import { PERMISSIONS } from '../../../../features/auth/permissions';
import type { OrderDetail } from '../../../../services/domain.types';

/**
 * PURE UI-visibility helper for the Management Order Detail action bar.
 *
 * It mirrors — but is NOT — the backend state machine. It only decides which
 * buttons/menu items are worth showing given the current permissions and the
 * obviously-current Order state. Every action is still fully validated
 * server-side (order.service.ts); a stale check here just means the backend
 * returns 400/409 and the page reloads the real state.
 *
 * Status gates below are copied from order.service.ts:
 *   edit        -> EDITABLE_ORDER_STATUSES            (RECEIVED, READY_FOR_PICKUP, ASSIGNED)
 *   ready       -> readyOrder()                       (RECEIVED only)
 *   assign      -> INITIAL_ASSIGNMENT_SOURCE_STATUSES (RECEIVED, READY_FOR_PICKUP) + no current driver
 *   reassign    -> REASSIGNABLE_SOURCE_STATUSES       (ASSIGNED, RESCHEDULED) + has current driver
 *   reschedule  -> rescheduleOrder()                  (FAILED_DELIVERY only)
 *   cancel      -> CANCELLABLE_STATUSES               (RECEIVED, READY_FOR_PICKUP, ASSIGNED, FAILED_DELIVERY, RESCHEDULED)
 */

export interface OrderDetailActionAvailability {
  canEdit: boolean;
  canMarkReady: boolean;
  canAssign: boolean;
  canReassign: boolean;
  canReschedule: boolean;
  canCancel: boolean;
  /** True when at least one mutating action is available. */
  hasAnyAction: boolean;
}

const EDITABLE_STATUSES = new Set([
  'RECEIVED',
  'READY_FOR_PICKUP',
  'ASSIGNED',
]);
const INITIAL_ASSIGNMENT_STATUSES = new Set(['RECEIVED', 'READY_FOR_PICKUP']);
const REASSIGNABLE_STATUSES = new Set(['ASSIGNED', 'RESCHEDULED']);
const CANCELLABLE_STATUSES = new Set([
  'RECEIVED',
  'READY_FOR_PICKUP',
  'ASSIGNED',
  'FAILED_DELIVERY',
  'RESCHEDULED',
]);

export function getOrderDetailActions(
  order: Pick<OrderDetail, 'status' | 'currentDriver'>,
  permissions: readonly string[],
): OrderDetailActionAvailability {
  const has = (p: string) => permissions.includes(p);
  const { status } = order;
  const assigned = order.currentDriver != null;

  const canEdit =
    has(PERMISSIONS.ORDERS_UPDATE) && EDITABLE_STATUSES.has(status);
  const canMarkReady =
    has(PERMISSIONS.ORDERS_CHANGE_STATUS) && status === 'RECEIVED';
  const canAssign =
    has(PERMISSIONS.ORDERS_ASSIGN) &&
    !assigned &&
    INITIAL_ASSIGNMENT_STATUSES.has(status);
  const canReassign =
    has(PERMISSIONS.ORDERS_ASSIGN) &&
    assigned &&
    REASSIGNABLE_STATUSES.has(status);
  const canReschedule =
    has(PERMISSIONS.ORDERS_CHANGE_STATUS) && status === 'FAILED_DELIVERY';
  const canCancel =
    has(PERMISSIONS.ORDERS_CANCEL) && CANCELLABLE_STATUSES.has(status);

  return {
    canEdit,
    canMarkReady,
    canAssign,
    canReassign,
    canReschedule,
    canCancel,
    hasAnyAction:
      canEdit ||
      canMarkReady ||
      canAssign ||
      canReassign ||
      canReschedule ||
      canCancel,
  };
}
