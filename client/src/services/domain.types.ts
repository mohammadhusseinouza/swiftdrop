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
  customer: OrderCustomerSummary;
  receiverName: string;
  receiverPhone: string;
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
      unassigned: number;
      failedDeliveries: number;
      collectionDifferences: number;
      returned: number;
    };
    items: Array<{
      type: 'FINANCIAL_REVIEW' | 'FAILED_DELIVERY' | 'UNASSIGNED' | 'RETURNED';
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
}

/* ============================ Reports ============================ */

export interface ReportRange {
  from: string | null;
  to: string | null;
}
/** The four report DTOs vary widely by groupBy; kept as discriminated `report`. */
export interface OrderReportDto {
  report: 'ORDERS';
  range: ReportRange;
  groupBy: string;
  bucket: string | null;
  summary: Record<string, string | number>;
  outcome: Record<string, number> | null;
  rows: Array<Record<string, unknown>>;
}
export interface DriverReportDto {
  report: 'DRIVERS';
  range: ReportRange;
  rows: Array<Record<string, unknown>>;
}
export interface CustomerReportDto {
  report: 'CUSTOMERS';
  range: ReportRange;
  rows: Array<Record<string, unknown>>;
}
export interface FinanceReportDto {
  report: 'FINANCE';
  range: ReportRange;
  groupBy: string;
  summary: Record<string, string | number>;
  rows: Array<Record<string, unknown>>;
}

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
