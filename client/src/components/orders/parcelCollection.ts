import type { BadgeTone } from '../ui/Badge';
import type {
  ParcelCollectionAssignmentEndReason,
  ParcelCollectionAttemptOutcome,
  ParcelCollectionStatus,
  ParcelIntakeMethod,
} from '../../services/domain.types';

/**
 * Presentation maps for the Parcel Intake / Parcel Collection domain
 * (Phase 11.17). DISPLAY ONLY — no workflow-transition logic, no financial
 * logic (Parcel Collection is financially neutral in V1). This is the single
 * place every Management view resolves a raw enum to a human label + tone, so
 * the mapping is never spread across pages (§61 / §62).
 *
 * PARCEL COLLECTION is Sender → Company. It is NOT delivery pickup: the
 * OrderStatus PICKED_UP means the *delivery* driver took the parcel from the
 * company. "Collected From Sender" ≠ "Picked Up".
 */

interface Presentation {
  label: string;
  tone: BadgeTone;
}

const UNKNOWN: Presentation = { label: 'Unknown', tone: 'neutral' };

/* ----------------------------- Intake method ---------------------------- */

export const PARCEL_INTAKE_METHODS: readonly ParcelIntakeMethod[] = [
  'ALREADY_AT_COMPANY',
  'DRIVER_COLLECTION',
];

const INTAKE_METHOD_LABEL: Record<ParcelIntakeMethod, string> = {
  ALREADY_AT_COMPANY: 'Already at Company',
  DRIVER_COLLECTION: 'Driver Collection',
};

export function getParcelIntakeMethodLabel(method: string): string {
  return method === 'ALREADY_AT_COMPANY' || method === 'DRIVER_COLLECTION'
    ? INTAKE_METHOD_LABEL[method]
    : 'Unknown';
}

/* -------------------------- Collection status -------------------------- */

export const PARCEL_COLLECTION_STATUSES: readonly ParcelCollectionStatus[] = [
  'AWAITING_ASSIGNMENT',
  'ASSIGNED',
  'COLLECTED_FROM_SENDER',
  'FAILED',
  'RESCHEDULED',
  'RECEIVED_AT_COMPANY',
];

const COLLECTION_STATUS: Record<ParcelCollectionStatus, Presentation> = {
  AWAITING_ASSIGNMENT: { label: 'Awaiting Collection', tone: 'warning' },
  ASSIGNED: { label: 'Collection Assigned', tone: 'info' },
  COLLECTED_FROM_SENDER: { label: 'Collected From Sender', tone: 'brand' },
  FAILED: { label: 'Collection Failed', tone: 'danger' },
  RESCHEDULED: { label: 'Collection Rescheduled', tone: 'warning' },
  RECEIVED_AT_COMPANY: { label: 'Received at Company', tone: 'success' },
};

function isCollectionStatus(v: string): v is ParcelCollectionStatus {
  return (PARCEL_COLLECTION_STATUSES as readonly string[]).includes(v);
}

export function getParcelCollectionStatusPresentation(
  status: string,
): Presentation {
  return isCollectionStatus(status) ? COLLECTION_STATUS[status] : UNKNOWN;
}

/**
 * Combined at-a-glance label for the Orders list (§20). ALREADY_AT_COMPANY
 * orders always sit at RECEIVED_AT_COMPANY, so their intake state reads as
 * "Already at Company"; DRIVER_COLLECTION orders read as their collection
 * status. Company possession is NEVER derived from OrderStatus.RECEIVED.
 */
export function getParcelIntakePresentation(
  method: string,
  status: string,
): Presentation {
  if (method === 'ALREADY_AT_COMPANY') {
    return { label: 'Already at Company', tone: 'neutral' };
  }
  if (method === 'DRIVER_COLLECTION') {
    return getParcelCollectionStatusPresentation(status);
  }
  return UNKNOWN;
}

/* --------------------------- Assignment end reason -------------------- */

const END_REASON_LABEL: Record<ParcelCollectionAssignmentEndReason, string> = {
  REASSIGNED: 'Reassigned',
  FAILED: 'Collection Failed',
  RECEIVED_AT_COMPANY: 'Received at Company',
  ORDER_CANCELLED: 'Order Cancelled',
};

export function getParcelEndReasonLabel(reason: string | null): string {
  if (!reason) return '—';
  return (END_REASON_LABEL as Record<string, string>)[reason] ?? reason;
}

/* ----------------------------- Attempt outcome ----------------------- */

const ATTEMPT_OUTCOME: Record<ParcelCollectionAttemptOutcome, Presentation> = {
  COLLECTED: { label: 'Collected', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
};

export function getParcelAttemptOutcomePresentation(
  outcome: string,
): Presentation {
  return outcome === 'COLLECTED' || outcome === 'FAILED'
    ? ATTEMPT_OUTCOME[outcome]
    : UNKNOWN;
}

/** True once the parcel is physically at the company — the ONLY state in
 *  which a final Delivery driver may be assigned (backend is authoritative). */
export function isParcelReceivedAtCompany(status: string): boolean {
  return status === 'RECEIVED_AT_COMPANY';
}
