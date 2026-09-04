// ============================================================
// Driver-scoped operational work DTOs (Phase 11.7 correction).
//
//   Current Orders  — CURRENT held active work
//                     (current_driver_id = driver AND status IN
//                     ORDER_ACTIVE_STATUSES). Shares the standard management
//                     OrderSummary shape (see order.types.ts).
//
//   Delivery History — HISTORICAL driver work, attributed via
//                     delivery_attempts.driver_id (never current_driver_id).
//                     One row per attempt this driver actually made. An
//                     order that was reassigned away still keeps this
//                     driver's earlier attempt(s); an order that never had
//                     an attempt by this driver never appears here.
// ============================================================

export interface DriverDeliveryHistoryOrderRef {
  id: string;
  orderNumber: string;
  // The order's CURRENT/resulting status (may be a later terminal state such
  // as CANCELLED / RETURNED_* reached after this attempt).
  status: string;
}

export interface DriverDeliveryHistoryRow {
  attemptId: string;
  attemptNumber: number;
  outcome: string;
  order: DriverDeliveryHistoryOrderRef;
  receiverName: string;
  area: string | null;
  expectedCollection: string;
  actualCollection: string | null;
  failedReason: { id: string; name: string } | null;
  notes: string | null;
  startedAt: string;
  completedAt: string | null;
}

// ============================================================
// Parcel Collection history (Phase 11.17.6 — task §27-§29).
//
// Base is parcel_collection_assignments (a Collection JOB/responsibility),
// never a derived Orders-list simulation. The same Order may legitimately
// appear more than once if this Driver was assigned to it across separate
// (reassigned/rescheduled) attempts — that is correct, permanent history,
// never collapsed. `parcelCollectionStatus` is the Order's CURRENT status
// (context only — it is not per-assignment state, since an assignment row
// itself carries no status field). Financially neutral: no money field.
// ============================================================

export interface DriverParcelCollectionHistoryOrderRef {
  id: string;
  orderNumber: string;
  orderType: string;
}

export interface DriverParcelCollectionHistoryRow {
  assignmentId: string;
  order: DriverParcelCollectionHistoryOrderRef;
  assignedAt: string;
  endedAt: string | null;
  endReason: string | null;
  isCurrent: boolean;
  parcelCollectionStatus: string;
}
