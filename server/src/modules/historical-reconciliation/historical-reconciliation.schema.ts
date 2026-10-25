import { z } from "zod";

// ============================================================
// FR.12A.5 — request schemas for the historical reconciliation workflow.
//
// The client never supplies an amount, a balance, an order, a missing row or
// a digest it has not reviewed: every evidence field is derived on the server
// from PostgreSQL (historical-reconciliation-workflow.service.ts). The client
// names only the surviving anchor row and the surviving audit, explains why,
// and — to approve — confirms the exact evidence fingerprint it reviewed.
// ============================================================

const uuid = z.string().uuid();
// Matches the database CHECKs (>= 20 meaningful characters).
const meaningfulText = (label: string) =>
  z.string().trim().min(20, `${label} must be at least 20 characters`).max(2000, `${label} is too long`);

const IncidentSchema = z
  .object({
    summary: meaningfulText("Incident summary"),
    discoveredAt: z.string().datetime({ offset: true }),
    occurredNotBefore: z.string().datetime({ offset: true }).nullable().optional(),
    occurredNotAfter: z.string().datetime({ offset: true }).nullable().optional(),
    // Per table: a count or "unknown". Counts and table names only — no records.
    missingRecords: z
      .record(z.string().regex(/^[a-z_]{1,63}$/), z.union([z.number().int().min(0), z.literal("unknown")]))
      .refine((r) => Object.keys(r).length > 0, "missingRecords must name at least one table"),
    remainingUncertainties: z.string().trim().min(1).max(4000),
    // Query ids, run timestamps, result digests, reviewer — investigation metadata, no PII.
    evidence: z.record(z.string().max(100), z.unknown()),
  })
  .strict()
  .refine(
    (i) => !i.occurredNotBefore || !i.occurredNotAfter || new Date(i.occurredNotBefore) <= new Date(i.occurredNotAfter),
    { message: "occurredNotBefore must be on or before occurredNotAfter", path: ["occurredNotAfter"] }
  );

export const ProposeHistoricalReconciliationSchema = z
  .object({
    // Exactly one of: an existing incident, or a new incident recorded atomically.
    incidentId: uuid.optional(),
    incident: IncidentSchema.optional(),
    // The first surviving ledger row AFTER the gap.
    anchorTransactionId: uuid,
    // The surviving COLLECTION_DIFFERENCE_RECORDED audit naming the missing row.
    sourceAuditLogId: uuid,
    // Only needed when the anchor is not itself the settlement's cash row.
    relatedSettlementId: uuid.nullable().optional(),
    reason: meaningfulText("Reason"),
  })
  .strict()
  .refine((b) => (b.incidentId === undefined) !== (b.incident === undefined), {
    message: "Provide exactly one of incidentId or incident",
    path: ["incident"],
  });
export type ProposeHistoricalReconciliationInput = z.infer<typeof ProposeHistoricalReconciliationSchema>;

export const ApproveHistoricalReconciliationSchema = z
  .object({
    // The fingerprint the reviewer actually reviewed (GET detail -> evidenceDigest).
    evidenceDigest: z.string().regex(/^[0-9a-f]{64}$/, "evidenceDigest must be 64 lowercase hex characters"),
    note: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();
export type ApproveHistoricalReconciliationInput = z.infer<typeof ApproveHistoricalReconciliationSchema>;

export const ReasonedDecisionSchema = z.object({ reason: meaningfulText("Reason") }).strict();
export type ReasonedDecisionInput = z.infer<typeof ReasonedDecisionSchema>;

export const ReconciliationIdParamsSchema = z.object({ id: uuid }).strict();

export const ListHistoricalReconciliationsQuerySchema = z
  .object({
    status: z.enum(["PROPOSED", "APPROVED", "REJECTED", "WITHDRAWN", "REVOKED", "INVALID_HISTORY"]).optional(),
    driverId: uuid.optional(),
    incidentId: uuid.optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListHistoricalReconciliationsQuery = z.infer<typeof ListHistoricalReconciliationsQuerySchema>;

export const ListIncidentsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
export type ListIncidentsQuery = z.infer<typeof ListIncidentsQuerySchema>;
