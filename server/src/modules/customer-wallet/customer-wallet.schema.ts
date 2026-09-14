import { z } from "zod";
import type { WalletTransactionType } from "../../generated/prisma/client";

// GET /api/v1/customer/me/wallet/transactions (Phase 13.5).
//
// `type` is the only filter (task §20) — the four approved wallet ledger
// types plus "all". No Management-style date / actor / reference search.
// page / limit follow the repository convention (default 20, max 100).
export const CustomerWalletTransactionTypeFilterSchema = z.enum([
  "all",
  "order_credit",
  "payout",
  "adjustment",
  "reversal",
]);

export const ListCustomerWalletTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  type: CustomerWalletTransactionTypeFilterSchema.optional().default("all"),
});

export type CustomerWalletTransactionTypeFilter = z.infer<typeof CustomerWalletTransactionTypeFilterSchema>;
export type ListCustomerWalletTransactionsQuery = z.infer<typeof ListCustomerWalletTransactionsQuerySchema>;

// Filter token -> the authoritative WalletTransactionType enum value.
export const TRANSACTION_TYPE_BY_FILTER: Record<
  Exclude<CustomerWalletTransactionTypeFilter, "all">,
  WalletTransactionType
> = {
  order_credit: "ORDER_CREDIT",
  payout: "PAYOUT",
  adjustment: "ADJUSTMENT",
  reversal: "REVERSAL",
};
