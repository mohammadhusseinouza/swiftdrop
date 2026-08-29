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

// ============================================================
// Authoritative per-Order financial allocation (Phase 11.5 correction).
//
// NET amounts computed from ORDER-SCOPED ledger rows only — NEVER derived
// from orderType + amountToCollect + remaining amounts (that would be wrong
// for prepayments, collection differences, reversals and adjustments):
//   companyAmount        = SUM(company_financial_transactions.amount) WHERE order_id
//                          (amount is SIGNED — a REVERSAL row is the negated
//                          original; an order-linked ADJUSTMENT is signed too —
//                          so a plain SUM nets correctly, exactly like
//                          finance-summary.service.ts's getCompanyRevenueFlow)
//   customerWalletAmount = SUM(credit - debit) over wallet_transactions WHERE order_id
//                          (ORDER_CREDIT adds; its REVERSAL — which copies the
//                          original's order_id — subtracts; customer-level
//                          manual ADJUSTMENT rows carry no order_id and are
//                          correctly excluded)
//
// Both are money strings. "0" means "no ledger row has been posted for this
// Order yet" — ledgers are only written at delivery finalization / collection-
// difference resolution, so a not-yet-delivered Order, or an all-prepaid
// exact delivery (which legitimately posts NO wallet/company rows), both
// report "0". These are the authoritative LEDGER-POSTED amounts for the
// Order, not a theoretical lifetime-ownership projection.
// ============================================================
export interface OrderFinancialAllocation {
  companyAmount: string;
  customerWalletAmount: string;
}

export type OrderFinancialEventLedger = "DRIVER_CASH" | "WALLET" | "COMPANY_FINANCE";

export interface OrderFinancialEventActor {
  id: string;
  firstName: string;
  lastName: string;
}

// One normalized entry per persisted order-scoped ledger row. Raw ledger
// internals (idempotency keys, running account balances) are deliberately
// never included. `ledger` values are safe symbolic names — never the
// underlying table names.
export interface OrderFinancialEvent {
  id: string;
  ledger: OrderFinancialEventLedger;
  // COLLECTION | ORDER_CREDIT | DELIVERY_FEE_REVENUE |
  // COMPANY_ORDER_PRODUCT_REVENUE | ADJUSTMENT | REVERSAL
  type: string;
  // Normalized net effect on that ledger for this Order.
  direction: "CREDIT" | "DEBIT";
  // Positive magnitude.
  amount: string;
  // Signed net effect (negative for a DEBIT). A REVERSAL row carries a
  // DEBIT direction + the negated magnitude, so "wallet credit reversed" /
  // "company revenue reversed" render from `type` + `direction` + `amount`
  // alone — the internal reversal_of_id relation stays backend-only.
  signedAmount: string;
  actor: OrderFinancialEventActor | null;
  notes: string | null;
  occurredAt: string;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  // Payment TYPE (CASH_ON_DELIVERY / ALREADY_PAID / PARTIALLY_PAID) — additive
  // in the Phase 11.5 correction. The list DTO (OrderSummary) already carried
  // it; the detail DTO now does too. Distinct from payment METHOD.
  paymentType: string;
  status: string;
  financialStatus: string;

  customer: OrderCustomerSummary;
  receiver: OrderReceiverSnapshot;
  package: OrderPackageInfo;
  financial: OrderFinancialSummary;

  // Authoritative order-scoped ledger allocation (see the type comment above).
  financialAllocation: OrderFinancialAllocation;

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

  // Order-scoped financial ledger events (Driver Cash collection, Customer
  // Wallet credit/reversal, Company revenue/reversal/adjustment), oldest-first
  // — same chronological convention as statusHistory/assignmentHistory.
  // One entry per persisted ledger row; empty until the Order is financially
  // finalized. Composed by the frontend into the operational Order Timeline
  // alongside status/assignment/attempt events (page-structure §6.7).
  financialEvents: OrderFinancialEvent[];
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
  // Payment TYPE (CASH_ON_DELIVERY / ALREADY_PAID / PARTIALLY_PAID) for the
  // approved Management Orders "Payment Type" column (Phase 6.3 correction).
  // Distinct from payment METHOD — the list DTO deliberately does NOT carry
  // the prepaid/collection payment-method objects.
  paymentType: string;

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
