// Management/Finance-facing correction DTOs (Phase 8.8). Richer than the
// Driver-safe DriverCashTransactionEntry (Phase 8.1) — Finance is the actor
// performing the correction and needs to see its own reason/notes and who
// created it. Still never exposes idempotencyKey, auth/session internals,
// or raw Prisma metadata.

export interface CorrectionActorSummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface DriverCashCorrectionEntry {
  id: string;
  driverId: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  orderId: string | null;
  settlementId: string | null;
  reversalOfId: string | null;
  createdBy: CorrectionActorSummary | null;
  notes: string | null;
  createdAt: string;
}

export interface CompanyCorrectionEntry {
  id: string;
  type: string;
  // Signed magnitude for ADJUSTMENT/REVERSAL — negative means a
  // DEBIT-direction correction (see company-finance-ledger.service.ts).
  amount: string;
  orderId: string | null;
  paymentMethodId: string | null;
  reversalOfId: string | null;
  createdBy: CorrectionActorSummary | null;
  notes: string | null;
  createdAt: string;
}
