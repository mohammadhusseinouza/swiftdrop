// Management-facing Driver Cash DTOs (Phase 11.7 correction). Deliberately
// narrow — Management needs the authoritative balance + a readable ledger,
// not internal mechanics. Excluded on purpose: idempotency_key, raw
// reversal_of_id, password/auth data, any other driver's balances, Prisma
// metadata.

export interface ManagementDriverCashSummary {
  driverId: string;
  currentBalance: string;
}

export interface ManagementDriverCashDetail {
  driverId: string;
  currentBalance: string;
}

export interface ManagementDriverCashTransactionEntry {
  id: string;
  type: string;
  // Derived from the balance delta (balance_after - balance_before) — the
  // stored `amount` is always a positive magnitude (Phase 8.1 convention).
  direction: "CREDIT" | "DEBIT";
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  order: { id: string; orderNumber: string } | null;
  settlement: { id: string; settlementNumber: string } | null;
  // Payment method lives on the linked settlement (Phase 8.6), never on the
  // cash transaction itself.
  paymentMethod: { id: string; code: string; name: string } | null;
  actor: { id: string; firstName: string; lastName: string } | null;
  notes: string | null;
  createdAt: string;
}
