import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { getCustomerProfileForUser } from "../auth/ownership.service";
import type { ListCustomerPayoutsQuery } from "./customer-payout.schema";
import type { CustomerPayoutSummary } from "./customer-payout.types";

// ============================================================
// GET /api/v1/customer/me/payouts (Phase 13.6)
//
// SELF-SCOPED, READ-ONLY. The Customer is resolved ONLY from
// req.actor.userId (passed as `userId`) via getCustomerProfileForUser —
// there is no code path that reads a customerId / customerNumber / walletId
// from query / params / body, so `?customerId=<other>` has no effect
// (identical discipline to customer-wallet.service.ts).
//
// AUTHORITATIVE SOURCE (task §3): the customer_payouts business record —
// never reconstructed from wallet_transactions, audit logs, or Company
// Finance. The wallet-impact ledger row of a payout is a different concept
// and lives at /customer/me/wallet/transactions.
//
// NO N+1 (task §26 / §58): exactly TWO queries regardless of row count —
// one findMany with a fixed `select` (the safe payment-method NAME comes
// from a selected relation, never a per-row lookup) and one count with the
// same `where`.
//
// APPEND-ONLY / HISTORICAL (task §13): every payout row is returned as-is,
// with its current status. A payout that was later reversed still appears.
// ============================================================

const customerPayoutSelect = {
  id: true,
  payout_number: true,
  amount: true,
  status: true,
  created_at: true,
  payment_methods: { select: { name: true } },
} satisfies Prisma.customer_payoutsSelect;

type CustomerPayoutRow = Prisma.customer_payoutsGetPayload<{ select: typeof customerPayoutSelect }>;

function toCustomerPayoutSummary(row: CustomerPayoutRow): CustomerPayoutSummary {
  return {
    id: row.id,
    payoutNumber: row.payout_number,
    // Positive decimal string — the page establishes this is a payout, so
    // it is never signed here (task §14). Exact server digits, no rounding.
    amount: row.amount.toString(),
    paymentMethod: { name: row.payment_methods.name },
    status: row.status,
    createdAt: row.created_at.toISOString(),
  };
}

export interface ListCustomerPayoutsResult {
  items: CustomerPayoutSummary[];
  total: number;
}

export async function listCustomerPayouts(
  userId: string,
  query: ListCustomerPayoutsQuery
): Promise<ListCustomerPayoutsResult> {
  const customer = await getCustomerProfileForUser(userId);

  // customer_id is ALWAYS pinned to the authenticated Customer.
  const where: Prisma.customer_payoutsWhereInput = { customer_id: customer.id };

  const [rows, total] = await Promise.all([
    prisma.customer_payouts.findMany({
      where,
      select: customerPayoutSelect,
      // Deterministic newest-first — created_at DESC, id DESC as the stable
      // tie-breaker (the same convention the Management payout list and the
      // wallet ledger use).
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.customer_payouts.count({ where }),
  ]);

  return { items: rows.map(toCustomerPayoutSummary), total };
}
