import type { BadgeTone } from '../ui/Badge';

/**
 * Presentation maps for Order status / type / payment-type.
 *
 * DISPLAY ONLY — no workflow-transition logic, no financial ownership logic.
 * These are the canonical label + tone lookups so every view renders a status
 * the same way.
 */

/** The 11 approved internal Order statuses (server OrderStatus enum). */
export const ORDER_STATUSES = [
  'RECEIVED',
  'READY_FOR_PICKUP',
  'ASSIGNED',
  'PICKED_UP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'FAILED_DELIVERY',
  'RESCHEDULED',
  'RETURNED_TO_COMPANY',
  'RETURNED_TO_CUSTOMER',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

interface StatusPresentation {
  label: string;
  tone: BadgeTone;
}

const INTERNAL_STATUS: Record<OrderStatus, StatusPresentation> = {
  RECEIVED: { label: 'Received', tone: 'neutral' },
  READY_FOR_PICKUP: { label: 'Ready for Pickup', tone: 'info' },
  ASSIGNED: { label: 'Assigned', tone: 'info' },
  PICKED_UP: { label: 'Picked Up', tone: 'brand' },
  OUT_FOR_DELIVERY: { label: 'Out for Delivery', tone: 'brand' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  FAILED_DELIVERY: { label: 'Failed Delivery', tone: 'danger' },
  RESCHEDULED: { label: 'Rescheduled', tone: 'warning' },
  RETURNED_TO_COMPANY: { label: 'Returned to Company', tone: 'warning' },
  RETURNED_TO_CUSTOMER: { label: 'Returned to Customer', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

const UNKNOWN_STATUS: StatusPresentation = { label: 'Unknown', tone: 'neutral' };

export function isOrderStatus(value: string): value is OrderStatus {
  return (ORDER_STATUSES as readonly string[]).includes(value);
}

/** Internal (Management) status presentation. Safe fallback for unknown values. */
export function getOrderStatusPresentation(status: string): StatusPresentation {
  return isOrderStatus(status) ? INTERNAL_STATUS[status] : UNKNOWN_STATUS;
}

/**
 * Customer / public simplified status (page-structure §40). Never exposes
 * Management-only wording where a safe simplified stage exists.
 */
const CUSTOMER_STAGE: Record<OrderStatus, StatusPresentation> = {
  RECEIVED: { label: 'Order Received', tone: 'neutral' },
  READY_FOR_PICKUP: { label: 'Ready for Delivery', tone: 'info' },
  ASSIGNED: { label: 'Ready for Delivery', tone: 'info' },
  PICKED_UP: { label: 'Ready for Delivery', tone: 'info' },
  OUT_FOR_DELIVERY: { label: 'Out for Delivery', tone: 'brand' },
  DELIVERED: { label: 'Delivered', tone: 'success' },
  FAILED_DELIVERY: { label: 'Delivery Attempt Unsuccessful', tone: 'danger' },
  RESCHEDULED: { label: 'Delivery Rescheduled', tone: 'warning' },
  RETURNED_TO_COMPANY: { label: 'Returned', tone: 'warning' },
  RETURNED_TO_CUSTOMER: { label: 'Returned', tone: 'warning' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};

export function getCustomerStatusPresentation(status: string): StatusPresentation {
  return isOrderStatus(status)
    ? CUSTOMER_STAGE[status]
    : { label: 'Processing', tone: 'neutral' };
}

/* -------------------------------- Order type -------------------------------- */

export const ORDER_TYPES = ['COMPANY_ORDER', 'DELIVERY_ONLY'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

const ORDER_TYPE_LABEL: Record<OrderType, string> = {
  COMPANY_ORDER: 'Company Order',
  DELIVERY_ONLY: 'Delivery Only',
};

export function getOrderTypeLabel(type: string): string {
  return type === 'COMPANY_ORDER' || type === 'DELIVERY_ONLY'
    ? ORDER_TYPE_LABEL[type]
    : 'Unknown';
}

/* ------------------------------- Payment type ------------------------------ */

/** Backend PaymentTypeSchema values only — payment TYPE, not payment METHOD. */
export const PAYMENT_TYPES = [
  'CASH_ON_DELIVERY',
  'ALREADY_PAID',
  'PARTIALLY_PAID',
] as const;
export type PaymentType = (typeof PAYMENT_TYPES)[number];

const PAYMENT_TYPE: Record<PaymentType, StatusPresentation> = {
  CASH_ON_DELIVERY: { label: 'Cash on Delivery', tone: 'warning' },
  ALREADY_PAID: { label: 'Already Paid', tone: 'success' },
  PARTIALLY_PAID: { label: 'Partially Paid', tone: 'info' },
};

export function getPaymentTypePresentation(type: string): StatusPresentation {
  return (PAYMENT_TYPES as readonly string[]).includes(type)
    ? PAYMENT_TYPE[type as PaymentType]
    : UNKNOWN_STATUS;
}
