// FR.12A.11 — Ownership tab rules (pure). Run:
//   npx --prefix ../server tsx --test tests/historicalOwnershipUi.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import type { LiabilityPolicy, OwnershipDecision, OwnershipResolutionDetail } from '../src/services/historicalOwnership.types';
import {
  HISTORICAL_OWNERSHIP_BASE,
  policyDecisionRequest,
  proposeResolutionRequest,
  resolutionActionRequest,
  reviewLiabilityRequest,
} from '../src/services/historicalOwnershipRequests';
import {
  classifyOwnershipError,
  evidenceErrors,
  failureMessage,
  liabilityResolutionPresentation,
  policyActions,
  policyFormErrors,
  requiresRefresh,
  resolutionActions,
  statusPresentation,
} from '../src/pages/management/finance/historical-reconciliation/ownership/ownershipModel';

const err = (status: number | 'FETCH_ERROR', reason?: string, extra: Record<string, unknown> = {}) =>
  status === 'FETCH_ERROR'
    ? ({ status: 'FETCH_ERROR', error: 'network' } as const)
    : ({ status, data: { success: false, error: { code: status === 403 ? 'FORBIDDEN' : 'CONFLICT', message: 'Server message.', details: reason ? { reason, ...extra } : extra } } } as const);

const user = (id: string, role: string) => ({ id, name: id, role });
const decision = (d: OwnershipDecision['decision'], by: string): OwnershipDecision => ({
  id: `${d}-${by}`,
  decision: d,
  decidedBy: user(by, d === 'APPROVED' || d === 'REJECTED' ? 'FINANCE' : 'ADMIN'),
  reason: null,
  revokesDecisionId: null,
  createdAt: '2026-10-26T00:00:00.000Z',
});

const policy = (status: LiabilityPolicy['status'], decisions: OwnershipDecision[] = []): LiabilityPolicy => ({
  id: 'p1',
  policyCode: 'COMPANY_ASSUMED_HISTORICAL_LIABILITY',
  version: 1,
  outcome: 'COMPANY_ASSUMED_LIABILITY',
  title: 'Company-assumed historical liability',
  summary: 'Summary of the approved Finance policy.',
  documentSha256: 'a'.repeat(64),
  documentReference: 'vault://policy.pdf',
  reviewIntervalDays: 90,
  unclaimedFundsHandling: 'Hold until a beneficiary is evidenced.',
  unclaimedReviewAfterDays: null,
  policyDigest: 'b'.repeat(64),
  status,
  failures: [],
  proposedBy: user('admin1', 'ADMIN'),
  decisions,
  createdAt: '2026-10-26T00:00:00.000Z',
});

const resolution = (over: Partial<OwnershipResolutionDetail>): OwnershipResolutionDetail => ({
  id: 'r1',
  incidentId: 'i1',
  incidentNumber: 'LI-2026-0001',
  outcome: 'COMPANY_ASSUMED_LIABILITY',
  deletedOrderReference: '0c937fee-8ebd-4679-8113-5bad8b713f01',
  orderType: 'DELIVERY_ONLY',
  expectedAmount: '210.00',
  collectedAmount: '110.00',
  collectionDifference: '-100.00',
  heldCollectionAmount: '110.00',
  trackedShortfallAmount: '100.00',
  status: 'PROPOSED',
  failures: [],
  releasesG5: false,
  liabilityState: 'NOT_RECORDED',
  outstandingAmount: '0.00',
  policy: { id: 'p1', policyCode: 'COMPANY_ASSUMED_HISTORICAL_LIABILITY', version: 1 },
  proposedBy: user('admin1', 'ADMIN'),
  createdAt: '2026-10-26T00:00:00.000Z',
  sourceAuditLogId: 'a1',
  verification: 'APPROVED_LEDGER_RECONCILIATION',
  ledgerReconciliationId: 'rec1',
  evidenceManifestDigest: 'c'.repeat(64),
  resolutionDigest: 'd'.repeat(64),
  rationale: 'x'.repeat(60),
  evidence: [],
  decisions: [],
  liability: null,
  supersedesResolutionId: null,
  supersededByResolutionId: null,
  ...over,
});

describe('FR.12A.11 ownership UI', () => {
  test('1. every write carries its Idempotency-Key; no request carries an amount', () => {
    const body = { incidentId: 'i', policyId: 'p', sourceAuditLogId: 'a', ledgerReconciliationId: 'r', evidence: [], rationale: 'x' };
    const propose = proposeResolutionRequest(body, 'k1');
    assert.equal(propose.url, `${HISTORICAL_OWNERSHIP_BASE}/resolutions`);
    assert.equal(propose.method, 'POST');
    assert.deepEqual(propose.headers, { 'Idempotency-Key': 'k1' });
    assert.equal(/amount/i.test(JSON.stringify(propose.body)), false);
    const record = resolutionActionRequest('r/1', 'record-liability', { resolutionDigest: 'd'.repeat(64) }, 'k2');
    assert.equal(record.url, `${HISTORICAL_OWNERSHIP_BASE}/resolutions/r%2F1/record-liability`);
    assert.deepEqual(record.body, { resolutionDigest: 'd'.repeat(64) });
    assert.equal(policyDecisionRequest('p1', 'approve', { policyDigest: 'b'.repeat(64) }, 'k3').url, `${HISTORICAL_OWNERSHIP_BASE}/policies/p1/approve`);
    assert.deepEqual(reviewLiabilityRequest('l1', 'note', 'k4').body, { note: 'note' });
  });

  test('2. errors: disabled, independence, stale fingerprint, invalid evidence, ambiguous', () => {
    assert.equal(classifyOwnershipError(err(403, 'HISTORICAL_OWNERSHIP_DISABLED')).kind, 'DISABLED');
    assert.equal(classifyOwnershipError(err(403, 'RECORDER_NOT_INDEPENDENT')).kind, 'NOT_INDEPENDENT');
    assert.equal(classifyOwnershipError(err(409, 'STALE_RESOLUTION_DIGEST')).kind, 'STALE_DIGEST');
    const invalid = classifyOwnershipError(err(409, 'OWNERSHIP_EVIDENCE_INVALID', { failures: ['POLICY_NOT_APPROVED'] }));
    assert.deepEqual(invalid.kind === 'EVIDENCE_INVALID' && invalid.failures, ['POLICY_NOT_APPROVED']);
    assert.equal(requiresRefresh(invalid), true);
    assert.equal(classifyOwnershipError(err('FETCH_ERROR')).kind, 'AMBIGUOUS');
    assert.equal(classifyOwnershipError(err(503)).kind, 'AMBIGUOUS');
  });

  test('3. action hints follow separation of duties (UX only)', () => {
    const fin = { id: 'fin1', roleCode: 'FINANCE' };
    const fin2 = { id: 'fin2', roleCode: 'FINANCE' };
    const admin2 = { id: 'admin2', roleCode: 'ADMIN' };
    assert.deepEqual(policyActions(policy('PROPOSED'), fin), ['approve', 'reject']);
    assert.deepEqual(policyActions(policy('APPROVED', [decision('APPROVED', 'fin1')]), { id: 'admin1', roleCode: 'ADMIN' }), [], 'proposer cannot revoke');
    assert.deepEqual(policyActions(policy('APPROVED', [decision('APPROVED', 'fin1')]), admin2), ['revoke']);

    assert.deepEqual(resolutionActions(resolution({}), fin), ['approve', 'reject']);
    const approved = resolution({ status: 'APPROVED', decisions: [decision('APPROVED', 'fin1')] });
    assert.deepEqual(resolutionActions(approved, fin), [], 'the approver cannot record');
    assert.deepEqual(resolutionActions(approved, fin2), ['record-liability']);
    assert.deepEqual(resolutionActions({ ...approved, failures: ['COLLECTION_NOT_VERIFIED'] }, fin2), [], 'invalid evidence cannot be recorded');
    assert.deepEqual(resolutionActions(approved, admin2), ['revoke']);
    assert.deepEqual(resolutionActions(approved, { id: 'admin1', roleCode: 'ADMIN' }), [], 'the proposer cannot revoke');
  });

  test('4. form validation: evidence fingerprints and policy fields', () => {
    assert.match(evidenceErrors([]) ?? '', /at least one/);
    assert.match(evidenceErrors([{ kind: 'FINANCE_MEMO', documentSha256: 'xyz', reference: 'vault://a', description: 'A finance memo' }]) ?? '', /SHA-256/);
    const ok = { kind: 'FINANCE_MEMO' as const, documentSha256: 'a'.repeat(64), reference: 'vault://a', description: 'A finance memo' };
    assert.equal(evidenceErrors([ok]), null);
    assert.match(evidenceErrors([ok, ok]) ?? '', /distinct/);
    assert.match(
      policyFormErrors({
        policyCode: 'bad code',
        title: 'Title long enough',
        summary: 'Summary long enough for the check.',
        documentSha256: 'a'.repeat(64),
        documentReference: 'vault://p',
        unclaimedFundsHandling: 'Hold until a beneficiary is evidenced.',
      }) ?? '',
      /UPPER_SNAKE_CASE/
    );
    assert.equal(statusPresentation('INVALID_HISTORY').tone, 'danger');
  });

  test('5. ledger ownership vs liability resolution are distinct labels (review L3)', () => {
    const ref = '0c937fee-8ebd-4679-8113-5bad8b713f01';
    assert.equal(liabilityResolutionPresentation(ref, undefined).tone, 'neutral');
    assert.deepEqual(liabilityResolutionPresentation(ref, []), { label: 'No recorded liability (G5 blocking)', tone: 'warning' });
    assert.equal(liabilityResolutionPresentation(ref, [{ deletedOrderReference: ref }]).tone, 'success');
    assert.match(failureMessage('SETTLEMENT_INCLUSION_NOT_ESTABLISHED'), /settlement/);
  });
});
