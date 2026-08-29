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
