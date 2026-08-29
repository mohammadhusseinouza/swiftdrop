export interface OrderCustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
  isActive: boolean;
}

// Snapshot data, NOT a live Customer/Area relationship (CLAUDE.md §11).
// `area` is the Area name AS IT WAS at order creation time — it does not
// change if the referenced Area is later renamed or deactivated.
export interface OrderReceiverSnapshot {
  name: string;
  phone: string;
  altPhone: string | null;
  areaId: string | null;
  area: string;
  address: string;
  buildingFloor: string | null;
  mapLink: string | null;
  instructions: string | null;
}

export interface OrderPackageInfo {
  description: string;
  packageCount: number;
  quantity: number | null;
  weightKg: string | null;
  notes: string | null;
}

// All Decimal money fields are serialized as strings — never JS numbers —
// matching the existing Customer wallet / Driver cash convention.
export interface OrderFinancialSummary {
  orderAmount: string;
  deliveryFee: string;
  prepaidOrderAmount: string;
  prepaidDeliveryFee: string;
  remainingOrderAmount: string;
  remainingDeliveryFee: string;
  amountToCollect: string;
  actualAmountCollected: string | null;
  // Populated (Phase 7.5) only when the Driver's actual collection differed
  // from amountToCollect — explains why needsFinancialReview is true. Null
  // for an exact collection, even if a client-supplied value was submitted.
  collectionDifferenceReason: string | null;
  needsFinancialReview: boolean;
}

export interface OrderPaymentMethodSummary {
  id: string;
  code: string;
  name: string;
}

// No Driver Portal/assignment mechanism exists yet in this phase — this is
// always null on create. It is still mapped defensively from
// orders.current_driver_id so Order detail behaves correctly for any
// future/seeded row that already has one.
export interface OrderDriverSummary {
  id: string;
  driverNumber: string;
  isActive: boolean;
}

// The Management user who made the status change — not User auth fields.
export interface OrderStatusHistoryChangedBy {
  id: string;
  firstName: string;
  lastName: string;
}

export interface OrderStatusHistoryEntry {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: OrderStatusHistoryChangedBy;
  reason: string | null;
  notes: string | null;
  createdAt: string;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  status: string;
  financialStatus: string;

  customer: OrderCustomerSummary;
  receiver: OrderReceiverSnapshot;
  package: OrderPackageInfo;
  financial: OrderFinancialSummary;

  prepaidPaymentMethod: OrderPaymentMethodSummary | null;
  collectionPaymentMethod: OrderPaymentMethodSummary | null;

  currentDriver: OrderDriverSummary | null;

  createdAt: string;
  updatedAt: string;
  assignedAt: string | null;
  pickedUpAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;

  // Oldest-first (chronological), matching the timeline example in
  // requirements.md §39 (09:15 created ... 11:20 delivered, read top-down).
  statusHistory: OrderStatusHistoryEntry[];

  // Oldest-first, same convention as statusHistory. Distinct from it:
  // status history records OrderStatus transitions, assignment history
  // records which Driver held the order and who assigned them — a
  // reassignment (ASSIGNED -> ASSIGNED) appears here but never in
  // statusHistory (see order.service.ts).
  assignmentHistory: OrderAssignmentHistoryEntry[];

  // attemptNumber ascending (Phase 7.4) — empty for any Order that has
  // never gone OUT_FOR_DELIVERY, including every pre-Phase-7.4 Order.
  deliveryAttempts: DeliveryAttemptEntry[];
}

// ============================================================
// Delivery attempts (Phase 7.4) — finalized only. A Driver-initiated
// OUT_FOR_DELIVERY is NOT represented here; a row is created only once an
// outcome (FAILED for now; DELIVERED in Phase 7.5) is known — see
// order.service.ts / driver-order.service.ts for the rationale.
// ============================================================

export interface DeliveryAttemptDriverSummary {
  id: string;
  driverNumber: string;
  user: {
    firstName: string;
    lastName: string;
    phone: string | null;
  };
}

export interface DeliveryAttemptFailedReasonSummary {
  id: string;
  name: string;
}

export interface DeliveryAttemptEntry {
  id: string;
  attemptNumber: number;
  driver: DeliveryAttemptDriverSummary;
  expectedCollection: string;
  actualCollection: string | null;
  outcome: string;
  failedReason: DeliveryAttemptFailedReasonSummary | null;
  notes: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}

// ============================================================
// Assignment history (Phase 6.5)
// ============================================================

export interface OrderAssignmentDriverSummary {
  id: string;
  driverNumber: string;
  user: {
    firstName: string;
    lastName: string;
    phone: string | null;
  };
}

// The Management user who performed the assignment — not the Driver.
export interface OrderAssignmentActorSummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface OrderAssignmentHistoryEntry {
  id: string;
  driver: OrderAssignmentDriverSummary;
  assignedBy: OrderAssignmentActorSummary;
  assignedAt: string;
  endedAt: string | null;
  endReason: string | null;
  isCurrent: boolean;
}

// ============================================================
// List DTO (Phase 6.3) — intentionally smaller than OrderDetail. No
// receiver instructions/package notes, no full payment-method objects, no
// status history, no financial ledger data. See order.service.ts's
// orderSummarySelect for the exact Prisma `select` this maps from (one
// query, no N+1).
// ============================================================

export interface OrderSummaryCustomer {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
}

export interface OrderSummaryDriverUser {
  firstName: string;
  lastName: string;
  phone: string | null;
}

export interface OrderSummaryDriver {
  id: string;
  driverNumber: string;
  user: OrderSummaryDriverUser;
}

export interface OrderSummary {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  status: string;
  financialStatus: string;

  customer: OrderSummaryCustomer;

  receiverName: string;
  receiverPhone: string;
  // The historical text snapshot (orders.receiver_area) — not a live Area
  // lookup. Use the areaId filter (orders.receiver_area_id) to query by
  // the structured Area reference.
  receiverArea: string;

  orderAmount: string;
  deliveryFee: string;
  amountToCollect: string;
  actualAmountCollected: string | null;
  needsFinancialReview: boolean;

  currentDriver: OrderSummaryDriver | null;

  createdAt: string;
  assignedAt: string | null;
  deliveredAt: string | null;
}

// Compact bulk-assign response — not three full rich OrderDetail payloads,
// per the task's explicit instruction.
export interface BulkAssignResult {
  assignedCount: number;
  driver: OrderAssignmentDriverSummary;
  orderIds: string[];
}

// GET /api/v1/orders/:id/history (Phase 6.6) — the two histories the Order
// Engine currently owns. Reuses the exact same safe entry shapes as
// OrderDetail (no duplicate mapping logic); this endpoint is additive and
// does not replace OrderDetail.statusHistory/assignmentHistory. Both
// oldest-first, matching OrderDetail's convention.
export interface OrderHistoryResponse {
  orderId: string;
  statusHistory: OrderStatusHistoryEntry[];
  assignmentHistory: OrderAssignmentHistoryEntry[];
}
