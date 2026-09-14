// ============================================================
// Customer-safe single-line Parcel Collection stage (Phase 13.2).
//
// THE ONE place the Customer-facing collection wording is defined for
// list / summary rows. It mirrors the Phase 11.17.6 tracking builder's
// "customer" audience (tracking.service.ts): a FAILED or RESCHEDULED
// collection both read as a single neutral "Collection Rescheduled" line —
// never an internal failure reason, never a Driver identity
// (page_structure.md §35, task §14 / §16 / §26). It is deliberately a
// separate, narrow helper rather than a second privacy model: the stage
// vocabulary is the same as requirements.md §35's Customer Tracking Stages.
//
// ALREADY_AT_COMPANY orders return `null` — they never show collection
// stages (task §15): the list marks them "Already at Company" from
// parcelIntakeMethod alone.
// ============================================================

export type CustomerCollectionStageCode =
  | "AWAITING_COLLECTION"
  | "COLLECTION_SCHEDULED"
  | "PARCEL_COLLECTED"
  | "RECEIVED_AT_COMPANY"
  | "COLLECTION_DELAYED";

export interface CustomerCollectionStage {
  code: CustomerCollectionStageCode;
  label: string;
}

// Maps the internal `orders.parcel_collection_status` enum to the customer
// stage. FAILED and RESCHEDULED collapse to one neutral entry.
const STAGE_BY_STATUS: Record<string, CustomerCollectionStage> = {
  AWAITING_ASSIGNMENT: { code: "AWAITING_COLLECTION", label: "Awaiting Collection" },
  ASSIGNED: { code: "COLLECTION_SCHEDULED", label: "Collection Scheduled" },
  COLLECTED_FROM_SENDER: { code: "PARCEL_COLLECTED", label: "Parcel Collected" },
  RECEIVED_AT_COMPANY: { code: "RECEIVED_AT_COMPANY", label: "Received at Company" },
  FAILED: { code: "COLLECTION_DELAYED", label: "Collection Rescheduled" },
  RESCHEDULED: { code: "COLLECTION_DELAYED", label: "Collection Rescheduled" },
};

export function customerCollectionStage(
  parcelIntakeMethod: string,
  parcelCollectionStatus: string
): CustomerCollectionStage | null {
  if (parcelIntakeMethod !== "DRIVER_COLLECTION") return null;
  // Unknown status falls back to the earliest stage rather than throwing —
  // a read endpoint must never 500 on an unexpected enum value.
  return STAGE_BY_STATUS[parcelCollectionStatus] ?? STAGE_BY_STATUS.AWAITING_ASSIGNMENT;
}
