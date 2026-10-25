// FR.10 closure — financial-status filter (all seven statuses) and the
// generic-reversal safety for dedicated correction workflows. Same lightweight
// approach as orderDetailActions.test.ts (Node's built-in runner, outside
// src/). Run:
//   npx --prefix ../server tsx --test tests/fr10Closure.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  FINANCIAL_STATUSES,
  getFinancialStatusPresentation,
} from '../src/components/finance/financialRelease';
import {
  EMPTY_ORDERS_STATE,
  hasActiveFilters,
  parseOrdersListParams,
  serializeOrdersListParams,
  toListOrdersParams,
} from '../src/pages/management/orders/ordersListParams';
import {
  DEDICATED_WORKFLOW_LABEL,
  classifyReverseRejection,
  isReversibleType,
  reverseActionState,
  type DedicatedWorkflow,
} from '../src/components/finance/ledgerCorrection';

const NEW = ['AWAITING_SETTLEMENT', 'COLLECTION_VOIDED', 'RELEASE_REVERSED'] as const;

/* -------------------------- 1-5. status filter -------------------------- */

describe('1. all seven financial-status filter options', () => {
  test('the option list is the full enum, each with a human label', () => {
    assert.deepEqual([...FINANCIAL_STATUSES].sort(), [
      'AWAITING_SETTLEMENT',
      'COLLECTION_VOIDED',
      'FINALIZED',
      'NOT_APPLICABLE',
      'PENDING',
      'RELEASE_REVERSED',
      'REVIEW_REQUIRED',
    ]);
    for (const s of NEW) assert.ok(FINANCIAL_STATUSES.includes(s), s);
    for (const s of FINANCIAL_STATUSES) assert.notEqual(getFinancialStatusPresentation(s).label, s);
  });
  test('the exact enum value is sent to the backend', () => {
    for (const s of FINANCIAL_STATUSES) {
      assert.equal(toListOrdersParams(parseOrdersListParams(new URLSearchParams({ financialStatus: s }))).financialStatus, s);
    }
  });
});

describe('2. URL query parameter persistence (refresh)', () => {
  test('select -> URL -> reload parses back to the same filter, with other filters intact', () => {
    for (const s of NEW) {
      const selected = { ...EMPTY_ORDERS_STATE, financialStatus: s, orderType: 'DELIVERY_ONLY', page: 3 };
      const url = serializeOrdersListParams(selected).toString();
      assert.match(url, new RegExp(`financialStatus=${s}`));
      const reloaded = parseOrdersListParams(new URLSearchParams(url));
      assert.equal(reloaded.financialStatus, s);
      assert.equal(reloaded.orderType, 'DELIVERY_ONLY');
      assert.equal(reloaded.page, 3);
    }
  });
});

describe('3. browser Back / Forward', () => {
  test('each history entry restores its own filter (the URL is the only source of truth)', () => {
    const history = [EMPTY_ORDERS_STATE, ...NEW.map((s) => ({ ...EMPTY_ORDERS_STATE, financialStatus: s }))].map((st) =>
      serializeOrdersListParams(st).toString(),
    );
    // Walk back and forward through the stack: parsing each entry yields that entry's filter.
    const expected = ['', ...NEW];
    for (const i of [3, 2, 1, 0, 1, 2, 3]) {
      assert.equal(parseOrdersListParams(new URLSearchParams(history[i])).financialStatus, expected[i]);
    }
  });
});

describe('4. clearing the filter', () => {
  test('removing the status restores the unfiltered request', () => {
    const filtered = { ...EMPTY_ORDERS_STATE, financialStatus: 'COLLECTION_VOIDED' };
    const cleared = { ...filtered, financialStatus: '' };
    assert.equal(serializeOrdersListParams(cleared).has('financialStatus'), false);
    assert.equal(toListOrdersParams(cleared).financialStatus, undefined);
    assert.equal(hasActiveFilters(cleared), false);
  });
});

describe('5. invalid URL parameters', () => {
  test('unknown, wrong-case or empty values are dropped safely (never sent)', () => {
    for (const bad of ['awaiting_settlement', 'DELIVERED', 'NOT_A_STATUS', '', ' RELEASE_REVERSED']) {
      const st = parseOrdersListParams(new URLSearchParams({ financialStatus: bad }));
      assert.equal(st.financialStatus, '', JSON.stringify(bad));
      assert.equal(toListOrdersParams(st).financialStatus, undefined);
    }
  });
});

/* -------------------- 6-10. generic reversal safety --------------------- */

const none = new Map<string, DedicatedWorkflow>();

describe('6. generic reversal eligibility', () => {
  test('eligible rows keep the generic Reverse action', () => {
    assert.deepEqual(reverseActionState({ id: 't1', type: 'ORDER_CREDIT' }, { canReverse: true, dedicated: none }), { kind: 'REVERSE' });
    assert.deepEqual(reverseActionState({ id: 't2', type: 'COLLECTION' }, { canReverse: true, dedicated: none }), { kind: 'REVERSE' });
  });
  test('a REVERSAL row is never reversible', () => {
    assert.equal(isReversibleType('REVERSAL'), false);
    assert.deepEqual(reverseActionState({ id: 't3', type: 'REVERSAL' }, { canReverse: true, dedicated: none }), { kind: 'NONE' });
  });
});

describe('7. release-linked transactions', () => {
  test("the backend's 409 USE_RELEASE_CORRECTION is a dedicated workflow, not 'already reversed'", () => {
    const r = classifyReverseRejection(409, { reason: 'USE_RELEASE_CORRECTION' }, 'This wallet credit was posted by a financial release — use the release reversal workflow');
    assert.deepEqual(r, {
      kind: 'DEDICATED_WORKFLOW',
      workflow: 'RELEASE_CORRECTION',
      message: 'This wallet credit was posted by a financial release — use the release reversal workflow',
    });
    const s = classifyReverseRejection(409, { reason: 'USE_SETTLEMENT_CORRECTION' }, 'This settlement has collection allocations — use the settlement reversal workflow');
    assert.equal(s.kind === 'DEDICATED_WORKFLOW' && s.workflow, 'SETTLEMENT_CORRECTION');
  });
  test('after that answer the row shows the explanation instead of Reverse (row still listed)', () => {
    const dedicated = new Map<string, DedicatedWorkflow>([
      ['rel-credit', 'RELEASE_CORRECTION'],
      ['alloc-settlement', 'SETTLEMENT_CORRECTION'],
    ]);
    assert.deepEqual(reverseActionState({ id: 'rel-credit', type: 'ORDER_CREDIT' }, { canReverse: true, dedicated }), {
      kind: 'DEDICATED',
      label: 'Requires financial release correction',
    });
    assert.deepEqual(reverseActionState({ id: 'alloc-settlement', type: 'SETTLEMENT' }, { canReverse: true, dedicated }), {
      kind: 'DEDICATED',
      label: 'Requires settlement correction',
    });
    assert.equal(DEDICATED_WORKFLOW_LABEL.RELEASE_CORRECTION, 'Requires financial release correction');
  });
  test('eligibility is never inferred from row data alone', () => {
    // Identical-looking rows: only the backend answer distinguishes them.
    const a = { id: 'a', type: 'ORDER_CREDIT' };
    const b = { id: 'b', type: 'ORDER_CREDIT' };
    const dedicated = new Map<string, DedicatedWorkflow>([['a', 'RELEASE_CORRECTION']]);
    assert.equal(reverseActionState(a, { canReverse: true, dedicated }).kind, 'DEDICATED');
    assert.equal(reverseActionState(b, { canReverse: true, dedicated }).kind, 'REVERSE');
  });
});

describe('8. legacy transaction compatibility', () => {
  test("a plain 409 (no details.reason) is still 'already reversed'", () => {
    assert.deepEqual(classifyReverseRejection(409, undefined, 'already reversed'), { kind: 'ALREADY_REVERSED' });
    assert.deepEqual(classifyReverseRejection(409, { reason: 'SOMETHING_ELSE' }, 'x'), { kind: 'ALREADY_REVERSED' });
  });
  test('non-409 failures are left to the existing handling', () => {
    for (const status of [400, 403, 404, 500, 'FETCH_ERROR'] as const) {
      assert.deepEqual(classifyReverseRejection(status, { reason: 'USE_RELEASE_CORRECTION' }, 'x'), { kind: 'OTHER' });
    }
  });
});

describe('9. permission restrictions', () => {
  test('without the adjust permission there is no control at all — not even the explanation', () => {
    const dedicated = new Map<string, DedicatedWorkflow>([['x', 'RELEASE_CORRECTION']]);
    assert.deepEqual(reverseActionState({ id: 'x', type: 'ORDER_CREDIT' }, { canReverse: false, dedicated }), { kind: 'NONE' });
    assert.deepEqual(reverseActionState({ id: 'y', type: 'ORDER_CREDIT' }, { canReverse: false, dedicated: none }), { kind: 'NONE' });
  });
});

describe('10. desktop and mobile action visibility', () => {
  test('desktop columns and mobile cards render from the same state, so they always agree', () => {
    const dedicated = new Map<string, DedicatedWorkflow>([['m', 'SETTLEMENT_CORRECTION']]);
    const rows = [
      { id: 'm', type: 'SETTLEMENT' },
      { id: 'n', type: 'SETTLEMENT' },
      { id: 'o', type: 'REVERSAL' },
    ];
    const desktop = rows.map((r) => reverseActionState(r, { canReverse: true, dedicated }).kind);
    const mobile = rows.map((r) => reverseActionState(r, { canReverse: true, dedicated }).kind);
    assert.deepEqual(desktop, ['DEDICATED', 'REVERSE', 'NONE']);
    assert.deepEqual(mobile, desktop);
  });
});
