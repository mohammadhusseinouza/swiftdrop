// ============================================================
// Phase 12.5 — Driver Work History DTOs.
//
// A discriminated union: the Driver's own historical COLLECTION (Sender ->
// Company) and DELIVERY (Company -> Receiver) work, kept semantically
// SEPARATE (task §5). The same physical Order can legitimately produce both
// a Collection history record AND a Delivery history record for the same
// Driver — never merged by orderId (task §16/§59).
//
// `result` is the DRIVER WORK RESULT (COMPLETED | FAILED). It is NOT the
// Order's current status and NOT ParcelCollectionStatus — a FAILED attempt
// stays FAILED even after Management later reschedules / returns / receives
// the Order (task §9/§63). `resultingOrderStatus` /
// `resultingParcelCollectionStatus` carry the CURRENT state as secondary
// context only.
//
// HISTORICAL IDENTITY (task §16): `id` is the attempt/assignment row id, not
// the Order id — the same Driver may fail and later retry the same Order,
// and each real attempt stays independently traceable.
//
// PRIVACY (CLAUDE.md §37 / task §22/§54/§55): no Customer Wallet, Company
// Finance, Driver Cash ledger id, financialStatus / needsFinancialReview /
// collectionDifferenceReason, settlement/payout data, receipt-confirming
// employee, Management assignment notes, or other Drivers' work. Completed
// Delivery MAY show the Driver's own `actualAmountCollected` (their own
// operational result). Completed Collection shows NO money — Parcel
// Collection is financially neutral in V1.
// ============================================================

export type DriverHistoryJobType = "COLLECTION" | "DELIVERY";
export type DriverHistoryResult = "COMPLETED" | "FAILED";

interface DriverWorkHistoryBase {
  /** attemptId (delivery / failed collection) or assignmentId (completed collection). */
  id: string;
  jobType: DriverHistoryJobType;
  result: DriverHistoryResult;
  orderId: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  /** Global sort key — see the per-variant timestamp semantics in task §64. */
  occurredAt: string;
  /** The Order's CURRENT status — secondary context, never the row's `result`. */
  resultingOrderStatus: string;
}

/** Sender -> Company collection contact snapshot — never money, never phone/full private data. */
export interface DriverHistoryCollectionContact {
  name: string | null;
  area: string | null;
  address: string | null;
}

export interface DriverHistoryFailureInfo {
  /** The configured reason name (snapshot-safe — a later deactivation never rewrites history). */
  reasonName: string | null;
  /** Driver-entered notes only. Never Management notes. */
  notes: string | null;
}

export interface CollectionCompletedHistory extends DriverWorkHistoryBase {
  jobType: "COLLECTION";
  result: "COMPLETED";
  assignmentId: string;
  /** = occurredAt: parcel_collection_assignments.ended_at where end_reason = RECEIVED_AT_COMPANY. */
  completedAt: string;
  /** When this Driver confirmed COLLECTED_FROM_SENDER (custody), if recorded. */
  collectedFromSenderAt: string | null;
  contact: DriverHistoryCollectionContact;
  resultingParcelCollectionStatus: string;
}

export interface CollectionFailedHistory extends DriverWorkHistoryBase {
  jobType: "COLLECTION";
  result: "FAILED";
  attemptId: string;
  attemptNumber: number;
  /** = occurredAt: parcel_collection_attempts.completed_at. */
  failedAt: string;
  contact: DriverHistoryCollectionContact;
  failure: DriverHistoryFailureInfo;
  resultingParcelCollectionStatus: string;
}

export interface DriverHistoryReceiver {
  name: string;
  area: string | null;
}

export interface DriverHistoryPaymentMethod {
  id: string;
  code: string;
  name: string;
}

export interface DeliveryCompletedHistory extends DriverWorkHistoryBase {
  jobType: "DELIVERY";
  result: "COMPLETED";
  attemptId: string;
  attemptNumber: number;
  /** = occurredAt: delivery_attempts.completed_at. */
  completedAt: string;
  receiver: DriverHistoryReceiver;
  /** The Driver's own submitted collection — safe to echo (task §22). No wallet/company split. */
  actualAmountCollected: string | null;
  paymentMethod: DriverHistoryPaymentMethod | null;
}

export interface DeliveryFailedHistory extends DriverWorkHistoryBase {
  jobType: "DELIVERY";
  result: "FAILED";
  attemptId: string;
  attemptNumber: number;
  /** = occurredAt: delivery_attempts.completed_at. */
  failedAt: string;
  receiver: DriverHistoryReceiver;
  failure: DriverHistoryFailureInfo;
}

export type DriverWorkHistoryItem =
  | CollectionCompletedHistory
  | CollectionFailedHistory
  | DeliveryCompletedHistory
  | DeliveryFailedHistory;
