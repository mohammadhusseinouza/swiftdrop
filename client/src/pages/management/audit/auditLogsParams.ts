import type { ListAuditLogsParams } from '../../../services/auditApi';

/**
 * URL state for the Audit Logs page. The live backend
 * `ListAuditLogsQuerySchema` (server/src/modules/audit) accepts exactly:
 *   page, limit, actorId (uuid — the real actor_user_id), action (≤100),
 *   entityType (≤100), entityId (≤100, NOT required to be a uuid),
 *   from, to (YYYY-MM-DD, from<=to). Every filter is optional and AND-combined.
 * Ordering is fixed `created_at DESC, id DESC` — no sort param, no search.
 * Dates are whole UTC calendar days.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface AuditLogsListState {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  from: string;
  to: string;
  page: number;
}

export const EMPTY_AUDIT_STATE: AuditLogsListState = {
  actorId: '',
  action: '',
  entityType: '',
  entityId: '',
  from: '',
  to: '',
  page: 1,
};

export function parseAuditLogsParams(sp: URLSearchParams): AuditLogsListState {
  const pageRaw = Number(sp.get('page'));
  const actorId = sp.get('actorId') ?? '';
  return {
    // actorId must be a uuid shape (the backend rejects otherwise)
    actorId: UUID_RE.test(actorId) ? actorId : '',
    // action / entityType are free strings server-side — keep any non-empty
    // value (a deep link to a novel action still filters correctly)
    action: (sp.get('action') ?? '').slice(0, 100),
    entityType: (sp.get('entityType') ?? '').slice(0, 100),
    entityId: (sp.get('entityId') ?? '').slice(0, 100),
    from: DATE_RE.test(sp.get('from') ?? '') ? (sp.get('from') as string) : '',
    to: DATE_RE.test(sp.get('to') ?? '') ? (sp.get('to') as string) : '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function serializeAuditLogsParams(
  state: AuditLogsListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.actorId) sp.set('actorId', state.actorId);
  if (state.action) sp.set('action', state.action);
  if (state.entityType) sp.set('entityType', state.entityType);
  if (state.entityId) sp.set('entityId', state.entityId);
  if (state.from) sp.set('from', state.from);
  if (state.to) sp.set('to', state.to);
  if (state.page > 1) sp.set('page', String(state.page));
  return sp;
}

export function toListAuditLogsParams(
  state: AuditLogsListState,
): ListAuditLogsParams {
  return {
    page: state.page,
    actorId: state.actorId || undefined,
    action: state.action || undefined,
    entityType: state.entityType || undefined,
    entityId: state.entityId || undefined,
    from: state.from || undefined,
    to: state.to || undefined,
  };
}

export function hasActiveAuditFilters(state: AuditLogsListState): boolean {
  return (
    state.actorId !== '' ||
    state.action !== '' ||
    state.entityType !== '' ||
    state.entityId !== '' ||
    state.from !== '' ||
    state.to !== ''
  );
}
