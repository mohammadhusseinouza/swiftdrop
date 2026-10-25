// FR.9 — pure-logic tests for the settlement allocation dialog, the
// settlement detail presentation and the settlement cache invalidation.
// Same lightweight approach as orderDetailActions.test.ts (Node's built-in
// runner, outside src/). Run:
//   npx --prefix ../server tsx --test tests/settlementAllocation.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { PERMISSIONS } from '../src/features/auth/permissions';
import type {
  DriverOutstandingCollections,
  OutstandingCollection,
  SettlementDetail,
} from '../src/services/settlementsApi';
import { settlementInvalidationTags } from '../src/services/settlementInvalidation';
import {
  MAX_ALLOCATIONS_PER_SETTLEMENT,
  allocationRowStatus,
  applyAllocationRejection,
  buildAllocationRequest,
  buildSettlementPreview,
  chooseSettlementFormat,
  clearSelections,
  deselectCollection,
  draftForDriver,
  emptyAllocationDraft,
  isSelectable,
  preselectOldestFirst,
  reconcileDraft,
  selectCollection,
  setAllocationAmount,
  setFullOutstanding,
  validateAllocationDraft,
  type AllocationDraft,
} from '../src/pages/management/settlements/settlementAllocation';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  classifySettlementError,
  needsPositionRefresh,
  resolveIdempotencyKey,
  settlementErrorMessage,
} from '../src/pages/management/settlements/settlementSubmission';
import {
  ALLOCATION_ROW_STATUS,
  collectionStateLabel,
  describeSettlementDetail,
  isLegacySettlement,
  releaseStatusLabel,
  reviewStatusLabel,
  settlementCapabilities,
} from '../src/pages/management/settlements/settlementPresentation';
import {
  legacyAmountError,
  toCreateSettlementRequest,
} from '../src/pages/management/settlements/processSettlement.schema';

/* -------------------------------- fixtures -------------------------------- */

const DRIVER = '11111111-1111-4111-8111-111111111111';
const OTHER_DRIVER = '22222222-2222-4222-8222-222222222222';
const METHOD = '33333333-3333-4333-8333-333333333333';

let seq = 0;
function collection(over: Partial<OutstandingCollection> = {}): OutstandingCollection {
  seq += 1;
  const n = String(seq).padStart(3, '0');
  return {
    releaseId: `rel-${n}`,
    order: { id: `ord-${n}`, orderNumber: `ORD-${n}` },
    customer: { id: `cus-${n}`, customerNumber: `C-${n}`, name: `Customer ${n}` },
    orderType: 'DELIVERY_ONLY',
    deliveredAt: `2026-10-${String(10 + (seq % 15)).padStart(2, '0')}T10:00:00.000Z`,
    collectionAmount: '105',
    allocatedAmount: '0',
    outstandingAmount: '105',
    settlementState: 'UNSETTLED',
    reviewStatus: 'NOT_REQUIRED',
    releaseStatus: 'PENDING',
    plannedCustomerWalletAmount: '100',
    plannedCompanyProductAmount: '0',
    plannedCompanyFeeAmount: '5',
    ...over,
  };
}

function position(items: OutstandingCollection[], over: Partial<DriverOutstandingCollections> = {}): DriverOutstandingCollections {
  return {
    driverId: DRIVER,
    cashBalance: '500',
    attributedOutstanding: '300',
    unattributedBalance: '200',
    outstandingCollectionCount: items.length,
    items,
    ...over,
  };
}

function select(draft: AllocationDraft, ...items: OutstandingCollection[]): AllocationDraft {
  let d = draft;
  for (const item of items) {
    const r = selectCollection(d, item);
    assert.ok(r.ok, `expected ${item.releaseId} to be selectable`);
    d = r.draft;
  }
  return d;
}

/** A backend error as RTK Query's fetchBaseQuery reports it. */
function apiError(status: number, code: string, message: string, details?: unknown) {
  return { status, data: { success: false, error: { code, message, ...(details ? { details } : {}) } } };
}

/* ---------------------------------- tests --------------------------------- */

describe('1. loading outstanding collections → request format', () => {
  test('settlement-mode money present → allocation format', () => {
    const p = position([collection()]);
    assert.equal(chooseSettlementFormat(p, false), 'ALLOCATION');
  });
  test('fully allocated but awaiting review (attributed 0, count 0) and no collections → legacy', () => {
    assert.equal(chooseSettlementFormat(position([], { attributedOutstanding: '0', outstandingCollectionCount: 0 }), false), 'LEGACY');
  });
  test('attributed cash with no visible item still requires allocations', () => {
    assert.equal(chooseSettlementFormat(position([], { attributedOutstanding: '10.00', outstandingCollectionCount: 0 }), false), 'ALLOCATION');
  });
  test('server-required allocation contract wins over a legacy-looking position', () => {
    assert.equal(chooseSettlementFormat(position([], { attributedOutstanding: '0', outstandingCollectionCount: 0 }), true), 'ALLOCATION');
  });
  test('position not loaded yet → legacy (the form stays disabled until it loads)', () => {
    assert.equal(chooseSettlementFormat(null, false), 'LEGACY');
  });
});

describe('2. driver switching', () => {
  test('a draft never carries selections to another driver', () => {
    const d = select(emptyAllocationDraft(DRIVER), collection());
    const switched = draftForDriver(d, OTHER_DRIVER);
    assert.equal(switched.driverId, OTHER_DRIVER);
    assert.deepEqual(switched.selections, {});
    assert.equal(switched.unattributedAmount, '');
  });
  test('same driver keeps the draft', () => {
    const d = select(emptyAllocationDraft(DRIVER), collection());
    assert.equal(draftForDriver(d, DRIVER), d);
  });
  test('reconciling against another driver\'s data empties the draft', () => {
    const d = select(emptyAllocationDraft(DRIVER), collection());
    const r = reconcileDraft(d, { driverId: OTHER_DRIVER, items: [] }, { completeList: true });
    assert.equal(r.draft.driverId, OTHER_DRIVER);
    assert.deepEqual(r.draft.selections, {});
  });
});

describe('3. full allocations', () => {
  test('selecting defaults to the full outstanding amount and will release', () => {
    const c = collection();
    const d = select(emptyAllocationDraft(DRIVER), c);
    assert.equal(d.selections[c.releaseId].amount, '105.00');
    assert.equal(allocationRowStatus(d.selections[c.releaseId]), 'WILL_RELEASE');
    const body = buildAllocationRequest(d, { paymentMethodId: METHOD, notes: '' });
    assert.deepEqual(body, {
      driverId: DRIVER,
      amountReceived: '105.00',
      paymentMethodId: METHOD,
      allocations: [{ releaseId: c.releaseId, amount: '105.00' }],
    });
  });
  test('"Full" restores the outstanding amount after an edit', () => {
    const c = collection({ outstandingAmount: '65', allocatedAmount: '40', settlementState: 'PARTIALLY_SETTLED' });
    let d = select(emptyAllocationDraft(DRIVER), c);
    d = setAllocationAmount(d, c.releaseId, '10');
    d = setFullOutstanding(d, c.releaseId);
    assert.equal(d.selections[c.releaseId].amount, '65.00');
  });
});

describe('4. partial allocations', () => {
  test('a lower amount is a partial allocation and stays outstanding', () => {
    const c = collection();
    const d = setAllocationAmount(select(emptyAllocationDraft(DRIVER), c), c.releaseId, '40');
    assert.equal(allocationRowStatus(d.selections[c.releaseId]), 'PARTIAL');
    const v = validateAllocationDraft(d, position([c]));
    assert.ok(v.valid);
    assert.equal(v.amountReceivedCents, 4000n);
    const p = buildSettlementPreview(d, position([c]));
    assert.equal(p.partial.length, 1);
    assert.equal(p.partial[0].outstandingAfter, '65.00');
    assert.equal(p.willRelease.length, 0);
    assert.equal(p.expectedWalletCredit, '0.00', 'a partial allocation releases nothing');
  });
});

describe('5. multiple collections', () => {
  test('several selections sum exactly; submission order follows selection order', () => {
    const a = collection();
    const b = collection({ orderType: 'COMPANY_ORDER', collectionAmount: '90', outstandingAmount: '90', plannedCustomerWalletAmount: '0', plannedCompanyProductAmount: '85', plannedCompanyFeeAmount: '5' });
    const c = collection({ collectionAmount: '20.50', outstandingAmount: '20.50', plannedCustomerWalletAmount: '15.50', plannedCompanyFeeAmount: '5' });
    const d = select(emptyAllocationDraft(DRIVER), a, b, c);
    const body = buildAllocationRequest(d, { paymentMethodId: METHOD, notes: '  handed over  ' });
    assert.equal(body.amountReceived, '215.50');
    assert.deepEqual(body.allocations?.map((x) => x.releaseId), [a.releaseId, b.releaseId, c.releaseId]);
    assert.equal(body.notes, 'handed over');
  });
  test('deselect and clear', () => {
    const a = collection();
    const b = collection();
    let d = select(emptyAllocationDraft(DRIVER), a, b);
    d = deselectCollection(d, a.releaseId);
    assert.deepEqual(Object.keys(d.selections), [b.releaseId]);
    assert.deepEqual(clearSelections(d).selections, {});
  });
  test('the allocation limit is enforced on select and preselect', () => {
    const items = Array.from({ length: MAX_ALLOCATIONS_PER_SETTLEMENT + 3 }, () => collection({ outstandingAmount: '1', collectionAmount: '1' }));
    let d = emptyAllocationDraft(DRIVER);
    for (const item of items.slice(0, MAX_ALLOCATIONS_PER_SETTLEMENT)) d = select(d, item);
    const over = selectCollection(d, items[MAX_ALLOCATIONS_PER_SETTLEMENT]);
    assert.deepEqual(over, { ok: false, reason: 'LIMIT_REACHED' });
    const pre = preselectOldestFirst(emptyAllocationDraft(DRIVER), items, '');
    assert.equal(Object.keys(pre!.selections).length, MAX_ALLOCATIONS_PER_SETTLEMENT);
  });
  test('oldest-first preselection fills up to a target, last row partial, never auto-submitted', () => {
    const newest = collection({ deliveredAt: '2026-10-20T10:00:00.000Z' });
    const oldest = collection({ deliveredAt: '2026-10-01T10:00:00.000Z' });
    const middle = collection({ deliveredAt: '2026-10-05T10:00:00.000Z' });
    const d = preselectOldestFirst(emptyAllocationDraft(DRIVER), [newest, oldest, middle], '150');
    assert.ok(d);
    assert.deepEqual(
      Object.values(d.selections).map((s) => [s.item.releaseId, s.amount]),
      [
        [oldest.releaseId, '105.00'],
        [middle.releaseId, '45.00'],
      ],
    );
    assert.equal(preselectOldestFirst(emptyAllocationDraft(DRIVER), [newest], 'abc'), null);
    assert.equal(preselectOldestFirst(emptyAllocationDraft(DRIVER), [newest], '0'), null);
  });
  test('ineligible collections (voided, released, nothing outstanding) are never selectable', () => {
    for (const bad of [
      collection({ releaseStatus: 'VOIDED' }),
      collection({ releaseStatus: 'RELEASED' }),
      collection({ releaseStatus: 'RELEASE_REVERSED' }),
      collection({ outstandingAmount: '0', allocatedAmount: '105', settlementState: 'FULLY_SETTLED' }),
    ]) {
      assert.equal(isSelectable(bad), false);
      assert.deepEqual(selectCollection(emptyAllocationDraft(DRIVER), bad), { ok: false, reason: 'NOT_SELECTABLE' });
    }
    const pre = preselectOldestFirst(emptyAllocationDraft(DRIVER), [collection({ releaseStatus: 'VOIDED' })], '');
    assert.deepEqual(pre!.selections, {});
  });
});

describe('6. unattributed amounts', () => {
  test('unattributed-only settlement still sends an explicit empty allocations array', () => {
    const d = { ...emptyAllocationDraft(DRIVER), unattributedAmount: '45', unattributedReason: 'Legacy cash collected in September' };
    const v = validateAllocationDraft(d, position([]));
    assert.ok(v.valid, JSON.stringify(v.formErrors));
    const body = buildAllocationRequest(d, { paymentMethodId: METHOD, notes: '' });
    assert.deepEqual(body.allocations, []);
    assert.equal(body.amountReceived, '45.00');
    assert.equal(body.unattributedAmount, '45.00');
    assert.equal(body.unattributedReason, 'Legacy cash collected in September');
  });
  test('a positive unattributed amount requires a reason of at least 10 characters', () => {
    const d = { ...emptyAllocationDraft(DRIVER), unattributedAmount: '5', unattributedReason: ' short ' };
    const v = validateAllocationDraft(d, position([]));
    assert.equal(v.valid, false);
    assert.ok(v.unattributedReasonError);
  });
  test('unattributed cannot exceed the driver\'s unattributed cash (never money reserved for orders)', () => {
    const d = { ...emptyAllocationDraft(DRIVER), unattributedAmount: '200.01', unattributedReason: 'Cash from older deliveries' };
    const v = validateAllocationDraft(d, position([], { unattributedBalance: '200' }));
    assert.equal(v.valid, false);
    assert.match(v.unattributedAmountError ?? '', /200\.00/);
  });
  test('zero unattributed sends no unattributed fields and needs no reason', () => {
    const c = collection();
    const d = { ...select(emptyAllocationDraft(DRIVER), c), unattributedAmount: '0' };
    const body = buildAllocationRequest(d, { paymentMethodId: METHOD, notes: '' });
    assert.equal('unattributedAmount' in body, false);
    assert.equal('unattributedReason' in body, false);
    assert.ok(validateAllocationDraft(d, position([c])).valid);
  });
});

describe('7. decimal precision', () => {
  test('cents arithmetic is exact (0.10 + 0.20 = 0.30, no float drift)', () => {
    const a = collection({ collectionAmount: '0.10', outstandingAmount: '0.10' });
    const b = collection({ collectionAmount: '0.20', outstandingAmount: '0.20' });
    const d = { ...select(emptyAllocationDraft(DRIVER), a, b), unattributedAmount: '0.01', unattributedReason: 'Rounding coin from route' };
    const body = buildAllocationRequest(d, { paymentMethodId: METHOD, notes: '' });
    assert.equal(body.amountReceived, '0.31');
  });
  test('amountReceived = Σ allocations + unattributed holds exactly for large values', () => {
    const a = collection({ collectionAmount: '999999999999.99', outstandingAmount: '999999999999.99' });
    const d = { ...select(emptyAllocationDraft(DRIVER), a), unattributedAmount: '0.01', unattributedReason: 'Exact cent check value' };
    const v = validateAllocationDraft(d, position([a], { cashBalance: '1000000000000.00', unattributedBalance: '1' }));
    assert.ok(v.valid, JSON.stringify(v.formErrors));
    assert.equal(v.amountReceivedCents, v.allocatedCents + v.unattributedCents);
    assert.equal(buildAllocationRequest(d, { paymentMethodId: METHOD, notes: '' }).amountReceived, '1000000000000.00');
  });
  test('server money strings are canonicalised ("105" → "105.00", "40.5" → "40.50")', () => {
    const c = collection({ outstandingAmount: '40.5' });
    assert.equal(select(emptyAllocationDraft(DRIVER), c).selections[c.releaseId].amount, '40.50');
  });
});

describe('8. invalid input', () => {
  test('per-row errors: blank, >2 decimals, zero, above outstanding', () => {
    const c = collection();
    const base = select(emptyAllocationDraft(DRIVER), c);
    const err = (amount: string) => validateAllocationDraft(setAllocationAmount(base, c.releaseId, amount), position([c])).rowErrors[c.releaseId];
    assert.equal(err(''), 'Enter an amount');
    assert.equal(err('1.234'), 'Enter an amount with at most 2 decimals');
    assert.equal(err('0'), 'Amount must be greater than zero');
    assert.match(err('105.01') ?? '', /Exceeds the outstanding \$105\.00/);
    assert.equal(err('105'), undefined);
  });
  test('nothing selected and no unattributed amount is not submittable', () => {
    const v = validateAllocationDraft(emptyAllocationDraft(DRIVER), position([]));
    assert.equal(v.valid, false);
    assert.equal(v.formErrors.length, 1);
  });
  test('a total above the cash held is rejected', () => {
    const c = collection();
    const v = validateAllocationDraft(select(emptyAllocationDraft(DRIVER), c), position([c], { cashBalance: '100' }));
    assert.equal(v.valid, false);
    assert.match(v.formErrors[0], /exceeds the cash held/);
  });
  test('legacy amount rules (no allocations, amount ≤ cash held)', () => {
    assert.equal(legacyAmountError('', '10'), 'Enter an amount');
    assert.equal(legacyAmountError('1.234', '10'), 'Enter an amount with at most 2 decimals');
    assert.equal(legacyAmountError('0', '10'), 'Amount must be greater than zero');
    assert.equal(legacyAmountError('10.01', '10'), 'Amount exceeds the cash held');
    assert.equal(legacyAmountError('10', '10'), null);
    const body = toCreateSettlementRequest({ driverId: DRIVER, amountReceived: '10', paymentMethodId: METHOD, notes: '' });
    assert.equal('allocations' in body, false, 'legacy body never carries allocations');
  });
});

describe('9. backend validation errors', () => {
  test('ALLOCATION_INVALID names the release and refreshes the position', () => {
    const k = classifySettlementError(
      apiError(400, 'VALIDATION_ERROR', 'Allocation for release rel-1 is invalid: amount exceeds the unsettled amount (40)', {
        reason: 'ALLOCATION_INVALID',
        releaseId: 'rel-1',
        problem: 'amount exceeds the unsettled amount (40)',
      }),
    );
    assert.deepEqual(k, { kind: 'ALLOCATION_INVALID', releaseId: 'rel-1', problem: 'amount exceeds the unsettled amount (40)' });
    assert.ok(needsPositionRefresh(k));
  });
  test('UNATTRIBUTED_EXCEEDS_BALANCE carries the server balance', () => {
    const k = classifySettlementError(
      apiError(400, 'VALIDATION_ERROR', 'unattributedAmount exceeds…', { reason: 'UNATTRIBUTED_EXCEEDS_BALANCE', unattributedBalance: '105' }),
    );
    assert.deepEqual(k, { kind: 'UNATTRIBUTED_EXCEEDS_BALANCE', unattributedBalance: '105' });
    assert.match(settlementErrorMessage(k), /cannot be taken from money reserved/);
  });
  test('ALLOCATION_CONTRACT_REQUIRED switches the dialog to the allocation format', () => {
    const k = classifySettlementError(
      apiError(400, 'VALIDATION_ERROR', "This driver's cash must be settled with explicit collection allocations", { reason: 'ALLOCATION_CONTRACT_REQUIRED' }),
    );
    assert.equal(k.kind, 'ALLOCATION_CONTRACT_REQUIRED');
    assert.equal(chooseSettlementFormat(position([], { attributedOutstanding: '0', outstandingCollectionCount: 0 }), true), 'ALLOCATION');
  });
  test('insufficient driver cash, plain validation, permission, not found, server', () => {
    assert.equal(classifySettlementError(apiError(400, 'VALIDATION_ERROR', 'Insufficient driver cash balance for this operation')).kind, 'INSUFFICIENT_CASH');
    assert.deepEqual(classifySettlementError(apiError(400, 'VALIDATION_ERROR', 'The specified payment method is not active')), { kind: 'VALIDATION', message: 'The specified payment method is not active' });
    assert.equal(classifySettlementError(apiError(403, 'FORBIDDEN', 'Forbidden')).kind, 'PERMISSION');
    assert.equal(classifySettlementError(apiError(404, 'NOT_FOUND', 'Driver not found')).kind, 'NOT_FOUND');
    assert.equal(classifySettlementError(apiError(500, 'INTERNAL_ERROR', 'x')).kind, 'SERVER');
  });
});

describe('10. stale collection conflicts', () => {
  test('409 "collection changed" is a stale conflict that refreshes the position', () => {
    const k = classifySettlementError(apiError(409, 'CONFLICT', 'A collection was changed by another request — please retry'));
    assert.equal(k.kind, 'STALE_COLLECTION');
    assert.ok(needsPositionRefresh(k));
  });
  test('reconcile removes collections no longer outstanding and flags over-allocation', () => {
    const gone = collection();
    const shrunk = collection();
    const same = collection();
    const d = select(emptyAllocationDraft(DRIVER), gone, shrunk, same);
    const fresh = {
      driverId: DRIVER,
      items: [{ ...shrunk, allocatedAmount: '100', outstandingAmount: '5', settlementState: 'PARTIALLY_SETTLED' as const }, same],
    };
    const r = reconcileDraft(d, fresh, { completeList: true });
    assert.deepEqual(r.removed, [gone.releaseId]);
    assert.deepEqual(r.overAllocated, [shrunk.releaseId]);
    assert.deepEqual(r.changed, [shrunk.releaseId]);
    assert.deepEqual(Object.keys(r.draft.selections), [shrunk.releaseId, same.releaseId]);
    assert.equal(r.draft.selections[shrunk.releaseId].amount, '105.00', 'never silently shrinks the typed amount');
    assert.equal(validateAllocationDraft(r.draft, position(fresh.items)).valid, false);
  });
  test('a difference resolved meanwhile is reported as changed (new planned split)', () => {
    const c = collection({ reviewStatus: 'AWAITING_REVIEW', plannedCustomerWalletAmount: null, plannedCompanyProductAmount: null, plannedCompanyFeeAmount: null });
    const d = select(emptyAllocationDraft(DRIVER), c);
    const r = reconcileDraft(d, { driverId: DRIVER, items: [{ ...c, reviewStatus: 'RESOLVED', plannedCustomerWalletAmount: '90', plannedCompanyProductAmount: '0', plannedCompanyFeeAmount: '5' }] }, { completeList: true });
    assert.deepEqual(r.changed, [c.releaseId]);
    assert.equal(r.draft.selections[c.releaseId].item.plannedCustomerWalletAmount, '90');
  });
  test('server rejection of a no-longer-eligible collection removes it (found by the browser check)', () => {
    // A collection settled by another user leaves the outstanding list; on a
    // paginated list it is indistinguishable from one on another page, so the
    // server's named rejection is what removes it.
    const gone = collection();
    const keep = collection();
    const d = select(emptyAllocationDraft(DRIVER), gone, keep);
    const r = applyAllocationRejection(d, gone.releaseId, 'collection is not eligible for settlement (RELEASED)');
    assert.equal(r.removed, true);
    assert.deepEqual(Object.keys(r.draft.selections), [keep.releaseId]);
    assert.match(r.message, new RegExp(`Order ${gone.order.orderNumber} can no longer be settled`));
    for (const problem of ['collection not found for this driver', 'collection has been reversed']) {
      assert.equal(applyAllocationRejection(d, gone.releaseId, problem).removed, true, problem);
    }
  });
  test('server rejection of an amount keeps the selection and names the order', () => {
    const c = collection();
    const d = select(emptyAllocationDraft(DRIVER), c);
    const r = applyAllocationRejection(d, c.releaseId, 'amount exceeds the unsettled amount (40)');
    assert.equal(r.removed, false);
    assert.equal(r.draft, d);
    assert.match(r.message, new RegExp(`Order ${c.order.orderNumber}: amount exceeds`));
  });
  test('on a paginated list, selections from other pages are kept for the server to judge', () => {
    const elsewhere = collection();
    const d = select(emptyAllocationDraft(DRIVER), elsewhere);
    const r = reconcileDraft(d, { driverId: DRIVER, items: [] }, { completeList: false });
    assert.deepEqual(r.removed, []);
    assert.deepEqual(Object.keys(r.draft.selections), [elsewhere.releaseId]);
  });
});

describe('11. idempotent retry behavior', () => {
  const gen = (() => {
    let n = 0;
    return () => `key-${++n}`;
  })();
  test('same body reuses the key after an ambiguous (transport) failure', () => {
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, 'body-A', gen);
    assert.ok(first.ok);
    const failed = afterFailure(first.state, true);
    const retry = resolveIdempotencyKey(failed, 'body-A', gen);
    assert.ok(retry.ok);
    assert.equal(retry.key, first.key);
  });
  test('a different body after an ambiguous failure is refused (never a second settlement)', () => {
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, 'body-A', gen);
    assert.ok(first.ok);
    const failed = afterFailure(first.state, true);
    assert.deepEqual(resolveIdempotencyKey(failed, 'body-B', gen), { ok: false, reason: 'AMBIGUOUS_PENDING' });
    // Ambiguity is sticky even if a later retry fails definitively.
    assert.equal(afterFailure(failed, false).ambiguous, true);
  });
  test('a changed body after a definitive failure gets a new key; the same body keeps it', () => {
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, 'body-A', gen);
    assert.ok(first.ok);
    const failed = afterFailure(first.state, false);
    const same = resolveIdempotencyKey(failed, 'body-A', gen);
    const changed = resolveIdempotencyKey(failed, 'body-B', gen);
    assert.ok(same.ok && changed.ok);
    assert.equal(same.key, first.key);
    assert.notEqual(changed.key, first.key);
  });
  test('success clears the key: the next settlement is a new intent', () => {
    const first = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, 'body-A', gen);
    assert.ok(first.ok);
    const next = resolveIdempotencyKey(afterSuccess(), 'body-A', gen);
    assert.ok(next.ok);
    assert.notEqual(next.key, first.key);
  });
  test('transport failure and idempotency conflict are classified distinctly', () => {
    assert.equal(classifySettlementError({ status: 'FETCH_ERROR', error: 'TypeError: Failed to fetch' }).kind, 'TRANSPORT');
    assert.equal(classifySettlementError({ status: 'TIMEOUT_ERROR', error: 'timeout' }).kind, 'TRANSPORT');
    const conflict = classifySettlementError(apiError(409, 'CONFLICT', 'Idempotency key was already used for a different request.'));
    assert.equal(conflict.kind, 'IDEMPOTENCY_CONFLICT');
    assert.match(settlementErrorMessage(conflict), /settlement history/);
  });
});

describe('12. double-submit prevention', () => {
  test('two submissions of one intent resolve to ONE key (the server replays, never re-executes)', () => {
    let calls = 0;
    const gen = () => `k-${++calls}`;
    const a = resolveIdempotencyKey(INITIAL_IDEMPOTENCY_STATE, 'body', gen);
    assert.ok(a.ok);
    const b = resolveIdempotencyKey(a.state, 'body', gen);
    assert.ok(b.ok);
    assert.equal(a.key, b.key);
    assert.equal(calls, 1);
  });
  test('the request body is deterministic for an unchanged draft (stable key binding)', () => {
    const c = collection();
    const d = { ...select(emptyAllocationDraft(DRIVER), c), unattributedAmount: '5', unattributedReason: 'Legacy coins from the route' };
    const s1 = JSON.stringify(buildAllocationRequest(d, { paymentMethodId: METHOD, notes: 'x' }));
    const s2 = JSON.stringify(buildAllocationRequest(d, { paymentMethodId: METHOD, notes: 'x' }));
    assert.equal(s1, s2);
  });
});

describe('13. settlement preview', () => {
  test('groups rows and sums only backend planned amounts of releasing collections', () => {
    const full = collection();
    const company = collection({ orderType: 'COMPANY_ORDER', collectionAmount: '90', outstandingAmount: '90', plannedCustomerWalletAmount: '0', plannedCompanyProductAmount: '85', plannedCompanyFeeAmount: '5' });
    const partial = collection();
    const review = collection({ collectionAmount: '95', outstandingAmount: '95', reviewStatus: 'AWAITING_REVIEW', plannedCustomerWalletAmount: null, plannedCompanyProductAmount: null, plannedCompanyFeeAmount: null });
    let d = select(emptyAllocationDraft(DRIVER), full, company, partial, review);
    d = setAllocationAmount(d, partial.releaseId, '30');
    d = { ...d, unattributedAmount: '20', unattributedReason: 'Legacy collections before cutover' };
    const p = buildSettlementPreview(d, position([full, company, partial, review], { cashBalance: '500' }));
    assert.deepEqual(p.willRelease.map((r) => r.releaseId), [full.releaseId, company.releaseId]);
    assert.deepEqual(p.partial.map((r) => r.releaseId), [partial.releaseId]);
    assert.deepEqual(p.awaitingReview.map((r) => r.releaseId), [review.releaseId]);
    assert.equal(p.expectedWalletCredit, '100.00');
    assert.equal(p.expectedProductRevenue, '85.00');
    assert.equal(p.expectedDeliveryFee, '10.00');
    assert.equal(p.allocated, '320.00');
    assert.equal(p.unattributed, '20.00');
    assert.equal(p.amountReceived, '340.00');
    assert.equal(p.cashAfter, '160.00');
  });
  test('a releasing row without a planned split is flagged, never guessed', () => {
    const odd = collection({ reviewStatus: 'RESOLVED', plannedCustomerWalletAmount: null, plannedCompanyProductAmount: null, plannedCompanyFeeAmount: null });
    const p = buildSettlementPreview(select(emptyAllocationDraft(DRIVER), odd), position([odd]));
    assert.equal(p.willRelease.length, 0);
    assert.equal(p.missingPlannedSplit.length, 1);
    assert.equal(p.expectedWalletCredit, '0.00');
  });
  test('a COMPANY_ORDER release never plans a wallet credit', () => {
    const company = collection({ orderType: 'COMPANY_ORDER', plannedCustomerWalletAmount: '0', plannedCompanyProductAmount: '100', plannedCompanyFeeAmount: '5' });
    const p = buildSettlementPreview(select(emptyAllocationDraft(DRIVER), company), position([company]));
    assert.equal(p.expectedWalletCredit, '0.00');
    assert.equal(p.expectedProductRevenue, '100.00');
  });
  test('row status labels', () => {
    assert.equal(ALLOCATION_ROW_STATUS.WILL_RELEASE.label, 'Will release');
    assert.equal(ALLOCATION_ROW_STATUS.SETTLES_AWAITS_REVIEW.label, 'Settles; awaits review');
    assert.equal(ALLOCATION_ROW_STATUS.PARTIAL.label, 'Partial');
  });
});

function detail(over: Partial<SettlementDetail> = {}): SettlementDetail {
  return {
    id: 'set-1',
    settlementNumber: 'SET-0001',
    driver: { id: DRIVER, driverNumber: 'D-1', user: { firstName: 'Ali', lastName: 'Hassan', phone: null } } as SettlementDetail['driver'],
    balanceBefore: '500',
    amountReceived: '150',
    balanceAfter: '350',
    allocatedTotal: '130',
    unattributedAmount: '20',
    unattributedReason: 'Legacy cash collected before cutover',
    reversed: false,
    shortfallTotal: '0',
    paymentMethod: { id: METHOD, code: 'CASH', name: 'Cash' } as SettlementDetail['paymentMethod'],
    receivedBy: { id: 'u1', firstName: 'Fin', lastName: 'Ance' },
    notes: null,
    createdAt: '2026-10-18T10:00:00.000Z',
    format: 'ALLOCATION',
    allocations: [
      {
        id: 'a1', releaseId: 'r1', order: { id: 'o1', orderNumber: 'ORD-1' }, customer: { id: 'c1', customerNumber: 'C-1', name: 'ABC' },
        orderType: 'DELIVERY_ONLY', amount: '105', status: 'ACTIVE', reversedByCorrectionId: null, releasedByThisSettlement: true,
        collection: { collectionAmount: '105', allocatedAmount: '105', outstandingAmount: '0', settlementState: 'FULLY_SETTLED', releaseStatus: 'RELEASED', reviewStatus: 'NOT_REQUIRED' },
      },
      {
        id: 'a2', releaseId: 'r2', order: { id: 'o2', orderNumber: 'ORD-2' }, customer: { id: 'c2', customerNumber: 'C-2', name: 'XYZ' },
        orderType: 'COMPANY_ORDER', amount: '25', status: 'REVERSED', reversedByCorrectionId: 'k1', releasedByThisSettlement: false,
        collection: { collectionAmount: '90', allocatedAmount: '0', outstandingAmount: '90', settlementState: 'UNSETTLED', releaseStatus: 'PENDING', reviewStatus: 'NOT_REQUIRED' },
      },
    ],
    releasedOrders: [{ releaseId: 'r1', order: { id: 'o1', orderNumber: 'ORD-1' }, releasedAt: '2026-10-18T10:00:00.000Z' }],
    collectionsFullySettled: 1,
    collectionsPartiallySettled: 0,
    corrections: [],
    ...over,
  };
}

describe('14. settlement detail', () => {
  test('allocation settlement summary', () => {
    const s = describeSettlementDetail(detail());
    assert.equal(s.isLegacy, false);
    assert.equal(s.activeAllocationCount, 1);
    assert.equal(s.reversedAllocationCount, 1);
    assert.equal(s.releasedCount, 1);
    assert.equal(s.hasUnattributed, true);
    assert.deepEqual(s.notices, []);
  });
  test('reversal and shortfall notices are read-only information', () => {
    const s = describeSettlementDetail(detail({ reversed: true, shortfallTotal: '10.00' }));
    assert.equal(s.notices.length, 2);
    assert.match(s.notices[0], /reversed/);
    assert.match(s.notices[1], /shortfall/i);
  });
  test('labels for collection, release and review states', () => {
    assert.deepEqual(collectionStateLabel('PARTIALLY_SETTLED'), { label: 'Partially settled', tone: 'info' });
    assert.equal(releaseStatusLabel('RELEASED').label, 'Released');
    assert.equal(releaseStatusLabel('VOIDED').label, 'Collection voided');
    assert.equal(releaseStatusLabel('RELEASE_REVERSED').label, 'Release reversed');
    assert.equal(reviewStatusLabel('NOT_REQUIRED'), null);
    assert.equal(reviewStatusLabel('AWAITING_REVIEW')?.label, 'Under review');
  });
  test('a zero unattributed amount is not shown as unattributed', () => {
    assert.equal(describeSettlementDetail(detail({ unattributedAmount: '0', unattributedReason: null })).hasUnattributed, false);
  });
});

describe('15. legacy settlement display', () => {
  test('a legacy record has null allocation fields and a legacy notice', () => {
    const legacy = detail({ format: 'LEGACY', allocatedTotal: null, unattributedAmount: null, unattributedReason: null, allocations: [], releasedOrders: [] });
    assert.equal(isLegacySettlement(legacy), true);
    const s = describeSettlementDetail(legacy);
    assert.equal(s.isLegacy, true);
    assert.equal(s.hasUnattributed, false);
    assert.match(s.notices[0], /Legacy settlement/);
  });
  test('an allocation-format settlement with only unattributed cash is not legacy', () => {
    assert.equal(isLegacySettlement({ allocatedTotal: '0' }), false);
  });
});

describe('16. desktop and mobile states', () => {
  // The same pure state drives both the desktop table and the mobile cards;
  // these cover the empty / limit / error states each layout renders.
  test('no outstanding collections → unattributed-only allocation state is still valid', () => {
    const p = position([], { attributedOutstanding: '0', outstandingCollectionCount: 0, unattributedBalance: '50', cashBalance: '50' });
    const d = { ...emptyAllocationDraft(DRIVER), unattributedAmount: '50', unattributedReason: 'Cash left from legacy orders' };
    assert.ok(validateAllocationDraft(d, p).valid);
    assert.equal(buildSettlementPreview(d, p).cashAfter, '0.00');
  });
  test('row errors are keyed by releaseId so either layout can place them', () => {
    const c = collection();
    const d = setAllocationAmount(select(emptyAllocationDraft(DRIVER), c), c.releaseId, '999');
    assert.deepEqual(Object.keys(validateAllocationDraft(d, position([c])).rowErrors), [c.releaseId]);
  });
});

describe('17. permission restrictions', () => {
  test('processing needs settlements.create AND finance.read', () => {
    const finance = settlementCapabilities([PERMISSIONS.SETTLEMENTS_CREATE, PERMISSIONS.SETTLEMENTS_READ, PERMISSIONS.FINANCE_READ]);
    assert.equal(finance.canProcess, true);
    const noFinance = settlementCapabilities([PERMISSIONS.SETTLEMENTS_CREATE, PERMISSIONS.SETTLEMENTS_READ]);
    assert.equal(noFinance.canCreate, true);
    assert.equal(noFinance.canProcess, false);
    const readOnly = settlementCapabilities([PERMISSIONS.SETTLEMENTS_READ]);
    assert.equal(readOnly.canCreate, false);
    assert.equal(readOnly.canProcess, false);
  });
  test('order / driver links follow their own read permissions', () => {
    const c = settlementCapabilities([PERMISSIONS.ORDERS_READ]);
    assert.equal(c.canViewOrders, true);
    assert.equal(c.canViewDriver, false);
  });
  test('a 403 is reported as a permission error', () => {
    assert.match(settlementErrorMessage(classifySettlementError(apiError(403, 'FORBIDDEN', 'nope'))), /permission/);
  });
});

describe('18. cache invalidation', () => {
  test('legacy / unattributed-only: driver cash + summaries, never wallets or orders', () => {
    const tags = settlementInvalidationTags(DRIVER, { customerIds: [], orderIds: [] }, 'set-1');
    const ids = tags.map((t) => `${t.type}:${t.id}`);
    for (const t of ['Settlement:LIST', 'Settlement:set-1', `DriverCash:${DRIVER}`, 'DriverCash:SUMMARIES', 'DriverCash:ME', 'Finance:SUMMARY', 'Finance:TRANSACTIONS', 'Dashboard:ROOT', 'Report:LIST']) {
      assert.ok(ids.includes(t), t);
    }
    assert.ok(!tags.some((t) => t.type === 'Wallet' || t.type === 'Order' || t.type === 'WalletTransaction'));
  });
  test('allocations also refresh affected wallets, customers and orders (deduplicated)', () => {
    const tags = settlementInvalidationTags(DRIVER, { customerIds: ['c1', 'c1', 'c2'], orderIds: ['o1', 'o2'] });
    const ids = tags.map((t) => `${t.type}:${t.id}`);
    for (const t of ['Wallet:LIST', 'WalletTransaction:LIST', 'Order:LIST', 'Wallet:c1', 'Wallet:c2', 'Customer:c1', 'Customer:c2', 'Order:o1', 'Order:o2']) {
      assert.ok(ids.includes(t), t);
    }
    assert.equal(ids.filter((i) => i === 'Wallet:c1').length, 1);
  });
});
