import { createHash } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type {
  DriverCashAccountReconciliation,
  DriverCashAccountReconciliationInput,
  HistoricalOwnershipRecord,
  HistoricalReconciliationDecisionRecord,
  HistoricalReconciliationEvidence,
  HistoricalReconciliationStatus,
} from "./historical-reconciliation.types";

// ============================================================
// FR.12A.3 — Pure helpers for driver cash historical reconciliation.
// No database access. reconcileDriverCashAccount is the exact mirror of the
// SQL residual rule G3 / R1 apply (historical-reconciliation.sql.ts, FR.12A.4).
// All money is exact Prisma.Decimal; nothing is rounded.
// ============================================================

export const EVIDENCE_DIGEST_VERSION = "dchr-evidence-v1";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// NUMERIC(14,2): at most 12 integer digits.
const MONEY_LIMIT = new Prisma.Decimal("1000000000000");

// ------------------------------------------------------------ lifecycle

// Status from the append-only decisions (DB constraints make any other shape
// impossible; an inconsistent history throws instead of counting as approved).
export function deriveHistoricalReconciliationStatus(
  decisions: readonly HistoricalReconciliationDecisionRecord[]
): HistoricalReconciliationStatus {
  const outcomes = decisions.filter((d) => d.decision !== "REVOKED");
  const revocations = decisions.filter((d) => d.decision === "REVOKED");
  if (outcomes.length > 1) {
    throw new Error("Historical reconciliation has more than one review outcome");
  }
  const outcome = outcomes[0];
  if (revocations.length > 0) {
    if (
      revocations.length > 1 ||
      outcome?.decision !== "APPROVED" ||
      revocations[0].revokesDecisionId !== outcome.id
    ) {
      throw new Error("Historical reconciliation revocation does not end its approval");
    }
    return "REVOKED";
  }
  return outcome ? outcome.decision : "PROPOSED";
}

// PROPOSED and APPROVED are live; the others are terminal and may be superseded.
export function isLiveHistoricalReconciliationStatus(status: HistoricalReconciliationStatus): boolean {
  return status === "PROPOSED" || status === "APPROVED";
}

// ------------------------------------------------------------ reconciliation equations (design §7)

// D = S − N
export function calculateRawDiscrepancy(storedBalance: Prisma.Decimal, rawLedgerNet: Prisma.Decimal): Prisma.Decimal {
  return storedBalance.minus(rawLedgerNet);
}

// R = D − A
export function calculateUnexplainedResidual(
  rawDiscrepancy: Prisma.Decimal,
  approvedHistoricalAmount: Prisma.Decimal
): Prisma.Decimal {
  return rawDiscrepancy.minus(approvedHistoricalAmount);
}

// The jump a gap leaves in the balance chain: anchor.balance_before −
// coalesce(predecessor.balance_after, 0) (a gap at the start follows 0).
export function calculateObservedJump(
  predecessorBalanceAfter: Prisma.Decimal | null,
  anchorBalanceBefore: Prisma.Decimal
): Prisma.Decimal {
  return anchorBalanceBefore.minus(predecessorBalanceAfter ?? new Prisma.Decimal(0));
}

// A = Σ amount of APPROVED reconciliations whose evidence is still valid.
// An APPROVED reconciliation with invalid evidence, or any record with an
// invalid decision history, contributes nothing and is reported separately
// (X, always blocking); PROPOSED / REJECTED / WITHDRAWN / REVOKED never count.
export function reconcileDriverCashAccount(input: DriverCashAccountReconciliationInput): DriverCashAccountReconciliation {
  let approvedHistoricalAmount = new Prisma.Decimal(0);
  const approvedValidReconciliationIds: string[] = [];
  const invalidApprovedReconciliationIds: string[] = [];

  for (const r of input.reconciliations) {
    if (r.accountId !== input.accountId) {
      throw new Error(`Historical reconciliation ${r.reconciliationId} belongs to another driver cash account`);
    }
    if (r.status === "INVALID_HISTORY") {
      invalidApprovedReconciliationIds.push(r.reconciliationId);
      continue;
    }
    if (r.status !== "APPROVED") continue;
    if (r.evidenceValidity.valid) {
      approvedHistoricalAmount = approvedHistoricalAmount.plus(r.amount);
      approvedValidReconciliationIds.push(r.reconciliationId);
    } else {
      invalidApprovedReconciliationIds.push(r.reconciliationId);
    }
  }

  const rawDiscrepancy = calculateRawDiscrepancy(input.storedBalance, input.rawLedgerNet);
  return {
    accountId: input.accountId,
    storedBalance: input.storedBalance,
    rawLedgerNet: input.rawLedgerNet,
    rawDiscrepancy,
    approvedHistoricalAmount,
    unexplainedResidual: calculateUnexplainedResidual(rawDiscrepancy, approvedHistoricalAmount),
    approvedValidReconciliationIds,
    invalidApprovedReconciliationIds,
  };
}

// ------------------------------------------------------------ ownership

// A ledger reconciliation never resolves ownership. Every record whose
// ownership is UNRESOLVED blocks activation (G5) WHATEVER its decision status:
// approving, rejecting, withdrawing or revoking the ledger explanation says
// nothing about who owns the collected money (FR.12A.4).
export function isUnresolvedHistoricalOwnership(record: HistoricalOwnershipRecord): boolean {
  return record.ownershipStatus === "UNRESOLVED";
}

// ------------------------------------------------------------ evidence digest

function canonicalUuid(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new Error(`${label} is not a UUID`);
  return value.toLowerCase();
}

// NUMERIC(14,2) text exactly as PostgreSQL prints it. Values the column would
// round or reject are refused instead of being silently rounded.
function canonicalMoney(value: Prisma.Decimal, label: string): string {
  if (!value.isFinite() || value.decimalPlaces() > 2 || value.abs().gte(MONEY_LIMIT)) {
    throw new Error(`${label} is not an exact NUMERIC(14,2) amount`);
  }
  return value.isZero() ? "0.00" : value.toFixed(2);
}

// Mirrors dchr_evidence_digest_chk in the migration character for character.
export function buildEvidenceCanonicalString(e: HistoricalReconciliationEvidence): string {
  return [
    EVIDENCE_DIGEST_VERSION,
    canonicalUuid(e.incidentId, "incidentId"),
    canonicalUuid(e.accountId, "accountId"),
    canonicalUuid(e.driverId, "driverId"),
    e.kind,
    e.accountingTreatment,
    canonicalMoney(e.amount, "amount"),
    canonicalMoney(e.observedJump, "observedJump"),
    e.predecessorTransactionId === null ? "" : canonicalUuid(e.predecessorTransactionId, "predecessorTransactionId"),
    canonicalUuid(e.anchorTransactionId, "anchorTransactionId"),
    canonicalUuid(e.missingTransactionId, "missingTransactionId"),
    canonicalUuid(e.sourceAuditLogId, "sourceAuditLogId"),
    canonicalUuid(e.deletedOrderReference, "deletedOrderReference"),
    e.orderType,
    canonicalMoney(e.expectedAmount, "expectedAmount"),
    canonicalMoney(e.actualAmount, "actualAmount"),
    canonicalMoney(e.collectionDifference, "collectionDifference"),
    e.relatedSettlementId === null ? "" : canonicalUuid(e.relatedSettlementId, "relatedSettlementId"),
  ].join("|");
}

export function computeEvidenceDigest(e: HistoricalReconciliationEvidence): string {
  return createHash("sha256").update(buildEvidenceCanonicalString(e), "utf8").digest("hex");
}
