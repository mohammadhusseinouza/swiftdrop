import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { moneySchema } from "../orders/order-financial.schema";

// Same Decimal-safe parsing as the approved order-financial moneySchema
// (rejects negative, >2 decimal places, NUMERIC(14,2) overflow), plus the
// settlement-specific ">0" rule — a settlement of exactly 0 is meaningless
// and must be rejected before it ever reaches the Driver Cash ledger
// primitive (which itself also rejects zero-amount rows).
const positiveMoneySchema = moneySchema.refine((amount) => amount.greaterThan(0), {
  message: "Amount must be greater than zero",
});

// Settlement-Based Financial Release (FR.4, contract §5.2). The conservative
// approved starting limit — the production value is decided by measurement
// (FR.4 / FR.11), never raised without performance evidence.
export const MAX_ALLOCATIONS_PER_SETTLEMENT = 20;

// Decision A11 — unattributed money needs a meaningful written explanation
// (mirrors the driver_settlements_unattributed_reason_chk CHECK).
export const UNATTRIBUTED_REASON_MIN_LENGTH = 10;

const SettlementAllocationSchema = z.object({
  releaseId: z.string().uuid(),
  amount: positiveMoneySchema,
});

// POST /api/v1/driver-settlements body. Deliberately excludes
// settlementNumber, balanceBefore, balanceAfter, receivedById,
// cashAccountId, transactionId/Type, createdById, allocatedTotal and
// idempotencyKey — all of those are server-derived (see settlement.service.ts)
// and Zod's default object behavior already strips any unknown field a
// client sends, with zero effect.
//
// Two request formats (contract §5.2):
//   - allocation format: `allocations` present (may be empty). The server
//     requires amountReceived = Σ allocations + unattributedAmount exactly.
//   - legacy format: `allocations` omitted (and no unattributed fields) —
//     accepted only under the documented safe conditions, enforced inside the
//     settlement transaction.
export const CreateSettlementBodySchema = z
  .object({
    driverId: z.string().uuid(),
    amountReceived: positiveMoneySchema,
    paymentMethodId: z.string().uuid(),
    notes: z.string().trim().min(1).max(2000).optional(),
    allocations: z
      .array(SettlementAllocationSchema)
      .max(MAX_ALLOCATIONS_PER_SETTLEMENT, `At most ${MAX_ALLOCATIONS_PER_SETTLEMENT} allocations are allowed per settlement`)
      .optional(),
    unattributedAmount: moneySchema.optional(),
    unattributedReason: z.string().trim().min(UNATTRIBUTED_REASON_MIN_LENGTH).max(2000).optional(),
  })
  .superRefine((body, ctx) => {
    if (body.allocations === undefined) {
      if (body.unattributedAmount !== undefined || body.unattributedReason !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["allocations"],
          message: "allocations is required when unattributedAmount or unattributedReason is provided",
        });
      }
      return;
    }

    const seen = new Set<string>();
    body.allocations.forEach((allocation, index) => {
      if (seen.has(allocation.releaseId)) {
        ctx.addIssue({ code: "custom", path: ["allocations", index, "releaseId"], message: "Duplicate releaseId in allocations" });
      }
      seen.add(allocation.releaseId);
    });

    const unattributed = body.unattributedAmount;
    const hasUnattributed = unattributed !== undefined && unattributed.greaterThan(0);
    if (hasUnattributed && body.unattributedReason === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["unattributedReason"],
        message: `unattributedReason (at least ${UNATTRIBUTED_REASON_MIN_LENGTH} characters) is required when unattributedAmount is greater than zero`,
      });
    }
    if (!hasUnattributed && body.unattributedReason !== undefined) {
      ctx.addIssue({ code: "custom", path: ["unattributedReason"], message: "unattributedReason is only allowed with a positive unattributedAmount" });
    }

    // Exact Decimal arithmetic — never floating point.
    const allocated = body.allocations.reduce((sum, a) => sum.plus(a.amount), new Prisma.Decimal(0));
    const expected = allocated.plus(unattributed ?? 0);
    if (!expected.equals(body.amountReceived)) {
      ctx.addIssue({
        code: "custom",
        path: ["amountReceived"],
        message: "amountReceived must equal the sum of allocations plus unattributedAmount",
      });
    }
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

// FR.6 — settlement corrections (contract §8). A correction needs a
// meaningful written reason (same minimum as the new correction tables).
export const CORRECTION_REASON_MIN_LENGTH = 10;

const correctionReasonSchema = z
  .string()
  .trim()
  .min(CORRECTION_REASON_MIN_LENGTH, `reason must be at least ${CORRECTION_REASON_MIN_LENGTH} characters`)
  .max(2000);

export const SettlementIdParamSchema = z.object({
  id: z.string().uuid(),
});

// POST /api/v1/driver-settlements/:id/reverse
export const ReverseSettlementBodySchema = z.object({
  reason: correctionReasonSchema,
});
export type ReverseSettlementInput = z.infer<typeof ReverseSettlementBodySchema>;

// POST /api/v1/driver-settlements/:id/shortfall — the driver genuinely
// handed over LESS than the recorded amount (a real driver obligation).
export const SettlementShortfallBodySchema = z.object({
  amount: positiveMoneySchema,
  reason: correctionReasonSchema,
});
export type SettlementShortfallInput = z.infer<typeof SettlementShortfallBodySchema>;
