// ============================================================
// Reports DTOs (Phase 9.3)
//
// Purpose-built aggregate/read shapes for GET /api/v1/reports/{orders,
// drivers,customers,finance} — never raw Prisma rows, never per-transaction
// ledger detail (that remains GET /api/v1/finance/transactions, finance.read-
// gated). All four routes require only reports.read; the Financial Report is
// therefore intentionally AGGREGATE-ONLY (counts/sums), since reports.read is
// also granted to Dispatcher, who does not have finance.read.
// ============================================================

export interface ReportRangeDto {
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

// ------------------------------------------------------------
// ORDER REPORT
// ------------------------------------------------------------

export type OrderReportGroupBy = "date" | "customer" | "driver" | "area" | "status" | "type" | "outcome";
export type OrderReportBucket = "day" | "week" | "month";

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

// groupBy=date row.
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

// groupBy=driver — delivered/failed use delivery_attempts.driver_id (real
// historical attribution), never orders.current_driver_id, per the Phase
// 9.3 contract; `ordersInPortfolio` (the population row-count) still uses
// current_driver_id, since that IS the plain "orders currently assigned to
// this driver, created in this period" filter dimension (consistent with
// the Order Report's own driverId query filter — see order-report.service.ts).
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

export interface OrderReportOutcomeSummary {
  deliveredOrders: number;
  failedCurrent: number;
  failedAttempts: number;
}

export type OrderReportRow =
  | OrderReportDateRow
  | OrderReportCustomerRow
  | OrderReportDriverRow
  | OrderReportAreaRow
  | OrderReportStatusRow
  | OrderReportTypeRow;

export interface OrderReportDto {
  report: "ORDERS";
  range: ReportRangeDto;
  groupBy: OrderReportGroupBy;
  bucket: OrderReportBucket | null;
  summary: OrderReportSummary;
  outcome: OrderReportOutcomeSummary | null;
  rows: OrderReportRow[];
}

// ------------------------------------------------------------
// DRIVER REPORT
// ------------------------------------------------------------

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
}

export interface DriverReportDto {
  report: "DRIVERS";
  range: ReportRangeDto;
  rows: DriverReportRow[];
}

// ------------------------------------------------------------
// CUSTOMER REPORT
// ------------------------------------------------------------

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
  report: "CUSTOMERS";
  range: ReportRangeDto;
  rows: CustomerReportRow[];
}

// ------------------------------------------------------------
// FINANCE REPORT
// ------------------------------------------------------------

export type FinanceReportGroupBy = "day" | "week" | "month" | "category";

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
  | "DELIVERY_FEE_REVENUE"
  | "COMPANY_ORDER_REVENUE"
  | "TOTAL_COLLECTED"
  | "CUSTOMER_PAYOUTS"
  | "DRIVER_SETTLEMENTS";

export interface FinanceReportCategoryRow {
  category: FinanceReportCategoryName;
  amount: string;
  count: number | null;
}

export interface FinanceReportDto {
  report: "FINANCE";
  range: ReportRangeDto;
  groupBy: FinanceReportGroupBy;
  summary: FinanceReportSummary;
  rows: FinanceReportPeriodRow[] | FinanceReportCategoryRow[];
}
