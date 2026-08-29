// Driver-facing Driver Cash DTOs (Phase 8.1). Deliberately narrow — a
// Driver needs to understand their own cash balance, not internal
// Finance/audit mechanics. Excluded on purpose: idempotencyKey, createdBy
// auth internals, reversalOf internal relation, any Customer Wallet or
// Company Finance data, other Drivers' data, Prisma metadata.

export interface DriverCashAccountSummary {
  id: string;
  currentBalance: string;
}

export interface DriverCashOrderSummary {
  id: string;
  orderNumber: string;
}

export interface DriverCashSettlementSummary {
  id: string;
  settlementNumber: string;
}

export interface DriverCashTransactionEntry {
  id: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  order: DriverCashOrderSummary | null;
  settlement: DriverCashSettlementSummary | null;
  createdAt: string;
}

export interface DriverCashOverview {
  account: DriverCashAccountSummary;
  transactions: DriverCashTransactionEntry[];
}
