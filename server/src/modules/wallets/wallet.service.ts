import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { ORDER_ACTIVE_STATUSES } from "../orders/order-lifecycle";
import type { ListWalletsQuery, ListWalletTransactionsQuery } from "./wallet.schema";
import type {
  WalletCustomerSummaryEntry,
  WalletDetail,
  WalletSummary,
  WalletTransactionEntry,
} from "./wallet.types";

// ============================================================
// PENDING AMOUNT (Phase 8.2) — derived only, never persisted, never
// written to wallet_transactions/customer_wallets. See the module-level
// business rule below for exactly what qualifies.
//
// For a Customer, pending = SUM(orders.remaining_order_amount) where:
//   order_type = DELIVERY_ONLY   (a COMPANY_ORDER's remaining amount is
//                                  company money, never customer pending)
//   status IN the currently active/retryable set below
//
// remaining_delivery_fee is deliberately excluded — for DELIVERY_ONLY that
// portion belongs to the company, never to customer pending money.
// DELIVERED is deliberately excluded — Phase 8.3 is what turns a qualifying
// exact successful delivery into a real, finalized ORDER_CREDIT; until then
// a DELIVERED order contributes nothing to pending (CLAUDE.md's "Pending Is
// Not Available" rule) and nothing to available_balance either.
// ============================================================
// Pending money is only ever attributable to a NON-TERMINAL order (a
// terminal order's remaining amount is either finalized or void). Reuses the
// single shared lifecycle definition (Phase 11.6 correction) rather than
// re-listing the statuses — the pending calculation additionally narrows to
// DELIVERY_ONLY in the queries below.
const PENDING_ACTIVE_STATUSES = [...ORDER_ACTIVE_STATUSES];

export async function getPendingAmountForCustomer(customerId: string): Promise<Prisma.Decimal> {
  const result = await prisma.orders.aggregate({
    where: { customer_id: customerId, order_type: "DELIVERY_ONLY", status: { in: PENDING_ACTIVE_STATUSES } },
    _sum: { remaining_order_amount: true },
  });
  return result._sum.remaining_order_amount ?? new Prisma.Decimal(0);
}

// Batched equivalent for a page of Customers — avoids one Order aggregate
// query per row (N+1) on the wallet list.
export async function getPendingAmountsForCustomers(customerIds: string[]): Promise<Map<string, Prisma.Decimal>> {
  const map = new Map<string, Prisma.Decimal>();
  if (customerIds.length === 0) return map;

  const grouped = await prisma.orders.groupBy({
    by: ["customer_id"],
    where: { customer_id: { in: customerIds }, order_type: "DELIVERY_ONLY", status: { in: PENDING_ACTIVE_STATUSES } },
    _sum: { remaining_order_amount: true },
  });
  for (const row of grouped) {
    map.set(row.customer_id, row._sum.remaining_order_amount ?? new Prisma.Decimal(0));
  }
  return map;
}

// ============================================================
// GET /api/v1/wallets
// ============================================================

export interface ListWalletsResult {
  items: WalletSummary[];
  total: number;
}

export async function listWallets(query: ListWalletsQuery): Promise<ListWalletsResult> {
  const where: Prisma.customersWhereInput = {};
  if (query.search) {
    where.OR = [
      { customer_number: { contains: query.search, mode: "insensitive" } },
      { name: { contains: query.search, mode: "insensitive" } },
      { primary_phone: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [customersPage, total] = await Promise.all([
    prisma.customers.findMany({
      where,
      include: { customer_wallets: true },
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.customers.count({ where }),
  ]);

  const customerIds = customersPage.map((c) => c.id);

  // Batched (not per-row) lookups — avoids N+1 queries across the page.
  const [pendingMap, lastTransactions, lastPayouts] = await Promise.all([
    getPendingAmountsForCustomers(customerIds),
    customerIds.length === 0
      ? Promise.resolve([])
      : prisma.wallet_transactions.findMany({
          where: { customer_id: { in: customerIds } },
          orderBy: { created_at: "desc" },
          distinct: ["customer_id"],
          select: { id: true, customer_id: true, type: true, created_at: true },
        }),
    customerIds.length === 0
      ? Promise.resolve([])
      : prisma.customer_payouts.findMany({
          where: { customer_id: { in: customerIds } },
          orderBy: { created_at: "desc" },
          distinct: ["customer_id"],
          select: { id: true, customer_id: true, payout_number: true, status: true, created_at: true },
        }),
  ]);
  const lastTransactionByCustomer = new Map(lastTransactions.map((t) => [t.customer_id, t]));
  const lastPayoutByCustomer = new Map(lastPayouts.map((p) => [p.customer_id, p]));

  const items: WalletSummary[] = customersPage.map((customer) => {
    // Phase 5.1 creates the Customer + wallet atomically — this should
    // never be null for a real row. Never silently skip a broken row (that
    // would hide the integrity failure) — fail the whole request closed.
    if (!customer.customer_wallets) {
      console.error(`[wallet.service] data-integrity failure: customer ${customer.id} has no linked customer_wallets row`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer wallet is missing" });
    }

    const pending = pendingMap.get(customer.id) ?? new Prisma.Decimal(0);
    const lastTransaction = lastTransactionByCustomer.get(customer.id);
    const lastPayout = lastPayoutByCustomer.get(customer.id);

    return {
      id: customer.customer_wallets.id,
      customer: {
        id: customer.id,
        customerNumber: customer.customer_number,
        name: customer.name,
        primaryPhone: customer.primary_phone,
        isActive: customer.is_active,
      },
      availableBalance: customer.customer_wallets.available_balance.toString(),
      pendingAmount: pending.toString(),
      lastTransaction: lastTransaction
        ? { id: lastTransaction.id, type: lastTransaction.type, createdAt: lastTransaction.created_at.toISOString() }
        : null,
      lastPayout: lastPayout
        ? {
            id: lastPayout.id,
            payoutNumber: lastPayout.payout_number,
            status: lastPayout.status,
            createdAt: lastPayout.created_at.toISOString(),
          }
        : null,
    };
  });

  return { items, total };
}

// ============================================================
// GET /api/v1/wallets/customer-summaries?customerIds=...
//
// Batched balance + pending for a page of Customers — the wallets.read-gated
// financial source for the Management Customer List (Phase 11.6 correction).
// Reuses getPendingAmountsForCustomers (the approved Phase 8.2 pending rule)
// verbatim — no second pending calculation. Returns an entry only for a
// requested id that has a wallet; unknown ids are simply absent.
// ============================================================

export async function getWalletCustomerSummaries(customerIds: string[]): Promise<WalletCustomerSummaryEntry[]> {
  if (customerIds.length === 0) return [];

  const [wallets, pendingMap] = await Promise.all([
    prisma.customer_wallets.findMany({
      where: { customer_id: { in: customerIds } },
      select: { customer_id: true, available_balance: true },
    }),
    getPendingAmountsForCustomers(customerIds),
  ]);

  return wallets.map((w) => ({
    customerId: w.customer_id,
    availableBalance: w.available_balance.toString(),
    pendingAmount: (pendingMap.get(w.customer_id) ?? new Prisma.Decimal(0)).toString(),
  }));
}

// ============================================================
// GET /api/v1/wallets/:customerId
// ============================================================

export async function getWalletDetail(customerId: string): Promise<WalletDetail> {
  const customer = await prisma.customers.findUnique({ where: { id: customerId }, include: { customer_wallets: true } });
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }
  // An inactive Customer remains fully readable — financial history must
  // not disappear merely because the Customer was deactivated.
  if (!customer.customer_wallets) {
    console.error(`[wallet.service] data-integrity failure: customer ${customerId} has no linked customer_wallets row`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer wallet is missing" });
  }

  const pending = await getPendingAmountForCustomer(customerId);

  return {
    customer: {
      id: customer.id,
      customerNumber: customer.customer_number,
      name: customer.name,
      primaryPhone: customer.primary_phone,
      secondaryPhone: customer.secondary_phone,
      email: customer.email,
      isActive: customer.is_active,
    },
    wallet: {
      id: customer.customer_wallets.id,
      availableBalance: customer.customer_wallets.available_balance.toString(),
      pendingAmount: pending.toString(),
      createdAt: customer.customer_wallets.created_at.toISOString(),
      updatedAt: customer.customer_wallets.updated_at.toISOString(),
    },
  };
}

// ============================================================
// GET /api/v1/wallets/:customerId/transactions
// ============================================================

// Exported for reuse by wallet-correction.service.ts (Phase 8.8) — an
// adjustment/reversal response should show the created transaction in the
// exact same safe shape as the normal transaction-history list, not a
// second bespoke DTO.
export const transactionSelect = {
  id: true,
  type: true,
  credit: true,
  debit: true,
  balance_before: true,
  balance_after: true,
  notes: true,
  created_at: true,
  orders: { select: { id: true, order_number: true } },
  customer_payouts: { select: { id: true, payout_number: true, status: true } },
  payment_methods: { select: { id: true, code: true, name: true } },
  users: { select: { id: true, first_name: true, last_name: true } },
} satisfies Prisma.wallet_transactionsSelect;

type TransactionRow = Prisma.wallet_transactionsGetPayload<{ select: typeof transactionSelect }>;

export function toWalletTransactionEntry(row: TransactionRow): WalletTransactionEntry {
  return {
    id: row.id,
    type: row.type,
    credit: row.credit.toString(),
    debit: row.debit.toString(),
    balanceBefore: row.balance_before.toString(),
    balanceAfter: row.balance_after.toString(),
    order: row.orders ? { id: row.orders.id, orderNumber: row.orders.order_number } : null,
    payout: row.customer_payouts
      ? { id: row.customer_payouts.id, payoutNumber: row.customer_payouts.payout_number, status: row.customer_payouts.status }
      : null,
    paymentMethod: row.payment_methods
      ? { id: row.payment_methods.id, code: row.payment_methods.code, name: row.payment_methods.name }
      : null,
    processedBy: row.users ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name } : null,
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ListWalletTransactionsResult {
  items: WalletTransactionEntry[];
  total: number;
}

export async function listWalletTransactions(
  customerId: string,
  query: ListWalletTransactionsQuery
): Promise<ListWalletTransactionsResult> {
  const customer = await prisma.customers.findUnique({
    where: { id: customerId },
    select: { id: true, customer_wallets: { select: { id: true } } },
  });
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }
  if (!customer.customer_wallets) {
    console.error(`[wallet.service] data-integrity failure: customer ${customerId} has no linked customer_wallets row`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer wallet is missing" });
  }

  const where: Prisma.wallet_transactionsWhereInput = { customer_id: customerId };
  if (query.type) {
    where.type = query.type;
  }

  const [rows, total] = await Promise.all([
    prisma.wallet_transactions.findMany({
      where,
      select: transactionSelect,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.wallet_transactions.count({ where }),
  ]);

  return { items: rows.map(toWalletTransactionEntry), total };
}
