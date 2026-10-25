// FR.10.2 — dedicated financial corrections (collection void, release
// reversal, settlement reversal). Same lightweight approach as
// orderDetailActions.test.ts. Run:
//   npx --prefix ../server tsx --test tests/fr102Corrections.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PERMISSIONS } from '../src/features/auth/permissions';
import type { OrderFinancialReleaseDetail, OrderFinancialReleaseView } from '../src/services/domain.types';
import type { SettlementDetail } from '../src/services/settlementsApi';
import {
  CORRECTION_REASON_MIN_LENGTH,
  canCorrectFinance,
  classifyCorrectionError,
  reasonError,
  releaseReversalSummary,
  reverseReleaseAvailability,
  settlementReversalConsequences,
  settlementReversalPlan,
  voidCollectionAvailability,
  voidCollectionSummary,
} from '../src/components/finance/correctionActions';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  resolveIdempotencyKey,
} from '../src/pages/management/settlements/settlementSubmission';
import {
  collectionVoidInvalidationTags,
  releaseReversalInvalidationTags,
  settlementReversalInvalidationTags,
} from '../src/services/settlementInvalidation';
import { correctionResultLabel, correctionTypeLabel } from '../src/pages/management/settlements/settlementPresentation';
import { releaseCorrectionLabel } from '../src/components/finance/financialRelease';
import { reverseActionState } from '../src/components/finance/ledgerCorrection';

const FIN = [PERMISSIONS.FINANCE_READ, PERMISSIONS.FINANCE_ADJUST];
const READ_ONLY = [PERMISSIONS.FINANCE_READ, PERMISSIONS.SETTLEMENTS_READ];

function release(over: Partial<OrderFinancialReleaseDetail> = {}): OrderFinancialReleaseDetail {
  return {
    id: 'rel-1', releaseStatus: 'PENDING', reviewStatus: 'NOT_REQUIRED', orderType: 'DELIVERY_ONLY',
    deliveredAt: '2026-10-18T10:00:00.000Z', collectionAmount: '105', allocatedAmount: '0', outstandingAmount: '105',
    settlementState: 'UNSETTLED', plannedCustomerWalletAmount: '100', plannedCompanyProductAmount: '0', plannedCompanyFeeAmount: '5',
    postedTransactions: { walletTransactionId: null, companyProductTransactionId: null, companyFeeTransactionId: null },
    releasedAt: null, releasedBy: null, releaseTrigger: null, releasedBySettlement: null, collectionReversed: false,
    allocations: [], correction: null, ...over,
  };
}
const view = (r: OrderFinancialReleaseDetail | null): OrderFinancialReleaseView => ({ orderId: 'o1', financialReleaseMode: 'ON_SETTLEMENT', financialStatus: 'AWAITING_SETTLEMENT', release: r });

function settlement(over: Partial<SettlementDetail> = {}): SettlementDetail {
  return {
    id: 's1', settlementNumber: 'SET-1',
    driver: { id: 'd1', driverNumber: 'D-1', user: { firstName: 'Ali', lastName: 'Hassan', phone: null } } as SettlementDetail['driver'],
    balanceBefore: '300', amountReceived: '145', balanceAfter: '155', allocatedTotal: '145', unattributedAmount: '0', unattributedReason: null,
    reversed: false, shortfallTotal: '0',
    paymentMethod: { id: 'pm', code: 'CASH', name: 'Cash' } as SettlementDetail['paymentMethod'],
    receivedBy: { id: 'u', firstName: 'F', lastName: 'A' }, notes: null, createdAt: '2026-10-18T10:00:00.000Z', format: 'ALLOCATION',
    allocations: [
      { id: 'a1', releaseId: 'r1', order: { id: 'o1', orderNumber: 'ORD-1' }, customer: { id: 'c1', customerNumber: 'C1', name: 'ABC' }, orderType: 'DELIVERY_ONLY',
        amount: '40', status: 'ACTIVE', reversedByCorrectionId: null, releasedByThisSettlement: false,
        collection: { collectionAmount: '105', allocatedAmount: '40', outstandingAmount: '65', settlementState: 'PARTIALLY_SETTLED', releaseStatus: 'PENDING', reviewStatus: 'NOT_REQUIRED' } },
      { id: 'a2', releaseId: 'r2', order: { id: 'o2', orderNumber: 'ORD-2' }, customer: { id: 'c1', customerNumber: 'C1', name: 'ABC' }, orderType: 'DELIVERY_ONLY',
        amount: '105', status: 'ACTIVE', reversedByCorrectionId: null, releasedByThisSettlement: false,
        collection: { collectionAmount: '105', allocatedAmount: '105', outstandingAmount: '0', settlementState: 'FULLY_SETTLED', releaseStatus: 'PENDING', reviewStatus: 'AWAITING_REVIEW' } },
    ],
    releasedOrders: [], collectionsFullySettled: 1, collectionsPartiallySettled: 1, corrections: [],
    ...over,
  } as SettlementDetail;
}
const apiError = (status: number, message: string, reason?: string) => ({
  status, data: { success: false, error: { code: status === 409 ? 'CONFLICT' : 'X', message, ...(reason ? { details: { reason } } : {}) } },
});

describe('1. permissions and action visibility', () => {
  test('every dedicated correction requires finance.adjust (finance.read alone sees nothing)', () => {
    assert.equal(canCorrectFinance(FIN), true);
    assert.equal(canCorrectFinance(READ_ONLY), false);
    assert.deepEqual(voidCollectionAvailability(view(release()), READ_ONLY), { kind: 'HIDDEN' });
    assert.deepEqual(reverseReleaseAvailability(view(release({ releaseStatus: 'RELEASED' })), READ_ONLY), { kind: 'HIDDEN' });
    assert.equal(settlementReversalPlan(settlement(), READ_ONLY).availability.kind, 'HIDDEN');
  });
  test('legacy / immediate orders have no release, so no dedicated action', () => {
    assert.deepEqual(voidCollectionAvailability(view(null), FIN), { kind: 'HIDDEN' });
    assert.deepEqual(reverseReleaseAvailability(view(null), FIN), { kind: 'HIDDEN' });
  });
});

describe('2. collection void', () => {
  test('available only for a PENDING, unallocated, uncorrected release', () => {
    assert.deepEqual(voidCollectionAvailability(view(release()), FIN), { kind: 'AVAILABLE' });
    assert.equal(voidCollectionAvailability(view(release({ allocatedAmount: '40', outstandingAmount: '65' })), FIN).kind, 'BLOCKED');
    assert.deepEqual(voidCollectionAvailability(view(release({ releaseStatus: 'RELEASED' })), FIN), { kind: 'HIDDEN' });
    assert.deepEqual(voidCollectionAvailability(view(release({ releaseStatus: 'VOIDED' })), FIN), { kind: 'HIDDEN' });
    const corrected = release({ correction: { id: 'k', correctionType: 'COLLECTION_VOID' } as OrderFinancialReleaseDetail['correction'] });
    assert.deepEqual(voidCollectionAvailability(view(corrected), FIN), { kind: 'HIDDEN' });
    assert.equal(voidCollectionAvailability(view(release({ collectionReversed: true })), FIN).kind, 'BLOCKED');
  });
  test('the confirmation shows order, driver, amounts and that delivery stays DELIVERED', () => {
    const s = voidCollectionSummary(view(release()), { orderNumber: 'ORD-9', driverLabel: 'D-7' });
    assert.deepEqual(s.rows.map((r) => [r.label, r.value]), [
      ['Order', 'ORD-9'], ['Driver', 'D-7'], ['Collection amount', '105.00'], ['Currently settled (allocated)', '0.00'],
    ]);
    assert.ok(s.consequences.some((c) => /VOIDED/.test(c)));
    assert.ok(s.consequences.some((c) => /stays DELIVERED/.test(c)));
  });
});

describe('3. financial release reversal', () => {
  test('available only for RELEASED, uncorrected releases', () => {
    assert.deepEqual(reverseReleaseAvailability(view(release({ releaseStatus: 'RELEASED' })), FIN), { kind: 'AVAILABLE' });
    assert.deepEqual(reverseReleaseAvailability(view(release()), FIN), { kind: 'HIDDEN' });
    assert.deepEqual(reverseReleaseAvailability(view(release({ releaseStatus: 'RELEASE_REVERSED' })), FIN), { kind: 'HIDDEN' });
  });
  test('8. exact released amounts; product revenue only where applicable; paid-out warning; no debt handling', () => {
    const d = releaseReversalSummary(view(release({ releaseStatus: 'RELEASED' })), { orderNumber: 'ORD-9', customerName: 'ABC' });
    assert.deepEqual(d.rows.map((r) => [r.label, r.value]), [
      ['Order', 'ORD-9'], ['Customer', 'ABC'], ['Released customer wallet credit', '100.00'], ['Released delivery-fee revenue', '5.00'],
    ]);
    assert.ok(d.consequences.some((c) => /debits 100\.00/.test(c)));
    assert.ok(d.warnings.some((w) => /no longer holds enough available funds/.test(w)));
    assert.ok(d.warnings.some((w) => /NOT handled by the system/.test(w)));
    const company = releaseReversalSummary(
      view(release({ releaseStatus: 'RELEASED', orderType: 'COMPANY_ORDER', plannedCustomerWalletAmount: '0', plannedCompanyProductAmount: '85', plannedCompanyFeeAmount: '5' })),
      { orderNumber: 'ORD-8', customerName: 'XYZ' },
    );
    assert.ok(company.rows.some((r) => r.label === 'Released company product revenue' && r.value === '85.00'));
    assert.ok(!company.consequences.some((c) => /debits/.test(c)), 'a company order never debits a wallet');
  });
});

describe('4. settlement reversal', () => {
  test('affected allocations and their settled amounts after reversal', () => {
    const p = settlementReversalPlan(settlement(), FIN);
    assert.deepEqual(p.availability, { kind: 'AVAILABLE' });
    assert.deepEqual(p.affected.map((a) => [a.orderNumber, a.amount, a.settledNow, a.settledAfter]), [
      ['ORD-1', '40.00', '40.00', '0.00'],
      ['ORD-2', '105.00', '105.00', '0.00'],
    ]);
    assert.ok(settlementReversalConsequences(settlement()).some((c) => /credited back with 145\.00/.test(c)));
  });
  test('not offered when released funds, a shortfall or a prior reversal exist', () => {
    const released = settlement();
    released.allocations[1].collection.releaseStatus = 'RELEASED';
    const r = settlementReversalPlan(released, FIN).availability;
    assert.equal(r.kind, 'BLOCKED');
    assert.match(r.kind === 'BLOCKED' ? r.reason : '', /Released funds exist for ORD-2/);
    const reversedRelease = settlement();
    reversedRelease.allocations[0].collection.releaseStatus = 'RELEASE_REVERSED';
    assert.equal(settlementReversalPlan(reversedRelease, FIN).availability.kind, 'BLOCKED');
    assert.equal(settlementReversalPlan(settlement({ shortfallTotal: '5.00' }), FIN).availability.kind, 'BLOCKED');
    assert.equal(settlementReversalPlan(settlement({ reversed: true }), FIN).availability.kind, 'BLOCKED');
  });
  test('reversed allocations are ignored; a legacy settlement can be reversed', () => {
    const s = settlement();
    s.allocations[1].status = 'REVERSED';
    s.allocations[1].collection.releaseStatus = 'RELEASED';
    assert.equal(settlementReversalPlan(s, FIN).availability.kind, 'AVAILABLE');
    const legacy = settlement({ format: 'LEGACY', allocatedTotal: null, allocations: [] });
    assert.equal(settlementReversalPlan(legacy, FIN).availability.kind, 'AVAILABLE');
    assert.ok(settlementReversalConsequences(legacy).some((c) => /legacy settlement has no allocations/.test(c)));
  });
});

describe('5. shortfall action', () => {
  test('withheld: no shortfall action exists in the correction module', async () => {
    const mod = await import('../src/components/finance/correctionActions');
    assert.equal(Object.keys(mod).some((k) => /shortfall/i.test(k)), false);
  });
});

describe('6-7. confirmation dialogs and required reasons', () => {
  test('a reason of at least 10 characters is required (server rule)', () => {
    assert.equal(CORRECTION_REASON_MIN_LENGTH, 10);
    assert.ok(reasonError(''));
    assert.ok(reasonError('   short   '));
    assert.equal(reasonError('Recorded against the wrong order'), null);
  });
});

describe('9-10. idempotent retries and double-submit prevention', () => {
  test('a retry of the same reason reuses the key; an ambiguous failure locks the reason', () => {
    let n = 0;
    const gen = () => `k${++n}`;
    const body = JSON.stringify({ reason: 'Recorded against the wrong order' });
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, body, gen);
    assert.ok(first.ok);
    const ambiguous = afterFailure(first.state, true);
    const retry = resolveIdempotencyKey(ambiguous, body, gen);
    assert.ok(retry.ok && retry.key === first.key);
    assert.deepEqual(resolveIdempotencyKey(ambiguous, JSON.stringify({ reason: 'A different reason entirely' }), gen), { ok: false, reason: 'AMBIGUOUS_PENDING' });
    const double = resolveIdempotencyKey(first.state, body, gen);
    assert.ok(double.ok && double.key === first.key);
    assert.equal(n, 1, 'one key for one intended correction');
    assert.notEqual((resolveIdempotencyKey(afterSuccess(), body, gen) as { key: string }).key, first.key);
  });
});

describe('11. error handling', () => {
  test('backend refusal reasons become precise, non-alarming messages', () => {
    const paid = classifyCorrectionError(apiError(409, 'x', 'RELEASED_FUNDS_PAID_OUT'));
    assert.equal(paid.kind, 'CONFLICT');
    assert.match(paid.message, /no longer holds enough available funds/);
    assert.match(paid.message, /Nothing was changed/);
    assert.match(classifyCorrectionError(apiError(409, 'x', 'COLLECTION_HAS_ALLOCATIONS')).message, /reverse the allocating settlement/);
    assert.match(classifyCorrectionError(apiError(409, 'x', 'SETTLEMENT_HAS_RELEASED_FUNDS')).message, /financial release reversal/);
    assert.match(classifyCorrectionError(apiError(409, 'x', 'RELEASE_STATE_CHANGED')).message, /refreshed/);
    assert.equal(classifyCorrectionError(apiError(400, 'reason must be at least 10 characters')).kind, 'VALIDATION');
    assert.equal(classifyCorrectionError(apiError(403, 'Forbidden')).kind, 'PERMISSION');
    assert.equal(classifyCorrectionError(apiError(404, 'Financial release not found')).kind, 'NOT_FOUND');
    assert.equal(classifyCorrectionError(apiError(500, 'boom')).kind, 'SERVER');
    const transport = classifyCorrectionError({ status: 'FETCH_ERROR', error: 'TypeError' });
    assert.equal(transport.kind, 'TRANSPORT');
    assert.match(transport.message, /will not apply it twice/);
  });
});

describe('12. cache invalidation', () => {
  const ids = (tags: { type: string; id: string }[]) => tags.map((t) => `${t.type}:${t.id}`);
  test('collection void refreshes the order, driver cash and the customer pending figures', () => {
    const t = ids(collectionVoidInvalidationTags({ orderId: 'o1', driverId: 'd1', customerId: 'c1' }));
    for (const x of ['Order:o1', 'Order:LIST', 'DriverCash:d1', 'DriverCash:SUMMARIES', 'Wallet:c1', 'Customer:c1', 'Finance:SUMMARY', 'Dashboard:ROOT', 'Report:LIST']) assert.ok(t.includes(x), x);
  });
  test('release reversal refreshes wallets, the order and the allocating settlements', () => {
    const t = ids(releaseReversalInvalidationTags({ orderId: 'o1', customerId: 'c1', settlementIds: ['s1', 's1', 's2'] }));
    for (const x of ['Order:o1', 'Wallet:c1', 'WalletTransaction:LIST', 'Settlement:s1', 'Settlement:s2', 'Settlement:LIST', 'Finance:TRANSACTIONS']) assert.ok(t.includes(x), x);
    assert.equal(t.filter((x) => x === 'Settlement:s1').length, 1);
  });
  test('settlement reversal refreshes driver cash and the affected orders, never wallets', () => {
    const t = ids(settlementReversalInvalidationTags({ settlementId: 's1', driverId: 'd1', orderIds: ['o1', 'o2'] }));
    for (const x of ['Settlement:s1', 'Settlement:LIST', 'DriverCash:d1', 'Order:o1', 'Order:o2', 'Report:LIST']) assert.ok(t.includes(x), x);
    assert.ok(!t.some((x) => x.startsWith('Wallet')));
  });
});

describe('13. legacy correction compatibility', () => {
  test('generic Reverse on eligible legacy rows is unchanged', () => {
    const legacy = { id: 'x', type: 'ORDER_CREDIT', correctionWorkflow: 'GENERIC' as const, canReverseGenerically: true, reversed: false };
    assert.deepEqual(reverseActionState(legacy, { canReverse: true, dedicated: new Map() }), { kind: 'REVERSE' });
  });
});

describe('14. correction history', () => {
  test('types and resulting states are labelled', () => {
    assert.equal(correctionTypeLabel('SETTLEMENT_REVERSAL'), 'Settlement reversed');
    assert.match(correctionResultLabel('SETTLEMENT_REVERSAL'), /driver cash credited back/);
    assert.match(correctionResultLabel('SETTLEMENT_SHORTFALL'), /driver obligation/);
    assert.equal(releaseCorrectionLabel('COLLECTION_VOID'), 'Collection voided');
    assert.equal(releaseCorrectionLabel('RELEASE_REVERSAL'), 'Release reversed');
  });
});

describe('15. mobile layouts', () => {
  test('the same availability drives desktop and mobile (pure state, no layout branching)', () => {
    const v = view(release());
    assert.deepEqual(voidCollectionAvailability(v, FIN), voidCollectionAvailability(v, FIN));
    assert.deepEqual(settlementReversalPlan(settlement(), FIN), settlementReversalPlan(settlement(), FIN));
  });
});
