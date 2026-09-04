/**
 * Frontend mirrors of the backend SAFE response DTOs (never Prisma models).
 * Source of truth: server/src/modules/<domain>/<domain>.types.ts.
 *
 * Conventions kept identical to the backend:
 *   - money / decimal values are `string` (never JS number)
 *   - timestamps are ISO `string` (never converted to Date in cache)
 *   - nullable fields stay `| null`
 *   - enum-like fields are `string` unless the backend narrows them
 */

/* ===================== Parcel Intake & Collection ===================== */
/**
 * Mirrors server/src/generated/prisma enums + parcel-collection.types.ts
 * (Phase 11.17). Parcel Collection is a DIFFERENT domain from financial cash
 * collection — these types never carry money.
 */
export type ParcelIntakeMethod = 'ALREADY_AT_COMPANY' | 'DRIVER_COLLECTION';
export type ParcelCollectionStatus =
  | 'AWAITING_ASSIGNMENT'
  | 'ASSIGNED'
  | 'COLLECTED_FROM_SENDER'
  | 'FAILED'
  | 'RESCHEDULED'
  | 'RECEIVED_AT_COMPANY';
export type ParcelCollectionAssignmentEndReason =
  | 'REASSIGNED'
  | 'FAILED'
  | 'RECEIVED_AT_COMPANY'
  | 'ORDER_CANCELLED';
export type ParcelCollectionAttemptOutcome = 'COLLECTED' | 'FAILED';

export interface ParcelCollectionDriverSummary {
  id: string;
  driverNumber: string;
  user: { firstName: string; lastName: string; phone: string | null };
}
export interface ParcelCollectionActorSummary {
  id: string;
  firstName: string;
  lastName: string;
}
export interface ParcelCollectionSnapshot {
  contactName: string | null;
  phone: string | null;
  altPhone: string | null;
  areaId: string | null;
  area: string | null;
  address: string | null;
  notes: string | null;
}
export interface ParcelCollectionAssignmentEntry {
  id: string;
  driver: ParcelCollectionDriverSummary;
  assignedBy: ParcelCollectionActorSummary;
  assignedAt: string;
  endedAt: string | null;
  endReason: ParcelCollectionAssignmentEndReason | null;
  isCurrent: boolean;
}
export interface ParcelCollectionAttemptEntry {
  id: string;
  attemptNumber: number;
  driver: ParcelCollectionDriverSummary;
  outcome: ParcelCollectionAttemptOutcome;
  failedReason: { id: string; name: string } | null;
  notes: string | null;
  /** V1: always null (no "start collection" action) — never render as a date. */
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}
/** GET /api/v1/orders/:id/parcel-collection (orders.read). */
export interface ParcelCollectionDetail {
  orderId: string;
  intakeMethod: ParcelIntakeMethod;
  status: ParcelCollectionStatus;
  collectionSnapshot: ParcelCollectionSnapshot;
  currentCollectionDriver: ParcelCollectionDriverSummary | null;
  parcelCollectedFromSenderAt: string | null;
  receivedAtCompanyAt: string | null;
  receivedAtCompanyBy: ParcelCollectionActorSummary | null;
  assignments: ParcelCollectionAssignmentEntry[];
  attempts: ParcelCollectionAttemptEntry[];
}

/* ============================ Orders ============================ */

export interface OrderCustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
}
export interface OrderDriverUser {
  firstName: string;
  lastName: string;
  phone: string | null;
}
export interface OrderSummaryDriver {
  id: string;
  driverNumber: string;
  user: OrderDriverUser;
}
export interface OrderSummary {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  status: string;
  financialStatus: string;
  /** CASH_ON_DELIVERY | ALREADY_PAID | PARTIALLY_PAID (Phase 6.3 correction). */
  paymentType: string;
  /** Parcel Intake at-a-glance (Phase 11.17.5 list-DTO extension). */
  parcelIntakeMethod: ParcelIntakeMethod;
  parcelCollectionStatus: ParcelCollectionStatus;
  customer: OrderCustomerSummary;
  receiverName: string;
  receiverPhone: string;
  receiverArea: string;
  orderAmount: string;
  deliveryFee: string;
  amountToCollect: string;
  actualAmountCollected: string | null;
  needsFinancialReview: boolean;
  /** The FINAL DELIVERY driver — unchanged meaning (Phase 6.3). */
  currentDriver: OrderSummaryDriver | null;
  /** The current COLLECTION driver — DISTINCT from currentDriver (Phase 11.17.6). */
  currentCollectionDriver: OrderSummaryDriver | null;
  createdAt: string;
  assignedAt: string | null;
  deliveredAt: string | null;
}

/**
 * Not a DB column — a derived operational-queue filter (Phase 11.17.6, task
 * §12). Mirrors server/src/modules/orders/order-workflow-queue.ts exactly.
 */
export type WorkflowQueue =
  | 'AWAITING_COLLECTION_ASSIGNMENT'
  | 'COLLECTION_IN_PROGRESS'
  | 'COLLECTION_ATTENTION'
  | 'AWAITING_COMPANY_RECEIPT'
  | 'READY_FOR_DELIVERY_ASSIGNMENT';

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
export interface OrderFinancialSummary {
  orderAmount: string;
  deliveryFee: string;
  prepaidOrderAmount: string;
  prepaidDeliveryFee: string;
  remainingOrderAmount: string;
  remainingDeliveryFee: string;
  amountToCollect: string;
  actualAmountCollected: string | null;
  collectionDifferenceReason: string | null;
  needsFinancialReview: boolean;
}
export interface PaymentMethodRef {
  id: string;
  code: string;
  name: string;
}
export interface OrderStatusHistoryEntry {
  id: string;
  fromStatus: string | null;
  toStatus: string;
  changedBy: { id: string; firstName: string; lastName: string };
  reason: string | null;
  notes: string | null;
  createdAt: string;
}
export interface OrderAssignmentHistoryEntry {
  id: string;
  driver: {
    id: string;
    driverNumber: string;
    user: OrderDriverUser;
  };
  assignedBy: { id: string; firstName: string; lastName: string };
  assignedAt: string;
  endedAt: string | null;
  endReason: string | null;
  isCurrent: boolean;
}
export interface DeliveryAttemptEntry {
  id: string;
  attemptNumber: number;
  driver: {
    id: string;
    driverNumber: string;
    user: OrderDriverUser;
  };
  expectedCollection: string;
  actualCollection: string | null;
  outcome: string;
  failedReason: { id: string; name: string } | null;
  notes: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
}
/**
 * Authoritative NET order-scoped ledger allocation (Phase 11.5 correction) —
 * computed backend-side from order_id-linked ledger rows, NEVER derived from
 * orderType + amountToCollect. Money strings; "0" means "no ledger row posted
 * for this order yet" (an all-prepaid exact delivery legitimately posts none).
 */
export interface OrderFinancialAllocation {
  companyAmount: string;
  customerWalletAmount: string;
}

/** One normalized order-scoped ledger event (Phase 11.5 correction). */
export interface OrderFinancialEvent {
  id: string;
  ledger: 'DRIVER_CASH' | 'WALLET' | 'COMPANY_FINANCE';
  /** COLLECTION | ORDER_CREDIT | DELIVERY_FEE_REVENUE | COMPANY_ORDER_PRODUCT_REVENUE | ADJUSTMENT | REVERSAL */
  type: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  signedAmount: string;
  actor: { id: string; firstName: string; lastName: string } | null;
  notes: string | null;
  occurredAt: string;
}

export interface OrderDetail {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  /** CASH_ON_DELIVERY | ALREADY_PAID | PARTIALLY_PAID (Phase 11.5 correction). */
  paymentType: string;
  status: string;
  financialStatus: string;
  /** Parcel Intake at-a-glance (Phase 11.17.4). Full domain: parcelCollectionApi. */
  parcelIntakeMethod: ParcelIntakeMethod;
  parcelCollectionStatus: ParcelCollectionStatus;
  customer: OrderCustomerSummary & { isActive: boolean };
  receiver: OrderReceiverSnapshot;
  package: OrderPackageInfo;
  financial: OrderFinancialSummary;
  financialAllocation: OrderFinancialAllocation;
  prepaidPaymentMethod: PaymentMethodRef | null;
  collectionPaymentMethod: PaymentMethodRef | null;
  currentDriver: { id: string; driverNumber: string; isActive: boolean } | null;
  createdAt: string;
  updatedAt: string;
  assignedAt: string | null;
  pickedUpAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  statusHistory: OrderStatusHistoryEntry[];
  assignmentHistory: OrderAssignmentHistoryEntry[];
  deliveryAttempts: DeliveryAttemptEntry[];
  financialEvents: OrderFinancialEvent[];
}
export interface OrderHistoryResponse {
  orderId: string;
  statusHistory: OrderStatusHistoryEntry[];
  assignmentHistory: OrderAssignmentHistoryEntry[];
}

/**
 * GET /api/v1/orders/:id/timeline (Phase 11.17.6). Mirrors
 * server/src/modules/orders/order-timeline.types.ts exactly. A deliberately
 * wide, flat shape — only the fields relevant to `type` are populated for
 * any given entry. Oldest-first (chronological), same raw-data convention
 * as statusHistory/assignmentHistory/deliveryAttempts/financialEvents.
 */
export type OrderTimelineEventType =
  | 'STATUS_CHANGED'
  | 'DELIVERY_DRIVER_ASSIGNED'
  | 'DELIVERY_ASSIGNMENT_ENDED'
  | 'DELIVERY_ATTEMPT'
  | 'FINANCIAL_EVENT'
  | 'PARCEL_COLLECTION_DRIVER_ASSIGNED'
  | 'PARCEL_COLLECTION_DRIVER_REASSIGNED'
  | 'PARCEL_COLLECTION_FAILED'
  | 'PARCEL_COLLECTION_RESCHEDULED'
  | 'PARCEL_COLLECTED_FROM_SENDER'
  | 'PARCEL_RECEIVED_AT_COMPANY'
  | 'PARCEL_COLLECTION_ENDED_ORDER_CANCELLED';

export interface OrderTimelineDriverRef {
  id: string;
  driverNumber: string;
  firstName: string;
  lastName: string;
}
export interface OrderTimelineEvent {
  id: string;
  type: OrderTimelineEventType;
  occurredAt: string;
  actor: { id: string; firstName: string; lastName: string } | null;
  driver: OrderTimelineDriverRef | null;
  /** Reassignment only — the NEW driver (`driver` holds the previous one). */
  toDriver: OrderTimelineDriverRef | null;
  fromStatus: string | null;
  toStatus: string | null;
  endReason: string | null;
  attemptNumber: number | null;
  outcome: string | null;
  reason: string | null;
  notes: string | null;
  amount: string | null;
  ledger: string | null;
  financialType: string | null;
}
export interface BulkAssignResult {
  assignedCount: number;
  driver: {
    id: string;
    driverNumber: string;
    user: OrderDriverUser;
  };
  orderIds: string[];
}

/* ==================== Driver self-service orders ==================== */

export interface DriverOrderSummary {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  status: string;
  receiver: {
    name: string;
    phone: string;
    altPhone: string | null;
    area: string;
    address: string;
    buildingFloor: string | null;
    mapLink: string | null;
    instructions: string | null;
  };
  package: {
    description: string;
    packageCount: number;
    quantity: number | null;
    weightKg: string | null;
    notes: string | null;
  };
  collection: {
    amountToCollect: string;
    actualAmountCollected: string | null;
    paymentMethod: PaymentMethodRef | null;
  };
  timestamps: {
    assignedAt: string | null;
    pickedUpAt: string | null;
    outForDeliveryAt: string | null;
    deliveredAt: string | null;
  };
}
export type DriverOrderDetail = DriverOrderSummary;

export interface DriverCashTransactionEntry {
  id: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  order: { id: string; orderNumber: string } | null;
  settlement: { id: string; settlementNumber: string } | null;
  createdAt: string;
}
export interface DriverCashOverview {
  account: { id: string; currentBalance: string };
  transactions: DriverCashTransactionEntry[];
}

/* ============================ Customers ============================ */

export interface CustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
  secondaryPhone: string | null;
  email: string | null;
  defaultAddress: string | null;
  area: { id: string; name: string } | null;
  hasPortalAccount: boolean;
  isActive: boolean;
  /** Non-terminal orders for this customer (batched server-side, never N+1). */
  activeOrders: number;
  createdAt: string;
  updatedAt: string;
}
export interface CustomerOrderSummary {
  activeOrders: number;
  deliveredOrders: number;
  totalOrders: number;
}
/**
 * Management-safe OPERATIONAL data only. Wallet balance / pending / ledger
 * data is NOT here (Phase 11.6 correction) — it comes exclusively from the
 * `wallets.read`-gated `GET /wallets/:customerId`.
 */
export interface CustomerDetail extends CustomerSummary {
  notes: string | null;
  orderSummary: CustomerOrderSummary;
}
/** `GET /wallets/customer-summaries` (wallets.read) — one entry per requested id with a wallet. */
export interface WalletCustomerSummary {
  customerId: string;
  availableBalance: string;
  pendingAmount: string;
}

/* ============================ Drivers ============================ */

export interface DriverUserSummary {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  phone: string | null;
  isActive: boolean;
}
/**
 * Authoritative server-side operational counts (Phase 11.7 correction) —
 * identical shape/semantics in the list and the detail DTO. The client never
 * counts orders.
 *   activeOrders   — current_driver = driver AND status in ORDER_ACTIVE_STATUSES
 *   outForDelivery — current_driver = driver AND status = OUT_FOR_DELIVERY
 *   completedToday — successful delivery ATTEMPTS today (delivery_attempts
 *                    .driver_id — historical, survives a later reassignment)
 */
export interface DriverOperationalSummary {
  activeOrders: number;
  outForDelivery: number;
  completedToday: number;
}
export interface DriverSummary {
  id: string;
  driverNumber: string;
  isActive: boolean;
  user: DriverUserSummary;
  operationalSummary: DriverOperationalSummary;
  createdAt: string;
  updatedAt: string;
}
/**
 * Management-safe operational/profile data ONLY. Cash balance / ledger is NOT
 * here (Phase 11.7 correction) — it comes exclusively from the `finance.read`
 * gated `GET /finance/driver-cash/:driverId(/transactions)`.
 */
export type DriverDetail = DriverSummary;

/** `GET /finance/driver-cash/:driverId` (finance.read). */
export interface ManagementDriverCashDetail {
  driverId: string;
  currentBalance: string;
}
/** `GET /finance/driver-cash/summaries?driverIds=…` (finance.read). */
export interface ManagementDriverCashSummary {
  driverId: string;
  currentBalance: string;
}
/** One row of `GET /finance/driver-cash/:driverId/transactions` (finance.read). */
export interface ManagementDriverCashTransactionEntry {
  id: string;
  type: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  order: { id: string; orderNumber: string } | null;
  settlement: { id: string; settlementNumber: string } | null;
  paymentMethod: { id: string; code: string; name: string } | null;
  actor: { id: string; firstName: string; lastName: string } | null;
  notes: string | null;
  createdAt: string;
}
/** One row of `GET /drivers/:id/delivery-history` (orders.read). */
export interface DriverDeliveryHistoryRow {
  attemptId: string;
  attemptNumber: number;
  outcome: string;
  order: { id: string; orderNumber: string; status: string };
  receiverName: string;
  area: string | null;
  expectedCollection: string;
  actualCollection: string | null;
  failedReason: { id: string; name: string } | null;
  notes: string | null;
  startedAt: string;
  completedAt: string | null;
}

/**
 * One row of `GET /drivers/:id/parcel-collection-history` (drivers.read,
 * Phase 11.17.6). Base is a Collection JOB assignment — the same Order may
 * legitimately appear more than once for separate assignments. Financially
 * neutral — no money field.
 */
export interface DriverParcelCollectionHistoryRow {
  assignmentId: string;
  order: { id: string; orderNumber: string; orderType: string };
  assignedAt: string;
  endedAt: string | null;
  endReason: ParcelCollectionAssignmentEndReason | null;
  isCurrent: boolean;
  parcelCollectionStatus: ParcelCollectionStatus;
}

/* ============================ Wallets ============================ */

export interface WalletSummary {
  id: string;
  customer: {
    id: string;
    customerNumber: string;
    name: string;
    primaryPhone: string;
    isActive: boolean;
  };
  availableBalance: string;
  pendingAmount: string;
  lastTransaction: { id: string; type: string; createdAt: string } | null;
  lastPayout: {
    id: string;
    payoutNumber: string;
    status: string;
    createdAt: string;
  } | null;
}
export interface WalletDetail {
  customer: {
    id: string;
    customerNumber: string;
    name: string;
    primaryPhone: string;
    secondaryPhone: string | null;
    email: string | null;
    isActive: boolean;
  };
  wallet: {
    id: string;
    availableBalance: string;
    pendingAmount: string;
    createdAt: string;
    updatedAt: string;
  };
}
export interface WalletTransactionEntry {
  id: string;
  type: string;
  credit: string;
  debit: string;
  balanceBefore: string;
  balanceAfter: string;
  order: { id: string; orderNumber: string } | null;
  payout: { id: string; payoutNumber: string; status: string } | null;
  paymentMethod: PaymentMethodRef | null;
  processedBy: { id: string; firstName: string; lastName: string } | null;
  notes: string | null;
  createdAt: string;
}

/* ============================ Payouts ============================ */

export interface PayoutSummary {
  id: string;
  payoutNumber: string;
  customer: {
    id: string;
    customerNumber: string;
    name: string;
    primaryPhone: string;
  };
  amount: string;
  paymentMethod: PaymentMethodRef;
  processedBy: { id: string; firstName: string; lastName: string };
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/* ========================== Settlements ========================== */

export interface SettlementSummary {
  id: string;
  settlementNumber: string;
  driver: {
    id: string;
    driverNumber: string;
    user: OrderDriverUser;
  };
  balanceBefore: string;
  amountReceived: string;
  balanceAfter: string;
  paymentMethod: PaymentMethodRef;
  receivedBy: { id: string; firstName: string; lastName: string };
  notes: string | null;
  createdAt: string;
}

/* ===================== Finance corrections ===================== */

/** Shared safe shape for adjust/reverse mutation responses across ledgers. */
export interface LedgerCorrectionResult {
  id: string;
  type: string;
  amount: string;
  createdAt: string;
}

/* ======================= Finance (read) ======================= */

export type LedgerName = 'WALLET' | 'DRIVER_CASH' | 'COMPANY_FINANCE';

export interface FinanceSummaryDto {
  range: { from: string | null; to: string | null };
  companyRevenue: string;
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  totalCollected: string;
  customerWalletLiability: string;
  customerPayouts: string;
  driverCashOutstanding: string;
}
export interface FinanceTransactionEntry {
  id: string;
  ledger: LedgerName;
  type: string;
  direction: 'CREDIT' | 'DEBIT';
  amount: string;
  signedAmount: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  order: { id: string; orderNumber: string } | null;
  customer: { id: string; customerNumber: string; name: string } | null;
  driver: { id: string; driverNumber: string; name: string } | null;
  payout: { id: string; payoutNumber: string; status: string } | null;
  settlement: { id: string; settlementNumber: string } | null;
  paymentMethod: PaymentMethodRef | null;
  actor: { id: string; firstName: string; lastName: string } | null;
  reversalOf: { id: string; type: string } | null;
  notes: string | null;
  createdAt: string;
}

/* ============================ Dashboard ============================ */

export interface DashboardSummary {
  generatedAt: string;
  orders: {
    ordersToday: number;
    readyForPickup: number;
    /** @deprecated superseded by parcelCollection.readyForDeliveryAssignment (Phase 11.17.6). */
    unassigned: number;
    assigned: number;
    outForDelivery: number;
    deliveredToday: number;
    failedToday: number;
    returned: number;
    cancelled: number;
  };
  drivers: {
    activeDrivers: number;
    driversCurrentlyDelivering: number;
    ordersAssigned: number;
    deliveriesCompletedToday: number;
    driversWithUnsettledCash: number | null;
    totalDriverCashHeld: string | null;
    /** Separate Collection dimensions (Phase 11.17.6) — never merged with the Delivery fields above. */
    activeCollectionJobs: number;
    collectionsCompletedToday: number;
  };
  finance: {
    deliveryFeeRevenue: string;
    companyOrderRevenue: string;
    totalCollected: string;
    customerWalletLiability: string;
    customerPayouts: string;
    driverCashOutstanding: string;
  } | null;
  attention: {
    counts: {
      /**
       * Phase 11.17.6 correction — renamed from `unassigned`; now requires
       * `parcel_collection_status = RECEIVED_AT_COMPANY` via the shared
       * workflowQueue predicate. Equals `parcelCollection.readyForDeliveryAssignment`.
       */
      readyForDeliveryAssignment: number;
      failedDeliveries: number;
      collectionDifferences: number;
      returned: number;
      collectionAttention: number;
    };
    items: Array<{
      type:
        | 'FINANCIAL_REVIEW'
        | 'FAILED_DELIVERY'
        | 'READY_FOR_DELIVERY_ASSIGNMENT'
        | 'RETURNED'
        | 'COLLECTION_ATTENTION';
      order: { id: string; orderNumber: string; status: string; orderType: string };
      customer: { id: string; customerNumber: string; name: string };
      driver: { id: string; driverNumber: string; name: string } | null;
      occurredAt: string;
    }>;
  };
  recentActivity: Array<{
    id: string;
    action: string;
    entityType: string;
    entityId: string;
    actor: { id: string; firstName: string; lastName: string } | null;
    occurredAt: string;
    context: {
      orderNumber: string | null;
      payoutNumber: string | null;
      settlementNumber: string | null;
    };
  }>;
  /** Never finance-gated — Parcel Collection is financially neutral (Phase 11.17.6). */
  parcelCollection: {
    awaitingCollectionAssignment: number;
    collectionInProgress: number;
    collectionAttention: number;
    awaitingCompanyReceipt: number;
    readyForDeliveryAssignment: number;
  };
}

/* ============================ Reports ============================ */

/**
 * Mirrors server/src/modules/reports/report.types.ts (Phase 9.3) exactly.
 * All four endpoints are `reports.read`-gated aggregate reads — no mutations,
 * no per-transaction ledger detail, no pagination. Money fields are strings.
 */

export interface ReportRange {
  from: string | null;
  to: string | null;
}
export interface ReportCustomerRef {
  id: string;
  customerNumber: string;
  name: string;
}
export interface ReportDriverRef {
  id: string;
  driverNumber: string;
  name: string;
}
export interface ReportAreaRef {
  id: string;
  name: string;
}

export type OrderReportGroupBy =
  | 'date'
  | 'customer'
  | 'driver'
  | 'area'
  | 'status'
  | 'type'
  | 'outcome';
export type OrderReportBucket = 'day' | 'week' | 'month';

export interface OrderReportSummary {
  totalOrders: number;
  deliveredOrders: number;
  failedOrders: number;
  cancelledOrders: number;
  companyOrders: number;
  deliveryOnlyOrders: number;
  totalOrderAmount: string;
  totalDeliveryFee: string;
  totalExpectedCollection: string;
  totalActualCollection: string;
}
export interface OrderReportDateRow {
  period: string;
  orders: number;
  delivered: number;
  failed: number;
  cancelled: number;
}
export interface OrderReportCustomerRow {
  customer: ReportCustomerRef;
  ordersCreated: number;
  deliveredOrders: number;
  failedOrders: number;
  totalOrderAmount: string;
  totalDeliveryFee: string;
  actualCollected: string;
}
export interface OrderReportDriverRow {
  driver: ReportDriverRef;
  ordersInPortfolio: number;
  delivered: number;
  failed: number;
  actualCollected: string;
}
export interface OrderReportAreaRow {
  area: ReportAreaRef | null;
  orders: number;
  delivered: number;
  failed: number;
}
export interface OrderReportStatusRow {
  status: string;
  orders: number;
}
export interface OrderReportTypeRow {
  orderType: string;
  count: number;
  totalOrderAmount: string;
  totalDeliveryFee: string;
  actualCollected: string;
}
export type OrderReportRow =
  | OrderReportDateRow
  | OrderReportCustomerRow
  | OrderReportDriverRow
  | OrderReportAreaRow
  | OrderReportStatusRow
  | OrderReportTypeRow;
export interface OrderReportOutcomeSummary {
  deliveredOrders: number;
  failedCurrent: number;
  failedAttempts: number;
}
/** Parcel Intake dimensions over the report population (Phase 11.17.6). Financially neutral. */
export interface OrderReportParcelSummary {
  alreadyAtCompanyOrders: number;
  driverCollectionOrders: number;
  awaitingCollectionAssignment: number;
  collectionInProgress: number;
  collectionAttention: number;
  awaitingCompanyReceipt: number;
  readyForDeliveryAssignment: number;
}

export interface OrderReportDto {
  report: 'ORDERS';
  range: ReportRange;
  groupBy: OrderReportGroupBy;
  bucket: OrderReportBucket | null;
  summary: OrderReportSummary;
  outcome: OrderReportOutcomeSummary | null;
  rows: OrderReportRow[];
  parcel: OrderReportParcelSummary;
}

export interface DriverReportRow {
  driver: ReportDriverRef & { isActive: boolean };
  ordersAssigned: number;
  ordersDelivered: number;
  failedAttempts: number;
  deliveryAttempts: number;
  successRate: string | null;
  moneyCollected: string;
  settlementCount: number;
  settlementAmount: string;
  currentCashHeld: string;
  /** Separate Parcel Collection dimensions (Phase 11.17.6) — never merged into the Delivery fields above. */
  collectionAssignments: number;
  collectionsCompleted: number;
  failedCollectionAttempts: number;
}
export interface DriverReportDto {
  report: 'DRIVERS';
  range: ReportRange;
  rows: DriverReportRow[];
}

export interface CustomerReportRow {
  customer: ReportCustomerRef & { isActive: boolean };
  ordersCreated: number;
  deliveredOrders: number;
  walletCredits: string;
  walletPayouts: string;
  currentWalletBalance: string;
  pendingOrderValue: string;
}
export interface CustomerReportDto {
  report: 'CUSTOMERS';
  range: ReportRange;
  rows: CustomerReportRow[];
}

export type FinanceReportGroupBy = 'day' | 'week' | 'month' | 'category';
export interface FinanceReportSummary {
  companyRevenue: string;
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  totalCollected: string;
  customerPayouts: string;
  currentCustomerWalletLiability: string;
  currentDriverCashOutstanding: string;
  settlementCount: number;
  settlementAmount: string;
}
export interface FinanceReportPeriodRow {
  period: string;
  companyRevenue: string;
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  totalCollected: string;
  customerPayouts: string;
  settlementAmount: string;
}
export type FinanceReportCategoryName =
  | 'DELIVERY_FEE_REVENUE'
  | 'COMPANY_ORDER_REVENUE'
  | 'TOTAL_COLLECTED'
  | 'CUSTOMER_PAYOUTS'
  | 'DRIVER_SETTLEMENTS';
export interface FinanceReportCategoryRow {
  category: FinanceReportCategoryName;
  amount: string;
  count: number | null;
}
export interface FinanceReportDto {
  report: 'FINANCE';
  range: ReportRange;
  groupBy: FinanceReportGroupBy;
  summary: FinanceReportSummary;
  rows: FinanceReportPeriodRow[] | FinanceReportCategoryRow[];
}

/* ============================ Employees ============================ */

/** Mirrors server/src/modules/employees/employee.types.ts (Phase 11.14). */
export interface EmployeeRoleRef {
  id: string;
  code: string;
  name: string;
}
export interface EmployeePermissionRef {
  code: string;
  name: string;
  description: string | null;
}
export interface EmployeeRoleDetail extends EmployeeRoleRef {
  description: string | null;
  isActive: boolean;
  permissionCount: number;
  permissions: EmployeePermissionRef[];
}
export interface EmployeeSummary {
  id: string;
  employeeNumber: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  role: EmployeeRoleRef;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface EmployeeDetail extends Omit<EmployeeSummary, 'role'> {
  role: EmployeeRoleDetail;
}
export type EmployeeRoleOption = EmployeeRoleDetail;

/* ==================== Settings / reference data ==================== */

export interface AreaSummary {
  id: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
export interface PaymentMethodSummary {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
export interface FailedDeliveryReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
/**
 * Failed Collection Reasons (Phase 11.17) — a SEPARATE catalog from
 * failed-delivery reasons. Same shape, never merged.
 * GET/POST/PATCH /api/v1/settings/failed-collection-reasons.
 */
export interface FailedCollectionReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}
export interface SystemSettingSummary {
  id: string;
  key: string;
  value: unknown;
  isSensitive: boolean;
  description: string | null;
  updatedBy: { id: string; firstName: string; lastName: string } | null;
  createdAt: string;
  updatedAt: string;
}

/** Mirrors server/src/modules/role-config/role-config.types.ts (Phase 11.16). */
export interface PermissionCatalogEntry {
  code: string;
  name: string;
  description: string | null;
}
export interface RoleConfigSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  userCount: number;
  editable: boolean;
  locked: boolean;
  permissionCount: number;
  permissionCodes: string[];
}
export interface RoleConfigResponse {
  roles: RoleConfigSummary[];
  permissionCatalog: PermissionCatalogEntry[];
  assignablePermissionCodes: string[];
  editableRoleCodes: string[];
  lockedRoleCodes: string[];
}

/* ============================ Audit ============================ */

export interface AuditLogEntry {
  id: string;
  createdAt: string;
  actor: { id: string; firstName: string; lastName: string; email: string } | null;
  action: string;
  entityType: string;
  entityId: string;
  previousValues: unknown | null;
  newValues: unknown | null;
  metadata: unknown | null;
}
