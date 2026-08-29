import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { getPendingAmountsForCustomers } from "../wallets/wallet.service";
import { resolveRange, type ResolvedRange } from "../finance/finance-summary.service";
import type { CustomerReportQuery } from "./report.schema";
import type { CustomerReportDto, CustomerReportRow } from "./report.types";

// ============================================================
// GET /api/v1/reports/customers (Phase 9.3)
//
// ordersCreated: orders.created_at in range. deliveredOrders: orders.
// delivered_at in range (explicit contract — unlike the Order Report's
// current-status approach, this metric is unambiguously delivery-evidence-
// based here). walletCredits/walletPayouts are FLOW metrics (each ledger
// row's own created_at, reversal-aware, mirroring Phase 9.2's formulas
// exactly). currentWalletBalance/pendingOrderValue are CURRENT snapshots —
// `from`/`to` never affects them, reusing the approved Phase 8.2 pending
// formula verbatim (getPendingAmountsForCustomers).
// ============================================================

interface NetSumRow {
  total: string | null;
}

function toAmount(value: Prisma.Decimal | string | null | undefined): string {
  return new Prisma.Decimal(value ?? "0").toString();
}

function dateRangeSql(column: string, range: ResolvedRange): Prisma.Sql {
  const clauses: Prisma.Sql[] = [];
  if (range.start) clauses.push(Prisma.sql`${Prisma.raw(column)} >= ${range.start}`);
  if (range.endExclusive) clauses.push(Prisma.sql`${Prisma.raw(column)} < ${range.endExclusive}`);
  return clauses.length ? Prisma.join(clauses, " AND ") : Prisma.sql`TRUE`;
}

function rangeToWhere(range: ResolvedRange): { gte?: Date; lt?: Date } | undefined {
  if (!range.start && !range.endExclusive) return undefined;
  return {
    ...(range.start ? { gte: range.start } : {}),
    ...(range.endExclusive ? { lt: range.endExclusive } : {}),
  };
}

// Net ORDER_CREDIT flow, scoped to one Customer — mirrors Phase 9.2's
// getNetCompanyCategoryFlow shape (category rows + reversals specifically
// targeting that category), applied to wallet_transactions/ORDER_CREDIT
// instead. Generic Wallet ADJUSTMENT is deliberately excluded (Phase 9.3
// contract: "Wallet Credits" means delivery-generated ORDER_CREDIT only).
async function getWalletCredits(customerId: string, range: ResolvedRange): Promise<string> {
  // A REVERSAL of an ORDER_CREDIT (itself a CREDIT-direction row) is
  // necessarily DEBIT-direction — its amount lives in the `debit` column,
  // never `credit` — so it must be explicitly SUBTRACTED, mirroring the
  // same unsigned-ledger convention as Phase 9.2's getNetPayoutFlow (never
  // simply "included" via a shared CASE branch keyed on type='ORDER_CREDIT'
  // alone, which would silently ignore the reversal's contribution).
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT (
      COALESCE(SUM(CASE WHEN type = 'ORDER_CREDIT' THEN credit ELSE 0 END), 0)
      - COALESCE(
          SUM(
            CASE
              WHEN type = 'REVERSAL' AND reversal_of_id IN (SELECT id FROM wallet_transactions WHERE type = 'ORDER_CREDIT' AND customer_id = ${customerId}::uuid)
              THEN debit
              ELSE 0
            END
          ),
          0
        )
    )::text AS total
    FROM wallet_transactions
    WHERE customer_id = ${customerId}::uuid AND ${dateRangeSql("created_at", range)}
  `;
  return toAmount(rows[0]?.total);
}

// Mirrors Phase 9.2's getNetPayoutFlow exactly, scoped to one Customer.
async function getWalletPayouts(customerId: string, range: ResolvedRange): Promise<string> {
  const rows = await prisma.$queryRaw<NetSumRow[]>`
    SELECT (
      COALESCE(SUM(CASE WHEN type = 'PAYOUT' THEN debit ELSE 0 END), 0)
      - COALESCE(
          SUM(
            CASE
              WHEN type = 'REVERSAL' AND reversal_of_id IN (SELECT id FROM wallet_transactions WHERE type = 'PAYOUT' AND customer_id = ${customerId}::uuid)
              THEN credit
              ELSE 0
            END
          ),
          0
        )
    )::text AS total
    FROM wallet_transactions
    WHERE customer_id = ${customerId}::uuid AND ${dateRangeSql("created_at", range)}
  `;
  return toAmount(rows[0]?.total);
}

export async function getCustomerReport(query: CustomerReportQuery): Promise<CustomerReportDto> {
  const range = resolveRange(query);

  const customerWhere: Prisma.customersWhereInput = {};
  if (query.customerId) customerWhere.id = query.customerId;
  if (query.isActive !== undefined) customerWhere.is_active = query.isActive;
  if (query.areaId) customerWhere.default_area_id = query.areaId;

  const customers = await prisma.customers.findMany({
    where: customerWhere,
    select: { id: true, customer_number: true, name: true, is_active: true },
  });
  if (customers.length === 0) {
    return { report: "CUSTOMERS", range: { from: query.from ?? null, to: query.to ?? null }, rows: [] };
  }
  const customerIds = customers.map((c) => c.id);

  const [ordersCreatedRows, deliveredRows, walletBalances, pendingByCustomer, creditsByCustomer, payoutsByCustomer] = await Promise.all([
    prisma.orders.groupBy({ by: ["customer_id"], where: { customer_id: { in: customerIds }, created_at: rangeToWhere(range) }, _count: true }),
    prisma.orders.groupBy({ by: ["customer_id"], where: { customer_id: { in: customerIds }, delivered_at: rangeToWhere(range) }, _count: true }),
    prisma.customer_wallets.findMany({ where: { customer_id: { in: customerIds } }, select: { customer_id: true, available_balance: true } }),
    getPendingAmountsForCustomers(customerIds),
    Promise.all(customerIds.map(async (id) => [id, await getWalletCredits(id, range)] as const)),
    Promise.all(customerIds.map(async (id) => [id, await getWalletPayouts(id, range)] as const)),
  ]);

  const ordersCreatedById = new Map(ordersCreatedRows.map((r) => [r.customer_id, r._count]));
  const deliveredById = new Map(deliveredRows.map((r) => [r.customer_id, r._count]));
  const balanceById = new Map(walletBalances.map((w) => [w.customer_id, w.available_balance]));
  const creditsById = new Map(creditsByCustomer);
  const payoutsById = new Map(payoutsByCustomer);

  const rows: CustomerReportRow[] = customers.map((customer) => ({
    customer: { id: customer.id, customerNumber: customer.customer_number, name: customer.name, isActive: customer.is_active },
    ordersCreated: ordersCreatedById.get(customer.id) ?? 0,
    deliveredOrders: deliveredById.get(customer.id) ?? 0,
    walletCredits: creditsById.get(customer.id) ?? "0",
    walletPayouts: payoutsById.get(customer.id) ?? "0",
    currentWalletBalance: toAmount(balanceById.get(customer.id)),
    pendingOrderValue: toAmount(pendingByCustomer.get(customer.id)),
  }));

  return { report: "CUSTOMERS", range: { from: query.from ?? null, to: query.to ?? null }, rows };
}
