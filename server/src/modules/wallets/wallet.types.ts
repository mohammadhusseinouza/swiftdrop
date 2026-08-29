// Management/Finance-facing Customer Wallet DTOs (Phase 8.2). Finance may
// safely see more accounting detail than a Driver (Phase 8.1's
// Driver-facing DTO), but never: idempotencyKey, auth/session internals,
// Driver Cash data, Company Finance ledger internals, raw reversal
// internals, or Prisma metadata.

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

export interface WalletSummary {
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

export interface WalletAccountDetail {
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
