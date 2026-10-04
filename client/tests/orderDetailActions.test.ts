// Pure-logic test for the Management Order Detail Edit-action condition.
// The client has no test runner yet; this uses Node's built-in runner and
// lives outside src/ so it is not part of the client tsc/Vite build. Run:
//   npx --prefix ../server tsx --test tests/orderDetailActions.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS } from '../src/features/auth/permissions';
import {
  canEditOrder,
  getOrderDetailActions,
} from '../src/pages/management/orders/detail/orderDetailActions';

const NON_DELIVERED_STATUSES = [
  'RECEIVED',
  'READY_FOR_PICKUP',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'FAILED_DELIVERY',
  'RESCHEDULED',
  'RETURNED_TO_COMPANY',
  'RETURNED_TO_CUSTOMER',
  'CANCELLED',
];

const WITH_UPDATE = [PERMISSIONS.ORDERS_UPDATE];
const WITHOUT_UPDATE = [PERMISSIONS.ORDERS_ASSIGN, PERMISSIONS.ORDERS_CANCEL];

function order(status: string) {
  return {
    status,
    currentDriver: null,
    parcelCollectionStatus: 'RECEIVED_AT_COMPANY',
  } as Parameters<typeof getOrderDetailActions>[0];
}

describe('Order Detail Edit action', () => {
  for (const status of NON_DELIVERED_STATUSES) {
    test(`non-delivered (${status}) + orders.update -> Edit available`, () => {
      assert.equal(canEditOrder(status, WITH_UPDATE), true);
      const actions = getOrderDetailActions(order(status), WITH_UPDATE);
      assert.equal(actions.canEdit, true);
      assert.equal(actions.hasAnyAction, true);
    });
  }

  test('DELIVERED + orders.update -> Edit unavailable', () => {
    assert.equal(canEditOrder('DELIVERED', WITH_UPDATE), false);
    assert.equal(getOrderDetailActions(order('DELIVERED'), WITH_UPDATE).canEdit, false);
  });

  for (const status of [...NON_DELIVERED_STATUSES, 'DELIVERED']) {
    test(`no orders.update permission (${status}) -> Edit unavailable`, () => {
      assert.equal(canEditOrder(status, WITHOUT_UPDATE), false);
      assert.equal(canEditOrder(status, []), false);
      assert.equal(getOrderDetailActions(order(status), WITHOUT_UPDATE).canEdit, false);
    });
  }
});
