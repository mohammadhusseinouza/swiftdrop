import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { HistoricalCollectionVerification, HistoricalOwnershipEvidenceKind, OrderType } from "../../generated/prisma/client";

// ============================================================
// FR.12A.9 — Pure digest helpers. Each canonical form is the exact mirror of
// a database CHECK (hlp_policy_digest_chk, hor_resolution_digest_chk,
// hl_liability_digest_chk) or of the validity SQL (content, evidence
// manifest, rationale — historical-ownership.sql.ts). No database access.
// ============================================================

const sha256Hex = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

// UTF-8 byte length prefix: unambiguous for any free text.
const lengthPrefixed = (value: string) => `${Buffer.byteLength(value, "utf8")}:${value}`;

const money = (v: Prisma.Decimal) => v.toFixed(2);

export function sha256OfText(text: string): string {
  return sha256Hex(text);
}

// ------------------------------------------------------------ policy

export interface PolicyContent {
  title: string;
  summary: string;
  documentReference: string;
  unclaimedFundsHandling: string;
}

export function computePolicyContentSha256(c: PolicyContent): string {
  return sha256Hex(
    ["hlp-content-v1", lengthPrefixed(c.title), lengthPrefixed(c.summary), lengthPrefixed(c.documentReference), lengthPrefixed(c.unclaimedFundsHandling)].join("\n")
  );
}

export interface PolicyDigestInput {
  id: string;
  policyCode: string;
  version: number;
  outcome: "COMPANY_ASSUMED_LIABILITY";
  documentSha256: string;
  reviewIntervalDays: number | null;
  unclaimedReviewAfterDays: number | null;
  contentSha256: string;
}

export function buildPolicyCanonicalString(p: PolicyDigestInput): string {
  return [
    "hlp-policy-v1",
    p.id.toLowerCase(),
    p.policyCode,
    String(p.version),
    p.outcome,
    p.documentSha256,
    p.reviewIntervalDays === null ? "" : String(p.reviewIntervalDays),
    p.unclaimedReviewAfterDays === null ? "" : String(p.unclaimedReviewAfterDays),
    p.contentSha256,
  ].join("|");
}

export function computePolicyDigest(p: PolicyDigestInput): string {
  return sha256Hex(buildPolicyCanonicalString(p));
}

// ------------------------------------------------------------ resolution

export interface EvidenceItem {
  ordinal: number;
  kind: HistoricalOwnershipEvidenceKind;
  documentSha256: string;
  reference: string;
  description: string;
}

export function computeEvidenceManifestDigest(items: readonly EvidenceItem[]): string {
  const ordered = [...items].sort((a, b) => a.ordinal - b.ordinal);
  return sha256Hex(
    "hor-evidence-v1" +
      ordered
        .map((e) => `\n${e.ordinal}|${e.kind}|${e.documentSha256}|${lengthPrefixed(e.reference)}|${lengthPrefixed(e.description)}`)
        .join("")
  );
}

export interface ResolutionDigestInput {
  id: string;
  incidentId: string;
  outcome: "COMPANY_ASSUMED_LIABILITY";
  policyId: string;
  policyDigest: string;
  deletedOrderReference: string;
  sourceAuditLogId: string;
  orderType: OrderType;
  expectedAmount: Prisma.Decimal;
  collectedAmount: Prisma.Decimal;
  collectionDifference: Prisma.Decimal;
  verification: HistoricalCollectionVerification;
  ledgerReconciliationId: string;
  heldCollectionAmount: Prisma.Decimal;
  trackedShortfallAmount: Prisma.Decimal;
  evidenceManifestDigest: string;
  evidenceCount: number;
  rationaleDigest: string;
}

export function buildResolutionCanonicalString(r: ResolutionDigestInput): string {
  return [
    "hor-resolution-v1",
    r.id.toLowerCase(),
    r.incidentId.toLowerCase(),
    r.outcome,
    r.policyId.toLowerCase(),
    r.policyDigest,
    r.deletedOrderReference.toLowerCase(),
    r.sourceAuditLogId.toLowerCase(),
    r.orderType,
    money(r.expectedAmount),
    money(r.collectedAmount),
    money(r.collectionDifference),
    r.verification,
    r.ledgerReconciliationId.toLowerCase(),
    money(r.heldCollectionAmount),
    money(r.trackedShortfallAmount),
    r.evidenceManifestDigest,
    String(r.evidenceCount),
    r.rationaleDigest,
  ].join("|");
}

export function computeResolutionDigest(r: ResolutionDigestInput): string {
  return sha256Hex(buildResolutionCanonicalString(r));
}

// Approved policy L1 / L2 (also DB CHECKs): the full collected amount is
// held as a liability; the shortfall is tracked separately, never recognized.
export function liabilityAmounts(expected: Prisma.Decimal, collected: Prisma.Decimal) {
  const shortfall = expected.minus(collected);
  return {
    heldCollectionAmount: collected,
    trackedShortfallAmount: shortfall.greaterThan(0) ? shortfall : new Prisma.Decimal(0),
  };
}

// ------------------------------------------------------------ liability

export interface LiabilityDigestInput {
  id: string;
  resolutionId: string;
  resolutionDigest: string;
  approvalDecisionId: string;
  approvedById: string;
  heldCollectionAmount: Prisma.Decimal;
  trackedShortfallAmount: Prisma.Decimal;
  recognizedAmount: Prisma.Decimal;
  recordedById: string;
}

export function buildLiabilityCanonicalString(l: LiabilityDigestInput): string {
  return [
    "hl-liability-v1",
    l.id.toLowerCase(),
    l.resolutionId.toLowerCase(),
    l.resolutionDigest,
    l.approvalDecisionId.toLowerCase(),
    l.approvedById.toLowerCase(),
    money(l.heldCollectionAmount),
    money(l.trackedShortfallAmount),
    money(l.recognizedAmount),
    l.recordedById.toLowerCase(),
  ].join("|");
}

export function computeLiabilityDigest(l: LiabilityDigestInput): string {
  return sha256Hex(buildLiabilityCanonicalString(l));
}
