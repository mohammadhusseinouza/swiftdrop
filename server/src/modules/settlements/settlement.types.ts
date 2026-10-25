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
  // Settlement-Based Financial Release (FR.4) — all three are null on a
  // legacy-format settlement (no allocations). Per-allocation detail is an
  // FR.7 read API.
  allocatedTotal: string | null;
  unattributedAmount: string | null;
  unattributedReason: string | null;
  // FR.7 — correction state (additive): reversed by a SETTLEMENT_REVERSAL
  // (or a pre-FR.6 generic reversal), and the total recorded shortfall.
  reversed: boolean;
  shortfallTotal: string;
  paymentMethod: SettlementPaymentMethodSummary;
  receivedBy: SettlementReceivedBySummary;
  notes: string | null;
  createdAt: string;
}

// FR.6 — settlement correction (SETTLEMENT_REVERSAL / SETTLEMENT_SHORTFALL).
// The request-derived idempotency key is never exposed.
export interface SettlementCorrectionEntry {
  id: string;
  settlementId: string;
  driverId: string;
  correctionType: string;
  amount: string;
  reason: string;
  cashTransactionId: string;
  reversedAllocations: { id: string; releaseId: string; amount: string }[];
  createdBy: { id: string; firstName: string; lastName: string };
  createdAt: string;
}

// FR.7 — GET /driver-settlements/:id. Collection figures are the CURRENT
// state of each allocated collection (a later settlement or reversal may
// have changed it since).
export interface SettlementAllocationDetail {
  id: string;
  releaseId: string;
  order: { id: string; orderNumber: string };
  customer: { id: string; customerNumber: string; name: string };
  orderType: string;
  amount: string;
  status: "ACTIVE" | "REVERSED";
  reversedByCorrectionId: string | null;
  releasedByThisSettlement: boolean;
  collection: {
    collectionAmount: string;
    allocatedAmount: string;
    outstandingAmount: string;
    settlementState: "UNSETTLED" | "PARTIALLY_SETTLED" | "FULLY_SETTLED";
    releaseStatus: string;
    reviewStatus: string;
  };
}

export interface SettlementCorrectionSummary {
  id: string;
  correctionType: string;
  amount: string;
  reason: string;
  cashTransactionId: string;
  createdBy: { id: string; firstName: string; lastName: string };
  createdAt: string;
}

export interface SettlementDetail extends SettlementSummary {
  format: "LEGACY" | "ALLOCATION";
  allocations: SettlementAllocationDetail[];
  releasedOrders: { releaseId: string; order: { id: string; orderNumber: string }; releasedAt: string | null }[];
  collectionsFullySettled: number;
  collectionsPartiallySettled: number;
  corrections: SettlementCorrectionSummary[];
}
