import {
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../../../../services/apiError';
import type {
  HistoricalLiabilityState,
  HistoricalOwnershipStatus,
  LiabilityPolicy,
  OwnershipEvidenceInput,
  OwnershipResolutionDetail,
  ProposePolicyBody,
} from '../../../../../services/historicalOwnership.types';
import type { BadgeTone } from '../../../../../components/ui/Badge';

/**
 * FR.12A.11 — pure presentation / validation helpers for the Ownership tab.
 * Everything here is UX only: the server re-checks roles, independence,
 * evidence and every amount.
 */

export const NO_POSTING_NOTICE =
  'Recording a historical liability posts nothing: no customer credit, driver cash movement, payout, settlement or revenue is created. ' +
  'The full verified collected amount is held as a liability to an unidentified beneficiary; the shortfall is tracked separately and never recognized.';

export const G5_NOTICE =
  'An approved resolution alone never clears activation gate G5. G5 treats a deleted order as resolved only once its approved liability is recorded and every check still holds.';

export const EVIDENCE_KIND_OPTIONS: { value: OwnershipEvidenceInput['kind']; label: string }[] = [
  { value: 'INVESTIGATION_REPORT', label: 'Investigation report' },
  { value: 'FINANCE_MEMO', label: 'Finance memo' },
  { value: 'BACKUP_EXTRACT', label: 'Backup extract' },
  { value: 'ORDER_DOCUMENT', label: 'Order document' },
  { value: 'CUSTOMER_STATEMENT', label: 'Customer statement' },
  { value: 'CORRESPONDENCE', label: 'Correspondence' },
  { value: 'OTHER', label: 'Other' },
];

export function statusPresentation(status: HistoricalOwnershipStatus): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'PROPOSED':
      return { label: 'Awaiting review', tone: 'info' };
    case 'APPROVED':
      return { label: 'Approved', tone: 'success' };
    case 'REJECTED':
      return { label: 'Rejected', tone: 'neutral' };
    case 'WITHDRAWN':
      return { label: 'Withdrawn', tone: 'neutral' };
    case 'REVOKED':
      return { label: 'Revoked', tone: 'warning' };
    case 'INVALID_HISTORY':
      return { label: 'Invalid history', tone: 'danger' };
  }
}

export function liabilityStatePresentation(state: HistoricalLiabilityState): { label: string; tone: BadgeTone } {
  switch (state) {
    case 'NOT_RECORDED':
      return { label: 'Not recorded', tone: 'neutral' };
    case 'OUTSTANDING':
      return { label: 'Outstanding liability', tone: 'warning' };
    case 'REVOKED':
      return { label: 'Revoked', tone: 'neutral' };
  }
}

const FAILURE_TEXT: Record<string, string> = {
  INVALID_DECISION_HISTORY: 'The decision history is inconsistent.',
  SOURCE_AUDIT_MISMATCH: 'The surviving collection-difference audit no longer matches.',
  DELETED_ORDER_PRESENT: 'The order exists again — use the normal collection-difference resolution.',
  DIFFERENCE_RESOLUTION_FOUND: 'The difference was resolved through the normal order path.',
  COLLECTION_NOT_VERIFIED: 'The collected amount is no longer verified by a valid approved ledger reconciliation.',
  SETTLEMENT_INCLUSION_NOT_ESTABLISHED:
    'The ledger reconciliation does not establish that the collected amount was handed over in a historical settlement (its anchor must be the settlement that handed over the whole balance).',
  POLICY_NOT_APPROVED: 'The cited policy version is not approved (or was revoked).',
  POLICY_CONTENT_MISMATCH: 'The policy text no longer matches its fingerprint.',
  EVIDENCE_MANIFEST_MISMATCH: 'The evidence documents no longer match their fingerprint.',
  RATIONALE_DIGEST_MISMATCH: 'The rationale no longer matches its fingerprint.',
  REVIEWER_NOT_INDEPENDENT: 'The approver is the proposer.',
  RESOLUTION_DIGEST_MISMATCH: 'The approval is not bound to this exact resolution.',
  APPROVAL_AUDIT_MISSING: 'The approval has no matching audit record.',
  CONFLICTING_RESOLUTION: 'Another live resolution exists for the same deleted order.',
  LIABILITY_AMOUNT_MISMATCH: 'The recorded liability amounts differ from the approved resolution.',
  LIABILITY_RECORDED_BEFORE_APPROVAL: 'The liability predates its approval.',
  LIABILITY_AUDIT_MISSING: 'The recorded liability has no matching audit record.',
  UNEXPECTED_LEDGER_POSTING: 'A ledger row uses this liability’s reserved key — recording must post nothing.',
  INCIDENT_MISMATCH: 'The ledger reconciliation belongs to a different incident.',
};

export function failureMessage(code: string): string {
  return FAILURE_TEXT[code] ?? code;
}

export type OwnershipErrorKind =
  | { kind: 'DISABLED' }
  | { kind: 'PERMISSION'; message: string }
  | { kind: 'NOT_INDEPENDENT'; message: string }
  | { kind: 'STALE_DIGEST' }
  | { kind: 'EVIDENCE_INVALID'; failures: string[]; message: string }
  | { kind: 'STATE_CHANGED'; message: string }
  | { kind: 'IDEMPOTENCY_CONFLICT' }
  | { kind: 'VALIDATION'; message: string }
  | { kind: 'NOT_FOUND' }
  | { kind: 'AMBIGUOUS' };

function details(error: UnknownApiError): { reason: string | null; failures: string[] } {
  const d = getApiErrorDetails(error);
  const obj = d && typeof d === 'object' ? (d as Record<string, unknown>) : {};
  return {
    reason: typeof obj.reason === 'string' ? obj.reason : null,
    failures: Array.isArray(obj.failures) ? obj.failures.filter((f): f is string => typeof f === 'string') : [],
  };
}

export function classifyOwnershipError(error: UnknownApiError): OwnershipErrorKind {
  // The request may have committed: only the SAME request may be retried.
  if (isTransportError(error)) return { kind: 'AMBIGUOUS' };
  const status = getApiErrorStatus(error);
  if (typeof status === 'number' && status >= 500) return { kind: 'AMBIGUOUS' };
  const { reason, failures } = details(error);
  const message = getApiErrorMessage(error);
  if (status === 403) {
    if (reason === 'HISTORICAL_OWNERSHIP_DISABLED') return { kind: 'DISABLED' };
    if (reason === 'REVIEWER_NOT_INDEPENDENT' || reason === 'REVOKER_NOT_INDEPENDENT' || reason === 'RECORDER_NOT_INDEPENDENT') {
      return { kind: 'NOT_INDEPENDENT', message };
    }
    return { kind: 'PERMISSION', message: 'You do not have permission to perform this action.' };
  }
  if (status === 404) return { kind: 'NOT_FOUND' };
  if (status === 409) {
    if (reason === 'STALE_RESOLUTION_DIGEST' || reason === 'STALE_POLICY_DIGEST') return { kind: 'STALE_DIGEST' };
    if (reason === 'OWNERSHIP_EVIDENCE_INVALID') return { kind: 'EVIDENCE_INVALID', failures, message };
    if (reason === 'IDEMPOTENCY_KEY_REUSED') return { kind: 'IDEMPOTENCY_CONFLICT' };
    return { kind: 'STATE_CHANGED', message };
  }
  return { kind: 'VALIDATION', message };
}

export function ownershipErrorMessage(e: OwnershipErrorKind): string {
  switch (e.kind) {
    case 'DISABLED':
      return 'Historical ownership changes are disabled in this environment. They are enabled only during an authorized window. Nothing was changed.';
    case 'PERMISSION':
    case 'NOT_INDEPENDENT':
    case 'VALIDATION':
      return e.message;
    case 'STALE_DIGEST':
      return 'The record changed after you reviewed it. Nothing was changed. It has been refreshed — review it again.';
    case 'EVIDENCE_INVALID':
      return `The evidence does not validate. Nothing was changed.${e.failures.length ? ` ${e.failures.map(failureMessage).join(' ')}` : ''}`;
    case 'STATE_CHANGED':
      return `${e.message} The record has been refreshed.`;
    case 'IDEMPOTENCY_CONFLICT':
      return 'This request conflicts with an earlier one that used the same request key. Close the dialog and start again.';
    case 'NOT_FOUND':
      return 'This record could not be found.';
    case 'AMBIGUOUS':
      return 'We could not confirm whether this was recorded. Retry the same request unchanged — the server never applies it twice — or close and check the record.';
  }
}

export function requiresRefresh(e: OwnershipErrorKind): boolean {
  return e.kind === 'STALE_DIGEST' || e.kind === 'EVIDENCE_INVALID' || e.kind === 'STATE_CHANGED' || e.kind === 'NOT_FOUND';
}

/* ------------------------------- available actions ------------------------------ */

export type PolicyUiAction = 'approve' | 'reject' | 'withdraw' | 'revoke';

/** UX hints only — the server enforces roles and independence. */
export function policyActions(policy: LiabilityPolicy, user: { id: string; roleCode: string } | null): PolicyUiAction[] {
  if (!user) return [];
  const approval = policy.decisions.find((d) => d.decision === 'APPROVED');
  const isProposer = policy.proposedBy.id === user.id;
  if (policy.status === 'PROPOSED') {
    if (user.roleCode === 'FINANCE' && !isProposer) return ['approve', 'reject'];
    if (user.roleCode === 'ADMIN') return ['withdraw'];
  }
  if (policy.status === 'APPROVED' && user.roleCode === 'ADMIN' && !isProposer && approval?.decidedBy.id !== user.id) return ['revoke'];
  return [];
}

export type ResolutionUiAction = 'approve' | 'reject' | 'withdraw' | 'revoke' | 'record-liability' | 'review';

export function resolutionActions(r: OwnershipResolutionDetail, user: { id: string; roleCode: string } | null): ResolutionUiAction[] {
  if (!user) return [];
  const approval = r.decisions.find((d) => d.decision === 'APPROVED');
  const isProposer = r.proposedBy.id === user.id;
  const isApprover = approval?.decidedBy.id === user.id;
  const isRecorder = r.liability?.recordedBy.id === user.id;
  const actions: ResolutionUiAction[] = [];
  if (r.status === 'PROPOSED') {
    if (user.roleCode === 'FINANCE' && !isProposer) actions.push('approve', 'reject');
    if (user.roleCode === 'ADMIN') actions.push('withdraw');
  }
  if (r.status === 'APPROVED') {
    if (user.roleCode === 'FINANCE' && !r.liability && r.failures.length === 0 && !isProposer && !isApprover) actions.push('record-liability');
    if (user.roleCode === 'FINANCE' && r.liabilityState === 'OUTSTANDING') actions.push('review');
    if (user.roleCode === 'ADMIN' && !isProposer && !isApprover && !isRecorder) actions.push('revoke');
  }
  return actions;
}

/* ---------------------------------- validation ---------------------------------- */

export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const REASON_MIN_LENGTH = 20;
export const RATIONALE_MIN_LENGTH = 50;

export function reasonError(reason: string, min = REASON_MIN_LENGTH): string | null {
  return reason.trim().length >= min ? null : `Enter at least ${min} characters.`;
}

export function evidenceErrors(items: OwnershipEvidenceInput[]): string | null {
  if (items.length === 0) return 'Add at least one evidence document.';
  for (const [i, e] of items.entries()) {
    if (!SHA256_PATTERN.test(e.documentSha256.trim())) return `Evidence ${i + 1}: the SHA-256 must be 64 lowercase hex characters.`;
    if (e.reference.trim().length < 3) return `Evidence ${i + 1}: enter where the document is stored.`;
    if (e.description.trim().length < 10) return `Evidence ${i + 1}: describe the document (at least 10 characters).`;
  }
  const hashes = items.map((e) => e.documentSha256.trim());
  if (new Set(hashes).size !== hashes.length) return 'Each evidence document must be distinct.';
  return null;
}

export function policyFormErrors(p: ProposePolicyBody): string | null {
  if (!/^[A-Z][A-Z0-9_]{2,59}$/.test(p.policyCode)) return 'Policy code must be UPPER_SNAKE_CASE (3–60 characters).';
  if (p.title.trim().length < 10) return 'Title must be at least 10 characters.';
  if (p.summary.trim().length < 20) return 'Summary must be at least 20 characters.';
  if (!SHA256_PATTERN.test(p.documentSha256)) return 'Document SHA-256 must be 64 lowercase hex characters.';
  if (p.documentReference.trim().length < 3) return 'Enter where the policy document is stored.';
  if (p.unclaimedFundsHandling.trim().length < 20) return 'Describe the unclaimed-funds handling (at least 20 characters).';
  return null;
}

/**
 * Review L3 — the liability resolution of a deleted order, shown next to (never
 * instead of) a ledger reconciliation's own ownership field. `dispositions` are
 * the deleted orders G5 currently treats as resolved by a recorded liability.
 */
export function liabilityResolutionPresentation(
  deletedOrderReference: string,
  dispositions: readonly { deletedOrderReference: string }[] | undefined,
): { label: string; tone: BadgeTone } {
  if (!dispositions) return { label: 'Liability resolution: loading', tone: 'neutral' };
  return dispositions.some((d) => d.deletedOrderReference === deletedOrderReference)
    ? { label: 'Resolved by recorded liability', tone: 'success' }
    : { label: 'No recorded liability (G5 blocking)', tone: 'warning' };
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}
