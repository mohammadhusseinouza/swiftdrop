import {
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../../../services/apiError';
import type {
  EvidenceValidityFailure,
  HistoricalOwnershipStatus,
  HistoricalReconciliationStatus,
  ProposeReconciliationBody,
  ReconciliationDetail,
  ReconciliationListItem,
  ReconciliationListParams,
} from '../../../../services/historicalReconciliation.types';
import type { BadgeTone } from '../../../../components/ui/Badge';

/**
 * FR.12A.6 — the historical reconciliation UI rules, pure (testable without
 * React). They decide only what the UI OFFERS and how it explains things;
 * the backend (FR.12A.5) re-checks role, independence, status, evidence and
 * the maintenance-window flag on every request and is the final authority.
 *
 * A historical reconciliation is EVIDENCE ONLY: approving one explains a gap
 * in the driver cash ledger for gates G3 / R1. It posts no money, changes no
 * balance and NEVER resolves who owns the collected amount (G5 keeps
 * blocking). Nothing in this module computes a financial figure.
 */

/** Backend: requireRole("ADMIN", "FINANCE") on every read. */
export const HISTORICAL_RECONCILIATION_ROLES = ['ADMIN', 'FINANCE'] as const;
/** Mirrors the backend schema (meaningful text, >= 20 characters). */
export const RECONCILIATION_REASON_MIN_LENGTH = 20;
export const RECONCILIATION_PAGE_SIZE = 20;

export const EVIDENCE_ONLY_NOTICE =
  'A historical reconciliation is evidence only. Approving it explains a gap in the driver cash ledger for the activation checks (G3 / R1). It posts no money, changes no balance, and does not decide who owns the collected amount.';

export const OWNERSHIP_NOTICE =
  'A ledger reconciliation never decides ownership: its own ownership field stays UNRESOLVED permanently, whatever its status. ' +
  'Whether the deleted order is resolved for gate G5 is shown separately as its liability resolution (Ownership tab).';

/* ------------------------------ presentation ------------------------------ */

export interface Presentation {
  label: string;
  tone: BadgeTone;
  description: string;
}

const STATUS: Record<HistoricalReconciliationStatus, Presentation> = {
  PROPOSED: { label: 'Proposed', tone: 'warning', description: 'Awaiting an independent Finance review. Explains nothing yet.' },
  APPROVED: {
    label: 'Approved (evidence only)',
    tone: 'success',
    description: 'Explains the ledger gap while its evidence stays valid. Ownership is still unresolved.',
  },
  REJECTED: { label: 'Rejected', tone: 'neutral', description: 'Rejected by Finance. Explains nothing.' },
  WITHDRAWN: { label: 'Withdrawn', tone: 'neutral', description: 'Withdrawn before review. Explains nothing.' },
  REVOKED: { label: 'Revoked', tone: 'neutral', description: 'The approval was revoked. Explains nothing; the gap is unexplained again.' },
  INVALID_HISTORY: {
    label: 'Invalid history',
    tone: 'danger',
    description: 'Its decisions do not form one valid lifecycle. It explains nothing, blocks G3 / R1 and accepts no further decision.',
  },
};

export function statusPresentation(status: HistoricalReconciliationStatus): Presentation {
  return STATUS[status] ?? { label: status, tone: 'neutral', description: '' };
}

/** Ownership is never "resolved" by any reconciliation status. */
export function ownershipPresentation(status: HistoricalOwnershipStatus | string): Presentation {
  if (status === 'UNRESOLVED') {
    return { label: 'Ledger record: ownership unresolved', tone: 'danger', description: OWNERSHIP_NOTICE };
  }
  // No other value exists today; anything unknown is shown, never assumed resolved.
  return { label: `Ownership: ${status}`, tone: 'warning', description: OWNERSHIP_NOTICE };
}

export function evidencePresentation(item: Pick<ReconciliationListItem, 'evidenceValid' | 'blocking'>): Presentation {
  if (item.evidenceValid) return { label: 'Evidence valid', tone: 'success', description: 'Every V1–V7 check currently passes.' };
  if (item.blocking) {
    return { label: 'Evidence invalid — blocking', tone: 'danger', description: 'An approval whose evidence fails blocks G3 / R1.' };
  }
  return { label: 'Evidence invalid', tone: 'warning', description: 'At least one V1–V7 check currently fails.' };
}

export const FAILURE_MESSAGES: Record<EvidenceValidityFailure, string> = {
  INVALID_DECISION_HISTORY: 'The decisions do not form one valid lifecycle.',
  ACCOUNT_MISMATCH: 'The driver cash account is missing or belongs to another driver.',
  ANCHOR_NOT_FOUND: 'A surviving ledger row is missing or belongs to another account.',
  JUMP_MISMATCH: 'The ledger gap no longer equals the claimed amount.',
  ORDERING_AMBIGUOUS: 'The surviving rows share a timestamp with another row, so their order cannot be proven.',
  ROWS_INSIDE_GAP: 'A ledger row now sits inside the gap.',
  EVIDENCE_TIME_OUTSIDE_GAP: 'The audit was recorded outside the gap.',
  MISSING_TRANSACTION_PRESENT: 'The missing cash row exists again (for example after a restore).',
  SOURCE_AUDIT_MISMATCH: 'The surviving audit is missing or does not match exactly.',
  DIFFERENCE_RESOLUTION_FOUND: 'Evidence shows the collection difference was resolved.',
  DELETED_ORDER_PRESENT: 'The deleted order exists again.',
  REVIEWER_NOT_INDEPENDENT: 'The approver is the proposer.',
  EVIDENCE_DIGEST_MISMATCH: 'The approval is not bound to the stored evidence.',
  APPROVAL_AUDIT_MISSING: 'The approval has no matching workflow audit record.',
  OVERLAPPING_EXPLANATION: 'Another live reconciliation explains the same gap.',
};

export function failureMessage(code: string): string {
  return FAILURE_MESSAGES[code as EvidenceValidityFailure] ?? code;
}

export function driverLabel(d: { driverNumber: string; firstName: string; lastName: string }): string {
  return `${d.driverNumber} · ${d.firstName} ${d.lastName}`;
}

/* -------------------------------- actions -------------------------------- */

export type ReconciliationAction = 'approve' | 'reject' | 'withdraw' | 'revoke';

export type ActionState =
  | { action: ReconciliationAction; kind: 'AVAILABLE' }
  | { action: ReconciliationAction; kind: 'BLOCKED'; reason: string };

export interface ActingUser {
  id: string;
  roleCode: string;
}

/**
 * The actions this user may be OFFERED. Hidden actions are omitted; blocked
 * ones explain why. Viewing a record never implies being allowed to act.
 *   FINANCE: approve / reject a PROPOSED record — never their own proposal.
 *   ADMIN:   withdraw a PROPOSED record; revoke an APPROVED record unless
 *            they proposed or approved it.
 */
export function availableActions(detail: ReconciliationDetail, user: ActingUser | null): ActionState[] {
  if (!user) return [];
  const out: ActionState[] = [];
  if (user.roleCode === 'FINANCE' && detail.status === 'PROPOSED') {
    if (detail.proposedBy.id === user.id) {
      const reason = 'You proposed this reconciliation — it must be reviewed by someone else.';
      out.push({ action: 'approve', kind: 'BLOCKED', reason }, { action: 'reject', kind: 'BLOCKED', reason });
    } else {
      out.push(
        detail.evidenceValid
          ? { action: 'approve', kind: 'AVAILABLE' }
          : { action: 'approve', kind: 'BLOCKED', reason: 'The evidence does not currently validate — it cannot be approved.' },
        { action: 'reject', kind: 'AVAILABLE' },
      );
    }
  }
  if (user.roleCode === 'ADMIN') {
    if (detail.status === 'PROPOSED') out.push({ action: 'withdraw', kind: 'AVAILABLE' });
    if (detail.status === 'APPROVED') {
      const approver = detail.decisions.find((d) => d.decision === 'APPROVED')?.decidedBy.id;
      out.push(
        user.id === detail.proposedBy.id || user.id === approver
          ? { action: 'revoke', kind: 'BLOCKED', reason: 'A revocation must be made by an Admin who neither proposed nor approved it.' }
          : { action: 'revoke', kind: 'AVAILABLE' },
      );
    }
  }
  return out;
}

export const ACTION_LABELS: Record<ReconciliationAction, string> = {
  approve: 'Approve',
  reject: 'Reject',
  withdraw: 'Withdraw',
  revoke: 'Revoke approval',
};

export const ACTION_CONSEQUENCES: Record<Exclude<ReconciliationAction, 'approve'>, string[]> = {
  reject: [
    'The proposal becomes REJECTED and never explains the ledger gap.',
    'Nothing is posted and no balance changes. The rejection is recorded in the history and the audit log.',
    'An Admin can propose the same evidence again later; the new record supersedes this one.',
  ],
  withdraw: [
    'The proposal becomes WITHDRAWN before review and never explains the ledger gap.',
    'Nothing is posted and no balance changes. The withdrawal is recorded in the history and the audit log.',
  ],
  revoke: [
    'A REVOKED decision is appended; the original approval stays in the history.',
    'The approved amount stops contributing to the driver cash explanation: the raw discrepancy is unexplained again and gates G3 / R1 may block activation again.',
    'Nothing is posted and no balance changes. Ownership stays unresolved.',
  ],
};

/* --------------------------------- errors --------------------------------- */

export type WorkflowErrorKind =
  | { kind: 'DISABLED' }
  | { kind: 'PERMISSION'; message: string }
  | { kind: 'NOT_INDEPENDENT'; message: string }
  | { kind: 'STALE_DIGEST' }
  | { kind: 'EVIDENCE_INVALID'; failures: string[]; message: string }
  | { kind: 'STATE_CHANGED'; reason: string | null; message: string }
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'VALIDATION'; message: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'AMBIGUOUS' };

function errorDetails(error: UnknownApiError): { reason: string | null; failures: string[] } {
  const d = getApiErrorDetails(error);
  const obj = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
  return {
    reason: typeof obj.reason === 'string' ? obj.reason : null,
    failures: Array.isArray(obj.failures) ? obj.failures.filter((f): f is string => typeof f === 'string') : [],
  };
}

export function classifyWorkflowError(error: UnknownApiError): WorkflowErrorKind {
  // The request may have committed: only the SAME request may be retried.
  if (isTransportError(error)) return { kind: 'AMBIGUOUS' };
  const status = getApiErrorStatus(error);
  if (typeof status === 'number' && status >= 500) return { kind: 'AMBIGUOUS' };
  const { reason, failures } = errorDetails(error);
  const message = getApiErrorMessage(error);
  if (status === 403) {
    if (reason === 'HISTORICAL_RECONCILIATION_DISABLED') return { kind: 'DISABLED' };
    if (reason === 'REVIEWER_NOT_INDEPENDENT' || reason === 'REVOKER_NOT_INDEPENDENT') return { kind: 'NOT_INDEPENDENT', message };
    return { kind: 'PERMISSION', message: 'You do not have permission to perform this action.' };
  }
  if (status === 404) return { kind: 'NOT_FOUND' };
  if (status === 409) {
    if (reason === 'STALE_EVIDENCE_DIGEST') return { kind: 'STALE_DIGEST' };
    if (reason === 'RECONCILIATION_EVIDENCE_INVALID') return { kind: 'EVIDENCE_INVALID', failures, message };
    if (reason === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'IDEMPOTENCY_CONFLICT' };
    return { kind: 'STATE_CHANGED', reason, message };
  }
  return { kind: 'VALIDATION', message };
}

export function workflowErrorMessage(e: WorkflowErrorKind): string {
  switch (e.kind) {
    case 'DISABLED':
      return 'Historical reconciliation changes are disabled in this environment. They are enabled only during an authorized maintenance window. Nothing was changed.';
    case 'PERMISSION':
    case 'NOT_INDEPENDENT':
    case 'VALIDATION':
      return e.message;
    case 'STALE_DIGEST':
      return 'The evidence changed after you reviewed it. Nothing was approved. The evidence has been refreshed — review it again before deciding.';
    case 'EVIDENCE_INVALID':
      return `The evidence does not validate. Nothing was changed.${e.failures.length ? ` ${e.failures.map(failureMessage).join(' ')}` : ''}`;
    case 'STATE_CHANGED':
      return `${e.message} The record has been refreshed.`;
    case 'IDEMPOTENCY_CONFLICT':
      return 'This request conflicts with an earlier one that used the same request key. Close the dialog and start again.';
    case 'NOT_FOUND':
      return 'This historical reconciliation could not be found.';
    case 'AMBIGUOUS':
      return 'We could not confirm whether this was recorded. Retry the same request unchanged — the server never applies it twice — or close and check the record.';
  }
}

/** The displayed evidence can no longer be trusted as what was reviewed. */
export function requiresReReview(e: WorkflowErrorKind): boolean {
  return e.kind === 'STALE_DIGEST' || e.kind === 'EVIDENCE_INVALID' || e.kind === 'STATE_CHANGED' || e.kind === 'NOT_FOUND';
}

/* ------------------------- independent Finance review ---------------------- */

/**
 * The approval review. The fingerprint submitted is ALWAYS the one of the
 * evidence snapshot displayed when the reviewer started (or restarted) the
 * review — never one fetched just before submitting. Any evidence error ends
 * the review: the evidence is refreshed and the reviewer must inspect it and
 * acknowledge again. There is no automatic retry and no path that resubmits
 * with a different fingerprint.
 */
export type ApprovalPhase = 'reviewing' | 'needs-re-review' | 'approved' | 'stopped';

export interface ApprovalReview {
  phase: ApprovalPhase;
  /** evidenceDigest of the snapshot the reviewer is looking at. */
  reviewedDigest: string;
  acknowledged: boolean;
  /** A previous attempt may have committed — only an unchanged retry is allowed. */
  ambiguous: boolean;
}

export function startReview(snapshot: Pick<ReconciliationDetail, 'evidence'>): ApprovalReview {
  return { phase: 'reviewing', reviewedDigest: snapshot.evidence.evidenceDigest, acknowledged: false, ambiguous: false };
}

export function acknowledge(review: ApprovalReview, acknowledged: boolean): ApprovalReview {
  return review.phase === 'reviewing' && !review.ambiguous ? { ...review, acknowledged } : review;
}

/** The latest server data no longer matches what was reviewed. */
export function reviewIsStale(review: ApprovalReview, latest: Pick<ReconciliationDetail, 'evidence' | 'status'> | undefined): boolean {
  return !!latest && (latest.evidence.evidenceDigest !== review.reviewedDigest || latest.status !== 'PROPOSED');
}

export function canSubmitApproval(review: ApprovalReview, latest: Pick<ReconciliationDetail, 'evidence' | 'status'> | undefined): boolean {
  return review.phase === 'reviewing' && review.acknowledged && !reviewIsStale(review, latest);
}

/** The request body: the REVIEWED fingerprint, nothing else. */
export function approvalBody(review: ApprovalReview): { evidenceDigest: string } {
  return { evidenceDigest: review.reviewedDigest };
}

export function afterApprovalFailure(review: ApprovalReview, e: WorkflowErrorKind): ApprovalReview {
  if (e.kind === 'AMBIGUOUS') return { ...review, ambiguous: true };
  if (requiresReReview(e)) return { ...review, phase: 'needs-re-review', acknowledged: false, ambiguous: false };
  return { ...review, phase: 'stopped' };
}

export function afterApprovalSuccess(review: ApprovalReview): ApprovalReview {
  return { ...review, phase: 'approved', ambiguous: false };
}

/* ------------------------------- list params ------------------------------ */

export const STATUS_FILTER_OPTIONS: { value: HistoricalReconciliationStatus; label: string }[] = (
  ['PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'REVOKED', 'INVALID_HISTORY'] as const
).map((value) => ({ value, label: STATUS[value].label }));

const STATUSES = new Set<string>(STATUS_FILTER_OPTIONS.map((o) => o.value));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseListParams(sp: URLSearchParams): ReconciliationListParams {
  const status = sp.get('status') ?? '';
  const incidentId = sp.get('incidentId') ?? '';
  const page = Number.parseInt(sp.get('page') ?? '1', 10);
  return {
    status: STATUSES.has(status) ? (status as HistoricalReconciliationStatus) : undefined,
    incidentId: UUID.test(incidentId) ? incidentId : undefined,
    page: Number.isFinite(page) && page >= 1 ? page : 1,
    limit: RECONCILIATION_PAGE_SIZE,
  };
}

export function serializeListParams(p: ReconciliationListParams): URLSearchParams {
  const sp = new URLSearchParams();
  if (p.status) sp.set('status', p.status);
  if (p.incidentId) sp.set('incidentId', p.incidentId);
  if (p.page > 1) sp.set('page', String(p.page));
  return sp;
}

/* ------------------------- responsive list layout ------------------------- */

/** Table columns from md up (mobile shows cards). Secondary figures collapse first. */
export const LIST_COLUMN_LAYOUT: { id: string; hideBelow?: 'lg' | 'xl' }[] = [
  { id: 'incident' },
  { id: 'driver' },
  { id: 'amount' },
  { id: 'rawDiscrepancy', hideBelow: 'xl' },
  { id: 'approved', hideBelow: 'xl' },
  { id: 'residual' },
  { id: 'status' },
  { id: 'ownership', hideBelow: 'lg' },
  { id: 'liability', hideBelow: 'lg' },
  { id: 'evidence', hideBelow: 'lg' },
  { id: 'proposed', hideBelow: 'xl' },
];

/* --------------------------------- reasons -------------------------------- */

export function reasonError(reason: string): string | null {
  return reason.trim().length < RECONCILIATION_REASON_MIN_LENGTH
    ? `Explain the decision (at least ${RECONCILIATION_REASON_MIN_LENGTH} characters).`
    : null;
}

/* ------------------------------ proposal form ----------------------------- */

/**
 * Only what the server accepts. There is deliberately NO amount, driver,
 * order, fingerprint or ownership field: the server derives the evidence from
 * the cited ledger row and audit, and refuses any extra field.
 */
export interface ProposalForm {
  incidentMode: 'new' | 'existing';
  incidentId: string;
  summary: string;
  /** datetime-local value (the operator's local time). */
  discoveredAt: string;
  occurredNotBefore: string;
  occurredNotAfter: string;
  missingRecords: { table: string; value: string }[];
  remainingUncertainties: string;
  evidenceQueries: string;
  evidenceNotes: string;
  anchorTransactionId: string;
  sourceAuditLogId: string;
  relatedSettlementId: string;
  reason: string;
}

export const EMPTY_PROPOSAL_FORM: ProposalForm = {
  incidentMode: 'new',
  incidentId: '',
  summary: '',
  discoveredAt: '',
  occurredNotBefore: '',
  occurredNotAfter: '',
  missingRecords: [
    { table: 'orders', value: '1' },
    { table: 'driver_cash_transactions', value: '1' },
  ],
  remainingUncertainties: '',
  evidenceQueries: '',
  evidenceNotes: '',
  anchorTransactionId: '',
  sourceAuditLogId: '',
  relatedSettlementId: '',
  reason: '',
};

const TABLE = /^[a-z_]{1,63}$/;
const COUNT = /^(0|[1-9][0-9]{0,8})$/;

function toIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export type ProposalErrors = Partial<Record<keyof ProposalForm, string>>;

export function validateProposal(f: ProposalForm): ProposalErrors {
  const e: ProposalErrors = {};
  if (!UUID.test(f.anchorTransactionId.trim())) e.anchorTransactionId = 'Enter the ledger row id (UUID) of the first surviving row after the gap.';
  if (!UUID.test(f.sourceAuditLogId.trim())) e.sourceAuditLogId = 'Enter the audit id (UUID) of the surviving collection-difference audit.';
  if (f.relatedSettlementId.trim() && !UUID.test(f.relatedSettlementId.trim())) e.relatedSettlementId = 'Enter a settlement id (UUID) or leave it empty.';
  if (f.reason.trim().length < RECONCILIATION_REASON_MIN_LENGTH) e.reason = `At least ${RECONCILIATION_REASON_MIN_LENGTH} characters.`;
  if (f.incidentMode === 'existing') {
    if (!UUID.test(f.incidentId.trim())) e.incidentId = 'Choose an existing incident.';
    return e;
  }
  if (f.summary.trim().length < 20) e.summary = 'At least 20 characters. Do not include customer details.';
  if (!toIso(f.discoveredAt)) e.discoveredAt = 'Enter when the incident was discovered.';
  const before = toIso(f.occurredNotBefore);
  const after = toIso(f.occurredNotAfter);
  if (f.occurredNotBefore && !before) e.occurredNotBefore = 'Enter a valid date and time.';
  if (f.occurredNotAfter && !after) e.occurredNotAfter = 'Enter a valid date and time.';
  if (before && after && before > after) e.occurredNotAfter = 'Must be on or after "occurred not before".';
  const rows = f.missingRecords.filter((r) => r.table.trim() || r.value.trim());
  if (rows.length === 0) e.missingRecords = 'Name at least one table with missing records.';
  else if (rows.some((r) => !TABLE.test(r.table.trim()) || !(r.value.trim() === 'unknown' || COUNT.test(r.value.trim())))) {
    e.missingRecords = 'Use lowercase table names and a whole number or "unknown" for each.';
  } else if (new Set(rows.map((r) => r.table.trim())).size !== rows.length) e.missingRecords = 'Each table may appear once.';
  if (!f.remainingUncertainties.trim()) e.remainingUncertainties = 'Describe what is still unknown.';
  return e;
}

export function buildProposalBody(f: ProposalForm): ProposeReconciliationBody {
  const base = {
    anchorTransactionId: f.anchorTransactionId.trim(),
    sourceAuditLogId: f.sourceAuditLogId.trim(),
    ...(f.relatedSettlementId.trim() ? { relatedSettlementId: f.relatedSettlementId.trim() } : {}),
    reason: f.reason.trim(),
  };
  if (f.incidentMode === 'existing') return { incidentId: f.incidentId.trim(), ...base };
  const missingRecords: Record<string, number | 'unknown'> = {};
  for (const r of f.missingRecords) {
    if (!r.table.trim()) continue;
    missingRecords[r.table.trim()] = r.value.trim() === 'unknown' ? 'unknown' : Number(r.value.trim());
  }
  const queries = f.evidenceQueries
    .split(/[,\n]/)
    .map((q) => q.trim())
    .filter(Boolean);
  return {
    incident: {
      summary: f.summary.trim(),
      discoveredAt: toIso(f.discoveredAt) as string,
      occurredNotBefore: toIso(f.occurredNotBefore),
      occurredNotAfter: toIso(f.occurredNotAfter),
      missingRecords,
      remainingUncertainties: f.remainingUncertainties.trim(),
      evidence: { ...(queries.length ? { queries } : {}), ...(f.evidenceNotes.trim() ? { notes: f.evidenceNotes.trim() } : {}) },
    },
    ...base,
  };
}
