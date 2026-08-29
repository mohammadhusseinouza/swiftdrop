// ============================================================
// GET /api/v1/audit-logs (Phase 9.4) — response DTO.
//
// Deliberately widens the actor summary to include `email` (unlike every
// other actor/processedBy summary in the codebase, e.g. payout.service.ts's
// toPayoutSummary, which use {id, firstName, lastName} only) — audit review
// is a more privileged, more identifying context, and the approved contract
// explicitly asks for it here. This is not a signal to add email elsewhere.
// ============================================================

export interface AuditActorRef {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
}

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actor: AuditActorRef | null;
  action: string;
  entityType: string;
  entityId: string;
  // previous_values/new_values/metadata are returned as the JSON they
  // actually are (never stringified) — the future Audit Logs UI formats
  // structured JSON itself. `unknown` because audit metadata shape varies
  // per action; every production producer was reviewed for sensitive-key
  // leakage (see audit-read.service.ts) rather than sanitized generically.
  previousValues: unknown | null;
  newValues: unknown | null;
  metadata: unknown | null;
}
