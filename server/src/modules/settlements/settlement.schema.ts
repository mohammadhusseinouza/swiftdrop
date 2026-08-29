import { z } from "zod";
import { moneySchema } from "../orders/order-financial.schema";

// Same Decimal-safe parsing as the approved order-financial moneySchema
// (rejects negative, >2 decimal places, NUMERIC(14,2) overflow), plus the
// settlement-specific ">0" rule — a settlement of exactly 0 is meaningless
// and must be rejected before it ever reaches the Driver Cash ledger
// primitive (which itself also rejects zero-amount rows).
const positiveMoneySchema = moneySchema.refine((amount) => amount.greaterThan(0), {
  message: "Amount must be greater than zero",
});

// POST /api/v1/driver-settlements body. Deliberately excludes
// settlementNumber, balanceBefore, balanceAfter, receivedById,
// cashAccountId, transactionId/Type, createdById, and idempotencyKey — all
// of those are server-derived (see settlement.service.ts) and Zod's default
// object behavior already strips any unknown field a client sends, with
// zero effect.
export const CreateSettlementBodySchema = z.object({
  driverId: z.string().uuid(),
  amountReceived: positiveMoneySchema,
  paymentMethodId: z.string().uuid(),
  notes: z.string().trim().min(1).max(2000).optional(),
});

export type CreateSettlementInput = z.infer<typeof CreateSettlementBodySchema>;

export const ListSettlementsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  driverId: z.string().uuid().optional(),
  paymentMethodId: z.string().uuid().optional(),
});

export type ListSettlementsQuery = z.infer<typeof ListSettlementsQuerySchema>;
