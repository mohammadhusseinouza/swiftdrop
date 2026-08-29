import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { nextUtcDay, parseUtcCalendarDate } from "../../shared/date/day-boundary";
import type { FinanceDateRangeQuery } from "./finance-read.schema";
import type { FinanceSummaryDto } from "./finance-read.types";

// ============================================================
// GET /api/v1/finance/summary (Phase 9.2)
//
// FLOW metrics ("what financial activity occurred during this date range?")
// vs SNAPSHOT metrics ("what balance/liability existed as of the end of this
// range?") are fundamentally different queries — see each function's own
// comment. Every flow metric filters by each ROW'S OWN created_at (a
// reversal counts in the period it happened, never the original's period);
// every reversal-aware category total is net-signed the same way Phase 9.1's
// dashboard.service.ts already established (reuse that reasoning, don't
// reinvent it): company_financial_transactions.amount is SIGNED (a REVERSAL
// row's amount is the negated original), so a plain SUM including matching
// REVERSAL rows nets correctly; driver_cash_transactions.amount and
// wallet_transactions.credit/debit are always POSITIVE MAGNITUDES, so a
// REVERSAL's contribution must be explicitly subtracted.
// ============================================================

interface NetSumRow {
  total: string | null;
}

function toDecimalString(value: string | null | undefined): string {
  return new Prisma.Decimal(value ?? "0").toString();
}

// Exported (Phase 9.3) — the Reports module reuses this shape directly
// (e.g. one {start,endExclusive} pair per day/week/month bucket) so it can
// call the flow/snapshot functions below without a second range type.
export interface ResolvedRange {
  start?: Date;
  endExclusive?: Date;
}

// `to` is inclusive as a calendar date, implemented internally as an
// EXCLUSIVE next-day UTC boundary (from=2026-08-01&to=2026-08-31 means
// >=2026-08-01T00:00:00.000Z and <2026-09-01T00:00:00.000Z) — the same UTC
// convention Phase 9.1's Dashboard "today" cards use.
export function resolveRange(query: { from?: string; to?: string }): ResolvedRange {
  const start = query.from ? (parseUtcCalendarDate(query.from) ?? undefined) : undefined;
  const toDate = query.to ? (parseUtcCalendarDate(query.to) ?? undefined) : undefined;
  const endExclusive = toDate ? nextUtcDay(toDate) : undefined;
  return { start, endExclusive };
}

// A bare `created_at` range clause — `TRUE` (no filter) when neither bound is
// given, matching the "no date filter -> all-time" contract.
function createdAtRangeSql(range: ResolvedRange): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (range.start) clauses.push(Prisma.sql`created_at >= ${range.start}`);
  if (range.endExclusive) clauses.push(Prisma.sql`created_at < ${range.endExclusive}`);
  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

// ------------------------------------------------------------
// FLOW metrics
// ------------------------------------------------------------

// Broad signed Company Finance movement in the period — deliberately
// includes generic ADJUSTMENT rows (CLAUDE.md/Phase 9.2 contract: this is
// the "Company Revenue" card, not a category-specific total).
// Exported (Phase 9.3) — the Finance Report reuses this verbatim rather
// than reimplementing the broad signed Company Finance total a third time.
export async function getCompanyRevenueFlow(range: ResolvedRange): Promise<string> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM company_financial_transactions
    WHERE ${createdAtRangeSql(range)}
  `;
  return toDecimalString(rows[0]?.total);
}

// Net category total: the category's own rows PLUS reversals that
// specifically target that category — never generic ADJUSTMENT, which has
// no approved category attribution. The date filter applies to each row's
// own created_at; the inner subquery identifying "which ids belong to this
// category" is deliberately unfiltered by date, since a reversal dated
// weeks after its (out-of-range) original must still match.
// Exported (Phase 9.3) — reused verbatim for the Finance Report's
// deliveryFeeRevenue/companyOrderRevenue category totals.
export async function getNetCompanyCategoryFlow(
  type: "DELIVERY_FEE_REVENUE" | "COMPANY_ORDER_PRODUCT_REVENUE",
  range: ResolvedRange
): Promise<string> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT COALESCE(SUM(amount), 0)::text AS total
    FROM company_financial_transactions
    WHERE (
      type = ${type}::"CompanyFinancialTransactionType"
      OR reversal_of_id IN (SELECT id FROM company_financial_transactions WHERE type = ${type}::"CompanyFinancialTransactionType")
    )
    AND ${createdAtRangeSql(range)}
  `;
  return toDecimalString(rows[0]?.total);
}

// Physical Driver Cash collection history. SETTLEMENT (custody change, not
// new collection) and ADJUSTMENT are never included; only a REVERSAL that
// specifically reverses a COLLECTION subtracts from the total.
// Exported (Phase 9.3) — reused verbatim for the Finance Report's
// totalCollected and (scoped by driverId) the Driver Report's moneyCollected.
export async function getNetCollectedFlow(range: ResolvedRange): Promise<string> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT (
      COALESCE(SUM(CASE WHEN type = 'COLLECTION' THEN amount ELSE 0 END), 0)
      - COALESCE(
          SUM(
            CASE
              WHEN type = 'REVERSAL' AND reversal_of_id IN (SELECT id FROM driver_cash_transactions WHERE type = 'COLLECTION')
              THEN amount
              ELSE 0
            END
          ),
          0
        )
    )::text AS total
    FROM driver_cash_transactions
    WHERE ${createdAtRangeSql(range)}
  `;
  return toDecimalString(rows[0]?.total);
}

// Payout cash-flow derived from the Wallet ledger event history (never the
// business row's CURRENT status) — a PAYOUT debit is +flow, a REVERSAL of
// that PAYOUT is -flow, each counted in ITS OWN period. This keeps historical
// periods stable: reversing a payout later never rewrites an earlier period's
// reported total (unlike a naive "SUM WHERE status=COMPLETED" would).
// Exported (Phase 9.3) — reused verbatim for the Finance Report's
// customerPayouts and (scoped by customerId) the Customer Report's
// walletPayouts.
export async function getNetPayoutFlow(range: ResolvedRange): Promise<string> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT (
      COALESCE(SUM(CASE WHEN type = 'PAYOUT' THEN debit ELSE 0 END), 0)
      - COALESCE(
          SUM(
            CASE
              WHEN type = 'REVERSAL' AND reversal_of_id IN (SELECT id FROM wallet_transactions WHERE type = 'PAYOUT')
              THEN credit
              ELSE 0
            END
          ),
          0
        )
    )::text AS total
    FROM wallet_transactions
    WHERE ${createdAtRangeSql(range)}
  `;
  return toDecimalString(rows[0]?.total);
}

// ------------------------------------------------------------
// SNAPSHOT metrics — `from` is IGNORED entirely (a snapshot is a point-in-
// time balance, not a windowed movement). With no `to`, use the current
// authoritative cached balance; with a `to`, reconstruct the balance as of
// the end of that UTC date from the full append-only ledger history (every
// account starts at zero and every movement is ledgered — CLAUDE.md §22/§25).
// ------------------------------------------------------------

// Exported (Phase 9.3) — reused verbatim for the Finance Report's
// currentCustomerWalletLiability (always called with no endExclusive there,
// since the Finance Report names it "current*" precisely to avoid the
// as-of-`to` ambiguity this snapshot otherwise supports).
export async function getWalletLiabilitySnapshot(endExclusive?: Date): Promise<string> {
  if (!endExclusive) {
    const agg = await prisma.customer_wallets.aggregate({ _sum: { available_balance: true } });
    return toDecimalString(agg._sum.available_balance?.toString());
  }
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT COALESCE(SUM(credit - debit), 0)::text AS total
    FROM wallet_transactions
    WHERE created_at < ${endExclusive}
  `;
  return toDecimalString(rows[0]?.total);
}

// Exported (Phase 9.3) — reused verbatim for the Finance Report's
// currentDriverCashOutstanding (always called with no endExclusive there).
export async function getDriverCashOutstandingSnapshot(endExclusive?: Date): Promise<string> {
  if (!endExclusive) {
    const agg = await prisma.driver_cash_accounts.aggregate({ _sum: { current_balance: true } });
    return toDecimalString(agg._sum.current_balance?.toString());
  }
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT COALESCE(SUM(balance_after - balance_before), 0)::text AS total
    FROM driver_cash_transactions
    WHERE created_at < ${endExclusive}
  `;
  return toDecimalString(rows[0]?.total);
}

export async function getFinanceSummary(query: FinanceDateRangeQuery): Promise<FinanceSummaryDto> {
  const range = resolveRange(query);

  const [
    companyRevenue,
    deliveryFeeRevenue,
    companyOrderRevenue,
    totalCollected,
    customerPayouts,
    customerWalletLiability,
    driverCashOutstanding,
  ] = await Promise.all([
    getCompanyRevenueFlow(range),
    getNetCompanyCategoryFlow("DELIVERY_FEE_REVENUE", range),
    getNetCompanyCategoryFlow("COMPANY_ORDER_PRODUCT_REVENUE", range),
    getNetCollectedFlow(range),
    getNetPayoutFlow(range),
    getWalletLiabilitySnapshot(range.endExclusive),
    getDriverCashOutstandingSnapshot(range.endExclusive),
  ]);

  return {
    range: { from: query.from ?? null, to: query.to ?? null },
    companyRevenue,
    deliveryFeeRevenue,
    companyOrderRevenue,
    totalCollected,
    customerWalletLiability,
    customerPayouts,
    driverCashOutstanding,
  };
}
