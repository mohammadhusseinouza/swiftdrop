import { z } from "zod";

// ============================================================
// FR.12A.11 — request schemas for historical ownership resolution.
//
// The client never supplies an amount: the expected, collected and
// difference amounts, the liability components (L1 / L2) and every digest
// are derived on the server from PostgreSQL. To approve or record, the
// reviewer confirms the exact fingerprint it reviewed.
// ============================================================

const uuid = z.string().uuid();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "Must be 64 lowercase hex characters");
const text = (label: string, min: number, max = 2000) =>
  z.string().trim().min(min, `${label} must be at least ${min} characters`).max(max, `${label} is too long`);

export const ProposeLiabilityPolicySchema = z
  .object({
    policyCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,59}$/, "policyCode must be UPPER_SNAKE_CASE (3–60 characters)"),
    title: text("Title", 10, 200),
    summary: text("Summary", 20, 4000),
    documentSha256: sha256,
    documentReference: text("Document reference", 3, 500),
    // L7: configurable; omitted = none configured (no legal expiry is assumed).
    reviewIntervalDays: z.number().int().min(1).max(3660).nullable().optional(),
    unclaimedFundsHandling: text("Unclaimed-funds handling", 20, 4000),
    unclaimedReviewAfterDays: z.number().int().min(1).max(36600).nullable().optional(),
  })
  .strict();
export type ProposeLiabilityPolicyInput = z.infer<typeof ProposeLiabilityPolicySchema>;

const EvidenceItemSchema = z
  .object({
    kind: z.enum(["INVESTIGATION_REPORT", "FINANCE_MEMO", "BACKUP_EXTRACT", "ORDER_DOCUMENT", "CUSTOMER_STATEMENT", "CORRESPONDENCE", "OTHER"]),
    documentSha256: sha256,
    // Where the document is stored (outside SwiftDrop) — a reference, never the document.
    reference: text("Evidence reference", 3, 500),
    description: text("Evidence description", 10, 1000),
  })
  .strict();

export const ProposeResolutionSchema = z
  .object({
    incidentId: uuid,
    policyId: uuid,
    // The surviving COLLECTION_DIFFERENCE_RECORDED audit of the deleted order.
    sourceAuditLogId: uuid,
    // The approved, valid ledger reconciliation that proves the collected
    // amount and its handover in a historical settlement — the only accepted
    // verification (a surviving COLLECTION row alone is never enough).
    ledgerReconciliationId: uuid,
    evidence: z
      .array(EvidenceItemSchema)
      .min(1, "At least one evidence document is required")
      .max(20)
      .refine((items) => new Set(items.map((i) => i.documentSha256)).size === items.length, "Evidence documents must be distinct"),
    rationale: text("Rationale", 50, 4000),
  })
  .strict();
export type ProposeResolutionInput = z.infer<typeof ProposeResolutionSchema>;

export const ApprovePolicySchema = z.object({ policyDigest: sha256, note: z.string().trim().min(1).max(2000).optional() }).strict();
export type ApprovePolicyInput = z.infer<typeof ApprovePolicySchema>;

export const ApproveResolutionSchema = z.object({ resolutionDigest: sha256, note: z.string().trim().min(1).max(2000).optional() }).strict();
export type ApproveResolutionInput = z.infer<typeof ApproveResolutionSchema>;

// Recording confirms the same fingerprint the approval bound.
export const RecordLiabilitySchema = z.object({ resolutionDigest: sha256 }).strict();
export type RecordLiabilityInput = z.infer<typeof RecordLiabilitySchema>;

export const ReasonedSchema = z.object({ reason: text("Reason", 20) }).strict();
export type ReasonedInput = z.infer<typeof ReasonedSchema>;

export const ReviewLiabilitySchema = z.object({ note: text("Review note", 20) }).strict();
export type ReviewLiabilityInput = z.infer<typeof ReviewLiabilitySchema>;

export const IdParamsSchema = z.object({ id: uuid }).strict();

export const ListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListQuery = z.infer<typeof ListQuerySchema>;
