import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { parseUtcCalendarDate } from "../../shared/date/day-boundary";
import {
  getCompanyRevenueFlow,
  getDriverCashOutstandingSnapshot,
  getNetCollectedFlow,
  getNetCompanyCategoryFlow,
  getNetPayoutFlow,
  getWalletLiabilitySnapshot,
  resolveRange,
  type ResolvedRange,
} from "../finance/finance-summary.service";
import type { FinanceReportQuery } from "./report.schema";
import type { FinanceReportCategoryRow, FinanceReportDto, FinanceReportPeriodRow, FinanceReportSummary } from "./report.types";

// ============================================================
// GET /api/v1/reports/finance (Phase 9.3)
//
// Reuses Phase 9.2's already-correct, already-tested reversal-aware flow/
// snapshot functions verbatim (finance-summary.service.ts) — this module
// NEVER reimplements the signed/unsigned reversal-aware SQL a third time.
// AGGREGATE-ONLY: reports.read (not finance.read) gates this route, and
// reports.read is also granted to Dispatcher, so no raw ledger notes/rows
// are ever exposed here — that remains GET /finance/transactions.
//
// Period grouping (day/week/month) is built by first finding the DISTINCT
// periods that actually have ledger activity (a single lightweight raw
// query), then calling the exported flow functions once per non-empty
// period via Promise.all — this reuses 100% of the proven-correct formulas
// instead of folding reversal logic into a `GROUP BY date_trunc(...)`
// (which would require a 3rd reimplementation of the reversal subqueries in
// a grouped context) and never enumerates empty buckets over "all time".
// ============================================================

function toAmount(value: Prisma.Decimal | string | null | undefined): string {
  return new Prisma.Decimal(value ?? "0").toString();
}

async function getSettlementAggregate(range: ResolvedRange): Promise<{ count: number; amount: string }> {
  const where: Prisma.driver_settlementsWhereInput = {};
  if (range.start || range.endExclusive) {
    where.created_at = { ...(range.start ? { gte: range.start } : {}), ...(range.endExclusive ? { lt: range.endExclusive } : {}) };
  }
  const agg = await prisma.driver_settlements.aggregate({ where, _count: true, _sum: { amount_received: true } });
  return { count: agg._count, amount: toAmount(agg._sum.amount_received) };
}

async function getSummary(range: ResolvedRange): Promise<FinanceReportSummary> {
  const [companyRevenue, deliveryFeeRevenue, companyOrderRevenue, totalCollected, customerPayouts, walletLiability, driverCashOutstanding, settlement] =
    await Promise.all([
      getCompanyRevenueFlow(range),
      getNetCompanyCategoryFlow("DELIVERY_FEE_REVENUE", range),
      getNetCompanyCategoryFlow("COMPANY_ORDER_PRODUCT_REVENUE", range),
      getNetCollectedFlow(range),
      getNetPayoutFlow(range),
      // "current*" fields are ALWAYS the live snapshot, ignoring `to`
      // entirely — the Finance Report names them current* precisely to
      // avoid the as-of-`to` ambiguity Phase 9.2's plain field names allow.
      getWalletLiabilitySnapshot(undefined),
      getDriverCashOutstandingSnapshot(undefined),
      getSettlementAggregate(range),
    ]);

  return {
    companyRevenue,
    deliveryFeeRevenue,
    companyOrderRevenue,
    totalCollected,
    customerPayouts,
    currentCustomerWalletLiability: walletLiability,
    currentDriverCashOutstanding: driverCashOutstanding,
    settlementCount: settlement.count,
    settlementAmount: settlement.amount,
  };
}

// ------------------------------------------------------------
// Period (day/week/month) grouping
// ------------------------------------------------------------

interface PeriodRow {
  period_start: string;
}

type Bucket = "day" | "week" | "month";

async function findDistinctPeriods(bucket: Bucket, range: ResolvedRange): Promise<{ label: string; start: Date; endExclusive: Date }[]> {
  const clauses: Prisma.Sql[] = [];
  if (range.start) clauses.push(Prisma.sql`created_at >= ${range.start}`);
  if (range.endExclusive) clauses.push(Prisma.sql`created_at < ${range.endExclusive}`);
  const dateClause = clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;

  // `bucket` is a validated "day"|"week"|"month" enum value — a bound value
  // argument to date_trunc(), never an interpolated identifier. AT TIME
  // ZONE 'UTC' before truncation is mandatory (date_trunc on a bare
  // timestamptz truncates in the session timezone, not UTC).
  const rows = await prisma.$queryRaw<PeriodRow[]>`
    SELECT DISTINCT to_char(date_trunc(${bucket}, created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS period_start
    FROM (
      SELECT created_at FROM company_financial_transactions WHERE ${dateClause}
      UNION ALL
      SELECT created_at FROM driver_cash_transactions WHERE ${dateClause}
      UNION ALL
      SELECT created_at FROM wallet_transactions WHERE ${dateClause}
      UNION ALL
      SELECT created_at FROM driver_settlements WHERE ${dateClause}
    ) activity
    ORDER BY period_start ASC
  `;

  return rows
    .map((row) => {
      const start = parseUtcCalendarDate(row.period_start);
      if (!start) return null;
      let endExclusive: Date;
      if (bucket === "day") {
        endExclusive = new Date(start.getTime() + 24 * 60 * 60 * 1000);
      } else if (bucket === "week") {
        endExclusive = new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000);
      } else {
        endExclusive = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1));
      }
      const label = bucket === "month" ? row.period_start.slice(0, 7) : row.period_start;
      return { label, start, endExclusive };
    })
    .filter((row): row is { label: string; start: Date; endExclusive: Date } => row !== null);
}

async function getPeriodRows(bucket: Bucket, range: ResolvedRange): Promise<FinanceReportPeriodRow[]> {
  const periods = await findDistinctPeriods(bucket, range);
  return Promise.all(
    periods.map(async (period): Promise<FinanceReportPeriodRow> => {
      const periodRange: ResolvedRange = { start: period.start, endExclusive: period.endExclusive };
      const [companyRevenue, deliveryFeeRevenue, companyOrderRevenue, totalCollected, customerPayouts, settlement] = await Promise.all([
        getCompanyRevenueFlow(periodRange),
        getNetCompanyCategoryFlow("DELIVERY_FEE_REVENUE", periodRange),
        getNetCompanyCategoryFlow("COMPANY_ORDER_PRODUCT_REVENUE", periodRange),
        getNetCollectedFlow(periodRange),
        getNetPayoutFlow(periodRange),
        getSettlementAggregate(periodRange),
      ]);
      return {
        period: period.label,
        companyRevenue,
        deliveryFeeRevenue,
        companyOrderRevenue,
        totalCollected,
        customerPayouts,
        settlementAmount: settlement.amount,
      };
    })
  );
}

// ------------------------------------------------------------
// Category grouping — aggregate-only rows, never raw transactions.
// ------------------------------------------------------------
async function getCategoryRows(range: ResolvedRange): Promise<FinanceReportCategoryRow[]> {
  const [deliveryFee, productRevenue, totalCollected, payouts, settlement] = await Promise.all([
    getNetCompanyCategoryFlow("DELIVERY_FEE_REVENUE", range),
    getNetCompanyCategoryFlow("COMPANY_ORDER_PRODUCT_REVENUE", range),
    getNetCollectedFlow(range),
    getNetPayoutFlow(range),
    getSettlementAggregate(range),
  ]);

  return [
    { category: "DELIVERY_FEE_REVENUE", amount: deliveryFee, count: null },
    { category: "COMPANY_ORDER_REVENUE", amount: productRevenue, count: null },
    { category: "TOTAL_COLLECTED", amount: totalCollected, count: null },
    { category: "CUSTOMER_PAYOUTS", amount: payouts, count: null },
    { category: "DRIVER_SETTLEMENTS", amount: settlement.amount, count: settlement.count },
  ];
}

export async function getFinanceReport(query: FinanceReportQuery): Promise<FinanceReportDto> {
  const range = resolveRange(query);

  const [summary, rows] = await Promise.all([
    getSummary(range),
    query.groupBy === "category" ? getCategoryRows(range) : getPeriodRows(query.groupBy, range),
  ]);

  return {
    report: "FINANCE",
    range: { from: query.from ?? null, to: query.to ?? null },
    groupBy: query.groupBy,
    summary,
    rows,
  };
}
