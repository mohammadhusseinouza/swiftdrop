// ============================================================
// Customer / Public Tracking — BACKEND CONTRACTS ONLY (Phase 11.17.6, task
// §55-§64). No Customer Portal / Public Tracking UI exists yet (Phase 13/14
// are not started) — these DTOs and the safe stage builder in
// tracking.service.ts exist so that later UI work has an authoritative,
// privacy-reviewed contract to build against.
//
// Stage vocabulary follows requirements.md §35 (Customer Tracking Stages)
// exactly:
//   DRIVER_COLLECTION: Order Created -> Collection Scheduled -> Parcel
//     Collected -> Received at Company -> Preparing for Delivery ->
//     Out for Delivery -> Delivered
//   ALREADY_AT_COMPANY: Order Received -> Ready for Delivery ->
//     Out for Delivery -> Delivered
// (docs/delivery_management_system_..._spec_v1.md / the Phase 11.17.6 task
// brief sketch a 5-stage ALREADY_AT_COMPANY sequence with an extra
// "Received at Company" step; requirements.md is the authoritative business
// document per CLAUDE.md §2, so its 4-stage version is what is implemented
// here — see the Phase 11.17.6 closing report for this reconciliation.)
// ============================================================

export type TrackingStageCode =
  | "ORDER_CREATED"
  | "ORDER_RECEIVED"
  | "COLLECTION_SCHEDULED"
  | "PARCEL_COLLECTED"
  | "RECEIVED_AT_COMPANY"
  | "READY_FOR_DELIVERY"
  | "PREPARING_FOR_DELIVERY"
  | "OUT_FOR_DELIVERY"
  | "DELIVERED";

export type TrackingStageState = "done" | "current" | "upcoming";

export interface TrackingStageEntry {
  code: TrackingStageCode;
  label: string;
  state: TrackingStageState;
  /** ISO timestamp the stage was reached, or null (not yet reached / not tracked). */
  occurredAt: string | null;
}

export type TrackingExceptionCode =
  | "COLLECTION_ATTENTION"
  | "COLLECTION_RESCHEDULED"
  | "FAILED_DELIVERY"
  | "RESCHEDULED"
  | "RETURNED"
  | "CANCELLED";

export interface TrackingException {
  code: TrackingExceptionCode;
  /** Safe, human-facing message only — never an internal reason/note. */
  message: string;
}

// The narrowest, PUBLIC-safe shape (requirements.md §36). Never includes:
// sender/collection address or phone, Collection Driver identity, the
// receipt-confirming employee, internal failure notes, assignment/attempt
// history, or any financial data.
export interface PublicTrackingDetail {
  trackingCode: string;
  stages: TrackingStageEntry[];
  exception: TrackingException | null;
  isDelivered: boolean;
  deliveredAt: string | null;
}

// Customer-own-order view — same safe stage/exception contract, plus a
// couple of fields the Customer already legitimately sees elsewhere
// (their own order number/id/creation date). Still never includes Collection
// Driver identity, the receipt-confirming employee, or any financial data.
export interface CustomerTrackingDetail extends PublicTrackingDetail {
  orderId: string;
  orderNumber: string;
  createdAt: string;
}
