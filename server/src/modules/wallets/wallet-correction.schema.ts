import { z } from "zod";
import { moneySchema } from "../orders/order-financial.schema";

const positiveMoneySchema = moneySchema.refine((amount) => amount.greaterThan(0), {
  message: "Amount must be greater than zero",
});

export const CorrectionDirectionSchema = z.enum(["CREDIT", "DEBIT"]);

// POST /api/v1/wallets/:customerId/adjust (Phase 8.8). Deliberately excludes
// actorId/processedById/createdById/type/balanceBefore/balanceAfter/
// reversalOfId/idempotencyKey — all server-authoritative.
export const AdjustWalletBodySchema = z.object({
  direction: CorrectionDirectionSchema,
  amount: positiveMoneySchema,
  reason: z.string().trim().min(1, "reason is required").max(2000),
});

export type AdjustWalletInput = z.infer<typeof AdjustWalletBodySchema>;

export const WalletTransactionIdParamSchema = z.object({
  transactionId: z.string().uuid(),
});

// POST /api/v1/wallet-transactions/:transactionId/reverse. Direction/amount
// are always server-derived from the original transaction — never client
// input (see WALLET REVERSAL DIRECTION in the Phase 8.8 spec).
export const ReverseWalletTransactionBodySchema = z.object({
  reason: z.string().trim().min(1, "reason is required").max(2000),
});

export type ReverseWalletTransactionInput = z.infer<typeof ReverseWalletTransactionBodySchema>;
