// Management-facing Customer Payout DTOs (Phase 8.5). Safe subset only —
// never idempotencyKey, auth/session internals, password hashes, raw Wallet
// ledger internals beyond the approved payout relationship, Driver Cash, or
// Company Finance data.

export interface PayoutCustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
}

export interface PayoutPaymentMethodSummary {
  id: string;
  code: string;
  name: string;
}

export interface PayoutProcessedBySummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface PayoutSummary {
  id: string;
  payoutNumber: string;
  customer: PayoutCustomerSummary;
  amount: string;
  paymentMethod: PayoutPaymentMethodSummary;
  processedBy: PayoutProcessedBySummary;
  status: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
