import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerProfileForUser } from "../auth/ownership.service";
import { getCustomerWalletFigures } from "../wallets/wallet.service";
import { TRANSACTION_TYPE_BY_FILTER, type ListCustomerWalletTransactionsQuery } from "./customer-wallet.schema";
import type { CustomerWalletSummary, CustomerWalletTransactionSummary } from "./customer-wallet.types";

// ============================================================
// GET /api/v1/customer/me/wallet (Phase 13.4)
//
// SELF-SCOPED, READ-ONLY. The Customer is resolved ONLY from
// req.actor.userId — no customerId / customerNumber / walletId from the
// request anywhere (identical discipline to customer-dashboard.service.ts).
//
// Exactly the same authoritative figures as the Phase 13.1 Dashboard, via
// the shared getCustomerWalletFigures helper — one wallet lookup + one
// pending aggregate, plus a tiny name lookup. No per-Order query, no ledger
// scan (task §60). Pure read — zero writes (task §21 / §58).
// ============================================================

export async function getCustomerWallet(userId: string): Promise<CustomerWalletSummary> {
  const customer = await getCustomerProfileForUser(userId);

  const [figures, customerRow] = await Promise.all([
    getCustomerWalletFigures(customer.id),
    prisma.customers.findUnique({
      where: { id: customer.id },
      select: { name: true, customer_number: true },
    }),
  ]);

  if (!customerRow) {
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer record is missing" });
  }

  return {
    customer: { name: customerRow.name, customerNumber: customerRow.customer_number },
    availableBalance: figures.availableBalance,
    pendingAmount: figures.pendingAmount,
  };
}

// ============================================================
// GET /api/v1/customer/me/wallet/transactions (Phase 13.5)
//
// SELF-SCOPED, READ-ONLY, over the authoritative append-only
// wallet_transactions ledger (task §8 — never reconstructed from orders /
// payouts / audit). Same guard discipline as getCustomerWallet.
//
// NO N+1 (task §23 / §58): exactly THREE queries regardless of row count —
// one wallet existence check, one findMany with a fixed `select` (the safe
// Order number / payout number come from selected relations, never a per-row
// lookup), one count with the same `where`.
//
// APPEND-ONLY (task §38 / §39): every historical row is returned as-is;
// a reversal is its own separate row — nothing is collapsed or rewritten.
// ============================================================

const customerTransactionSelect = {
  id: true,
  type: true,
  balance_before: true,
  balance_after: true,
  created_at: true,
  orders: { select: { order_number: true } },
  customer_payouts: { select: { payout_number: true } },
} satisfies Prisma.wallet_transactionsSelect;

type CustomerTransactionRow = Prisma.wallet_transactionsGetPayload<{ select: typeof customerTransactionSelect }>;

function toCustomerWalletTransactionSummary(row: CustomerTransactionRow): CustomerWalletTransactionSummary {
  // Exact Decimal movement — derived from the authoritative balances, never
  // from the type and never from JS floating point (task §13).
  const delta = row.balance_after.minus(row.balance_before);
  const direction = delta.greaterThan(0) ? "CREDIT" : delta.lessThan(0) ? "DEBIT" : "NONE";

  let reference: CustomerWalletTransactionSummary["reference"] = null;
  if (row.orders) {
    reference = { kind: "ORDER", label: row.orders.order_number };
  } else if (row.customer_payouts) {
    reference = { kind: "PAYOUT", label: row.customer_payouts.payout_number };
  }

  return {
    id: row.id,
    type: row.type,
    occurredAt: row.created_at.toISOString(),
    direction,
    amount: delta.abs().toString(),
    balanceAfter: row.balance_after.toString(),
    reference,
  };
}

export interface ListCustomerWalletTransactionsResult {
  items: CustomerWalletTransactionSummary[];
  total: number;
}

export async function listCustomerWalletTransactions(
  userId: string,
  query: ListCustomerWalletTransactionsQuery
): Promise<ListCustomerWalletTransactionsResult> {
  const customer = await getCustomerProfileForUser(userId);

  const wallet = await prisma.customer_wallets.findUnique({
    where: { customer_id: customer.id },
    select: { id: true },
  });
  if (!wallet) {
    console.error(`[customer-wallet.service] data-integrity failure: customer ${customer.id} has no linked customer_wallets row`);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Customer wallet is missing" });
  }

  const where: Prisma.wallet_transactionsWhereInput = { customer_id: customer.id };
  if (query.type !== "all") {
    where.type = TRANSACTION_TYPE_BY_FILTER[query.type];
  }

  const [rows, total] = await Promise.all([
    prisma.wallet_transactions.findMany({
      where,
      select: customerTransactionSelect,
      // Deterministic newest-first — created_at DESC, id DESC tie-breaker
      // (the established wallet-ledger ordering, wallet.service.ts).
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.wallet_transactions.count({ where }),
  ]);

  return { items: rows.map(toCustomerWalletTransactionSummary), total };
}
