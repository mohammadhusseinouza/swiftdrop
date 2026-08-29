import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { nextUtcDay, parseUtcCalendarDate } from "../../shared/date/day-boundary";
import type { ListAuditLogsQuery } from "./audit-read.schema";
import type { AuditLogEntry } from "./audit-read.types";

// ============================================================
// GET /api/v1/audit-logs (Phase 9.4)
//
// A single well-indexed table with straightforward equality/range filters —
// no raw SQL, no reversal math, no UNION pagination (unlike Phase 9.2/9.3's
// ledger reads). The three existing indexes ((actor_user_id, created_at),
// (action, created_at), (entity_type, entity_id, created_at)) already match
// every filter combination this API supports; no schema change needed.
//
// Strictly read-only: this module never calls createAuditLog (that stays in
// src/shared/audit/audit.service.ts, untouched) and viewing audit history
// must never itself produce an audit row.
// ============================================================

const auditLogSelect = {
  id: true,
  created_at: true,
  action: true,
  entity_type: true,
  entity_id: true,
  previous_values: true,
  new_values: true,
  metadata: true,
  users: { select: { id: true, first_name: true, last_name: true, email: true } },
} satisfies Prisma.audit_logsSelect;

type AuditLogRow = Prisma.audit_logsGetPayload<{ select: typeof auditLogSelect }>;

function toAuditLogEntry(row: AuditLogRow): AuditLogEntry {
  return {
    id: row.id,
    createdAt: row.created_at.toISOString(),
    // actor_user_id is nullable (system/no-longer-linked actions) — a null
    // actor is a normal, expected value here, never fabricated as a
    // "System User" row (CLAUDE.md/Phase 9.4 contract: the frontend may
    // choose to label it, the backend never invents one).
    actor: row.users
      ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name, email: row.users.email }
      : null,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    previousValues: row.previous_values,
    newValues: row.new_values,
    metadata: row.metadata,
  };
}

// `to` is inclusive as a calendar date, implemented internally as an
// EXCLUSIVE next-day UTC boundary — the same shared convention Phase 9.2/9.3
// already use (src/shared/date/day-boundary.ts), never a second date parser.
function resolveCreatedAtFilter(query: ListAuditLogsQuery): Prisma.DateTimeFilter | undefined {
  const start = query.from ? (parseUtcCalendarDate(query.from) ?? undefined) : undefined;
  const toDate = query.to ? (parseUtcCalendarDate(query.to) ?? undefined) : undefined;
  const endExclusive = toDate ? nextUtcDay(toDate) : undefined;
  if (!start && !endExclusive) return undefined;
  return { ...(start ? { gte: start } : {}), ...(endExclusive ? { lt: endExclusive } : {}) };
}

export interface ListAuditLogsResult {
  items: AuditLogEntry[];
  total: number;
}

export async function listAuditLogs(query: ListAuditLogsQuery): Promise<ListAuditLogsResult> {
  const where: Prisma.audit_logsWhereInput = {};

  // actorId is a search filter, not a User-detail lookup — a syntactically
  // valid UUID with no matching User (or no matching rows) simply yields an
  // empty result set below, never a 404.
  if (query.actorId) where.actor_user_id = query.actorId;
  if (query.action) where.action = query.action;
  if (query.entityType) where.entity_type = query.entityType;
  if (query.entityId) where.entity_id = query.entityId;

  const createdAtFilter = resolveCreatedAtFilter(query);
  if (createdAtFilter) where.created_at = createdAtFilter;

  const [total, rows] = await Promise.all([
    prisma.audit_logs.count({ where }),
    prisma.audit_logs.findMany({
      where,
      select: auditLogSelect,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
  ]);

  return { items: rows.map(toAuditLogEntry), total };
}
