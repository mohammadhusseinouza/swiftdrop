// FR.10.1 — generic Reverse driven by backend correction eligibility. Same
// lightweight approach as orderDetailActions.test.ts. Run:
//   npx --prefix ../server tsx --test tests/fr101Eligibility.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyReverseRejection,
  reverseActionState,
  type DedicatedWorkflow,
  type RowCorrectionEligibility,
} from '../src/components/finance/ledgerCorrection';

const none = new Map<string, DedicatedWorkflow>();
const row = (over: RowCorrectionEligibility & { id?: string; type?: string } = {}) => ({
  id: 'tx-1',
  type: 'ORDER_CREDIT',
  correctionWorkflow: 'GENERIC' as const,
  canReverseGenerically: true,
  reversed: false,
  ...over,
});
const state = (r: ReturnType<typeof row>, canReverse = true, dedicated = none) => reverseActionState(r, { canReverse, dedicated });

describe('1. button visibility', () => {
  test('Reverse only when the backend says generically reversible and the user may reverse', () => {
    assert.deepEqual(state(row()), { kind: 'REVERSE' });
    assert.deepEqual(state(row(), false), { kind: 'NONE' });
    assert.deepEqual(state(row({ canReverseGenerically: false })), { kind: 'INFO', label: 'Not reversible' });
  });
});

describe('2. workflow explanations', () => {
  test('release- and settlement-linked rows explain the dedicated workflow', () => {
    assert.deepEqual(state(row({ correctionWorkflow: 'RELEASE_CORRECTION', canReverseGenerically: false })), {
      kind: 'DEDICATED',
      label: 'Requires financial release correction',
    });
    assert.deepEqual(state(row({ type: 'SETTLEMENT', correctionWorkflow: 'SETTLEMENT_CORRECTION', canReverseGenerically: false })), {
      kind: 'DEDICATED',
      label: 'Requires settlement correction',
    });
  });
});

describe('3. already-reversed transactions', () => {
  test('"Already reversed" wins over the workflow label (matches the backend check order)', () => {
    assert.deepEqual(state(row({ reversed: true, canReverseGenerically: false })), { kind: 'INFO', label: 'Already reversed' });
    assert.deepEqual(state(row({ correctionWorkflow: 'RELEASE_CORRECTION', canReverseGenerically: false, reversed: true })), {
      kind: 'INFO',
      label: 'Already reversed',
    });
  });
  test('a REVERSAL row never shows a control', () => {
    assert.deepEqual(state(row({ type: 'REVERSAL', canReverseGenerically: false })), { kind: 'NONE' });
  });
});

describe('4. desktop and mobile behavior', () => {
  test('both layouts render from the same state for every row', () => {
    const rows = [
      row({ id: 'a' }),
      row({ id: 'b', correctionWorkflow: 'RELEASE_CORRECTION', canReverseGenerically: false }),
      row({ id: 'c', reversed: true, canReverseGenerically: false }),
      row({ id: 'd', type: 'REVERSAL', canReverseGenerically: false }),
    ];
    const desktop = rows.map((r) => state(r).kind);
    const mobile = rows.map((r) => state(r).kind);
    assert.deepEqual(desktop, ['REVERSE', 'DEDICATED', 'INFO', 'NONE']);
    assert.deepEqual(mobile, desktop);
  });
});

describe('5. legacy transaction compatibility', () => {
  test('an eligible legacy / immediate-mode row keeps the generic Reverse', () => {
    assert.deepEqual(state(row({ type: 'COLLECTION' })), { kind: 'REVERSE' });
    assert.deepEqual(state(row({ type: 'PAYOUT' })), { kind: 'REVERSE' });
  });
  test('rows from an older API without eligibility fields keep the previous behaviour', () => {
    assert.deepEqual(reverseActionState({ id: 'x', type: 'ORDER_CREDIT' }, { canReverse: true, dedicated: none }), { kind: 'REVERSE' });
  });
});

describe('6. stale eligibility and backend conflicts', () => {
  test('a dedicated-workflow 409 seen this session overrides a stale "reversible" read', () => {
    const stale = row({ id: 'stale' });
    const r = classifyReverseRejection(409, { reason: 'USE_RELEASE_CORRECTION' }, 'use the release reversal workflow');
    assert.equal(r.kind, 'DEDICATED_WORKFLOW');
    const dedicated = new Map<string, DedicatedWorkflow>([['stale', 'RELEASE_CORRECTION']]);
    assert.deepEqual(state(stale, true, dedicated), { kind: 'DEDICATED', label: 'Requires financial release correction' });
  });
  test('a plain 409 is still "already reversed" (the dialog refetches, and the next read says reversed)', () => {
    assert.deepEqual(classifyReverseRejection(409, undefined, 'already'), { kind: 'ALREADY_REVERSED' });
    assert.deepEqual(state(row({ reversed: true, canReverseGenerically: false })), { kind: 'INFO', label: 'Already reversed' });
  });
});
