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
  unassigned: number;
  assigned: number;
  outForDelivery: number;
  deliveredToday: number;
  failedToday: number;
  returned: number;
  cancelled: number;
}

export interface DashboardDriverMetrics {
  activeDrivers: number;
  driversCurrentlyDelivering: number;
  ordersAssigned: number;
  deliveriesCompletedToday: number;
  driversWithUnsettledCash: number | null;
  totalDriverCashHeld: string | null;
}

export interface DashboardFinanceMetrics {
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  totalCollected: string;
  customerWalletLiability: string;
  customerPayouts: string;
  driverCashOutstanding: string;
}

export type DashboardAttentionItemType = "FINANCIAL_REVIEW" | "FAILED_DELIVERY" | "UNASSIGNED" | "RETURNED";

export interface DashboardAttentionCounts {
  unassigned: number;
  failedDeliveries: number;
  collectionDifferences: number;
  returned: number;
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
}
