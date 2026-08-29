// Management-facing Driver Settlement DTOs (Phase 8.6). Safe subset only —
// never idempotencyKey, auth/session internals, password hashes, raw Driver
// Cash ledger internals beyond the approved settlement relationship,
// Customer Wallet, or Company Finance data.

export interface SettlementDriverUserSummary {
  firstName: string;
  lastName: string;
  phone: string | null;
}

export interface SettlementDriverSummary {
  id: string;
  driverNumber: string;
  user: SettlementDriverUserSummary;
}

export interface SettlementPaymentMethodSummary {
  id: string;
  code: string;
  name: string;
}

export interface SettlementReceivedBySummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface SettlementSummary {
  id: string;
  settlementNumber: string;
  driver: SettlementDriverSummary;
  balanceBefore: string;
  amountReceived: string;
  balanceAfter: string;
  paymentMethod: SettlementPaymentMethodSummary;
  receivedBy: SettlementReceivedBySummary;
  notes: string | null;
  createdAt: string;
}
