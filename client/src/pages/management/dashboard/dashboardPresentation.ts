import type { BadgeTone } from '../../../components/ui/Badge';
import { humanizeToken } from '../../../lib/format';

/**
 * Presentation-only helpers for the Management Dashboard (Phase 11.11).
 *
 * The backend `GET /api/v1/dashboard` (Phase 9.1) is the single authoritative
 * source for every number here — this module NEVER computes a metric, it only
 * maps DTO enum values to human labels / tones.
 */

/* ----------------------------- attention ------------------------------ */

export type DashboardAttentionType =
  | 'FINANCIAL_REVIEW'
  | 'FAILED_DELIVERY'
  | 'READY_FOR_DELIVERY_ASSIGNMENT'
  | 'RETURNED'
  | 'COLLECTION_ATTENTION';

export function attentionTypeLabel(type: string): string {
  switch (type) {
    case 'FINANCIAL_REVIEW':
      return 'Needs financial review';
    case 'FAILED_DELIVERY':
      return 'Failed delivery';
    case 'READY_FOR_DELIVERY_ASSIGNMENT':
      return 'Ready for delivery';
    case 'RETURNED':
      return 'Returned';
    case 'COLLECTION_ATTENTION':
      return 'Collection failed';
    default:
      return humanizeToken(type);
  }
}

export function attentionTypeTone(type: string): BadgeTone {
  switch (type) {
    case 'FINANCIAL_REVIEW':
      return 'warning';
    case 'FAILED_DELIVERY':
      return 'danger';
    case 'READY_FOR_DELIVERY_ASSIGNMENT':
      return 'warning';
    case 'RETURNED':
      return 'neutral';
    case 'COLLECTION_ATTENTION':
      return 'danger';
    default:
      return 'neutral';
  }
}

/* --------------------------- recent activity -------------------------- */

const ACTIVITY_LABELS: Record<string, string> = {
  DELIVERY_ONLY_FINANCE_FINALIZED: 'Delivery-only order finalized',
  COMPANY_ORDER_FINANCE_FINALIZED: 'Company order finalized',
  COLLECTION_DIFFERENCE_RECORDED: 'Collection difference recorded',
  COLLECTION_DIFFERENCE_RESOLVED: 'Collection difference resolved',
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
};

export function activityLabel(action: string): string {
  return ACTIVITY_LABELS[action] ?? humanizeToken(action);
}

/**
 * The human-readable reference for an activity row, from the curated
 * `context` the backend already resolved (never parsed out of a display
 * string, never a second API call).
 */
export function activityReference(context: {
  orderNumber: string | null;
  payoutNumber: string | null;
  settlementNumber: string | null;
}): string | null {
  return (
    context.orderNumber ?? context.payoutNumber ?? context.settlementNumber ?? null
  );
}
