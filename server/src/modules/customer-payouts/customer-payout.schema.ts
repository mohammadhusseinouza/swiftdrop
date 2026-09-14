import { z } from "zod";

// GET /api/v1/customer/me/payouts (Phase 13.6).
//
// page / limit follow the repository convention (default 20, max 100 —
// identical to ListCustomerWalletTransactionsQuerySchema / the Management
// ListPayoutsQuerySchema).
//
// NO status filter (task §25): every payout this Customer can hold is
// COMPLETED — POST /api/v1/payouts only ever creates COMPLETED, and there is
// no approved reversal / cancel workflow (see payout.test.ts §56). A filter
// whose "Reversed" / "Cancelled" tabs can never match adds no UX value, so
// the page stays simple. Documented as NOT USED in the phase gate.
export const ListCustomerPayoutsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type ListCustomerPayoutsQuery = z.infer<typeof ListCustomerPayoutsQuerySchema>;
