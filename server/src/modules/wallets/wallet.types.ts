import type { CorrectionEligibility } from "../finance/correction-eligibility.service";
// Management/Finance-facing Customer Wallet DTOs (Phase 8.2). Finance may
// safely see more accounting detail than a Driver (Phase 8.1's
// Driver-facing DTO), but never: idempotencyKey, auth/session internals,
// Driver Cash data, Company Finance ledger internals, raw reversal
// internals, or Prisma metadata.

// FR.7 (contract §9) — additive pending breakdown on every Management wallet
// DTO. pendingAmount = pendingDeliveryAmount + pendingSettlementAmount.
// underReviewCollectionAmount (cash collected on differences awaiting
// review) is Management-only and never part of pendingAmount.
export interface WalletPendingBreakdown {
  pendingDeliveryAmount: string;
  pendingSettlementAmount: string;
  underReviewOrderCount: number;
  underReviewCollectionAmount: string;
}

export interface WalletCustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
  isActive: boolean;
}

export interface WalletLastTransactionSummary {
  id: string;
  type: string;
  createdAt: string;
}

export interface WalletLastPayoutSummary {
  id: string;
  payoutNumber: string;
  status: string;
  createdAt: string;
}

export interface WalletSummary extends WalletPendingBreakdown {
  id: string;
  customer: WalletCustomerSummary;
  availableBalance: string;
  pendingAmount: string;
  lastTransaction: WalletLastTransactionSummary | null;
  lastPayout: WalletLastPayoutSummary | null;
}

export interface WalletDetailCustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
  secondaryPhone: string | null;
  email: string | null;
  isActive: boolean;
}

export interface WalletAccountDetail extends WalletPendingBreakdown {
  id: string;
  availableBalance: string;
  pendingAmount: string;
  createdAt: string;
  updatedAt: string;
}

export interface WalletDetail {
  customer: WalletDetailCustomerSummary;
  wallet: WalletAccountDetail;
}

// GET /api/v1/wallets/customer-summaries (Phase 11.6 correction) — one
// entry per requested customerId that has a wallet. Money as strings.
export interface WalletCustomerSummaryEntry extends WalletPendingBreakdown {
  customerId: string;
  availableBalance: string;
  pendingAmount: string;
}

// GET /api/v1/wallets/totals — system-wide figures across ALL customers,
// same definitions as a single Customer's wallet. Money as strings.
export interface WalletTotals extends WalletPendingBreakdown {
  availableBalance: string;
  pendingAmount: string;
}

export interface WalletTransactionOrderSummary {
  id: string;
  orderNumber: string;
}

export interface WalletTransactionPayoutSummary {
  id: string;
  payoutNumber: string;
  status: string;
}

export interface WalletTransactionPaymentMethodSummary {
  id: string;
  code: string;
  name: string;
}

export interface WalletTransactionProcessedBySummary {
  id: string;
  firstName: string;
  lastName: string;
}

// FR.10.1 — a Management wallet ledger LIST row: the transaction plus its
// read-only correction eligibility (additive; correction responses keep the
// plain WalletTransactionEntry shape).
export interface WalletLedgerEntry extends WalletTransactionEntry, CorrectionEligibility {}

export interface WalletTransactionEntry {
  id: string;
  type: string;
  credit: string;
  debit: string;
  balanceBefore: string;
  balanceAfter: string;
  order: WalletTransactionOrderSummary | null;
  payout: WalletTransactionPayoutSummary | null;
  paymentMethod: WalletTransactionPaymentMethodSummary | null;
  processedBy: WalletTransactionProcessedBySummary | null;
  notes: string | null;
  createdAt: string;
}
