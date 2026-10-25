// FR.12A.6 — Historical reconciliation Management UI rules (pure; same
// lightweight approach as fr102Corrections.test.ts). Run:
//   npx --prefix ../server tsx --test tests/historicalReconciliationUi.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PERMISSIONS } from '../src/features/auth/permissions';
import { buildManagementNavigation, getActiveManagementNavId } from '../src/features/navigation/managementNavigation';
import { getManagementRouteTitle } from '../src/features/navigation/routeTitle';
import { decideRole } from '../src/routes/guards/decisions';
import { paths } from '../src/routes/paths';
import type { ReconciliationDetail, ReconciliationDecision } from '../src/services/historicalReconciliation.types';
import {
  HISTORICAL_RECONCILIATION_BASE,
  decisionRequest,
  listReconciliationsRequest,
  proposeReconciliationRequest,
  reconciliationDetailRequest,
} from '../src/services/historicalReconciliationRequests';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  resolveIdempotencyKey,
} from '../src/pages/management/settlements/settlementSubmission';
import {
  ACTION_CONSEQUENCES,
  EMPTY_PROPOSAL_FORM,
  HISTORICAL_RECONCILIATION_ROLES,
  LIST_COLUMN_LAYOUT,
  RECONCILIATION_REASON_MIN_LENGTH,
  acknowledge,
  afterApprovalFailure,
  afterApprovalSuccess,
  approvalBody,
  availableActions,
  buildProposalBody,
  canSubmitApproval,
  classifyWorkflowError,
  evidencePresentation,
  failureMessage,
  ownershipPresentation,
  parseListParams,
  reasonError,
  requiresReReview,
  reviewIsStale,
  serializeListParams,
  startReview,
  statusPresentation,
  validateProposal,
  workflowErrorMessage,
  type ProposalForm,
} from '../src/pages/management/finance/historical-reconciliation/historicalReconciliationModel';

/* -------------------------------- fixtures -------------------------------- */

const PROPOSER = 'aaaaaaaa-0000-4000-8000-000000000001';
const APPROVER = 'aaaaaaaa-0000-4000-8000-000000000002';
const OTHER_ADMIN = 'aaaaaaaa-0000-4000-8000-000000000003';
const OTHER_FINANCE = 'aaaaaaaa-0000-4000-8000-000000000004';
const ID = 'bbbbbbbb-0000-4000-8000-000000000001';
const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const actor = (id: string) => ({ id, firstName: 'Test', lastName: id.slice(-1) });

function detail(overrides: Partial<ReconciliationDetail> = {}, decisions: ReconciliationDecision[] = []): ReconciliationDetail {
  return {
    reconciliationId: ID,
    status: 'PROPOSED',
    evidenceValid: true,
    failures: [],
    contributes: false,
    blocking: false,
    incident: { id: 'cccccccc-0000-4000-8000-000000000001', incidentNumber: 'LI-2026-0001', cause: 'MANUAL_DATABASE_DELETION' },
    evidence: {
      kind: 'MISSING_COLLECTION',
      accountingTreatment: 'EVIDENCE_ONLY_NO_CASH_EFFECT',
      accountId: 'dddddddd-0000-4000-8000-000000000001',
      driverId: 'eeeeeeee-0000-4000-8000-000000000001',
      amount: '110.00',
      observedJump: '110.00',
      predecessorTransactionId: 'ffffffff-0000-4000-8000-000000000001',
      anchorTransactionId: 'ffffffff-0000-4000-8000-000000000002',
      missingTransactionId: 'ffffffff-0000-4000-8000-000000000003',
      sourceAuditLogId: 'ffffffff-0000-4000-8000-000000000004',
      deletedOrderReference: 'ffffffff-0000-4000-8000-000000000005',
      orderType: 'DELIVERY_ONLY',
      expectedAmount: '210.00',
      actualAmount: '110.00',
      collectionDifference: '-100.00',
      relatedSettlementId: 'ffffffff-0000-4000-8000-000000000006',
      evidenceDigest: DIGEST_A,
    },
    evidenceContext: { predecessorTransaction: null, anchorTransaction: null, sourceAudit: null, relatedSettlement: null },
    driver: { id: 'eeeeeeee-0000-4000-8000-000000000001', driverNumber: 'DRV-000001', firstName: 'D', lastName: 'One' },
    reason: 'Explains the documented ledger gap.',
    proposedBy: actor(PROPOSER),
    proposedAt: '2026-10-25T10:00:00.000Z',
    supersedesReconciliationId: null,
    decisions,
    account: {
      accountId: 'dddddddd-0000-4000-8000-000000000001',
      driverId: 'eeeeeeee-0000-4000-8000-000000000001',
      storedBalance: '0.00',
      rawLedgerNet: '-110.00',
      rawDiscrepancy: '110.00',
      approvedHistoricalAmount: '0.00',
      unexplainedResidual: '110.00',
      invalidApprovedCount: 0,
      reconciliationCount: 1,
      latestBalanceMatches: true,
    },
    ownership: { status: 'UNRESOLVED', blocksActivation: true },
    ...overrides,
  };
}
const approval: ReconciliationDecision = { id: 'd1', decision: 'APPROVED', decidedBy: actor(APPROVER), reason: null, revokesDecisionId: null, decidedAt: '2026-10-25T11:00:00.000Z' };
const approved = () => detail({ status: 'APPROVED', contributes: true }, [approval]);

/** An RTK Query-shaped error. */
const err = (status: number | 'FETCH_ERROR', reason?: string, extra: Record<string, unknown> = {}) =>
  status === 'FETCH_ERROR'
    ? ({ status: 'FETCH_ERROR', error: 'network' } as const)
    : ({ status, data: { success: false, error: { code: status === 403 ? 'FORBIDDEN' : 'CONFLICT', message: 'Server message.', details: reason ? { reason, ...extra } : extra } } } as const);

/* ---------------------------------- tests --------------------------------- */

describe('FR.12A.6 historical reconciliation UI', () => {
  test('1. navigation: the role-scoped item shows for ADMIN and FINANCE only, under Finance', () => {
    const all = Object.values(PERMISSIONS);
    const ids = (role: string) => buildManagementNavigation(all, role).flatMap((g) => g.items.map((i) => i.id));
    assert.ok(ids('ADMIN').includes('historical-reconciliations'));
    assert.ok(ids('FINANCE').includes('historical-reconciliations'));
    // Even with every permission (finance.read is grantable), Dispatcher never sees it.
    assert.ok(!ids('DISPATCHER').includes('historical-reconciliations'));
    const finance = buildManagementNavigation(all, 'FINANCE').find((g) => g.id === 'finance')!;
    assert.ok(finance.items.some((i) => i.id === 'historical-reconciliations' && i.indent));
    assert.equal(getActiveManagementNavId(paths.management.historicalReconciliationDetail(ID)), 'historical-reconciliations');
    assert.equal(getActiveManagementNavId(paths.management.finance), 'finance');
    assert.equal(getManagementRouteTitle(paths.management.historicalReconciliations), 'Ledger Reconciliation');
    assert.equal(getManagementRouteTitle(paths.management.historicalReconciliationDetail(ID)), 'Historical Reconciliation');
  });

  test('2-3. route guard: ADMIN and FINANCE read; every other role is refused', () => {
    assert.deepEqual([...HISTORICAL_RECONCILIATION_ROLES], ['ADMIN', 'FINANCE']);
    for (const role of ['ADMIN', 'FINANCE']) assert.equal(decideRole(role, HISTORICAL_RECONCILIATION_ROLES).kind, 'allow');
    for (const role of ['DISPATCHER', 'DRIVER', 'CUSTOMER', undefined]) assert.equal(decideRole(role, HISTORICAL_RECONCILIATION_ROLES).kind, 'unauthorized');
    // Never reachable from the Driver / Customer portals or public tracking.
    for (const p of [...Object.values(paths.driver), ...Object.values(paths.customer), paths.public.track]) {
      assert.ok(typeof p !== 'string' || !p.includes('historical'), String(p));
    }
  });

  test('4. list filters and pagination are server parameters, round-tripped through the URL', () => {
    const p = parseListParams(new URLSearchParams('status=APPROVED&incidentId=cccccccc-0000-4000-8000-000000000001&page=3'));
    assert.deepEqual(p, { status: 'APPROVED', incidentId: 'cccccccc-0000-4000-8000-000000000001', page: 3, limit: 20 });
    assert.equal(serializeListParams(p).toString(), 'status=APPROVED&incidentId=cccccccc-0000-4000-8000-000000000001&page=3');
    assert.deepEqual(parseListParams(new URLSearchParams('status=BOGUS&incidentId=x&page=-2')), { status: undefined, incidentId: undefined, page: 1, limit: 20 });
    assert.deepEqual(listReconciliationsRequest(p), {
      url: HISTORICAL_RECONCILIATION_BASE,
      params: { page: 3, limit: 20, status: 'APPROVED', incidentId: 'cccccccc-0000-4000-8000-000000000001' },
    });
  });

  test('5-6. detail presentation: statuses, evidence validity and failure explanations', () => {
    assert.equal(statusPresentation('APPROVED').label, 'Approved (evidence only)');
    assert.equal(statusPresentation('INVALID_HISTORY').tone, 'danger');
    assert.equal(evidencePresentation({ evidenceValid: true, blocking: false }).tone, 'success');
    assert.equal(evidencePresentation({ evidenceValid: false, blocking: true }).label, 'Evidence invalid — blocking');
    assert.match(failureMessage('MISSING_TRANSACTION_PRESENT'), /exists again/);
    assert.equal(failureMessage('SOMETHING_NEW'), 'SOMETHING_NEW');
    assert.deepEqual(reconciliationDetailRequest(ID), { url: `${HISTORICAL_RECONCILIATION_BASE}/${ID}` });
  });

  test('7. proposal: only API fields are sent — never an amount, driver, fingerprint or ownership', () => {
    const form: ProposalForm = {
      ...EMPTY_PROPOSAL_FORM,
      summary: 'Order and its cash collection were deleted directly in the database.',
      discoveredAt: '2026-10-20T09:00',
      remainingUncertainties: 'Exact deletion time.',
      evidenceQueries: 'I1, I2\nI10',
      anchorTransactionId: ' ffffffff-0000-4000-8000-000000000002 ',
      sourceAuditLogId: 'ffffffff-0000-4000-8000-000000000004',
      reason: 'Explains the located ledger gap left by the deleted collection.',
    };
    assert.deepEqual(validateProposal(form), {});
    const body = buildProposalBody(form);
    assert.deepEqual(Object.keys(body).sort(), ['anchorTransactionId', 'incident', 'reason', 'sourceAuditLogId']);
    assert.equal(body.anchorTransactionId, 'ffffffff-0000-4000-8000-000000000002');
    assert.deepEqual(body.incident!.missingRecords, { orders: 1, driver_cash_transactions: 1 });
    assert.deepEqual(body.incident!.evidence, { queries: ['I1', 'I2', 'I10'] });
    const json = JSON.stringify(body);
    for (const forbidden of ['amount', 'driverId', 'evidenceDigest', 'ownership', 'expected', 'difference']) assert.ok(!json.includes(forbidden), forbidden);

    const existing = buildProposalBody({ ...form, incidentMode: 'existing', incidentId: 'cccccccc-0000-4000-8000-000000000001' });
    assert.deepEqual(Object.keys(existing).sort(), ['anchorTransactionId', 'incidentId', 'reason', 'sourceAuditLogId']);

    const bad = validateProposal({ ...EMPTY_PROPOSAL_FORM, missingRecords: [{ table: 'Orders!', value: 'x' }] });
    for (const k of ['anchorTransactionId', 'sourceAuditLogId', 'reason', 'summary', 'discoveredAt', 'missingRecords', 'remainingUncertainties']) assert.ok(k in bad, k);
    const req = proposeReconciliationRequest(body, 'key-1');
    assert.deepEqual([req.url, req.method, req.headers], [HISTORICAL_RECONCILIATION_BASE, 'POST', { 'Idempotency-Key': 'key-1' }]);
  });

  test('8-9. approval needs an explicit acknowledgment and submits the REVIEWED fingerprint', () => {
    const shown = detail();
    let review = startReview(shown);
    assert.equal(review.reviewedDigest, DIGEST_A);
    assert.equal(canSubmitApproval(review, shown), false, 'not acknowledged');
    review = acknowledge(review, true);
    assert.equal(canSubmitApproval(review, shown), true);
    assert.deepEqual(approvalBody(review), { evidenceDigest: DIGEST_A });
    const req = decisionRequest(ID, 'approve', approvalBody(review), 'k');
    assert.deepEqual([req.url, req.method, req.body], [`${HISTORICAL_RECONCILIATION_BASE}/${ID}/approve`, 'POST', { evidenceDigest: DIGEST_A }]);

    // Newer server data never silently replaces the reviewed fingerprint: submission is blocked instead.
    const changed = detail({ evidence: { ...shown.evidence, evidenceDigest: DIGEST_B } });
    assert.equal(reviewIsStale(review, changed), true);
    assert.equal(canSubmitApproval(review, changed), false);
    assert.deepEqual(approvalBody(review), { evidenceDigest: DIGEST_A }, 'still the reviewed digest — never the latest one');
    assert.equal(canSubmitApproval(review, detail({ status: 'REJECTED' })), false, 'decided meanwhile');
  });

  test('10-11. stale fingerprint: nothing is approved, re-review + new acknowledgment required, no automatic retry', () => {
    const review = acknowledge(startReview(detail()), true);
    const stale = classifyWorkflowError(err(409, 'STALE_EVIDENCE_DIGEST'));
    assert.deepEqual(stale, { kind: 'STALE_DIGEST' });
    assert.equal(requiresReReview(stale), true);
    const after = afterApprovalFailure(review, stale);
    assert.deepEqual([after.phase, after.acknowledged], ['needs-re-review', false]);
    assert.equal(canSubmitApproval(after, detail()), false, 'no resubmission from this state');
    assert.equal(acknowledge(after, true).acknowledged, false, 'cannot re-acknowledge without restarting the review');
    // Only an explicit new review (of the refreshed snapshot) re-enables approval, with its own digest.
    const restarted = startReview(detail({ evidence: { ...detail().evidence, evidenceDigest: DIGEST_B } }));
    assert.deepEqual([restarted.reviewedDigest, restarted.acknowledged], [DIGEST_B, false]);

    const invalid = classifyWorkflowError(err(409, 'RECONCILIATION_EVIDENCE_INVALID', { failures: ['MISSING_TRANSACTION_PRESENT'] }));
    assert.equal(invalid.kind, 'EVIDENCE_INVALID');
    assert.equal(afterApprovalFailure(review, invalid).phase, 'needs-re-review');
    assert.match(workflowErrorMessage(invalid), /exists again/);

    // A different fingerprint is a new intent -> a new key (never a replay of the old request).
    const k1 = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, JSON.stringify({ evidenceDigest: DIGEST_A }), () => 'k1');
    assert.ok(k1.ok);
    const k2 = resolveIdempotencyKey(afterFailure(k1.ok ? k1.state : INITIAL_IDEMPOTENCY_STATE, false), JSON.stringify({ evidenceDigest: DIGEST_B }), () => 'k2');
    assert.ok(k2.ok && k2.key === 'k2');
  });

  test('ambiguous approval: only the unchanged request may be retried, with the same key', () => {
    const review = acknowledge(startReview(detail()), true);
    const amb = classifyWorkflowError(err('FETCH_ERROR'));
    assert.deepEqual(amb, { kind: 'AMBIGUOUS' });
    assert.deepEqual(classifyWorkflowError(err(503)), { kind: 'AMBIGUOUS' });
    const after = afterApprovalFailure(review, amb);
    assert.deepEqual([after.phase, after.ambiguous, after.reviewedDigest], ['reviewing', true, DIGEST_A]);
    assert.equal(acknowledge(after, false).acknowledged, true, 'acknowledgment locked while ambiguous');
    const body = JSON.stringify(approvalBody(after));
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, body, () => 'same');
    const locked = afterFailure(first.ok ? first.state : INITIAL_IDEMPOTENCY_STATE, true);
    const retry = resolveIdempotencyKey(locked, body, () => 'new');
    assert.ok(retry.ok && retry.key === 'same');
    assert.deepEqual(resolveIdempotencyKey(locked, JSON.stringify({ evidenceDigest: DIGEST_B }), () => 'new'), { ok: false, reason: 'AMBIGUOUS_PENDING' });
    assert.equal(afterApprovalSuccess(after).phase, 'approved');
  });

  test('approval and rejection are offered to Finance only, never to the proposer', () => {
    const d = detail();
    assert.deepEqual(availableActions(d, { id: OTHER_FINANCE, roleCode: 'FINANCE' }).map((a) => [a.action, a.kind]), [
      ['approve', 'AVAILABLE'],
      ['reject', 'AVAILABLE'],
    ]);
    // A Finance user who proposed (only possible via a role change) is blocked, with a reason.
    assert.ok(availableActions(d, { id: PROPOSER, roleCode: 'FINANCE' }).every((a) => a.kind === 'BLOCKED'));
    // No Admin fallback for approval.
    assert.deepEqual(availableActions(d, { id: OTHER_ADMIN, roleCode: 'ADMIN' }).map((a) => a.action), ['withdraw']);
    assert.deepEqual(availableActions(d, { id: OTHER_ADMIN, roleCode: 'DISPATCHER' }), []);
    assert.deepEqual(availableActions(d, null), []);
    const invalid = availableActions(detail({ evidenceValid: false, failures: ['ROWS_INSIDE_GAP'] }), { id: OTHER_FINANCE, roleCode: 'FINANCE' });
    assert.equal(invalid.find((a) => a.action === 'approve')!.kind, 'BLOCKED');
    assert.equal(invalid.find((a) => a.action === 'reject')!.kind, 'AVAILABLE');
  });

  test('12-14. reject / withdraw / revoke: reasons, consequences, requests with an Idempotency-Key', () => {
    assert.equal(RECONCILIATION_REASON_MIN_LENGTH, 20);
    assert.ok(reasonError('too short'));
    assert.equal(reasonError('A documented reason of more than twenty.'), null);
    for (const action of ['reject', 'withdraw', 'revoke'] as const) {
      const req = decisionRequest(ID, action, { reason: 'x'.repeat(20) }, `key-${action}`);
      assert.deepEqual([req.url, req.method, req.headers], [`${HISTORICAL_RECONCILIATION_BASE}/${ID}/${action}`, 'POST', { 'Idempotency-Key': `key-${action}` }]);
      assert.ok(ACTION_CONSEQUENCES[action].some((c) => /Nothing is posted and no balance changes/.test(c)), action);
    }
    assert.ok(ACTION_CONSEQUENCES.revoke.some((c) => /G3 \/ R1 may block activation again/.test(c)));
  });

  test('15. revocation is offered to an independent Admin only', () => {
    const d = approved();
    assert.deepEqual(availableActions(d, { id: OTHER_ADMIN, roleCode: 'ADMIN' }).map((a) => [a.action, a.kind]), [['revoke', 'AVAILABLE']]);
    assert.equal(availableActions(d, { id: PROPOSER, roleCode: 'ADMIN' })[0].kind, 'BLOCKED');
    assert.equal(availableActions(d, { id: APPROVER, roleCode: 'ADMIN' })[0].kind, 'BLOCKED');
    assert.deepEqual(availableActions(d, { id: OTHER_FINANCE, roleCode: 'FINANCE' }), []);
    for (const status of ['REJECTED', 'WITHDRAWN', 'REVOKED', 'INVALID_HISTORY'] as const) {
      assert.deepEqual(availableActions(detail({ status }), { id: OTHER_ADMIN, roleCode: 'ADMIN' }), [], status);
      assert.deepEqual(availableActions(detail({ status }), { id: OTHER_FINANCE, roleCode: 'FINANCE' }), [], status);
    }
  });

  test('16. a disabled maintenance window is explained, never assumed enabled', () => {
    const disabled = classifyWorkflowError(err(403, 'HISTORICAL_RECONCILIATION_DISABLED'));
    assert.deepEqual(disabled, { kind: 'DISABLED' });
    assert.match(workflowErrorMessage(disabled), /disabled in this environment.*Nothing was changed/);
    assert.equal(requiresReReview(disabled), false);
    assert.equal(afterApprovalFailure(acknowledge(startReview(detail()), true), disabled).phase, 'stopped');
    assert.equal(classifyWorkflowError(err(403, 'REVOKER_NOT_INDEPENDENT')).kind, 'NOT_INDEPENDENT');
    assert.equal(classifyWorkflowError(err(403)).kind, 'PERMISSION');
    assert.equal(classifyWorkflowError(err(409, 'IDEMPOTENCY_KEY_REUSED')).kind, 'IDEMPOTENCY_CONFLICT');
    assert.equal(classifyWorkflowError(err(409, 'RECONCILIATION_NOT_PENDING')).kind, 'STATE_CHANGED');
    assert.equal(classifyWorkflowError(err(404)).kind, 'NOT_FOUND');
  });

  test('17. error / empty-state copy is defined for every failure kind', () => {
    for (const e of [
      err('FETCH_ERROR'),
      err(403, 'HISTORICAL_RECONCILIATION_DISABLED'),
      err(403),
      err(404),
      err(409, 'STALE_EVIDENCE_DIGEST'),
      err(409, 'RECONCILIATION_EVIDENCE_INVALID'),
      err(409, 'IDEMPOTENCY_KEY_REUSED'),
      err(409, 'RECONCILIATION_ALREADY_PROPOSED'),
      err(400),
    ]) {
      assert.ok(workflowErrorMessage(classifyWorkflowError(e)).length > 10);
    }
  });

  test('18. ownership stays unresolved whatever the status — APPROVED never reads as resolved', () => {
    const o = ownershipPresentation('UNRESOLVED');
    assert.deepEqual([o.label, o.tone], ['Ownership unresolved', 'danger']);
    assert.match(o.description, /G5 keeps blocking/);
    assert.ok(!/resolved/i.test(statusPresentation('APPROVED').label));
    assert.match(statusPresentation('APPROVED').description, /Ownership is still unresolved/);
    assert.notEqual(ownershipPresentation('SOMETHING').label, 'Ownership resolved', 'an unknown value is never assumed resolved');
  });

  test('19. the client issues no posting: every write targets the reconciliation workflow only', () => {
    const writes = [
      proposeReconciliationRequest(buildProposalBody({ ...EMPTY_PROPOSAL_FORM }), 'k'),
      ...(['approve', 'reject', 'withdraw', 'revoke'] as const).map((a) => decisionRequest(ID, a, { reason: 'r' }, 'k')),
    ];
    for (const w of writes) {
      assert.ok(w.url.startsWith(HISTORICAL_RECONCILIATION_BASE), w.url);
      assert.ok(w.headers?.['Idempotency-Key'], w.url);
      assert.ok(!/wallet|settlement|driver-cash|adjust|reverse|payout|activate/.test(w.url), w.url);
    }
  });

  test('20. responsive list: primary columns always visible on desktop; secondary figures collapse first', () => {
    const visible = (bp: 'md' | 'lg' | 'xl') =>
      LIST_COLUMN_LAYOUT.filter((c) => !c.hideBelow || (bp === 'xl' ? true : bp === 'lg' ? c.hideBelow === 'lg' : false)).map((c) => c.id);
    for (const id of ['incident', 'driver', 'amount', 'residual', 'status']) assert.ok(visible('md').includes(id), id);
    assert.ok(visible('lg').includes('ownership') && visible('lg').includes('evidence'));
    assert.equal(visible('xl').length, LIST_COLUMN_LAYOUT.length);
  });
});
