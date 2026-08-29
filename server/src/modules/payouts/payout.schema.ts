import { z } from "zod";
import { moneySchema } from "../orders/order-financial.schema";

export const PayoutStatusSchema = z.enum(["COMPLETED", "REVERSED", "CANCELLED"]);

// Same Decimal-safe parsing as the approved order-financial moneySchema
// (rejects negative, >2 decimal places, NUMERIC(14,2) overflow), plus the
// payout-specific ">0" rule — a payout of exactly 0 is meaningless and must
// be rejected before it ever reaches the Wallet ledger primitive.
const positiveMoneySchema = moneySchema.refine((amount) => amount.greaterThan(0), {
  message: "Amount must be greater than zero",
});

// POST /api/v1/payouts body. Deliberately excludes payoutNumber, status,
// processedById, walletId, balanceBefore/After, transaction type, and
// idempotencyKey — all of those are server-derived (see payout.service.ts)
// and Zod's default object behavior already strips any unknown field a
// client sends, with zero effect.
export const CreatePayoutBodySchema = z.object({
  customerId: z.string().uuid(),
  amount: positiveMoneySchema,
  paymentMethodId: z.string().uuid(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

export type CreatePayoutInput = z.infer<typeof CreatePayoutBodySchema>;

export const ListPayoutsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  customerId: z.string().uuid().optional(),
  status: PayoutStatusSchema.optional(),
  paymentMethodId: z.string().uuid().optional(),
});

export type ListPayoutsQuery = z.infer<typeof ListPayoutsQuerySchema>;
