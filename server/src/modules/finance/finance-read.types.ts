// ============================================================
// Finance Summary + Transactions DTOs (Phase 9.2)
//
// Purpose-built read shapes for GET /api/v1/finance/summary and
// GET /api/v1/finance/transactions — never raw Prisma rows. Both endpoints
// require finance.read (see finance.routes.ts); unlike Phase 9.1's Dashboard,
// there is no partial/nullable-finance-section case here — the entire module
// is finance.read-gated at the route level.
// ============================================================

// DIRECT_COMPANY_COLLECTION is a READ-ONLY feed source (company_direct_
// collections — money collected at delivery with a bypass_driver_cash payment
// method). It is not a correctable ledger: no adjust/reverse endpoint accepts
// it, and it is neither Driver Cash nor company revenue.
export const LEDGER_VALUES = ["WALLET", "DRIVER_CASH", "COMPANY_FINANCE", "DIRECT_COMPANY_COLLECTION"] as const;
export type LedgerName = (typeof LEDGER_VALUES)[number];

export type FinanceTransactionDirection = "CREDIT" | "DEBIT";

export interface FinanceDateRangeDto {
  from: string | null;
  to: string | null;
}

// See finance-summary.service.ts for the FLOW-vs-SNAPSHOT distinction:
// companyRevenue/deliveryFeeRevenue/companyOrderRevenue/totalCollected/
// customerPayouts are FLOW metrics (filtered by each ledger row's own
// created_at); customerWalletLiability/driverCashOutstanding are SNAPSHOT
// metrics (as-of the end of `to`, ignoring `from` entirely).
export interface FinanceSummaryDto {
  range: FinanceDateRangeDto;
  companyRevenue: string;
  deliveryFeeRevenue: string;
  companyOrderRevenue: string;
  // All money collected at delivery = driverCollected + directCompanyCollected.
  totalCollected: string;
  // Collected and held by Drivers (Driver Cash COLLECTION, net of reversals).
  driverCollected: string;
  // Collected with a bypass_driver_cash payment method — received directly by
  // the company, never part of Driver Cash or settlement obligations.
  directCompanyCollected: string;
  customerWalletLiability: string;
  customerPayouts: string;
  driverCashOutstanding: string;
}

export interface FinanceOrderRef {
  id: string;
  orderNumber: string;
}

export interface FinanceCustomerRef {
  id: string;
  customerNumber: string;
  name: string;
}

export interface FinanceDriverRef {
  id: string;
  driverNumber: string;
  name: string;
}

export interface FinancePayoutRef {
  id: string;
  payoutNumber: string;
  status: string;
}

export interface FinanceSettlementRef {
  id: string;
  settlementNumber: string;
}

export interface FinancePaymentMethodRef {
  id: string;
  code: string;
  name: string;
}

export interface FinanceActorRef {
  id: string;
  firstName: string;
  lastName: string;
}

export interface FinanceReversalRef {
  id: string;
  type: string;
}

export type FinanceCollectionRoute = "DRIVER_CASH" | "DIRECT_COMPANY";

export interface FinanceTransactionEntry {
  id: string;
  ledger: LedgerName;
  type: string;
  direction: FinanceTransactionDirection;
  amount: string;
  signedAmount: string;
  balanceBefore: string | null;
  balanceAfter: string | null;
  order: FinanceOrderRef | null;
  customer: FinanceCustomerRef | null;
  driver: FinanceDriverRef | null;
  payout: FinancePayoutRef | null;
  settlement: FinanceSettlementRef | null;
  paymentMethod: FinancePaymentMethodRef | null;
  actor: FinanceActorRef | null;
  reversalOf: FinanceReversalRef | null;
  // Where money collected at delivery went: DRIVER_CASH (a Driver Cash
  // COLLECTION row — held by the driver) or DIRECT_COMPANY (a direct company
  // collection). null for every non-collection row.
  collectionRoute: FinanceCollectionRoute | null;
  notes: string | null;
  createdAt: string;
}

export interface FinanceTransactionsResult {
  items: FinanceTransactionEntry[];
  total: number;
}
