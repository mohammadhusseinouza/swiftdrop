// Management-facing financial release correction DTOs (FR.6). Finance /
// Admin only — never exposed to Driver or Customer self-service.

export interface CorrectionActorSummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ReleaseCorrectionEntry {
  id: string;
  releaseId: string;
  orderId: string;
  correctionType: string;
  reason: string;
  driverCashReversalTransactionId: string | null;
  walletReversalTransactionId: string | null;
  companyProductReversalTransactionId: string | null;
  companyFeeReversalTransactionId: string | null;
  releaseStatus: string;
  orderFinancialStatus: string;
  createdBy: CorrectionActorSummary;
  createdAt: string;
}

// ============================================================
// FR.7 read DTOs (Management / Finance only, finance.read).
// ============================================================

export type CollectionSettlementState = "UNSETTLED" | "PARTIALLY_SETTLED" | "FULLY_SETTLED";

// GET /finance/driver-cash/:driverId/outstanding-collections
export interface OutstandingCollectionEntry {
  releaseId: string;
  order: { id: string; orderNumber: string };
  customer: { id: string; customerNumber: string; name: string };
  orderType: string;
  deliveredAt: string;
  collectionAmount: string;
  allocatedAmount: string;
  outstandingAmount: string;
  settlementState: CollectionSettlementState;
  reviewStatus: string;
  releaseStatus: string;
  // FR.9 — the approved planned split (same values a release would post);
  // all three null while the collection difference awaits review.
  plannedCustomerWalletAmount: string | null;
  plannedCompanyProductAmount: string | null;
  plannedCompanyFeeAmount: string | null;
}

export interface DriverOutstandingCollections {
  driverId: string;
  cashBalance: string;
  // Σ (collection − allocated) over PENDING releases still holding cash.
  attributedOutstanding: string;
  // cashBalance − attributedOutstanding (contract §7 U).
  unattributedBalance: string;
  outstandingCollectionCount: number;
  items: OutstandingCollectionEntry[];
}

// GET /orders/:id/financial-release
export interface OrderFinancialReleaseAllocation {
  id: string;
  settlement: { id: string; settlementNumber: string; createdAt: string };
  amount: string;
  status: "ACTIVE" | "REVERSED";
  reversedByCorrectionId: string | null;
  createdAt: string;
}

export interface OrderFinancialReleaseCorrection {
  id: string;
  correctionType: string;
  reason: string;
  driverCashReversalTransactionId: string | null;
  walletReversalTransactionId: string | null;
  companyProductReversalTransactionId: string | null;
  companyFeeReversalTransactionId: string | null;
  createdBy: CorrectionActorSummary;
  createdAt: string;
}

export interface OrderFinancialReleaseDetail {
  id: string;
  releaseStatus: string;
  reviewStatus: string;
  orderType: string;
  deliveredAt: string;
  collectionAmount: string;
  allocatedAmount: string;
  outstandingAmount: string;
  settlementState: CollectionSettlementState;
  plannedCustomerWalletAmount: string | null;
  plannedCompanyProductAmount: string | null;
  plannedCompanyFeeAmount: string | null;
  postedTransactions: {
    walletTransactionId: string | null;
    companyProductTransactionId: string | null;
    companyFeeTransactionId: string | null;
  };
  releasedAt: string | null;
  releasedBy: CorrectionActorSummary | null;
  releaseTrigger: "SETTLEMENT" | "RESOLUTION" | null;
  releasedBySettlement: { id: string; settlementNumber: string } | null;
  collectionReversed: boolean;
  allocations: OrderFinancialReleaseAllocation[];
  correction: OrderFinancialReleaseCorrection | null;
}

export interface OrderFinancialReleaseView {
  orderId: string;
  financialReleaseMode: string | null;
  financialStatus: string;
  // null for legacy (NULL mode) and IMMEDIATE orders.
  release: OrderFinancialReleaseDetail | null;
}
