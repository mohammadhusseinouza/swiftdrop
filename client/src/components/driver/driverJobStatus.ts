import type { BadgeTone } from '../ui/Badge';

/**
 * Presentation map for Driver "My Jobs" Collection status wording (Phase
 * 12.1). DISPLAY ONLY. Deliberately a SEPARATE wording set from the
 * Management `getParcelCollectionStatusPresentation` in
 * components/orders/parcelCollection.ts — the Driver Portal uses
 * operational, action-oriented copy ("Assigned for Collection", "Parcel
 * Collected") rather than the Management audit-log style wording
 * ("Collection Assigned", "Collected From Sender"). Delivery job statuses
 * reuse `getOrderStatusPresentation` from components/orders/orderStatus.ts
 * directly (its ASSIGNED/PICKED_UP/OUT_FOR_DELIVERY/RESCHEDULED wording
 * already matches the approved Driver Portal copy exactly — no second
 * mapping needed there).
 */
interface JobStatusPresentation {
  label: string;
  tone: BadgeTone;
}

const COLLECTION_JOB_STATUS: Record<string, JobStatusPresentation> = {
  ASSIGNED: { label: 'Assigned for Collection', tone: 'info' },
  COLLECTED_FROM_SENDER: { label: 'Parcel Collected', tone: 'brand' },
};

const UNKNOWN_JOB_STATUS: JobStatusPresentation = { label: 'Unknown', tone: 'neutral' };

export function getCollectionJobStatusPresentation(status: string): JobStatusPresentation {
  return COLLECTION_JOB_STATUS[status] ?? UNKNOWN_JOB_STATUS;
}

/** Supporting copy shown under a COLLECTED_FROM_SENDER card — custody is not yet handed to the company. */
export const COLLECTION_CUSTODY_NOTE = 'Awaiting company receipt';
