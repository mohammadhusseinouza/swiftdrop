/**
 * FR.12A.6 — client contract for /finance/historical-reconciliations
 * (backend: server/src/modules/historical-reconciliation/*, FR.12A.5).
 * ADMIN / FINANCE only. Money is always a 2-decimal string from the server;
 * the client never computes a financial figure from these values.
 */

export type HistoricalReconciliationStatus =
  | 'PROPOSED'
  | 'APPROVED'
  | 'REJECTED'
  | 'WITHDRAWN'
  | 'REVOKED'
  | 'INVALID_HISTORY';

export type HistoricalOwnershipStatus = 'UNRESOLVED';

export type HistoricalDecisionType = 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'REVOKED';

export type EvidenceValidityFailure =
  | 'INVALID_DECISION_HISTORY'
  | 'ACCOUNT_MISMATCH'
  | 'ANCHOR_NOT_FOUND'
  | 'JUMP_MISMATCH'
  | 'ORDERING_AMBIGUOUS'
  | 'ROWS_INSIDE_GAP'
  | 'EVIDENCE_TIME_OUTSIDE_GAP'
  | 'MISSING_TRANSACTION_PRESENT'
  | 'SOURCE_AUDIT_MISMATCH'
  | 'DIFFERENCE_RESOLUTION_FOUND'
  | 'DELETED_ORDER_PRESENT'
  | 'REVIEWER_NOT_INDEPENDENT'
  | 'EVIDENCE_DIGEST_MISMATCH'
  | 'APPROVAL_AUDIT_MISSING'
  | 'OVERLAPPING_EXPLANATION';

export interface ReconciliationActor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ReconciliationDriver {
  id: string;
  driverNumber: string;
  firstName: string;
  lastName: string;
}

export interface ReconciliationAccountFigures {
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

export interface ReconciliationListItem {
  reconciliationId: string;
  incidentId: string;
  accountId: string;
  driverId: string;
  status: HistoricalReconciliationStatus;
  amount: string;
  ownershipStatus: HistoricalOwnershipStatus;
  deletedOrderReference: string;
  evidenceValid: boolean;
  failures: EvidenceValidityFailure[];
  contributes: boolean;
  blocking: boolean;
  incidentNumber: string;
  proposedBy: ReconciliationActor;
  proposedAt: string;
  driver: ReconciliationDriver;
  account: ReconciliationAccountFigures;
}

export interface LedgerRowSummary {
  id: string;
  type: string;
  amount: string;
  balanceBefore: string;
  balanceAfter: string;
  settlementId: string | null;
  recordedAt: string;
}

export interface ReconciliationEvidenceContext {
  predecessorTransaction: LedgerRowSummary | null;
  anchorTransaction: LedgerRowSummary | null;
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

export interface ReconciliationDecision {
  id: string;
  decision: HistoricalDecisionType;
  decidedBy: ReconciliationActor;
  reason: string | null;
  revokesDecisionId: string | null;
  decidedAt: string;
}

export interface ReconciliationDetail {
  reconciliationId: string;
  status: HistoricalReconciliationStatus;
  evidenceValid: boolean;
  failures: EvidenceValidityFailure[];
  contributes: boolean;
  blocking: boolean;
  incident: { id: string; incidentNumber: string; cause: string };
  evidence: {
    kind: string;
    accountingTreatment: string;
    accountId: string;
    driverId: string;
    amount: string;
    observedJump: string;
    predecessorTransactionId: string | null;
    anchorTransactionId: string;
    missingTransactionId: string;
    sourceAuditLogId: string;
    deletedOrderReference: string;
    orderType: 'COMPANY_ORDER' | 'DELIVERY_ONLY';
    expectedAmount: string;
    actualAmount: string;
    collectionDifference: string;
    relatedSettlementId: string | null;
    evidenceDigest: string;
  };
  evidenceContext: ReconciliationEvidenceContext;
  driver: ReconciliationDriver;
  reason: string;
  proposedBy: ReconciliationActor;
  proposedAt: string;
  supersedesReconciliationId: string | null;
  decisions: ReconciliationDecision[];
  account: ReconciliationAccountFigures;
  ownership: { status: HistoricalOwnershipStatus; blocksActivation: boolean };
}

export interface LedgerIncident {
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
  reportedBy: ReconciliationActor;
  recordedAt: string;
  reconciliationCount: number;
}

export interface ReconciliationSummary {
  schemaPresent: boolean;
  totals: {
    rawDiscrepancy: string;
    approvedHistoricalAmount: string;
    unexplainedResidual: string;
    invalidApprovedCount: number;
  };
  accounts: ReconciliationAccountFigures[];
  accountsTruncated: boolean;
}

export interface ListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface ReconciliationListParams {
  status?: HistoricalReconciliationStatus;
  incidentId?: string;
  page: number;
  limit: number;
}

/** POST / — exactly the fields the server accepts (strict schema). */
export interface ProposeReconciliationBody {
  incidentId?: string;
  incident?: {
    summary: string;
    discoveredAt: string;
    occurredNotBefore?: string | null;
    occurredNotAfter?: string | null;
    missingRecords: Record<string, number | 'unknown'>;
    remainingUncertainties: string;
    evidence: Record<string, unknown>;
  };
  anchorTransactionId: string;
  sourceAuditLogId: string;
  relatedSettlementId?: string | null;
  reason: string;
}
