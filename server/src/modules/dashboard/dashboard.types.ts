// ============================================================
// Management Dashboard DTOs (Phase 9.1)
//
// Purpose-built read summary for GET /api/v1/dashboard — never raw Prisma
// rows. `finance` is null for a caller without finance.read (see
// dashboard.service.ts); `driversWithUnsettledCash`/`totalDriverCashHeld`
// are independently null for the same reason (Driver Cash figures are
// financial information too — CLAUDE.md/Phase 9.1 contract).
// ============================================================

export interface DashboardOrderMetrics {
  ordersToday: number;
  readyForPickup: number;
  /**
   * @deprecated Phase 11.17.6 — this counted `status IN (RECEIVED,
   * READY_FOR_PICKUP) AND current_driver_id IS NULL` WITHOUT the Parcel
   * Intake gate, so it silently included orders whose parcel collection was
   * still in progress (never a real "ready for delivery" problem —
   * requirements.md §37). Kept, UNCHANGED, only for backend compatibility
   * with any existing caller; `parcelCollection.readyForDeliveryAssignment`
   * below is the authoritative field going forward and additionally
   * requires `parcel_collection_status = RECEIVED_AT_COMPANY`. Do not
   * present this field as "ready for delivery" in new UI.
   */
  unassigned: number;
  assigned: number;
  outForDelivery: number;
  deliveredToday: number;
  failedToday: number;
  returned: number;
  cancelled: number;
}

// Parcel Intake & Collection operational counts (Phase 11.17.6 —
// requirements.md §37's "Order Statistics" list). Computed with the exact
// same predicate as the Orders List `workflowQueue` filter (order-workflow-
// queue.ts) — never a second, independently-drifting definition (task §18/
// §80). Financially neutral: never gated by finance.read.
export interface DashboardParcelCollectionMetrics {
  awaitingCollectionAssignment: number;
  collectionInProgress: number;
  collectionAttention: number;
  awaitingCompanyReceipt: number;
  /** Authoritative replacement for `orders.unassigned` above. */
  readyForDeliveryAssignment: number;
}

export interface DashboardDriverMetrics {
  activeDrivers: number;
  driversCurrentlyDelivering: number;
  ordersAssigned: number;
  deliveriesCompletedToday: number;
  driversWithUnsettledCash: number | null;
  totalDriverCashHeld: string | null;
  // requirements.md §37 Driver Statistics — DELIVERY-only metrics above are
  // unchanged; these two are the separate Collection dimensions. Never
  // merged into ordersAssigned/deliveriesCompletedToday.
  activeCollectionJobs: number;
  collectionsCompletedToday: number;
}

export interface DashboardFinanceMetrics {
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  totalCollected: string;
  customerWalletLiability: string;
  customerPayouts: string;
  driverCashOutstanding: string;
}

export type DashboardAttentionItemType =
  | "FINANCIAL_REVIEW"
  | "FAILED_DELIVERY"
  // Phase 11.17.6 correction — this REPLACES the old "UNASSIGNED" item type,
  // which used `status IN (RECEIVED, READY_FOR_PICKUP) AND current_driver_id
  // IS NULL` WITHOUT the Parcel Intake gate and therefore wrongly surfaced
  // Collection-in-progress orders as a Delivery-assignment problem. This
  // value is computed by the exact same shared workflowQueue predicate
  // (order-workflow-queue.ts) as the Orders List / parcelCollection metric —
  // never a second, independently-drifting definition.
  | "READY_FOR_DELIVERY_ASSIGNMENT"
  | "RETURNED"
  // Phase 11.17.6 — a FAILED Parcel Collection needs a Management decision
  // (reassign / reschedule), same operational urgency tier as FAILED_DELIVERY.
  | "COLLECTION_ATTENTION";

export interface DashboardAttentionCounts {
  /**
   * Phase 11.17.6 correction — renamed from `unassigned` to
   * `readyForDeliveryAssignment` and its query fixed to require
   * `parcel_collection_status = RECEIVED_AT_COMPANY` (see the item-type
   * comment above). Equals `parcelCollection.readyForDeliveryAssignment`
   * (same shared predicate, same instant).
   */
  readyForDeliveryAssignment: number;
  failedDeliveries: number;
  collectionDifferences: number;
  returned: number;
  /** Orders with `parcel_collection_status = FAILED` (non-terminal). */
  collectionAttention: number;
}

export interface DashboardAttentionOrderRef {
  id: string;
  orderNumber: string;
  status: string;
  orderType: string;
}

export interface DashboardAttentionCustomerRef {
  id: string;
  customerNumber: string;
  name: string;
}

export interface DashboardAttentionDriverRef {
  id: string;
  driverNumber: string;
  name: string;
}

export interface DashboardAttentionItem {
  type: DashboardAttentionItemType;
  order: DashboardAttentionOrderRef;
  customer: DashboardAttentionCustomerRef;
  driver: DashboardAttentionDriverRef | null;
  occurredAt: string;
}

export interface DashboardAttention {
  counts: DashboardAttentionCounts;
  items: DashboardAttentionItem[];
}

export interface DashboardActivityActor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface DashboardActivityContext {
  orderNumber: string | null;
  payoutNumber: string | null;
  settlementNumber: string | null;
}

export interface DashboardActivityItem {
  id: string;
  action: string;
  entityType: string;
  entityId: string;
  actor: DashboardActivityActor | null;
  occurredAt: string;
  context: DashboardActivityContext;
}

export interface DashboardSummary {
  generatedAt: string;
  orders: DashboardOrderMetrics;
  drivers: DashboardDriverMetrics;
  finance: DashboardFinanceMetrics | null;
  attention: DashboardAttention;
  recentActivity: DashboardActivityItem[];
  // Phase 11.17.6 — never finance-gated (Parcel Collection is financially
  // neutral; every dashboard.read caller sees this, incl. Dispatcher).
  parcelCollection: DashboardParcelCollectionMetrics;
}
