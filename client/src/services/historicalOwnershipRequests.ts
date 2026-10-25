import type { ProposePolicyBody, ProposeResolutionBody } from './historicalOwnership.types';
import type { RequestArgs } from './historicalReconciliationRequests';

/**
 * FR.12A.11 — request builders for the historical ownership API, kept pure
 * (no RTK / env imports) so tests can assert the exact URL, method, body and
 * Idempotency-Key of every write. One key per intended action, reused
 * unchanged only for a retry of the SAME action.
 */
export const HISTORICAL_OWNERSHIP_BASE = '/finance/historical-ownership';

export type PolicyAction = 'approve' | 'reject' | 'withdraw' | 'revoke';
export type ResolutionAction = 'approve' | 'reject' | 'withdraw' | 'revoke' | 'record-liability';

export type PolicyDecisionBody = { policyDigest: string } | { reason: string };
export type ResolutionActionBody = { resolutionDigest: string } | { reason: string };

const idem = (key: string) => ({ 'Idempotency-Key': key });
const seg = encodeURIComponent;

export function proposePolicyRequest(body: ProposePolicyBody, idempotencyKey: string): RequestArgs {
  return { url: `${HISTORICAL_OWNERSHIP_BASE}/policies`, method: 'POST', body, headers: idem(idempotencyKey) };
}

export function policyDecisionRequest(id: string, action: PolicyAction, body: PolicyDecisionBody, idempotencyKey: string): RequestArgs {
  return { url: `${HISTORICAL_OWNERSHIP_BASE}/policies/${seg(id)}/${action}`, method: 'POST', body, headers: idem(idempotencyKey) };
}

export function proposeResolutionRequest(body: ProposeResolutionBody, idempotencyKey: string): RequestArgs {
  return { url: `${HISTORICAL_OWNERSHIP_BASE}/resolutions`, method: 'POST', body, headers: idem(idempotencyKey) };
}

export function resolutionActionRequest(
  id: string,
  action: ResolutionAction,
  body: ResolutionActionBody,
  idempotencyKey: string,
): RequestArgs {
  return { url: `${HISTORICAL_OWNERSHIP_BASE}/resolutions/${seg(id)}/${action}`, method: 'POST', body, headers: idem(idempotencyKey) };
}

export function reviewLiabilityRequest(liabilityId: string, note: string, idempotencyKey: string): RequestArgs {
  return { url: `${HISTORICAL_OWNERSHIP_BASE}/liabilities/${seg(liabilityId)}/reviews`, method: 'POST', body: { note }, headers: idem(idempotencyKey) };
}
