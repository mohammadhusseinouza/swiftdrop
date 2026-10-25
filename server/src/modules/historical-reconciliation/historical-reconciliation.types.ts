import type {
  DriverCashHistoricalReconciliationKind,
  HistoricalOwnershipStatus,
  HistoricalReconciliationAccountingTreatment,
  HistoricalReconciliationDecisionType,
  OrderType,
  Prisma,
} from "../../generated/prisma/client";

// ============================================================
// FR.12A.3 — Driver cash historical reconciliation: internal domain types.
// Design: docs/fr12a2-historical-ledger-reconciliation-design.md (option B),
// refined in docs/fr12a3-historical-reconciliation-foundation.md.
//
// A historical reconciliation is EVIDENCE ONLY. It never changes a balance,
// a ledger row, a wallet or company revenue, and it never decides who owns the
// money. Nothing here is exposed by an API or used by a gate yet (FR.12A.4).
// ============================================================

// Derived from the append-only decision rows; never stored.
export type HistoricalReconciliationStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "REVOKED";

// What the shared SQL evaluation reports: an impossible decision history is
// surfaced (and always blocks) instead of being thrown away.
export type HistoricalReconciliationEvaluatedStatus = HistoricalReconciliationStatus | "INVALID_HISTORY";

export interface HistoricalReconciliationDecisionRecord {
  id: string;
  decision: HistoricalReconciliationDecisionType;
  revokesDecisionId: string | null;
}

// The server-derived evidence a reconciliation is bound to. Exactly the
// columns covered by the database evidence digest (dchr_evidence_digest_chk).
// There is deliberately no timestamp: the evidence time is the source audit's
// created_at, compared inside SQL only (application-bound timestamps depend on
// the session time zone — docs/timezone-investigation.md).
export interface HistoricalReconciliationEvidence {
  incidentId: string;
  accountId: string;
  driverId: string;
  kind: DriverCashHistoricalReconciliationKind;
  accountingTreatment: HistoricalReconciliationAccountingTreatment;
  amount: Prisma.Decimal;
  observedJump: Prisma.Decimal;
  predecessorTransactionId: string | null;
  anchorTransactionId: string;
  missingTransactionId: string;
  sourceAuditLogId: string;
  deletedOrderReference: string;
  orderType: OrderType;
  expectedAmount: Prisma.Decimal;
  actualAmount: Prisma.Decimal;
  collectionDifference: Prisma.Decimal;
  relatedSettlementId: string | null;
}

// Why a reconciliation does not (or no longer) explain its gap (design §7
// V1–V7, plus decision-history and evidence integrity). Computed inside
// PostgreSQL by historical-reconciliation.sql.ts (FR.12A.4).
export type EvidenceValidityFailure =
  | "INVALID_DECISION_HISTORY" // decisions do not form one valid lifecycle
  | "ACCOUNT_MISMATCH" // account missing or belongs to another driver
  | "ANCHOR_NOT_FOUND" // V1 anchor / predecessor missing or on another account
  | "JUMP_MISMATCH" // V2 located jump no longer equals the amount
  | "ORDERING_AMBIGUOUS" // V3 predecessor / anchor share a timestamp: adjacency cannot be proven
  | "ROWS_INSIDE_GAP" // V3 a ledger row sits between predecessor and anchor
  | "EVIDENCE_TIME_OUTSIDE_GAP" // V3 the audit's stored time is outside the gap
  | "MISSING_TRANSACTION_PRESENT" // V4 the "missing" row exists (e.g. restored)
  | "SOURCE_AUDIT_MISMATCH" // V5 audit missing / different action, order, row or amount
  | "DIFFERENCE_RESOLUTION_FOUND" // V5 resolution / finalization evidence exists
  | "DELETED_ORDER_PRESENT" // V6 the order exists again
  | "REVIEWER_NOT_INDEPENDENT" // V7 approver equal to the proposer
  | "EVIDENCE_DIGEST_MISMATCH" // the approval is not bound to the stored evidence
  | "APPROVAL_AUDIT_MISSING" // the approval lacks its same-transaction workflow audit (FR.12A.5)
  | "OVERLAPPING_EXPLANATION"; // another live record explains the same gap / row / audit / order

export type EvidenceValidity = { valid: true } | { valid: false; failures: readonly EvidenceValidityFailure[] };

export interface HistoricalReconciliationContribution {
  reconciliationId: string;
  accountId: string;
  status: HistoricalReconciliationEvaluatedStatus;
  amount: Prisma.Decimal;
  evidenceValidity: EvidenceValidity;
}

export interface DriverCashAccountReconciliationInput {
  accountId: string;
  // driver_cash_accounts.current_balance
  storedBalance: Prisma.Decimal;
  // Σ (balance_after − balance_before) over every ledger row of the account
  rawLedgerNet: Prisma.Decimal;
  reconciliations: readonly HistoricalReconciliationContribution[];
}

// D, A, R and X of design §7, always reported together so the raw
// discrepancy never disappears. The pure mirror of the SQL residual rule used
// by G3 / R1 (historical-reconciliation.sql.ts).
export interface DriverCashAccountReconciliation {
  accountId: string;
  storedBalance: Prisma.Decimal;
  rawLedgerNet: Prisma.Decimal;
  rawDiscrepancy: Prisma.Decimal;
  approvedHistoricalAmount: Prisma.Decimal;
  unexplainedResidual: Prisma.Decimal;
  approvedValidReconciliationIds: string[];
  invalidApprovedReconciliationIds: string[];
}

export interface HistoricalOwnershipRecord {
  reconciliationId: string;
  status: HistoricalReconciliationEvaluatedStatus;
  ownershipStatus: HistoricalOwnershipStatus;
}

// ------------------------------------------------------------ FR.12A.4 read DTOs
// Management / Finance / Admin only. Ids, amounts and codes — no personal data.

export interface DriverCashAccountReconciliationEntry {
  accountId: string;
  driverId: string;
  storedBalance: string;
  rawLedgerNet: string;
  rawDiscrepancy: string;
  approvedHistoricalAmount: string;
  unexplainedResidual: string;
  invalidApprovedCount: number;
  reconciliationCount: number;
  latestBalanceMatches: boolean;
}

export interface HistoricalReconciliationEvaluationEntry {
  reconciliationId: string;
  incidentId: string;
  accountId: string;
  driverId: string;
  status: HistoricalReconciliationEvaluatedStatus;
  amount: string;
  ownershipStatus: HistoricalOwnershipStatus;
  deletedOrderReference: string;
  evidenceValid: boolean;
  failures: EvidenceValidityFailure[];
  // true when it contributes to the approved historical amount A
  contributes: boolean;
  // true when it is an invalid approval / invalid history (blocks G3 / R1)
  blocking: boolean;
}

export interface DriverCashHistoricalReconciliationSummary {
  // false before the FR.12A.3 migration: the raw rule applies unchanged
  schemaPresent: boolean;
  // Accounts with a raw discrepancy or any reconciliation record (bounded).
  accounts: DriverCashAccountReconciliationEntry[];
  accountsTruncated: boolean;
  reconciliations: HistoricalReconciliationEvaluationEntry[];
  reconciliationsTruncated: boolean;
  totals: {
    rawDiscrepancy: string;
    approvedHistoricalAmount: string;
    unexplainedResidual: string;
    invalidApprovedCount: number;
  };
}

// ------------------------------------------------------------ FR.12A.5 read DTOs
// ADMIN / FINANCE only (requireRole). Staff names, ids, amounts and codes.

export interface HistoricalReconciliationActor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface HistoricalReconciliationDriver {
  id: string;
  driverNumber: string;
  firstName: string;
  lastName: string;
}

export interface HistoricalReconciliationListEntry extends HistoricalReconciliationEvaluationEntry {
  incidentNumber: string;
  proposedBy: HistoricalReconciliationActor;
  proposedAt: string;
  // FR.12A.6 (additive): the affected driver and the account's figures.
  driver: HistoricalReconciliationDriver;
  account: DriverCashAccountReconciliationEntry;
}

export interface HistoricalLedgerRowSummary {
  id: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  settlementId: string | null;
  recordedAt: string;
}

// FR.12A.6 (additive): what a reviewer inspects. null when the cited row no
// longer exists (the evidence is then invalid — see failures).
export interface HistoricalReconciliationEvidenceContext {
  predecessorTransaction: HistoricalLedgerRowSummary | null;
  anchorTransaction: HistoricalLedgerRowSummary | null;
  sourceAudit: { id: string; action: string; entityType: string; entityId: string; recordedAt: string } | null;
  relatedSettlement: {
    id: string;
    settlementNumber: string;
    amountReceived: string;
    balanceBefore: string;
    balanceAfter: string;
    recordedAt: string;
  } | null;
}

export interface HistoricalReconciliationDecisionEntry {
  id: string;
  decision: HistoricalReconciliationDecisionType;
  decidedBy: HistoricalReconciliationActor;
  reason: string | null;
  revokesDecisionId: string | null;
  decidedAt: string;
}

export interface HistoricalReconciliationDetail {
  reconciliationId: string;
  status: HistoricalReconciliationEvaluatedStatus;
  evidenceValid: boolean;
  failures: EvidenceValidityFailure[];
  contributes: boolean;
  blocking: boolean;
  incident: { id: string; incidentNumber: string; cause: string };
  evidence: {
    kind: DriverCashHistoricalReconciliationKind;
    accountingTreatment: HistoricalReconciliationAccountingTreatment;
    accountId: string;
    driverId: string;
    amount: string;
    observedJump: string;
    predecessorTransactionId: string | null;
    anchorTransactionId: string;
    missingTransactionId: string;
    sourceAuditLogId: string;
    deletedOrderReference: string;
    orderType: OrderType;
    expectedAmount: string;
    actualAmount: string;
    collectionDifference: string;
    relatedSettlementId: string | null;
    // What an approver confirms (POST /:id/approve { evidenceDigest }).
    evidenceDigest: string;
  };
  evidenceContext: HistoricalReconciliationEvidenceContext;
  driver: HistoricalReconciliationDriver;
  reason: string;
  proposedBy: HistoricalReconciliationActor;
  proposedAt: string;
  supersedesReconciliationId: string | null;
  decisions: HistoricalReconciliationDecisionEntry[];
  // Raw discrepancy, approved historical amount and residual of the account.
  account: DriverCashAccountReconciliationEntry;
  // A ledger reconciliation never resolves ownership: always blocks (G5).
  ownership: { status: HistoricalOwnershipStatus; blocksActivation: boolean };
}

export interface LedgerIncidentEntry {
  id: string;
  incidentNumber: string;
  cause: string;
  summary: string;
  discoveredAt: string;
  occurredNotBefore: string | null;
  occurredNotAfter: string | null;
  missingRecords: unknown;
  remainingUncertainties: string;
  evidence: unknown;
  reportedBy: HistoricalReconciliationActor;
  recordedAt: string;
  reconciliationCount: number;
}

export interface LedgerIncidentDetail extends LedgerIncidentEntry {
  reconciliations: HistoricalReconciliationListEntry[];
}
