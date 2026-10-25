import type {
  ProposeReconciliationBody,
  ReconciliationListParams,
} from './historicalReconciliation.types';

/**
 * FR.12A.6 — request builders for the historical reconciliation API, kept
 * pure (no RTK / env imports) so tests can assert the exact URL, method,
 * body and Idempotency-Key of every write. The RTK slice
 * (historicalReconciliationApi.ts) uses these and nothing else.
 *
 * Every write carries the caller's Idempotency-Key: one key per intended
 * action, reused unchanged for a retry of the SAME action.
 */
export const HISTORICAL_RECONCILIATION_BASE = '/finance/historical-reconciliations';

export interface RequestArgs {
  url: string;
  method?: 'GET' | 'POST';
  params?: Record<string, string | number>;
  body?: unknown;
  headers?: Record<string, string>;
}

export type ReconciliationDecisionAction = 'approve' | 'reject' | 'withdraw' | 'revoke';

export function listReconciliationsRequest(p: ReconciliationListParams): RequestArgs {
  const params: Record<string, string | number> = { page: p.page, limit: p.limit };
  if (p.status) params.status = p.status;
  if (p.incidentId) params.incidentId = p.incidentId;
  return { url: HISTORICAL_RECONCILIATION_BASE, params };
}

export function reconciliationDetailRequest(id: string): RequestArgs {
  return { url: `${HISTORICAL_RECONCILIATION_BASE}/${encodeURIComponent(id)}` };
}

export function proposeReconciliationRequest(body: ProposeReconciliationBody, idempotencyKey: string): RequestArgs {
  return {
    url: HISTORICAL_RECONCILIATION_BASE,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  };
}

export type DecisionBody = { evidenceDigest: string } | { reason: string };

export function decisionRequest(
  id: string,
  action: ReconciliationDecisionAction,
  body: DecisionBody,
  idempotencyKey: string,
): RequestArgs {
  return {
    url: `${HISTORICAL_RECONCILIATION_BASE}/${encodeURIComponent(id)}/${action}`,
    method: 'POST',
    body,
    headers: { 'Idempotency-Key': idempotencyKey },
  };
}
