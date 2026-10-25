import { Prisma } from "../../generated/prisma/client";
import { walletCorrectionEligibility, type CorrectionEligibility } from "../finance/correction-eligibility.service";
import { prisma } from "../../db/prisma";
import { readSnapshot } from "../../db/read-snapshot";
import { AppError } from "../../shared/errors/app-error";
import { ORDER_ACTIVE_STATUSES } from "../orders/order-lifecycle";
import { PENDING_RELEASE_HOLDS_CASH } from "../financial-release/financial-release.service";
import type { ListWalletsQuery, ListWalletTransactionsQuery } from "./wallet.schema";
import type {
  WalletCustomerSummaryEntry,
  WalletDetail,
  WalletSummary,
  WalletTotals,
  WalletLedgerEntry,
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

// The ONE pending-qualification predicate — every pending query (single
// Customer, batched page, system-wide total) builds on this so they can
// never diverge.
function pendingOrdersWhere(customerScope?: Prisma.ordersWhereInput["customer_id"]): Prisma.ordersWhereInput {
  return {
    ...(customerScope !== undefined ? { customer_id: customerScope } : {}),
    order_type: "DELIVERY_ONLY",
    status: { in: PENDING_ACTIVE_STATUSES },
  };
}

// ============================================================
// PENDING SETTLEMENT + UNDER REVIEW (FR.7, contract §9, requirements §13)
//
//   pendingDelivery    = the Phase 8.2 rule above (active DELIVERY_ONLY orders)
//   pendingSettlement  = Σ planned_customer_wallet_amount of DELIVERY_ONLY
//                        releases still PENDING (holding driver cash) whose
//                        review is NOT_REQUIRED / RESOLVED
//   underReview        = DELIVERY_ONLY PENDING releases AWAITING_REVIEW — a
//                        count (and, for Management only, the collected cash);
//                        never an unapproved monetary pending amount
//   pendingAmount      = pendingDelivery + pendingSettlement (name unchanged)
//
// No double counting: DELIVERED is not an active status, and a release
// exists only for a DELIVERED order. RELEASED / VOIDED / RELEASE_REVERSED
// releases are excluded (released money is in available_balance; voided /
// reversed money is nobody's pending money). Company product revenue and
// delivery fees never enter these sums. With settlement-based release
// disabled no release rows exist, so the figures equal the Phase 8.2 ones.
// ============================================================

export interface PendingBreakdown {
  pendingDelivery: Prisma.Decimal;
  pendingSettlement: Prisma.Decimal;
  underReviewOrderCount: number;
  underReviewCollectionAmount: Prisma.Decimal;
}

const zero = () => new Prisma.Decimal(0);
const emptyBreakdown = (): PendingBreakdown => ({
  pendingDelivery: zero(),
  pendingSettlement: zero(),
  underReviewOrderCount: 0,
  underReviewCollectionAmount: zero(),
});

export function totalPending(b: PendingBreakdown): Prisma.Decimal {
  return b.pendingDelivery.plus(b.pendingSettlement);
}

type ReleasePendingRow = {
  customer_id: string;
  pending_settlement: Prisma.Decimal | null;
  under_review_count: number;
  under_review_amount: Prisma.Decimal | null;
};

// One grouped statement for any set of customers (null = all customers,
// collapsed into a single row keyed "*"). Uses the
// (customer_id, release_status) index.
async function loadReleasePending(db: Prisma.TransactionClient, customerIds: string[] | null): Promise<ReleasePendingRow[]> {
  const scope = customerIds === null ? Prisma.empty : Prisma.sql`AND r.customer_id = ANY(${customerIds}::uuid[])`;
  const key = customerIds === null ? Prisma.sql`'*'` : Prisma.sql`r.customer_id::text`;
  return db.$queryRaw<ReleasePendingRow[]>`
    SELECT ${key} AS customer_id,
      SUM(r.planned_customer_wallet_amount) FILTER (WHERE r.review_status <> 'AWAITING_REVIEW') AS pending_settlement,
      (COUNT(*) FILTER (WHERE r.review_status = 'AWAITING_REVIEW'))::int AS under_review_count,
      SUM(r.collection_amount) FILTER (WHERE r.review_status = 'AWAITING_REVIEW') AS under_review_amount
    FROM order_financial_releases r
    WHERE r.order_type = 'DELIVERY_ONLY' AND ${PENDING_RELEASE_HOLDS_CASH} ${scope}
    GROUP BY 1
  `;
}

function applyReleaseRow(target: PendingBreakdown, row: ReleasePendingRow): void {
  target.pendingSettlement = new Prisma.Decimal(row.pending_settlement ?? 0);
  target.underReviewOrderCount = row.under_review_count;
  target.underReviewCollectionAmount = new Prisma.Decimal(row.under_review_amount ?? 0);
}

// Batched breakdown for a page of Customers — two grouped queries, never one
// per row. Every requested id gets an entry (zero when nothing is pending).
export async function getPendingBreakdowns(
  customerIds: string[],
  db: Prisma.TransactionClient = prisma
): Promise<Map<string, PendingBreakdown>> {
  const map = new Map<string, PendingBreakdown>(customerIds.map((id) => [id, emptyBreakdown()]));
  if (customerIds.length === 0) return map;

  const [delivery, releases] = await Promise.all([
    db.orders.groupBy({
      by: ["customer_id"],
      where: pendingOrdersWhere({ in: customerIds }),
      _sum: { remaining_order_amount: true },
    }),
    loadReleasePending(db, customerIds),
  ]);
  for (const row of delivery) {
    const entry = map.get(row.customer_id);
    if (entry) entry.pendingDelivery = row._sum.remaining_order_amount ?? zero();
  }
  for (const row of releases) {
    const entry = map.get(row.customer_id);
    if (entry) applyReleaseRow(entry, row);
  }
  return map;
}

export async function getPendingBreakdownForCustomer(customerId: string, db: Prisma.TransactionClient = prisma): Promise<PendingBreakdown> {
  return (await getPendingBreakdowns([customerId], db)).get(customerId) ?? emptyBreakdown();
}

async function getPendingBreakdownTotals(db: Prisma.TransactionClient): Promise<PendingBreakdown> {
  const [delivery, releases] = await Promise.all([
    db.orders.aggregate({ where: pendingOrdersWhere(), _sum: { remaining_order_amount: true } }),
    loadReleasePending(db, null),
  ]);
  const totals = emptyBreakdown();
  totals.pendingDelivery = delivery._sum.remaining_order_amount ?? zero();
  if (releases[0]) applyReleaseRow(totals, releases[0]);
  return totals;
}

// Total pending (delivery + settlement) — the `pendingAmount` every existing
// DTO carries. Kept for callers that only need the single figure.
export async function getPendingAmountForCustomer(customerId: string): Promise<Prisma.Decimal> {
  return totalPending(await getPendingBreakdownForCustomer(customerId));
}

export async function getPendingAmountsForCustomers(customerIds: string[]): Promise<Map<string, Prisma.Decimal>> {
  const breakdowns = await getPendingBreakdowns(customerIds);
  return new Map([...breakdowns].map(([id, b]) => [id, totalPending(b)]));
}

// Management DTO fields (additive). underReviewCollectionAmount is
// Management-only — never on a Customer DTO.
export interface PendingBreakdownFields {
  pendingDeliveryAmount: string;
  pendingSettlementAmount: string;
  underReviewOrderCount: number;
  underReviewCollectionAmount: string;
}

export function toPendingBreakdownFields(b: PendingBreakdown): PendingBreakdownFields {
  return {
    pendingDeliveryAmount: b.pendingDelivery.toString(),
    pendingSettlementAmount: b.pendingSettlement.toString(),
    underReviewOrderCount: b.underReviewOrderCount,
    underReviewCollectionAmount: b.underReviewCollectionAmount.toString(),
  };
}

// ============================================================
// CUSTOMER-FACING WALLET FIGURES (Phase 13.4)
//
// The ONE authoritative source for the two numbers the Customer Portal shows
// on BOTH /customer/dashboard and /customer/wallet:
//   availableBalance -> customer_wallets.available_balance (the Phase 8.2
//                       authoritative cached balance — never a re-sum of
//                       wallet_transactions or of delivered orders)
//   pendingAmount    -> getPendingAmountForCustomer (the approved Phase 8.2
//                       pending rule, above)
//
// customer-dashboard.service.ts and customer-wallet.service.ts both call
// this, so the Dashboard and the Wallet page can never disagree (task
// §34 / §39). A missing wallet row for a real Customer is a data-integrity
// failure — fail closed, identical to the rest of this module (task §20 /
// §57).
// ============================================================

export interface CustomerWalletFigures {
  availableBalance: string;
  pendingAmount: string;
  // FR.7 — Customer-safe breakdown (no collected-cash amount for under review).
  pendingDeliveryAmount: string;
  pendingSettlementAmount: string;
  underReviewOrderCount: number;
}

export async function getCustomerWalletFigures(customerId: string): Promise<CustomerWalletFigures> {
  // One snapshot: a release moves money from pending settlement to the
  // available balance atomically, so both are read from the same instant.
  const [wallet, pending] = await readSnapshot((tx) =>
    Promise.all([
      tx.customer_wallets.findUnique({
        where: { customer_id: customerId },
        select: { available_balance: true },
      }),
      getPendingBreakdownForCustomer(customerId, tx),
    ])
  );

  if (!wallet) {
    console.error(`[wallet.service] data-integrity failure: customer ${customerId} has no linked customer_wallets row`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer wallet is missing" });
  }

  return {
    availableBalance: wallet.available_balance.toString(),
    pendingAmount: totalPending(pending).toString(),
    pendingDeliveryAmount: pending.pendingDelivery.toString(),
    pendingSettlementAmount: pending.pendingSettlement.toString(),
    underReviewOrderCount: pending.underReviewOrderCount,
  };
}

// ============================================================
// GET /api/v1/wallets/totals — system-wide figures for the Management
// Customers page summary cards. Same definitions as a single Customer's
// Wallet Detail, summed across ALL customers in the database:
//   availableBalance -> SUM(customer_wallets.available_balance)
//   pendingAmount    -> pendingOrdersWhere() with no customer scope
// Never derived from a client page of rows.
// ============================================================

export async function getWalletTotals(): Promise<WalletTotals> {
  const [wallets, pending] = await readSnapshot((tx) =>
    Promise.all([tx.customer_wallets.aggregate({ _sum: { available_balance: true } }), getPendingBreakdownTotals(tx)])
  );
  return {
    availableBalance: (wallets._sum.available_balance ?? new Prisma.Decimal(0)).toString(),
    pendingAmount: totalPending(pending).toString(),
    ...toPendingBreakdownFields(pending),
  };
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
    getPendingBreakdowns(customerIds),
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

    const pending = pendingMap.get(customer.id) ?? emptyBreakdown();
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
      pendingAmount: totalPending(pending).toString(),
      ...toPendingBreakdownFields(pending),
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

  const [wallets, pendingMap] = await readSnapshot((tx) =>
    Promise.all([
      tx.customer_wallets.findMany({
        where: { customer_id: { in: customerIds } },
        select: { customer_id: true, available_balance: true },
      }),
      getPendingBreakdowns(customerIds, tx),
    ])
  );

  return wallets.map((w) => {
    const pending = pendingMap.get(w.customer_id) ?? emptyBreakdown();
    return {
      customerId: w.customer_id,
      availableBalance: w.available_balance.toString(),
      pendingAmount: totalPending(pending).toString(),
      ...toPendingBreakdownFields(pending),
    };
  });
}

// ============================================================
// GET /api/v1/wallets/:customerId
// ============================================================

export async function getWalletDetail(customerId: string): Promise<WalletDetail> {
  const [customer, pending] = await readSnapshot((tx) =>
    Promise.all([
      tx.customers.findUnique({ where: { id: customerId }, include: { customer_wallets: true } }),
      getPendingBreakdownForCustomer(customerId, tx),
    ])
  );
  if (!customer) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Customer not found" });
  }
  // An inactive Customer remains fully readable — financial history must
  // not disappear merely because the Customer was deactivated.
  if (!customer.customer_wallets) {
    console.error(`[wallet.service] data-integrity failure: customer ${customerId} has no linked customer_wallets row`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer wallet is missing" });
  }

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
      pendingAmount: totalPending(pending).toString(),
      ...toPendingBreakdownFields(pending),
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
  items: WalletLedgerEntry[];
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

  // FR.10.1 — correction eligibility for the page, batched.
  const eligibility = await walletCorrectionEligibility(
    rows.map((r) => ({ id: r.id, type: r.type, payoutStatus: r.customer_payouts?.status ?? null }))
  );
  return {
    items: rows.map((r) => ({ ...toWalletTransactionEntry(r), ...(eligibility.get(r.id) as CorrectionEligibility) })),
    total,
  };
}
