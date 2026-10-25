/**
 * FR.12A.11 — historical ownership resolution / company-assumed historical
 * liability. Mirrors server historical-ownership.types.ts. Money is a
 * two-decimal string; nothing here is authoritative.
 */

export type HistoricalOwnershipStatus = 'PROPOSED' | 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'REVOKED' | 'INVALID_HISTORY';
export type HistoricalLiabilityState = 'NOT_RECORDED' | 'OUTSTANDING' | 'REVOKED';
export type OwnershipEvidenceKind =
  | 'INVESTIGATION_REPORT'
  | 'FINANCE_MEMO'
  | 'BACKUP_EXTRACT'
  | 'ORDER_DOCUMENT'
  | 'CUSTOMER_STATEMENT'
  | 'CORRESPONDENCE'
  | 'OTHER';

export interface OwnershipUserRef {
  id: string;
  name: string;
  role: string;
}

export interface OwnershipDecision {
  id: string;
  decision: 'APPROVED' | 'REJECTED' | 'WITHDRAWN' | 'REVOKED';
  decidedBy: OwnershipUserRef;
  reason: string | null;
  revokesDecisionId: string | null;
  createdAt: string;
}

export interface LiabilityPolicy {
  id: string;
  policyCode: string;
  version: number;
  outcome: 'COMPANY_ASSUMED_LIABILITY';
  title: string;
  summary: string;
  documentSha256: string;
  documentReference: string;
  reviewIntervalDays: number | null;
  unclaimedFundsHandling: string;
  unclaimedReviewAfterDays: number | null;
  policyDigest: string;
  status: HistoricalOwnershipStatus;
  failures: string[];
  proposedBy: OwnershipUserRef;
  decisions: OwnershipDecision[];
  createdAt: string;
}

export interface HistoricalLiabilitySnapshot {
  outstanding: string;
  trackedShortfall: string;
  liabilityCount: number;
  invalidCount: number;
  reviewOverdueCount: number;
  unclaimedReviewDueCount: number;
}

export interface HistoricalDisposition {
  deletedOrderReference: string;
  resolutionId: string;
  liabilityId: string;
  outcome: 'COMPANY_ASSUMED_LIABILITY';
  recognizedAmount: string;
  outstandingAmount: string;
  trackedShortfallAmount: string;
  policyCode: string;
  policyVersion: number;
}

export interface UnresolvedOwnershipCandidate {
  deletedOrderReference: string;
  sourceAuditLogId: string | null;
  orderType: string | null;
  expectedAmount: string | null;
  actualAmount: string | null;
  difference: string | null;
  recordedAt: string | null;
  approvedLedgerReconciliationId: string | null;
  incidentId: string | null;
  incidentNumber: string | null;
  activeResolutionId: string | null;
}

export interface HistoricalOwnershipSummary {
  writesEnabled: boolean;
  liabilities: HistoricalLiabilitySnapshot;
  unresolvedCandidates: UnresolvedOwnershipCandidate[];
  dispositions: HistoricalDisposition[];
}

export interface OwnershipResolutionSummary {
  id: string;
  incidentId: string;
  incidentNumber: string;
  outcome: 'COMPANY_ASSUMED_LIABILITY';
  deletedOrderReference: string;
  orderType: 'COMPANY_ORDER' | 'DELIVERY_ONLY';
  expectedAmount: string;
  collectedAmount: string;
  collectionDifference: string;
  heldCollectionAmount: string;
  trackedShortfallAmount: string;
  status: HistoricalOwnershipStatus;
  failures: string[];
  releasesG5: boolean;
  liabilityState: HistoricalLiabilityState;
  outstandingAmount: string;
  policy: { id: string; policyCode: string; version: number };
  proposedBy: OwnershipUserRef;
  createdAt: string;
}

export interface OwnershipLiability {
  id: string;
  state: HistoricalLiabilityState;
  recognizedAmount: string;
  outstandingAmount: string;
  heldCollectionAmount: string;
  trackedShortfallAmount: string;
  liabilityDigest: string;
  recordedBy: OwnershipUserRef;
  createdAt: string;
  reviews: { id: string; reviewedBy: OwnershipUserRef; note: string; createdAt: string }[];
  nextReviewDueAt: string | null;
  unclaimedReviewDueAt: string | null;
}

export interface OwnershipResolutionDetail extends OwnershipResolutionSummary {
  sourceAuditLogId: string;
  verification: 'APPROVED_LEDGER_RECONCILIATION';
  ledgerReconciliationId: string;
  evidenceManifestDigest: string;
  resolutionDigest: string;
  rationale: string;
  evidence: { ordinal: number; kind: OwnershipEvidenceKind; documentSha256: string; reference: string; description: string }[];
  decisions: OwnershipDecision[];
  liability: OwnershipLiability | null;
  supersedesResolutionId: string | null;
  supersededByResolutionId: string | null;
}

export interface ProposePolicyBody {
  policyCode: string;
  title: string;
  summary: string;
  documentSha256: string;
  documentReference: string;
  reviewIntervalDays?: number | null;
  unclaimedFundsHandling: string;
  unclaimedReviewAfterDays?: number | null;
}

export interface OwnershipEvidenceInput {
  kind: OwnershipEvidenceKind;
  documentSha256: string;
  reference: string;
  description: string;
}

/** The client never sends an amount: the server derives every figure. */
export interface ProposeResolutionBody {
  incidentId: string;
  policyId: string;
  sourceAuditLogId: string;
  /** The approved ledger reconciliation — the only accepted verification. */
  ledgerReconciliationId: string;
  evidence: OwnershipEvidenceInput[];
  rationale: string;
}
