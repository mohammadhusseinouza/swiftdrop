import type {
  DriverOrderCollectionSummary,
  DriverOrderPackageSummary,
  DriverOrderReceiverSummary,
} from "../driver-orders/driver-order.types";

// ============================================================
// Phase 12.1 — "My Jobs" DTOs.
//
// A discriminated union so the frontend never has to reach for an optional
// field that only exists for the other job type. jobType + orderId together
// are the job identity (task §14) — never orderId alone, since the same
// Order can legitimately carry both a current COLLECTION job and a current
// DELIVERY job at once (different Driver responsibilities, possibly the
// same physical Driver).
//
// PRIVACY (CLAUDE.md §37/§44): neither variant ever carries Customer
// Wallet, Driver Cash ledger internals, Company Finance, payouts,
// settlements, financial-review internals, or Management audit data.
//
// FINANCIAL SEPARATION (CLAUDE.md §72 / task §18): Parcel Collection is
// financially neutral in V1 — CollectionDriverJobSummary deliberately has
// no amount-to-collect field. Only the DELIVERY variant carries money (via
// the embedded `collection` object — the identical shape driver-order.types
// already exposes for the final, Company→Receiver delivery).
// ============================================================

export type DriverJobType = "COLLECTION" | "DELIVERY";

/** Sender→Company collection contact/address snapshot — never money. */
export interface DriverJobCollectionContact {
  name: string | null;
  phone: string | null;
  altPhone: string | null;
  area: string | null;
  address: string | null;
  notes: string | null;
}

export interface CollectionDriverJobSummary {
  jobType: "COLLECTION";
  orderId: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  /** ASSIGNED | COLLECTED_FROM_SENDER — the only two "current" Collection states (task §12). */
  status: string;
  /** The current parcel_collection_assignments row id, when the data model has one (defensive: null on an unexpected gap, never a 500 for a list read). */
  assignmentId: string | null;
  assignedAt: string | null;
  /** Non-null only once status = COLLECTED_FROM_SENDER (custody kept, task §46). */
  collectedFromSenderAt: string | null;
  contact: DriverJobCollectionContact;
}

// DELIVERY reuses the exact Phase 7.1 Driver-facing Order DTO shapes
// (receiver/package/collection) — never a duplicate, independently-drifting
// mapping (task §17/§34).
export interface DeliveryDriverJobSummary {
  jobType: "DELIVERY";
  orderId: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  /** ASSIGNED | PICKED_UP | OUT_FOR_DELIVERY | RESCHEDULED — the only "current" Delivery states (task §13). */
  status: string;
  receiver: DriverOrderReceiverSummary;
  package: DriverOrderPackageSummary;
  collection: DriverOrderCollectionSummary;
  timestamps: {
    assignedAt: string | null;
    pickedUpAt: string | null;
    outForDeliveryAt: string | null;
  };
}

export type DriverJobSummary = CollectionDriverJobSummary | DeliveryDriverJobSummary;

// ============================================================
// Phase 12.2 — Driver Job Detail.
//
// One shape serves both the "My Jobs" summary and the detail endpoint
// wherever the summary already has everything a detail view needs — same
// precedent as driver-order.types.ts's `DriverOrderDetail = DriverOrderSummary`.
// DELIVERY needs nothing detail-only yet (receiver/package/collection/
// timestamps already cover task §14's required field list), so
// DeliveryDriverJobDetail is a plain alias. COLLECTION detail additionally
// needs package/order information (task §11) that the summary/card never
// needed — that is the ONE genuinely detail-only addition here.
// ============================================================

export interface CollectionDriverJobDetail extends CollectionDriverJobSummary {
  package: DriverOrderPackageSummary;
}

export interface DeliveryDriverJobDetail extends DeliveryDriverJobSummary {
  /**
   * CASH_ON_DELIVERY | ALREADY_PAID | PARTIALLY_PAID — detail-only (task
   * §14/§16: "Payment Type ≠ Payment Method", never merged into one field).
   * The My Jobs card/list DTO doesn't need it; only the detail view does.
   */
  paymentType: string;
}

export type DriverJobDetail = CollectionDriverJobDetail | DeliveryDriverJobDetail;
