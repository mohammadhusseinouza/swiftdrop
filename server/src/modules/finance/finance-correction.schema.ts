import { z } from "zod";
import { moneySchema } from "../orders/order-financial.schema";

const positiveMoneySchema = moneySchema.refine((amount) => amount.greaterThan(0), {
  message: "Amount must be greater than zero",
});

export const CorrectionDirectionSchema = z.enum(["CREDIT", "DEBIT"]);

const CorrectionBodyBase = z.object({
  direction: CorrectionDirectionSchema,
  amount: positiveMoneySchema,
  reason: z.string().trim().min(1, "reason is required").max(2000),
});

// POST /api/v1/finance/driver-cash/:driverId/adjust
export const AdjustDriverCashBodySchema = CorrectionBodyBase;
export type AdjustDriverCashInput = z.infer<typeof AdjustDriverCashBodySchema>;

export const DriverIdParamSchema = z.object({
  driverId: z.string().uuid(),
});

export const DriverCashTransactionIdParamSchema = z.object({
  transactionId: z.string().uuid(),
});

const ReversalBodySchema = z.object({
  reason: z.string().trim().min(1, "reason is required").max(2000),
});

export const ReverseDriverCashTransactionBodySchema = ReversalBodySchema;
export type ReverseDriverCashTransactionInput = z.infer<typeof ReverseDriverCashTransactionBodySchema>;

// POST /api/v1/finance/company/adjust
export const AdjustCompanyBodySchema = CorrectionBodyBase;
export type AdjustCompanyInput = z.infer<typeof AdjustCompanyBodySchema>;

export const CompanyTransactionIdParamSchema = z.object({
  transactionId: z.string().uuid(),
});

export const ReverseCompanyTransactionBodySchema = ReversalBodySchema;
export type ReverseCompanyTransactionInput = z.infer<typeof ReverseCompanyTransactionBodySchema>;

// FR.6 — settlement-mode financial release corrections (contract §8).
export const RELEASE_CORRECTION_REASON_MIN_LENGTH = 10;

export const ReleaseIdParamSchema = z.object({
  releaseId: z.string().uuid(),
});

// POST /api/v1/finance/order-releases/:releaseId/void-collection
// POST /api/v1/finance/order-releases/:releaseId/reverse-release
// Mirrors ofrc_reason_meaningful_chk (length(btrim(reason)) >= 10).
export const ReleaseCorrectionBodySchema = z.object({
  reason: z
    .string()
    .trim()
    .min(RELEASE_CORRECTION_REASON_MIN_LENGTH, `reason must be at least ${RELEASE_CORRECTION_REASON_MIN_LENGTH} characters`)
    .max(2000),
});
export type ReleaseCorrectionInput = z.infer<typeof ReleaseCorrectionBodySchema>;
