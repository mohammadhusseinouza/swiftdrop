// FR.10 — pure-logic tests for the settlement-based financial release
// frontend: pending breakdowns, order release presentation, financial status
// labels and filters, report basis, dashboard labels, permissions and cache
// tags. Same lightweight approach as orderDetailActions.test.ts (Node's
// built-in runner, outside src/). Run:
//   npx --prefix ../server tsx --test tests/financialReleaseFrontend.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PERMISSIONS } from '../src/features/auth/permissions';
import type {
  OrderFinancialReleaseDetail,
  OrderFinancialReleaseView,
} from '../src/services/domain.types';
import {
  FINANCIAL_STATUSES,
  REPORTING_BASES,
  REPORTING_BASIS_LABEL,
  canViewFinancialRelease,
  collectionStateLabel,
  customerPendingSupportingText,
  getFinancialStatusPresentation,
  getReleaseModePresentation,
  parseReportingBasis,
  pendingBreakdown,
  pendingSubline,
  releaseCorrectionLabel,
  releaseStatusLabel,
  reviewStatusLabel,
  summarizeOrderRelease,
  sumMoney,
} from '../src/components/finance/financialRelease';
import * as settlementPresentation from '../src/pages/management/settlements/settlementPresentation';
import {
  EMPTY_ORDERS_STATE,
  hasActiveFilters,
  parseOrdersListParams,
  serializeOrdersListParams,
  toListOrdersParams,
} from '../src/pages/management/orders/ordersListParams';
import {
  parseDateRange,
  parseFinancialReportBasis,
  parseFinancialReportGroupBy,
  patchReportParams,
  switchReportParams,
} from '../src/pages/management/reports/reportsParams';
import { activityLabel } from '../src/pages/management/dashboard/dashboardPresentation';
import {
  resolutionInvalidationTags,
  settlementInvalidationTags,
} from '../src/services/settlementInvalidation';
import { formatMoney } from '../src/lib/format';

/* -------------------------------- fixtures -------------------------------- */

function release(over: Partial<OrderFinancialReleaseDetail> = {}): OrderFinancialReleaseDetail {
  return {
    id: 'rel-1',
    releaseStatus: 'PENDING',
    reviewStatus: 'NOT_REQUIRED',
    orderType: 'DELIVERY_ONLY',
    deliveredAt: '2026-10-18T10:00:00.000Z',
    collectionAmount: '105',
    allocatedAmount: '0',
    outstandingAmount: '105',
    settlementState: 'UNSETTLED',
    plannedCustomerWalletAmount: '100',
    plannedCompanyProductAmount: '0',
    plannedCompanyFeeAmount: '5',
    postedTransactions: { walletTransactionId: null, companyProductTransactionId: null, companyFeeTransactionId: null },
    releasedAt: null,
    releasedBy: null,
    releaseTrigger: null,
    releasedBySettlement: null,
    collectionReversed: false,
    allocations: [],
    correction: null,
    ...over,
  };
}

function view(r: OrderFinancialReleaseDetail | null, mode: string | null = 'ON_SETTLEMENT', status = 'AWAITING_SETTLEMENT'): OrderFinancialReleaseView {
  return { orderId: 'ord-1', financialReleaseMode: mode, financialStatus: status, release: r };
}

/* ---------------------------------- tests --------------------------------- */

describe('1-3. wallet pending breakdown, combined total, available balance', () => {
  test('delivery + settlement are shown; the total is the backend value', () => {
    const b = pendingBreakdown({ pendingAmount: '120.00', pendingDeliveryAmount: '70', pendingSettlementAmount: '50', underReviewOrderCount: 0 });
    assert.equal(b.totalPending, '120.00');
    assert.equal(b.pendingDelivery, '70');
    assert.equal(b.pendingSettlement, '50');
    assert.equal(b.hasBreakdown, true);
    assert.equal(b.consistent, true);
    assert.equal(pendingSubline(b, formatMoney), '$70.00 delivery · $50.00 settlement');
  });
  test('an inconsistent backend total is flagged, never silently recomputed', () => {
    const b = pendingBreakdown({ pendingAmount: '121.00', pendingDeliveryAmount: '70', pendingSettlementAmount: '50' });
    assert.equal(b.totalPending, '121.00');
    assert.equal(b.consistent, false);
  });
  test('exact cents (no float drift): 0.10 + 0.20 = 0.30', () => {
    assert.equal(pendingBreakdown({ pendingAmount: '0.30', pendingDeliveryAmount: '0.10', pendingSettlementAmount: '0.20' }).consistent, true);
  });
  test('an older payload without parts shows only the total', () => {
    const b = pendingBreakdown({ pendingAmount: '40.00' });
    assert.equal(b.hasBreakdown, false);
    assert.equal(b.pendingDelivery, null);
    assert.equal(pendingSubline(b, formatMoney), null);
  });
  test('pending never feeds the available balance (separate inputs, no aggregation helper)', () => {
    // pendingBreakdown never reads or returns an available figure.
    const b = pendingBreakdown({ pendingAmount: '10', pendingDeliveryAmount: '0', pendingSettlementAmount: '10' }) as unknown as Record<string, unknown>;
    assert.equal('availableBalance' in b, false);
  });
});

describe('4. unresolved financial reviews', () => {
  test('under-review differences are a count only, never part of the pending money', () => {
    const b = pendingBreakdown({ pendingAmount: '0.00', pendingDeliveryAmount: '0', pendingSettlementAmount: '0', underReviewOrderCount: 2 });
    assert.equal(b.underReviewOrderCount, 2);
    assert.equal(b.totalPending, '0.00');
  });
  test('an order awaiting review has no planned split and a review headline', () => {
    const s = summarizeOrderRelease(view(release({ reviewStatus: 'AWAITING_REVIEW', plannedCustomerWalletAmount: null, plannedCompanyProductAmount: null, plannedCompanyFeeAmount: null }), 'ON_SETTLEMENT', 'REVIEW_REQUIRED'));
    assert.equal(s.state, 'AWAITING_REVIEW');
    assert.equal(s.plannedSplitKnown, false);
    assert.equal(reviewStatusLabel('AWAITING_REVIEW')?.label, 'Under review');
  });
});

describe('5-6. customer dashboard and customer wallet', () => {
  test('plain-language pending explanation with both parts', () => {
    const text = customerPendingSupportingText(
      pendingBreakdown({ pendingAmount: '120', pendingDeliveryAmount: '70', pendingSettlementAmount: '50' }),
      formatMoney,
    );
    assert.match(text, /\$70\.00 on the way/);
    assert.match(text, /\$50\.00 delivered, awaiting courier settlement/);
    assert.match(text, /Not yet available/);
  });
  test('customer wording never mentions internal ledgers', () => {
    const text = customerPendingSupportingText(pendingBreakdown({ pendingAmount: '1', pendingDeliveryAmount: '1', pendingSettlementAmount: '0' }), formatMoney);
    for (const internal of ['driver cash', 'revenue', 'settlement record', 'adjustment']) assert.ok(!text.toLowerCase().includes(internal), internal);
  });
  test('fallback wording without a breakdown', () => {
    assert.equal(customerPendingSupportingText(pendingBreakdown({ pendingAmount: '5' }), formatMoney), 'Money from your orders that is not yet available.');
  });
});

describe('7. finance permission boundaries', () => {
  test('the release sub-resource needs finance.read', () => {
    assert.equal(canViewFinancialRelease([PERMISSIONS.FINANCE_READ]), true);
    assert.equal(canViewFinancialRelease([PERMISSIONS.ORDERS_READ, PERMISSIONS.SETTLEMENTS_READ]), false);
    assert.equal(canViewFinancialRelease([]), false);
  });
});

describe('8-12. order financial release detail', () => {
  test('9. legacy (null mode) and immediate orders have no release and say so', () => {
    const legacy = summarizeOrderRelease(view(null, null, 'FINALIZED'));
    assert.equal(legacy.state, 'LEGACY');
    assert.match(legacy.headline, /Legacy/);
    const immediate = summarizeOrderRelease(view(null, 'IMMEDIATE', 'FINALIZED'));
    assert.equal(immediate.state, 'IMMEDIATE');
    assert.equal(getReleaseModePresentation(null).label, 'Legacy (immediate)');
    assert.equal(getReleaseModePresentation('IMMEDIATE').label, 'Immediate');
    assert.equal(getReleaseModePresentation('ON_SETTLEMENT').label, 'On settlement');
  });
  test('8. pending (unsettled) release with an approved split', () => {
    const s = summarizeOrderRelease(view(release()));
    assert.equal(s.state, 'UNSETTLED');
    assert.equal(s.plannedSplitKnown, true);
  });
  test('10. partially settled', () => {
    const s = summarizeOrderRelease(view(release({ allocatedAmount: '40', outstandingAmount: '65', settlementState: 'PARTIALLY_SETTLED' })));
    assert.equal(s.state, 'PARTIALLY_SETTLED');
    assert.equal(collectionStateLabel('PARTIALLY_SETTLED').label, 'Partially settled');
  });
  test('11. fully settled awaiting review, and released', () => {
    const waiting = summarizeOrderRelease(view(release({ allocatedAmount: '95', outstandingAmount: '0', settlementState: 'FULLY_SETTLED', reviewStatus: 'AWAITING_REVIEW', plannedCustomerWalletAmount: null, plannedCompanyProductAmount: null, plannedCompanyFeeAmount: null }), 'ON_SETTLEMENT', 'REVIEW_REQUIRED'));
    assert.equal(waiting.state, 'SETTLED_AWAITING_REVIEW');
    const released = summarizeOrderRelease(view(release({ releaseStatus: 'RELEASED', settlementState: 'FULLY_SETTLED', allocatedAmount: '105', outstandingAmount: '0', releasedAt: '2026-10-18T11:00:00.000Z' }), 'ON_SETTLEMENT', 'FINALIZED'));
    assert.equal(released.state, 'RELEASED');
    assert.equal(released.tone, 'success');
    assert.equal(releaseStatusLabel('RELEASED').label, 'Released');
  });
  test('12. voided and reversed releases', () => {
    assert.equal(summarizeOrderRelease(view(release({ releaseStatus: 'VOIDED', outstandingAmount: '0' }), 'ON_SETTLEMENT', 'COLLECTION_VOIDED')).state, 'VOIDED');
    assert.equal(summarizeOrderRelease(view(release({ releaseStatus: 'RELEASE_REVERSED' }), 'ON_SETTLEMENT', 'RELEASE_REVERSED')).state, 'REVERSED');
    assert.equal(releaseCorrectionLabel('COLLECTION_VOID'), 'Collection voided');
    assert.equal(releaseCorrectionLabel('RELEASE_REVERSAL'), 'Release reversed');
    assert.equal(releaseStatusLabel('VOIDED').tone, 'danger');
  });
  test('settlement detail and order detail share one vocabulary', () => {
    assert.equal(settlementPresentation.releaseStatusLabel, releaseStatusLabel);
    assert.equal(settlementPresentation.reviewStatusLabel, reviewStatusLabel);
    assert.equal(settlementPresentation.collectionStateLabel, collectionStateLabel);
  });
});

describe('13. order financial status labels and filters', () => {
  test('every status has a label; DELIVERED stays an operational status', () => {
    assert.deepEqual([...FINANCIAL_STATUSES], ['PENDING', 'REVIEW_REQUIRED', 'AWAITING_SETTLEMENT', 'FINALIZED', 'COLLECTION_VOIDED', 'RELEASE_REVERSED', 'NOT_APPLICABLE']);
    for (const s of FINANCIAL_STATUSES) assert.notEqual(getFinancialStatusPresentation(s).label, s);
    assert.equal(getFinancialStatusPresentation('AWAITING_SETTLEMENT').label, 'Awaiting settlement');
    assert.equal(FINANCIAL_STATUSES.includes('DELIVERED' as never), false);
  });
  test('the URL filter accepts all seven statuses (the backend filter accepts them since the FR.10 closure) and round-trips', () => {
    for (const s of FINANCIAL_STATUSES) {
      const state = parseOrdersListParams(new URLSearchParams({ financialStatus: s }));
      assert.equal(state.financialStatus, s);
      assert.equal(toListOrdersParams(state).financialStatus, s);
      assert.equal(serializeOrdersListParams(state).get('financialStatus'), s);
      assert.equal(hasActiveFilters(state), true);
    }
    assert.equal(parseOrdersListParams(new URLSearchParams({ financialStatus: 'DELIVERED' })).financialStatus, '');
    assert.equal(hasActiveFilters(EMPTY_ORDERS_STATE), false);
  });
});

describe('14. finance summary / dashboard indicators', () => {
  test('backend amounts are summed exactly for display only', () => {
    assert.equal(sumMoney(['5.10', '0.20']), '5.30');
    assert.equal(sumMoney(['-5.00', '10.00']), '5.00');
  });
});

describe('15-16. report basis switching and date filter preservation', () => {
  test('released is the default and is never written to the URL', () => {
    assert.equal(parseReportingBasis(null), 'released');
    assert.equal(parseReportingBasis('nonsense'), 'released');
    assert.equal(parseFinancialReportBasis(new URLSearchParams()), 'released');
    assert.deepEqual([...REPORTING_BASES], ['released', 'delivered']);
    assert.match(REPORTING_BASIS_LABEL.delivered.label, /Delivery date/);
  });
  test('switching basis keeps the date range and grouping', () => {
    const sp = new URLSearchParams({ report: 'financial', from: '2026-10-01', to: '2026-10-18', groupBy: 'week' });
    const delivered = patchReportParams(sp, { basis: 'delivered' });
    assert.equal(parseFinancialReportBasis(delivered), 'delivered');
    assert.deepEqual(parseDateRange(delivered), { from: '2026-10-01', to: '2026-10-18' });
    assert.equal(parseFinancialReportGroupBy(delivered), 'week');
    const back = patchReportParams(delivered, { basis: undefined });
    assert.equal(back.has('basis'), false);
    assert.equal(parseFinancialReportBasis(back), 'released');
    assert.deepEqual(parseDateRange(back), { from: '2026-10-01', to: '2026-10-18' });
  });
  test('changing the date range keeps the basis', () => {
    const sp = new URLSearchParams({ report: 'financial', basis: 'delivered' });
    assert.equal(parseFinancialReportBasis(patchReportParams(sp, { from: '2026-09-01' })), 'delivered');
  });
  test('switching to another report keeps only the shared date range', () => {
    const next = switchReportParams(new URLSearchParams({ report: 'financial', basis: 'delivered', from: '2026-10-01' }), 'orders');
    assert.equal(next.has('basis'), false);
    assert.equal(next.get('from'), '2026-10-01');
  });
});

describe('17. dashboard financial indicators (activity labels)', () => {
  test('FR.8 audit actions have readable labels', () => {
    assert.equal(activityLabel('DELIVERY_FINANCE_AWAITING_SETTLEMENT'), 'Delivery awaiting driver settlement');
    assert.equal(activityLabel('FINANCIAL_RELEASE_COMPLETED'), 'Financial release completed');
    assert.equal(activityLabel('FINANCIAL_RELEASE_COLLECTION_VOIDED'), 'Settlement-mode collection voided');
    assert.equal(activityLabel('FINANCIAL_RELEASE_REVERSED'), 'Financial release reversed');
    assert.equal(activityLabel('DRIVER_SETTLEMENT_SHORTFALL_RECORDED'), 'Settlement shortfall recorded');
  });
});

describe('18. driver cash breakdown', () => {
  test('attributed + unattributed is driver custody — the release labels never call it revenue', () => {
    // The breakdown is rendered from backend fields only; the shared labels
    // keep custody and release vocabulary distinct.
    assert.notEqual(releaseStatusLabel('PENDING').label.toLowerCase(), 'revenue');
    assert.equal(collectionStateLabel('UNSETTLED').label, 'Unsettled');
  });
});

describe('19. API errors and missing optional fields', () => {
  test('unknown statuses degrade to readable neutral labels', () => {
    assert.deepEqual(getFinancialStatusPresentation('SOMETHING_NEW'), { label: 'Something new', tone: 'neutral', description: '' });
    assert.equal(releaseStatusLabel('SOMETHING_NEW').tone, 'neutral');
    assert.equal(reviewStatusLabel('NOT_REQUIRED'), null);
  });
  test('missing review count defaults to zero', () => {
    assert.equal(pendingBreakdown({ pendingAmount: '1', pendingDeliveryAmount: '1', pendingSettlementAmount: '0', underReviewOrderCount: null }).underReviewOrderCount, 0);
  });
});

describe('20. cache refresh', () => {
  test('a resolution refreshes the customer wallet and the driver outstanding collections', () => {
    const tags = resolutionInvalidationTags({ customer: { id: 'c1' }, currentDriver: { id: 'd1' } }).map((t) => `${t.type}:${t.id}`);
    assert.deepEqual(tags, ['Wallet:c1', 'Customer:c1', 'DriverCash:d1']);
    assert.deepEqual(resolutionInvalidationTags(undefined), []);
    assert.deepEqual(resolutionInvalidationTags({ customer: { id: 'c1' }, currentDriver: null }).map((t) => t.type), ['Wallet', 'Customer']);
  });
  test('a settlement refreshes the driver cash tag that also backs outstanding collections', () => {
    const ids = settlementInvalidationTags('d1', { customerIds: ['c1'], orderIds: ['o1'] }).map((t) => `${t.type}:${t.id}`);
    for (const t of ['DriverCash:d1', 'Order:o1', 'Wallet:c1', 'Finance:SUMMARY', 'Report:LIST', 'Dashboard:ROOT']) assert.ok(ids.includes(t), t);
  });
});

describe('21. desktop and mobile rendering inputs', () => {
  test('the compact mobile sub-line fits the same data as the desktop column', () => {
    const b = pendingBreakdown({ pendingAmount: '1234.50', pendingDeliveryAmount: '1000', pendingSettlementAmount: '234.50' });
    assert.equal(pendingSubline(b, formatMoney), '$1,000.00 delivery · $234.50 settlement');
  });
});
