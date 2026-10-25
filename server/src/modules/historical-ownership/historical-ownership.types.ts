// ============================================================
// FR.12A.9–11 — Historical ownership resolution / company-assumed liability
// types. Read DTOs are purpose-built (never raw Prisma rows); money is a
// two-decimal string.
// ============================================================

import type { HistoricalCollectionVerification, HistoricalOwnershipEvidenceKind, OrderType } from "../../generated/prisma/client";

export type HistoricalOwnershipStatus = "PROPOSED" | "APPROVED" | "REJECTED" | "WITHDRAWN" | "REVOKED" | "INVALID_HISTORY";

export type HistoricalLiabilityState = "NOT_RECORDED" | "OUTSTANDING" | "REVOKED";

export interface ResolutionEvaluation {
  resolutionId: string;
  deletedOrderReference: string;
  policyId: string;
  status: HistoricalOwnershipStatus;
  assertsApproval: boolean;
  failures: string[];
  liabilityId: string | null;
  recognizedAmount: string | null;
  // True only when this resolution makes G5 treat its deleted order as resolved.
  releasesG5: boolean;
}

export interface LiabilityPolicyEvaluation {
  policyId: string;
  status: HistoricalOwnershipStatus;
  assertsApproval: boolean;
  failures: string[];
  approvedById: string | null;
}

export interface HistoricalDisposition {
  deletedOrderReference: string;
  resolutionId: string;
  liabilityId: string;
  outcome: "COMPANY_ASSUMED_LIABILITY";
  recognizedAmount: string;
  outstandingAmount: string;
  trackedShortfallAmount: string;
  policyCode: string;
  policyVersion: number;
}

export interface HistoricalLiabilitySnapshot {
  // Σ recognized amount of recorded liabilities whose approval stands
  // (no discharge workflow exists yet, so outstanding = recognized).
  outstanding: string;
  // Separately tracked shortfall (approved policy L2) — never recognized.
  trackedShortfall: string;
  liabilityCount: number;
  // Outstanding liabilities whose evidence no longer validates (R14 fails).
  invalidCount: number;
  reviewOverdueCount: number;
  unclaimedReviewDueCount: number;
}

export interface UserRef {
  id: string;
  name: string;
  role: string;
}

export interface DecisionDto {
  id: string;
  decision: "APPROVED" | "REJECTED" | "WITHDRAWN" | "REVOKED";
  decidedBy: UserRef;
  reason: string | null;
  revokesDecisionId: string | null;
  createdAt: string;
}

export interface LiabilityPolicyDto {
  id: string;
  policyCode: string;
  version: number;
  outcome: "COMPANY_ASSUMED_LIABILITY";
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
  proposedBy: UserRef;
  decisions: DecisionDto[];
  createdAt: string;
}

export interface EvidenceItemDto {
  ordinal: number;
  kind: HistoricalOwnershipEvidenceKind;
  documentSha256: string;
  reference: string;
  description: string;
}

export interface LiabilityReviewDto {
  id: string;
  reviewedBy: UserRef;
  note: string;
  createdAt: string;
}

export interface LiabilityDto {
  id: string;
  state: HistoricalLiabilityState;
  recognizedAmount: string;
  outstandingAmount: string;
  heldCollectionAmount: string;
  trackedShortfallAmount: string;
  liabilityDigest: string;
  recordedBy: UserRef;
  createdAt: string;
  reviews: LiabilityReviewDto[];
  nextReviewDueAt: string | null;
  unclaimedReviewDueAt: string | null;
}

export interface ResolutionSummaryDto {
  id: string;
  incidentId: string;
  incidentNumber: string;
  outcome: "COMPANY_ASSUMED_LIABILITY";
  deletedOrderReference: string;
  orderType: OrderType;
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
  proposedBy: UserRef;
  createdAt: string;
}

export interface ResolutionDetailDto extends ResolutionSummaryDto {
  sourceAuditLogId: string;
  verification: HistoricalCollectionVerification;
  ledgerReconciliationId: string;
  evidenceManifestDigest: string;
  resolutionDigest: string;
  rationale: string;
  evidence: EvidenceItemDto[];
  decisions: DecisionDto[];
  liability: LiabilityDto | null;
  supersedesResolutionId: string | null;
  supersededByResolutionId: string | null;
}

// A deleted order G5 currently reports as unresolved, with the evidence a
// proposal would cite (no customer data exists for it).
export interface UnresolvedOwnershipCandidateDto {
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

export interface HistoricalOwnershipSummaryDto {
  writesEnabled: boolean;
  liabilities: HistoricalLiabilitySnapshot;
  unresolvedCandidates: UnresolvedOwnershipCandidateDto[];
  dispositions: HistoricalDisposition[];
}
