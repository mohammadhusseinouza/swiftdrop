import type { BadgeTone } from '../ui/Badge';
import type { CustomerCollectionStageCode } from '../../services/domain.types';

/**
 * Phase 13.2 — Customer "My Orders" presentation.
 *
 * DISPLAY ONLY. Delivery status + order type reuse the existing shared
 * Customer-safe helpers (getCustomerStatusPresentation / getOrderTypeLabel in
 * components/orders/orderStatus.ts — the canonical page_structure §40
 * mapping). The only thing added here is the badge TONE for the backend's
 * already-safe collection-stage code (the label text comes from the server).
 */

/**
 * Customer-facing Parcel Intake label (task §13). Slightly friendlier
 * phrasing than the Management `getParcelIntakeMethodLabel` ("Driver
 * Collection") — the Customer sees "Collection by Driver".
 */
export function getCustomerParcelIntakeLabel(method: string): string {
  if (method === 'ALREADY_AT_COMPANY') return 'Already at Company';
  if (method === 'DRIVER_COLLECTION') return 'Collection by Driver';
  return 'Unknown';
}

const COLLECTION_STAGE_TONE: Record<CustomerCollectionStageCode, BadgeTone> = {
  AWAITING_COLLECTION: 'warning',
  COLLECTION_SCHEDULED: 'info',
  PARCEL_COLLECTED: 'brand',
  RECEIVED_AT_COMPANY: 'success',
  // FAILED + RESCHEDULED both arrive here as one neutral "delayed" line.
  COLLECTION_DELAYED: 'warning',
};

export function getCollectionStageTone(code: string): BadgeTone {
  return (COLLECTION_STAGE_TONE as Record<string, BadgeTone>)[code] ?? 'neutral';
}
