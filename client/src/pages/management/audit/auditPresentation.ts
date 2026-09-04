import type { BadgeTone } from '../../../components/ui/Badge';
import { humanizeToken } from '../../../lib/format';

/**
 * PRESENTATION-ONLY helpers for the Audit Logs page. These never change a
 * stored code's meaning — they map codes to readable labels and supplemental
 * tones. An unknown/new action still renders (humanized) rather than
 * disappearing.
 */

/** Every audit action a producer in this codebase can currently write. */
export const KNOWN_AUDIT_ACTIONS = [
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_DEACTIVATED',
  'CUSTOMER_REACTIVATED',
  'DRIVER_CREATED',
  'DRIVER_UPDATED',
  'DRIVER_DEACTIVATED',
  'DRIVER_REACTIVATED',
  'EMPLOYEE_CREATED',
  'EMPLOYEE_UPDATED',
  'EMPLOYEE_DEACTIVATED',
  'EMPLOYEE_REACTIVATED',
  'CUSTOMER_PAYOUT_COMPLETED',
  'CUSTOMER_PAYOUT_REVERSED',
  'DRIVER_SETTLEMENT_COMPLETED',
  'DRIVER_SETTLEMENT_REVERSED',
  'WALLET_ADJUSTMENT_CREATED',
  'WALLET_TRANSACTION_REVERSED',
  'DRIVER_CASH_ADJUSTMENT_CREATED',
  'DRIVER_CASH_TRANSACTION_REVERSED',
  'COMPANY_FINANCIAL_ADJUSTMENT_CREATED',
  'COMPANY_FINANCIAL_TRANSACTION_REVERSED',
  'DELIVERY_ONLY_FINANCE_FINALIZED',
  'COMPANY_ORDER_FINANCE_FINALIZED',
  'COLLECTION_DIFFERENCE_RECORDED',
  'COLLECTION_DIFFERENCE_RESOLVED',
  'AREA_CREATED',
  'AREA_UPDATED',
  'AREA_DEACTIVATED',
  'AREA_REACTIVATED',
  'PAYMENT_METHOD_CREATED',
  'PAYMENT_METHOD_UPDATED',
  'PAYMENT_METHOD_DEACTIVATED',
  'PAYMENT_METHOD_REACTIVATED',
  'FAILED_DELIVERY_REASON_CREATED',
  'FAILED_DELIVERY_REASON_UPDATED',
  'FAILED_DELIVERY_REASON_DEACTIVATED',
  'FAILED_DELIVERY_REASON_REACTIVATED',
  'SYSTEM_SETTING_UPDATED',
  'ROLE_PERMISSIONS_UPDATED',
  // Parcel Intake & Collection (Phase 11.17.6, task §50-§51).
  'PARCEL_COLLECTION_DRIVER_ASSIGNED',
  'PARCEL_COLLECTION_DRIVER_REASSIGNED',
  'PARCEL_COLLECTION_RESCHEDULED',
  'PARCEL_RECEIPT_CONFIRMED',
  'FAILED_COLLECTION_REASON_CREATED',
  'FAILED_COLLECTION_REASON_UPDATED',
  'FAILED_COLLECTION_REASON_DEACTIVATED',
  'FAILED_COLLECTION_REASON_REACTIVATED',
] as const;

/** Every entity type an audit producer currently writes. */
export const KNOWN_AUDIT_ENTITY_TYPES = [
  'ORDER',
  'CUSTOMER',
  'DRIVER',
  'EMPLOYEE',
  'CUSTOMER_WALLET',
  'CUSTOMER_PAYOUT',
  'DRIVER_SETTLEMENT',
  'DRIVER_CASH_ACCOUNT',
  'WALLET_TRANSACTION',
  'DRIVER_CASH_TRANSACTION',
  'COMPANY_FINANCIAL_TRANSACTION',
  'AREA',
  'PAYMENT_METHOD',
  'FAILED_DELIVERY_REASON',
  'SYSTEM_SETTING',
  'ROLE',
  // Failed Collection Reasons config (Phase 11.17.6) — Parcel Collection
  // operational events (assign/reassign/reschedule/receipt) keep
  // entityType ORDER, since they are actions on an Order.
  'FAILED_COLLECTION_REASON',
] as const;

const ACTION_LABELS: Record<string, string> = {
  CUSTOMER_CREATED: 'Customer created',
  CUSTOMER_UPDATED: 'Customer updated',
  CUSTOMER_DEACTIVATED: 'Customer deactivated',
  CUSTOMER_REACTIVATED: 'Customer reactivated',
  DRIVER_CREATED: 'Driver created',
  DRIVER_UPDATED: 'Driver updated',
  DRIVER_DEACTIVATED: 'Driver deactivated',
  DRIVER_REACTIVATED: 'Driver reactivated',
  EMPLOYEE_CREATED: 'Employee created',
  EMPLOYEE_UPDATED: 'Employee updated',
  EMPLOYEE_DEACTIVATED: 'Employee deactivated',
  EMPLOYEE_REACTIVATED: 'Employee reactivated',
  CUSTOMER_PAYOUT_COMPLETED: 'Customer payout processed',
  CUSTOMER_PAYOUT_REVERSED: 'Customer payout reversed',
  DRIVER_SETTLEMENT_COMPLETED: 'Driver settlement recorded',
  DRIVER_SETTLEMENT_REVERSED: 'Driver settlement reversed',
  WALLET_ADJUSTMENT_CREATED: 'Wallet adjustment posted',
  WALLET_TRANSACTION_REVERSED: 'Wallet transaction reversed',
  DRIVER_CASH_ADJUSTMENT_CREATED: 'Driver cash adjustment posted',
  DRIVER_CASH_TRANSACTION_REVERSED: 'Driver cash transaction reversed',
  COMPANY_FINANCIAL_ADJUSTMENT_CREATED: 'Company finance adjustment posted',
  COMPANY_FINANCIAL_TRANSACTION_REVERSED: 'Company finance transaction reversed',
  DELIVERY_ONLY_FINANCE_FINALIZED: 'Delivery-only order finalized',
  COMPANY_ORDER_FINANCE_FINALIZED: 'Company order finalized',
  COLLECTION_DIFFERENCE_RECORDED: 'Collection difference recorded',
  COLLECTION_DIFFERENCE_RESOLVED: 'Collection difference resolved',
  AREA_CREATED: 'Area created',
  AREA_UPDATED: 'Area updated',
  AREA_DEACTIVATED: 'Area deactivated',
  AREA_REACTIVATED: 'Area reactivated',
  PAYMENT_METHOD_CREATED: 'Payment method created',
  PAYMENT_METHOD_UPDATED: 'Payment method updated',
  PAYMENT_METHOD_DEACTIVATED: 'Payment method deactivated',
  PAYMENT_METHOD_REACTIVATED: 'Payment method reactivated',
  FAILED_DELIVERY_REASON_CREATED: 'Failed delivery reason created',
  FAILED_DELIVERY_REASON_UPDATED: 'Failed delivery reason updated',
  FAILED_DELIVERY_REASON_DEACTIVATED: 'Failed delivery reason deactivated',
  FAILED_DELIVERY_REASON_REACTIVATED: 'Failed delivery reason reactivated',
  SYSTEM_SETTING_UPDATED: 'System setting updated',
  ROLE_PERMISSIONS_UPDATED: 'Role permissions updated',
  PARCEL_COLLECTION_DRIVER_ASSIGNED: 'Parcel Collection driver assigned',
  PARCEL_COLLECTION_DRIVER_REASSIGNED: 'Parcel Collection driver reassigned',
  PARCEL_COLLECTION_RESCHEDULED: 'Parcel Collection rescheduled',
  PARCEL_RECEIPT_CONFIRMED: 'Parcel received at company',
  FAILED_COLLECTION_REASON_CREATED: 'Failed collection reason created',
  FAILED_COLLECTION_REASON_UPDATED: 'Failed collection reason updated',
  FAILED_COLLECTION_REASON_DEACTIVATED: 'Failed collection reason deactivated',
  FAILED_COLLECTION_REASON_REACTIVATED: 'Failed collection reason reactivated',
};

export function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? humanizeToken(action);
}

/** Supplemental visual grouping only — never business severity. */
export function actionTone(action: string): BadgeTone {
  if (/REVERSED/.test(action)) return 'warning';
  if (/DEACTIVATED/.test(action)) return 'warning';
  if (/PAYOUT|SETTLEMENT|ADJUSTMENT|FINANCE|COLLECTION_DIFFERENCE/.test(action))
    return 'info';
  if (/EMPLOYEE|ROLE/.test(action)) return 'brand';
  // Parcel Collection operational actions (Phase 11.17.6) — distinct from
  // the money-adjacent "COLLECTION_DIFFERENCE" match above.
  if (/^PARCEL_/.test(action)) return 'brand';
  if (/CREATED|REACTIVATED|FINALIZED/.test(action)) return 'success';
  return 'neutral';
}

export function entityTypeLabel(entityType: string): string {
  return humanizeToken(entityType);
}

/**
 * The Management detail route for an audit entity — ONLY where `entityId` is
 * genuinely that route's id type AND the viewer holds the read permission.
 * Payout / Settlement / ledger-row entities have no dedicated detail route,
 * so they return null (plain reference text).
 */
export function entityRoute(
  entityType: string,
  entityId: string,
  perms: {
    orders: boolean;
    customers: boolean;
    drivers: boolean;
    employees: boolean;
  },
): string | null {
  switch (entityType) {
    case 'ORDER':
      return perms.orders ? `/management/orders/${entityId}` : null;
    case 'CUSTOMER':
      return perms.customers ? `/management/customers/${entityId}` : null;
    case 'DRIVER':
      return perms.drivers ? `/management/drivers/${entityId}` : null;
    case 'EMPLOYEE':
      return perms.employees ? `/management/employees/${entityId}` : null;
    default:
      return null;
  }
}

/** "Created" / "N fields changed" / "Removed" / "—" from the value snapshots. */
export function changeSummary(entry: {
  previousValues: unknown | null;
  newValues: unknown | null;
}): string {
  const hasPrev = isNonEmptyObject(entry.previousValues);
  const hasNew = isNonEmptyObject(entry.newValues);
  if (hasNew && !hasPrev) return 'Created';
  if (hasPrev && !hasNew) return 'Removed';
  if (hasNew && hasPrev) {
    const keys = new Set([
      ...Object.keys(entry.newValues as object),
      ...Object.keys(entry.previousValues as object),
    ]);
    return `${keys.size} field${keys.size === 1 ? '' : 's'} changed`;
  }
  return '—';
}

function isNonEmptyObject(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    Object.keys(v).length > 0
  );
}

/** Short readable form of a UUID for a table cell. */
export function shortId(id: string): string {
  return /^[0-9a-f-]{20,}$/i.test(id) ? `${id.slice(0, 8)}…` : id;
}
