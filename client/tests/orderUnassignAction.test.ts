// Pure-logic test for the Management Order Detail Unassign Driver condition.
// Same lightweight approach as orderDetailActions.test.ts (Node's built-in
// runner, outside src/). Run:
//   npx --prefix ../server tsx --test tests/orderUnassignAction.test.ts
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSIONS } from '../src/features/auth/permissions';
import {
  canUnassignOrder,
  getOrderDetailActions,
} from '../src/pages/management/orders/detail/orderDetailActions';

type ActionOrder = Parameters<typeof getOrderDetailActions>[0];

const DRIVER = { id: 'drv-1', driverNumber: 'D-001', isActive: true };
const WITH_ASSIGN = [PERMISSIONS.ORDERS_ASSIGN];
const WITHOUT_ASSIGN = [
  PERMISSIONS.ORDERS_UPDATE,
  PERMISSIONS.ORDERS_CANCEL,
  PERMISSIONS.ORDERS_CHANGE_STATUS,
];

function order(
  status: string,
  opts: { driver?: boolean; pickedUpAt?: string | null } = {},
): ActionOrder {
  return {
    status,
    currentDriver: opts.driver === false ? null : DRIVER,
    pickedUpAt: opts.pickedUpAt ?? null,
    parcelCollectionStatus: 'RECEIVED_AT_COMPANY',
  } as ActionOrder;
}

function unassignAvailable(o: ActionOrder, permissions: readonly string[]) {
  const viaHelper = canUnassignOrder(o, permissions);
  const viaActions = getOrderDetailActions(o, permissions).canUnassign;
  assert.equal(viaHelper, viaActions, 'helper and action bar must agree');
  return viaActions;
}

describe('Order Detail Unassign Driver action', () => {
  test('assigned + before pickup + orders.assign -> Unassign available', () => {
    const o = order('ASSIGNED');
    assert.equal(unassignAvailable(o, WITH_ASSIGN), true);
    assert.equal(getOrderDetailActions(o, WITH_ASSIGN).hasAnyAction, true);
  });

  for (const status of [
    'PICKED_UP',
    'OUT_FOR_DELIVERY',
    'FAILED_DELIVERY',
    'RESCHEDULED',
    'DELIVERED',
    'RETURNED_TO_COMPANY',
    'RETURNED_TO_CUSTOMER',
  ]) {
    test(`picked up (${status}) + orders.assign -> Unassign unavailable`, () => {
      const o = order(status, { pickedUpAt: '2026-10-01T10:00:00.000Z' });
      assert.equal(unassignAvailable(o, WITH_ASSIGN), false);
    });
  }

  test('ASSIGNED with historical pickedUpAt (earlier driver picked up) + orders.assign -> Unassign available', () => {
    const o = order('ASSIGNED', { pickedUpAt: '2026-10-01T10:00:00.000Z' });
    assert.equal(unassignAvailable(o, WITH_ASSIGN), true);
    assert.equal(getOrderDetailActions(o, WITH_ASSIGN).canReassign, true);
  });

  test('ASSIGNED with historical pickedUpAt + no orders.assign -> Unassign unavailable', () => {
    const o = order('ASSIGNED', { pickedUpAt: '2026-10-01T10:00:00.000Z' });
    assert.equal(unassignAvailable(o, WITHOUT_ASSIGN), false);
  });

  test('RESCHEDULED with no driver (after unassign) -> Assign available, Unassign/Reassign unavailable', () => {
    const o = order('RESCHEDULED', { driver: false, pickedUpAt: '2026-10-01T10:00:00.000Z' });
    const actions = getOrderDetailActions(o, WITH_ASSIGN);
    assert.equal(actions.canAssign, true);
    assert.equal(actions.canUnassign, false);
    assert.equal(actions.canReassign, false);
    assert.equal(getOrderDetailActions(o, WITHOUT_ASSIGN).canAssign, false);
  });

  test('RESCHEDULED with its driver retained -> Assign unavailable, Reassign available', () => {
    const actions = getOrderDetailActions(order('RESCHEDULED'), WITH_ASSIGN);
    assert.equal(actions.canAssign, false);
    assert.equal(actions.canReassign, true);
  });

  for (const status of ['RECEIVED', 'READY_FOR_PICKUP', 'ASSIGNED', 'CANCELLED']) {
    test(`no assigned driver (${status}) -> Unassign unavailable`, () => {
      assert.equal(unassignAvailable(order(status, { driver: false }), WITH_ASSIGN), false);
    });
  }

  test('assigned + no orders.assign permission -> Unassign unavailable', () => {
    assert.equal(unassignAvailable(order('ASSIGNED'), WITHOUT_ASSIGN), false);
    assert.equal(unassignAvailable(order('ASSIGNED'), []), false);
  });

  test('Reassign remains available alongside Unassign', () => {
    const actions = getOrderDetailActions(order('ASSIGNED'), WITH_ASSIGN);
    assert.equal(actions.canUnassign, true);
    assert.equal(actions.canReassign, true);
  });
});
