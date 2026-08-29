// ============================================================
// Minimal audit writer (Phase 8.3 — foundation only).
//
// No reusable general audit-writing infrastructure existed before this
// sub-phase (every prior phase in this project explicitly deferred it to
// the approved future Audit phase — CLAUDE.md §30, and Phase 9 owns the
// read-side GET /api/v1/audit-logs search API). Phase 8.3's financial
// transaction is the first sub-phase whose own task explicitly requires a
// durable audit record, so this adds ONLY the minimal transaction-client
// writer needed for that — not a general-purpose audit subsystem, not the
// Phase 9 search API.
//
// Express-independent by design, exactly like the Driver Cash/Wallet/
// Company Finance ledger primitives: accepts an already-open transaction
// client so an audit row commits atomically with the financial event it
// documents. If the insert fails for any reason, the caller's outer
// transaction rolls back along with it — an audit failure must never leave
// a financial transaction "half recorded".
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import type { audit_logs } from "../../generated/prisma/client";

export interface CreateAuditLogInput {
  actorUserId?: string;
  action: string;
  entityType: string;
  entityId: string;
  previousValues?: Prisma.InputJsonValue;
  newValues?: Prisma.InputJsonValue;
  metadata?: Prisma.InputJsonValue;
}

export async function createAuditLog(tx: Prisma.TransactionClient, input: CreateAuditLogInput): Promise<audit_logs> {
  return tx.audit_logs.create({
    data: {
      actor_user_id: input.actorUserId,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      previous_values: input.previousValues,
      new_values: input.newValues,
      metadata: input.metadata,
    },
  });
}
