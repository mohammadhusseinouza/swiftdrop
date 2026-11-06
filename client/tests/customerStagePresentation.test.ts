// Customer Portal Redesign Step 1 — StageProgress / StatusPill presentation.
// Pure logic, Node's built-in runner (same approach as the other client tests). Run:
//   npx --prefix ../server tsx --test tests/customerStagePresentation.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  getCustomerPillPresentation,
  getCustomerStageLabels,
  getCustomerStageNumber,
} from '../src/components/customer/customerStagePresentation';
import { getCustomerStatusPresentation } from '../src/components/orders/orderStatus';

describe('customer stage presentation', () => {
  test('stage labels come from the canonical customer-safe mapping', () => {
    assert.deepEqual(getCustomerStageLabels(), [
      'Order Received',
      'Ready for Delivery',
      'Out for Delivery',
      'Delivered',
    ]);
  });

  test('status → stage follows page_structure §40 grouping', () => {
    assert.equal(getCustomerStageNumber('RECEIVED'), 1);
    for (const s of ['READY_FOR_PICKUP', 'ASSIGNED', 'PICKED_UP']) {
      assert.equal(getCustomerStageNumber(s), 2, s);
    }
    assert.equal(getCustomerStageNumber('OUT_FOR_DELIVERY'), 3);
    assert.equal(getCustomerStageNumber('DELIVERED'), 4);
  });

  test('exception and unknown statuses are not drawn as a stage', () => {
    for (const s of [
      'FAILED_DELIVERY',
      'RESCHEDULED',
      'RETURNED_TO_COMPANY',
      'RETURNED_TO_CUSTOMER',
      'CANCELLED',
      'SOMETHING_NEW',
    ]) {
      assert.equal(getCustomerStageNumber(s), null, s);
    }
  });

  test('pill wording is the canonical customer wording for every status', () => {
    for (const s of ['RECEIVED', 'ASSIGNED', 'FAILED_DELIVERY', 'RESCHEDULED', 'CANCELLED', 'X']) {
      assert.equal(getCustomerPillPresentation(s).label, getCustomerStatusPresentation(s).label);
    }
  });

  test('pill tones follow handoff §3.2', () => {
    assert.equal(getCustomerPillPresentation('RECEIVED').tone, 'neutral');
    assert.equal(getCustomerPillPresentation('PICKED_UP').tone, 'neutral-strong');
    assert.equal(getCustomerPillPresentation('OUT_FOR_DELIVERY').tone, 'brand');
    assert.equal(getCustomerPillPresentation('DELIVERED').tone, 'success');
    assert.equal(getCustomerPillPresentation('FAILED_DELIVERY').tone, 'warning');
    assert.equal(getCustomerPillPresentation('RESCHEDULED').tone, 'warning');
    assert.equal(getCustomerPillPresentation('CANCELLED').tone, 'neutral');
  });

  test('no second status mapping: presentation file names no internal status beyond the four representatives', () => {
    const src = readFileSync(
      new URL('../src/components/customer/customerStagePresentation.ts', import.meta.url),
      'utf8',
    );
    for (const s of ['ASSIGNED', 'PICKED_UP', 'FAILED_DELIVERY', 'RESCHEDULED', 'RETURNED_TO', 'CANCELLED']) {
      assert.ok(!new RegExp(`'${s}`).test(src), `unexpected literal ${s}`);
    }
  });
});
