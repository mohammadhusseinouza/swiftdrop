// ============================================================
// FR.12A.11 — Historical ownership resolution workflow: liability policy
// versions, company-assumed liability resolutions, the explicit recording of
// an approved liability, and periodic Finance reviews.
//
// Design: docs/fr12a7b-company-assumed-historical-liability-design.md
// (approved policy direction P1, L1–L7, D8, D10 — §11).
//
// NOTHING here posts or moves money. Recording a liability creates a register
// row only: no wallet credit, driver cash movement, payout, settlement or
// company revenue is ever created, and no liability is ever discharged. The
// approved ledger reconciliation is read as evidence and never changed.
//
// Every write:
//   * requires HISTORICAL_OWNERSHIP_RESOLUTION_ENABLED=true (unset = disabled;
//     set only for an authorized window);
//   * is idempotent on the Idempotency-Key header (actor-scoped; a reused key
//     with different content is refused);
//   * takes the lock order: request advisory key -> deleted-order (or policy
//     code) advisory key -> activation row (FOR SHARE) -> policy row ->
//     resolution row -> inserts;
//   * re-evaluates the shared validity SQL inside the same transaction and
//     rolls back unless the result is exactly the expected state;
//   * appends (never edits) and writes its audit row in the same transaction.
//
// Separation of duties (D8, also DB CHECKs): ADMIN proposes and withdraws;
// FINANCE (never the proposer) approves or rejects; a FINANCE user who is
// neither the proposer nor the approver records the liability; an ADMIN who
// is neither the proposer nor the approver (nor the recorder) revokes.
// ============================================================

import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { OrderType } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { deriveRequestIdempotencyKey } from "../../shared/idempotency/request-idempotency";
import { readSettlementModeActivation } from "../financial-release/financial-release.service";
import {
  computeEvidenceManifestDigest,
  computeLiabilityDigest,
  computePolicyContentSha256,
  computePolicyDigest,
  computeResolutionDigest,
  liabilityAmounts,
  sha256OfText,
  type EvidenceItem,
} from "./historical-ownership.calculation";
import { evaluatePolicies, evaluateResolutions } from "./historical-ownership.service";
import {
  HISTORICAL_LIABILITY_AUDIT_ACTIONS,
  HISTORICAL_LIABILITY_POLICY_AUDIT_ACTIONS,
  HISTORICAL_OWNERSHIP_AUDIT_ENTITIES,
  HISTORICAL_OWNERSHIP_RESOLUTION_AUDIT_ACTIONS,
} from "./historical-ownership.sql";
import type {
  ApprovePolicyInput,
  ApproveResolutionInput,
  ProposeLiabilityPolicyInput,
  ProposeResolutionInput,
  ReasonedInput,
  RecordLiabilityInput,
  ReviewLiabilityInput,
} from "./historical-ownership.schema";

export const HISTORICAL_OWNERSHIP_WRITES_ENV = "HISTORICAL_OWNERSHIP_RESOLUTION_ENABLED";
export const LIABILITY_OUTCOME = "COMPANY_ASSUMED_LIABILITY" as const;

const TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };
const MONEY_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY_LIMIT = new Prisma.Decimal("1000000000000");
const ORDER_TYPES: readonly OrderType[] = ["COMPANY_ORDER", "DELIVERY_ONLY"];

export interface WorkflowActor {
  userId: string;
  roleCode: string;
}

type DecisionKind = "APPROVED" | "REJECTED" | "WITHDRAWN" | "REVOKED";

const DECISION_ROLE: Record<DecisionKind, "ADMIN" | "FINANCE"> = {
  APPROVED: "FINANCE",
  REJECTED: "FINANCE",
  WITHDRAWN: "ADMIN",
  REVOKED: "ADMIN",
};

export function areHistoricalOwnershipWritesEnabled(): boolean {
  return process.env[HISTORICAL_OWNERSHIP_WRITES_ENV] === "true";
}

function assertWritesEnabled(): void {
  if (!areHistoricalOwnershipWritesEnabled()) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Historical ownership resolution changes are disabled for this environment",
      details: { reason: "HISTORICAL_OWNERSHIP_DISABLED" },
    });
  }
}

// Defense in depth — the routes already restrict by role.
function assertRole(actor: WorkflowActor, roleCode: "ADMIN" | "FINANCE"): void {
  if (actor.roleCode !== roleCode) {
    throw new AppError({ statusCode: 403, code: "FORBIDDEN", message: "You do not have permission to perform this action" });
  }
}

function conflict(reason: string, message: string, details: Record<string, unknown> = {}): AppError {
  return new AppError({ statusCode: 409, code: "CONFLICT", message, details: { reason, ...details } });
}

function forbidden(reason: string, message: string): AppError {
  return new AppError({ statusCode: 403, code: "FORBIDDEN", message, details: { reason } });
}

function notFound(message: string): AppError {
  return new AppError({ statusCode: 404, code: "NOT_FOUND", message });
}

function idempotencyReused(): AppError {
  return conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different request.");
}

function evidenceInvalid(message: string, details: Record<string, unknown> = {}): AppError {
  return conflict("OWNERSHIP_EVIDENCE_INVALID", message, details);
}

function auditAmount(raw: unknown, label: string): Prisma.Decimal {
  if (typeof raw !== "string" || !MONEY_TEXT.test(raw)) {
    throw evidenceInvalid(`The source audit's ${label} is not an exact decimal amount`, { failures: ["SOURCE_AUDIT_MISMATCH"] });
  }
  const value = new Prisma.Decimal(raw);
  if (value.decimalPlaces() > 2 || value.abs().gte(MONEY_LIMIT)) {
    throw evidenceInvalid(`The source audit's ${label} is not a two-decimal ledger amount`, { failures: ["SOURCE_AUDIT_MISMATCH"] });
  }
  return value;
}

function mapWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") return conflict("HISTORICAL_OWNERSHIP_CONFLICT", "A conflicting historical ownership record already exists");
    if (error.code === "P2003") return evidenceInvalid("A referenced record does not match the approved record it must bind to");
  }
  return error;
}

async function advisory(tx: Prisma.TransactionClient, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key})::bigint)`;
}

const orderLockKey = (deletedOrderReference: string) => `historical-ownership:${deletedOrderReference}`;
const policyLockKey = (policyCode: string) => `historical-liability-policy:${policyCode}`;

async function lockPolicyRow(tx: Prisma.TransactionClient, policyId: string, mode: "SHARE" | "NO KEY UPDATE"): Promise<void> {
  const rows =
    mode === "SHARE"
      ? await tx.$queryRaw<{ id: string }[]>`SELECT id FROM historical_liability_policies WHERE id = ${policyId}::uuid FOR SHARE`
      : await tx.$queryRaw<{ id: string }[]>`SELECT id FROM historical_liability_policies WHERE id = ${policyId}::uuid FOR NO KEY UPDATE`;
  if (rows.length === 0) throw notFound("Liability policy not found");
}

async function lockResolutionRow(tx: Prisma.TransactionClient, resolutionId: string): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM historical_ownership_resolutions WHERE id = ${resolutionId}::uuid FOR NO KEY UPDATE
  `;
  if (rows.length === 0) throw notFound("Historical ownership resolution not found");
}

async function policyEvaluation(tx: Prisma.TransactionClient, policyId: string) {
  const [entry] = await evaluatePolicies(tx, [policyId]);
  if (!entry) throw notFound("Liability policy not found");
  return entry;
}

async function resolutionEvaluation(tx: Prisma.TransactionClient, resolutionId: string) {
  const [entry] = await evaluateResolutions(tx, { resolutionIds: [resolutionId] });
  if (!entry) throw notFound("Historical ownership resolution not found");
  return entry;
}

// ============================================================ policies

type PolicyRow = Prisma.historical_liability_policiesGetPayload<object>;

// A replay must be the IDENTICAL request (review L1): every field the client
// sent is compared, as stored (trimmed / defaulted exactly like the insert).
function reconcilePolicyReplay(existing: PolicyRow, input: ProposeLiabilityPolicyInput): string {
  if (
    existing.policy_code === input.policyCode &&
    existing.title === input.title.trim() &&
    existing.summary === input.summary.trim() &&
    existing.document_sha256 === input.documentSha256 &&
    existing.document_reference === input.documentReference.trim() &&
    existing.review_interval_days === (input.reviewIntervalDays ?? null) &&
    existing.unclaimed_funds_handling === input.unclaimedFundsHandling.trim() &&
    existing.unclaimed_review_after_days === (input.unclaimedReviewAfterDays ?? null)
  ) {
    return existing.id;
  }
  throw idempotencyReused();
}

export async function proposeLiabilityPolicy(input: ProposeLiabilityPolicyInput, actor: WorkflowActor, rawIdempotencyKey: string): Promise<string> {
  assertRole(actor, "ADMIN");
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-liability-policy-proposal", actor.userId, rawIdempotencyKey);
  const replay = await prisma.historical_liability_policies.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) return reconcilePolicyReplay(replay, input);

  try {
    return await prisma.$transaction(async (tx) => {
      await advisory(tx, derivedKey);
      await advisory(tx, policyLockKey(input.policyCode));
      await readSettlementModeActivation(tx);
      const postLock = await tx.historical_liability_policies.findUnique({ where: { idempotency_key: derivedKey } });
      if (postLock) return reconcilePolicyReplay(postLock, input);

      const latest = await tx.historical_liability_policies.findFirst({
        where: { policy_code: input.policyCode },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      const content = {
        title: input.title.trim(),
        summary: input.summary.trim(),
        documentReference: input.documentReference.trim(),
        unclaimedFundsHandling: input.unclaimedFundsHandling.trim(),
      };
      const id = randomUUID();
      const version = (latest?.version ?? 0) + 1;
      const reviewIntervalDays = input.reviewIntervalDays ?? null;
      const unclaimedReviewAfterDays = input.unclaimedReviewAfterDays ?? null;
      const contentSha256 = computePolicyContentSha256(content);
      const policyDigest = computePolicyDigest({
        id,
        policyCode: input.policyCode,
        version,
        outcome: LIABILITY_OUTCOME,
        documentSha256: input.documentSha256,
        reviewIntervalDays,
        unclaimedReviewAfterDays,
        contentSha256,
      });
      await tx.historical_liability_policies.create({
        data: {
          id,
          policy_code: input.policyCode,
          version,
          outcome: LIABILITY_OUTCOME,
          title: content.title,
          summary: content.summary,
          document_sha256: input.documentSha256,
          document_reference: content.documentReference,
          review_interval_days: reviewIntervalDays,
          unclaimed_funds_handling: content.unclaimedFundsHandling,
          unclaimed_review_after_days: unclaimedReviewAfterDays,
          content_sha256: contentSha256,
          policy_digest: policyDigest,
          proposed_by_id: actor.userId,
          idempotency_key: derivedKey,
        },
      });
      const evaluated = await policyEvaluation(tx, id);
      if (evaluated.status !== "PROPOSED" || evaluated.failures.length > 0) {
        throw evidenceInvalid("The policy does not validate", { failures: evaluated.failures });
      }
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_LIABILITY_POLICY_AUDIT_ACTIONS.PROPOSED,
        entityType: HISTORICAL_OWNERSHIP_AUDIT_ENTITIES.POLICY,
        entityId: id,
        newValues: { status: "PROPOSED" },
        metadata: {
          policyCode: input.policyCode,
          version,
          outcome: LIABILITY_OUTCOME,
          documentSha256: input.documentSha256,
          reviewIntervalDays,
          unclaimedReviewAfterDays,
          contentSha256,
          policyDigest,
        },
      });
      return id;
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

export interface PolicyDecisionResult {
  policyId: string;
  decisionId: string;
}

interface DecisionRequest {
  kind: DecisionKind;
  reason: string | null;
  // APPROVED only: the fingerprint the reviewer confirmed.
  digest?: string;
}

async function decidePolicy(policyId: string, request: DecisionRequest, actor: WorkflowActor, rawIdempotencyKey: string): Promise<PolicyDecisionResult> {
  assertRole(actor, DECISION_ROLE[request.kind]);
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-liability-policy-decision", actor.userId, rawIdempotencyKey);
  const reconcile = (existing: { id: string; policy_id: string; decision: string; reason: string | null; policy_digest: string }) => {
    if (
      existing.policy_id === policyId &&
      existing.decision === request.kind &&
      (existing.reason ?? null) === request.reason &&
      (request.digest === undefined || existing.policy_digest === request.digest)
    ) {
      return { policyId, decisionId: existing.id };
    }
    throw idempotencyReused();
  };
  const replay = await prisma.historical_liability_policy_decisions.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) return reconcile(replay);
  const policy = await prisma.historical_liability_policies.findUnique({ where: { id: policyId }, select: { policy_code: true } });
  if (!policy) throw notFound("Liability policy not found");

  try {
    return await prisma.$transaction(async (tx) => {
      await advisory(tx, derivedKey);
      await advisory(tx, policyLockKey(policy.policy_code));
      await readSettlementModeActivation(tx);
      await lockPolicyRow(tx, policyId, "NO KEY UPDATE");
      const postLock = await tx.historical_liability_policy_decisions.findUnique({ where: { idempotency_key: derivedKey } });
      if (postLock) return reconcile(postLock);

      const row = await tx.historical_liability_policies.findUniqueOrThrow({ where: { id: policyId } });
      const evaluated = await policyEvaluation(tx, policyId);
      let revokes: { id: string; approverId: string } | null = null;
      if (request.kind === "REVOKED") {
        if (evaluated.status !== "APPROVED") {
          throw conflict("POLICY_NOT_APPROVED", "Only an approved policy can be revoked", { status: evaluated.status });
        }
        const approval = await tx.historical_liability_policy_decisions.findFirstOrThrow({
          where: { policy_id: policyId, decision: "APPROVED" },
          select: { id: true, decided_by_id: true },
        });
        if (actor.userId === row.proposed_by_id || actor.userId === approval.decided_by_id) {
          throw forbidden("REVOKER_NOT_INDEPENDENT", "A revocation must be made by someone other than the proposer and the approver");
        }
        revokes = { id: approval.id, approverId: approval.decided_by_id };
      } else {
        if (evaluated.status !== "PROPOSED") {
          throw conflict("POLICY_NOT_PENDING", "This policy is no longer awaiting a decision", { status: evaluated.status });
        }
        if ((request.kind === "APPROVED" || request.kind === "REJECTED") && actor.userId === row.proposed_by_id) {
          throw forbidden("REVIEWER_NOT_INDEPENDENT", "A policy must be reviewed by someone other than its proposer");
        }
      }
      if (request.kind === "APPROVED") {
        if (request.digest !== row.policy_digest) {
          throw conflict("STALE_POLICY_DIGEST", "The policy fingerprint you reviewed no longer matches the stored policy — reload and review again");
        }
        if (evaluated.failures.length > 0) throw evidenceInvalid("The policy does not validate — it cannot be approved", { failures: evaluated.failures });
      }

      const decision = await tx.historical_liability_policy_decisions.create({
        data: {
          policy_id: policyId,
          decision: request.kind,
          is_terminal: request.kind !== "APPROVED",
          proposed_by_id: row.proposed_by_id,
          policy_digest: row.policy_digest,
          revokes_decision_id: revokes?.id ?? null,
          revokes_decision_type: revokes ? "APPROVED" : undefined,
          revoked_approver_id: revokes?.approverId ?? null,
          decided_by_id: actor.userId,
          reason: request.reason,
          idempotency_key: derivedKey,
        },
      });
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_LIABILITY_POLICY_AUDIT_ACTIONS[request.kind],
        entityType: HISTORICAL_OWNERSHIP_AUDIT_ENTITIES.POLICY,
        entityId: policyId,
        previousValues: { status: evaluated.status },
        newValues: { status: request.kind },
        metadata: {
          decisionId: decision.id,
          decision: request.kind,
          policyCode: row.policy_code,
          version: row.version,
          policyDigest: row.policy_digest,
          revokesDecisionId: revokes?.id ?? null,
          reason: request.reason,
        },
      });
      if (request.kind === "APPROVED") {
        const after = await policyEvaluation(tx, policyId);
        if (after.status !== "APPROVED" || after.failures.length > 0) {
          throw evidenceInvalid("The approved policy did not validate", { failures: after.failures });
        }
      }
      return { policyId, decisionId: decision.id };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

export const approveLiabilityPolicy = (id: string, input: ApprovePolicyInput, actor: WorkflowActor, key: string) =>
  decidePolicy(id, { kind: "APPROVED", reason: input.note ?? null, digest: input.policyDigest }, actor, key);
export const rejectLiabilityPolicy = (id: string, input: ReasonedInput, actor: WorkflowActor, key: string) =>
  decidePolicy(id, { kind: "REJECTED", reason: input.reason.trim() }, actor, key);
export const withdrawLiabilityPolicy = (id: string, input: ReasonedInput, actor: WorkflowActor, key: string) =>
  decidePolicy(id, { kind: "WITHDRAWN", reason: input.reason.trim() }, actor, key);
export const revokeLiabilityPolicy = (id: string, input: ReasonedInput, actor: WorkflowActor, key: string) =>
  decidePolicy(id, { kind: "REVOKED", reason: input.reason.trim() }, actor, key);

// ============================================================ resolutions

const replayInclude = { evidence: { orderBy: { ordinal: "asc" } } } as const;
type ResolutionRow = Prisma.historical_ownership_resolutionsGetPayload<{ include: typeof replayInclude }>;

// A replay must be the IDENTICAL request (review L1), evidence included: same
// documents in the same order with the same kind, fingerprint, reference and
// description (compared as stored, i.e. trimmed).
function reconcileResolutionReplay(existing: ResolutionRow, input: ProposeResolutionInput): string {
  const sameEvidence =
    existing.evidence.length === input.evidence.length &&
    existing.evidence.every((e, i) => {
      const x = input.evidence[i];
      return (
        e.ordinal === i + 1 &&
        e.kind === x.kind &&
        e.document_sha256 === x.documentSha256 &&
        e.reference === x.reference.trim() &&
        e.description === x.description.trim()
      );
    });
  if (
    existing.source_audit_log_id === input.sourceAuditLogId &&
    existing.policy_id === input.policyId &&
    existing.incident_id === input.incidentId &&
    existing.ledger_reconciliation_id === input.ledgerReconciliationId &&
    existing.rationale === input.rationale.trim() &&
    sameEvidence
  ) {
    return existing.id;
  }
  throw idempotencyReused();
}

export async function proposeOwnershipResolution(input: ProposeResolutionInput, actor: WorkflowActor, rawIdempotencyKey: string): Promise<string> {
  assertRole(actor, "ADMIN");
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-ownership-resolution-proposal", actor.userId, rawIdempotencyKey);
  const replay = await prisma.historical_ownership_resolutions.findUnique({ where: { idempotency_key: derivedKey }, include: replayInclude });
  if (replay) return reconcileResolutionReplay(replay, input);

  const audit = await prisma.audit_logs.findUnique({ where: { id: input.sourceAuditLogId } });
  if (!audit || audit.action !== "COLLECTION_DIFFERENCE_RECORDED" || audit.entity_type !== "ORDER" || !UUID.test(audit.entity_id)) {
    throw evidenceInvalid("The source audit is not a surviving COLLECTION_DIFFERENCE_RECORDED order audit", { failures: ["SOURCE_AUDIT_MISMATCH"] });
  }
  const deletedOrderReference = audit.entity_id.toLowerCase();

  try {
    return await prisma.$transaction(async (tx) => {
      await advisory(tx, derivedKey);
      await advisory(tx, orderLockKey(deletedOrderReference));
      await readSettlementModeActivation(tx);
      await lockPolicyRow(tx, input.policyId, "SHARE");
      const postLock = await tx.historical_ownership_resolutions.findUnique({ where: { idempotency_key: derivedKey }, include: replayInclude });
      if (postLock) return reconcileResolutionReplay(postLock, input);

      // ---- the deleted order and the exact amounts its surviving audit records
      if (await tx.orders.findUnique({ where: { id: deletedOrderReference }, select: { id: true } })) {
        throw evidenceInvalid("The order still exists — use the normal collection-difference resolution", { failures: ["DELETED_ORDER_PRESENT"] });
      }
      const metadata = (audit.metadata ?? {}) as Record<string, unknown>;
      const orderType = metadata.orderType;
      if (typeof orderType !== "string" || !ORDER_TYPES.includes(orderType as OrderType)) {
        throw evidenceInvalid("The source audit does not record a valid order type", { failures: ["SOURCE_AUDIT_MISMATCH"] });
      }
      const collected = auditAmount(metadata.actualAmount, "actualAmount");
      const expected = auditAmount(metadata.expectedAmount, "expectedAmount");
      const difference = auditAmount(metadata.difference, "difference");
      if (!collected.greaterThan(0) || expected.isNegative() || difference.isZero() || !difference.equals(collected.minus(expected))) {
        throw evidenceInvalid("The source audit's amounts are not a consistent recorded collection difference", { failures: ["SOURCE_AUDIT_MISMATCH"] });
      }

      // ---- the policy version must already be approved and valid
      const policy = await tx.historical_liability_policies.findUniqueOrThrow({ where: { id: input.policyId } });
      const policyState = await policyEvaluation(tx, input.policyId);
      if (policyState.status !== "APPROVED" || policyState.failures.length > 0 || policy.outcome !== LIABILITY_OUTCOME) {
        throw conflict("POLICY_NOT_APPROVED", "The cited policy version is not approved and valid", { status: policyState.status, failures: policyState.failures });
      }

      // ---- incident and collection verification
      const incident = await tx.financial_ledger_incidents.findUnique({ where: { id: input.incidentId }, select: { id: true, incident_number: true } });
      if (!incident) throw notFound("Ledger incident not found");
      // The approved ledger reconciliation is the only accepted verification
      // (its validity and the settlement handover are re-checked by the
      // shared validity SQL below).
      const rec = await tx.driver_cash_historical_reconciliations.findUnique({
        where: { id: input.ledgerReconciliationId },
        select: { deleted_order_reference: true, incident_id: true, source_audit_log_id: true },
      });
      if (!rec || rec.deleted_order_reference !== deletedOrderReference || rec.source_audit_log_id !== audit.id) {
        throw evidenceInvalid("The ledger reconciliation does not explain this deleted order's collection", { failures: ["COLLECTION_NOT_VERIFIED"] });
      }
      if (rec.incident_id !== incident.id) {
        throw evidenceInvalid("The ledger reconciliation belongs to a different incident", { failures: ["INCIDENT_MISMATCH"] });
      }

      // ---- duplicates and re-proposal (append-only supersession chain)
      const chain = await tx.historical_ownership_resolutions.findMany({
        where: { deleted_order_reference: deletedOrderReference },
        select: { id: true, supersedes_resolution_id: true },
      });
      let supersedes: { resolutionId: string; decisionId: string } | null = null;
      if (chain.length > 0) {
        const evaluated = await evaluateResolutions(tx, { resolutionIds: chain.map((c) => c.id) });
        const live = evaluated.find((e) => ["PROPOSED", "APPROVED", "INVALID_HISTORY"].includes(e.status));
        if (live) {
          throw conflict("RESOLUTION_ALREADY_PROPOSED", "This deleted order already has a live ownership resolution", {
            resolutionId: live.resolutionId,
            status: live.status,
          });
        }
        const superseded = new Set(chain.map((c) => c.supersedes_resolution_id).filter(Boolean));
        const head = chain.find((c) => !superseded.has(c.id));
        const terminal = head
          ? await tx.historical_ownership_resolution_decisions.findFirst({
              where: { resolution_id: head.id, is_terminal: true },
              orderBy: { created_at: "desc" },
              select: { id: true },
            })
          : null;
        if (!head || !terminal) throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Historical ownership resolution chain is inconsistent" });
        supersedes = { resolutionId: head.id, decisionId: terminal.id };
      }

      // ---- the proposal (server-derived amounts: L1 / L2)
      const evidence: EvidenceItem[] = input.evidence.map((e, i) => ({
        ordinal: i + 1,
        kind: e.kind,
        documentSha256: e.documentSha256,
        reference: e.reference.trim(),
        description: e.description.trim(),
      }));
      const rationale = input.rationale.trim();
      const { heldCollectionAmount, trackedShortfallAmount } = liabilityAmounts(expected, collected);
      const id = randomUUID();
      const digestInput = {
        id,
        incidentId: incident.id,
        outcome: LIABILITY_OUTCOME,
        policyId: policy.id,
        policyDigest: policy.policy_digest,
        deletedOrderReference,
        sourceAuditLogId: audit.id,
        orderType: orderType as OrderType,
        expectedAmount: expected,
        collectedAmount: collected,
        collectionDifference: difference,
        verification: "APPROVED_LEDGER_RECONCILIATION" as const,
        ledgerReconciliationId: input.ledgerReconciliationId,
        heldCollectionAmount,
        trackedShortfallAmount,
        evidenceManifestDigest: computeEvidenceManifestDigest(evidence),
        evidenceCount: evidence.length,
        rationaleDigest: sha256OfText(rationale),
      };
      const resolutionDigest = computeResolutionDigest(digestInput);
      await tx.historical_ownership_resolutions.create({
        data: {
          id,
          incident_id: digestInput.incidentId,
          outcome: LIABILITY_OUTCOME,
          policy_id: digestInput.policyId,
          policy_digest: digestInput.policyDigest,
          deleted_order_reference: deletedOrderReference,
          source_audit_log_id: audit.id,
          order_type: digestInput.orderType,
          expected_amount: expected,
          collected_amount: collected,
          collection_difference: difference,
          verification: digestInput.verification,
          ledger_reconciliation_id: digestInput.ledgerReconciliationId,
          held_collection_amount: heldCollectionAmount,
          tracked_shortfall_amount: trackedShortfallAmount,
          evidence_manifest_digest: digestInput.evidenceManifestDigest,
          evidence_count: digestInput.evidenceCount,
          rationale,
          rationale_digest: digestInput.rationaleDigest,
          resolution_digest: resolutionDigest,
          proposed_by_id: actor.userId,
          idempotency_key: derivedKey,
          supersedes_resolution_id: supersedes?.resolutionId,
          supersedes_decision_id: supersedes?.decisionId,
          supersedes_decision_is_terminal: supersedes ? true : undefined,
        },
      });
      await tx.historical_ownership_resolution_evidence.createMany({
        data: evidence.map((e) => ({
          resolution_id: id,
          ordinal: e.ordinal,
          kind: e.kind,
          document_sha256: e.documentSha256,
          reference: e.reference,
          description: e.description,
        })),
      });

      // The authoritative check: the shared validity SQL, same transaction.
      const evaluated = await resolutionEvaluation(tx, id);
      if (evaluated.status !== "PROPOSED" || evaluated.failures.length > 0) {
        throw evidenceInvalid("The derived evidence does not validate as a historical ownership resolution", { failures: evaluated.failures });
      }
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_OWNERSHIP_RESOLUTION_AUDIT_ACTIONS.PROPOSED,
        entityType: HISTORICAL_OWNERSHIP_AUDIT_ENTITIES.RESOLUTION,
        entityId: id,
        newValues: { status: "PROPOSED" },
        metadata: {
          incidentId: incident.id,
          incidentNumber: incident.incident_number,
          outcome: LIABILITY_OUTCOME,
          policyId: policy.id,
          policyCode: policy.policy_code,
          policyVersion: policy.version,
          deletedOrderReference,
          sourceAuditLogId: audit.id,
          orderType,
          expectedAmount: expected.toFixed(2),
          collectedAmount: collected.toFixed(2),
          collectionDifference: difference.toFixed(2),
          heldCollectionAmount: heldCollectionAmount.toFixed(2),
          trackedShortfallAmount: trackedShortfallAmount.toFixed(2),
          verification: digestInput.verification,
          ledgerReconciliationId: digestInput.ledgerReconciliationId,
          evidence: evidence.map((e) => ({ ordinal: e.ordinal, kind: e.kind, documentSha256: e.documentSha256 })),
          evidenceManifestDigest: digestInput.evidenceManifestDigest,
          resolutionDigest,
          supersedesResolutionId: supersedes?.resolutionId ?? null,
          // A proposal records nothing in any ledger.
          postings: [],
        },
      });
      return id;
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

export interface ResolutionDecisionResult {
  resolutionId: string;
  decisionId: string;
}

async function decideResolution(resolutionId: string, request: DecisionRequest, actor: WorkflowActor, rawIdempotencyKey: string): Promise<ResolutionDecisionResult> {
  assertRole(actor, DECISION_ROLE[request.kind]);
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-ownership-resolution-decision", actor.userId, rawIdempotencyKey);
  const reconcile = (existing: { id: string; resolution_id: string; decision: string; reason: string | null; resolution_digest: string }) => {
    if (
      existing.resolution_id === resolutionId &&
      existing.decision === request.kind &&
      (existing.reason ?? null) === request.reason &&
      (request.digest === undefined || existing.resolution_digest === request.digest)
    ) {
      return { resolutionId, decisionId: existing.id };
    }
    throw idempotencyReused();
  };
  const replay = await prisma.historical_ownership_resolution_decisions.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) return reconcile(replay);
  const record = await prisma.historical_ownership_resolutions.findUnique({
    where: { id: resolutionId },
    select: { deleted_order_reference: true, policy_id: true },
  });
  if (!record) throw notFound("Historical ownership resolution not found");

  try {
    return await prisma.$transaction(async (tx) => {
      await advisory(tx, derivedKey);
      await advisory(tx, orderLockKey(record.deleted_order_reference));
      await readSettlementModeActivation(tx);
      await lockPolicyRow(tx, record.policy_id, "SHARE");
      await lockResolutionRow(tx, resolutionId);
      const postLock = await tx.historical_ownership_resolution_decisions.findUnique({ where: { idempotency_key: derivedKey } });
      if (postLock) return reconcile(postLock);

      const row = await tx.historical_ownership_resolutions.findUniqueOrThrow({ where: { id: resolutionId } });
      const evaluated = await resolutionEvaluation(tx, resolutionId);
      let revokes: { id: string; approverId: string } | null = null;
      if (request.kind === "REVOKED") {
        if (evaluated.status !== "APPROVED") {
          throw conflict("RESOLUTION_NOT_APPROVED", "Only an approved resolution can be revoked", { status: evaluated.status });
        }
        const approval = await tx.historical_ownership_resolution_decisions.findFirstOrThrow({
          where: { resolution_id: resolutionId, decision: "APPROVED" },
          select: { id: true, decided_by_id: true },
        });
        const liability = await tx.historical_liabilities.findUnique({ where: { resolution_id: resolutionId }, select: { recorded_by_id: true } });
        if (actor.userId === row.proposed_by_id || actor.userId === approval.decided_by_id || actor.userId === liability?.recorded_by_id) {
          throw forbidden("REVOKER_NOT_INDEPENDENT", "A revocation must be made by someone other than the proposer, the approver and the recorder");
        }
        revokes = { id: approval.id, approverId: approval.decided_by_id };
      } else {
        if (evaluated.status !== "PROPOSED") {
          throw conflict("RESOLUTION_NOT_PENDING", "This resolution is no longer awaiting a decision", { status: evaluated.status });
        }
        if ((request.kind === "APPROVED" || request.kind === "REJECTED") && actor.userId === row.proposed_by_id) {
          throw forbidden("REVIEWER_NOT_INDEPENDENT", "A resolution must be reviewed by someone other than its proposer");
        }
      }
      if (request.kind === "APPROVED") {
        if (request.digest !== row.resolution_digest) {
          throw conflict("STALE_RESOLUTION_DIGEST", "The resolution fingerprint you reviewed no longer matches the stored resolution — reload and review again");
        }
        if (evaluated.failures.length > 0) throw evidenceInvalid("The evidence no longer validates — it cannot be approved", { failures: evaluated.failures });
      }

      const decision = await tx.historical_ownership_resolution_decisions.create({
        data: {
          resolution_id: resolutionId,
          decision: request.kind,
          is_terminal: request.kind !== "APPROVED",
          proposed_by_id: row.proposed_by_id,
          resolution_digest: row.resolution_digest,
          revokes_decision_id: revokes?.id ?? null,
          revokes_decision_type: revokes ? "APPROVED" : undefined,
          revoked_approver_id: revokes?.approverId ?? null,
          decided_by_id: actor.userId,
          reason: request.reason,
          idempotency_key: derivedKey,
        },
      });
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_OWNERSHIP_RESOLUTION_AUDIT_ACTIONS[request.kind],
        entityType: HISTORICAL_OWNERSHIP_AUDIT_ENTITIES.RESOLUTION,
        entityId: resolutionId,
        previousValues: { status: evaluated.status },
        newValues: { status: request.kind },
        metadata: {
          decisionId: decision.id,
          decision: request.kind,
          deletedOrderReference: row.deleted_order_reference,
          resolutionDigest: row.resolution_digest,
          revokesDecisionId: revokes?.id ?? null,
          reason: request.reason,
          collectedAmount: row.collected_amount.toFixed(2),
          // A decision never posts to any ledger.
          postings: [],
        },
      });
      if (request.kind === "APPROVED") {
        const after = await resolutionEvaluation(tx, resolutionId);
        if (after.status !== "APPROVED" || after.failures.length > 0) {
          throw evidenceInvalid("The approved resolution did not validate", { failures: after.failures });
        }
      }
      return { resolutionId, decisionId: decision.id };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

export const approveOwnershipResolution = (id: string, input: ApproveResolutionInput, actor: WorkflowActor, key: string) =>
  decideResolution(id, { kind: "APPROVED", reason: input.note ?? null, digest: input.resolutionDigest }, actor, key);
export const rejectOwnershipResolution = (id: string, input: ReasonedInput, actor: WorkflowActor, key: string) =>
  decideResolution(id, { kind: "REJECTED", reason: input.reason.trim() }, actor, key);
export const withdrawOwnershipResolution = (id: string, input: ReasonedInput, actor: WorkflowActor, key: string) =>
  decideResolution(id, { kind: "WITHDRAWN", reason: input.reason.trim() }, actor, key);
export const revokeOwnershipResolution = (id: string, input: ReasonedInput, actor: WorkflowActor, key: string) =>
  decideResolution(id, { kind: "REVOKED", reason: input.reason.trim() }, actor, key);

// ============================================================ liability register

export interface RecordLiabilityResult {
  resolutionId: string;
  liabilityId: string;
}

// Records an APPROVED resolution's liability — a separate, explicit step by a
// third person. Posts nothing to any ledger and never discharges anything.
export async function recordHistoricalLiability(
  resolutionId: string,
  input: RecordLiabilityInput,
  actor: WorkflowActor,
  rawIdempotencyKey: string
): Promise<RecordLiabilityResult> {
  assertRole(actor, "FINANCE");
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-liability-record", actor.userId, rawIdempotencyKey);
  const reconcile = (existing: { id: string; resolution_id: string; resolution_digest: string }) => {
    if (existing.resolution_id === resolutionId && existing.resolution_digest === input.resolutionDigest) {
      return { resolutionId, liabilityId: existing.id };
    }
    throw idempotencyReused();
  };
  const replay = await prisma.historical_liabilities.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) return reconcile(replay);
  const record = await prisma.historical_ownership_resolutions.findUnique({
    where: { id: resolutionId },
    select: { deleted_order_reference: true, policy_id: true },
  });
  if (!record) throw notFound("Historical ownership resolution not found");

  try {
    return await prisma.$transaction(async (tx) => {
      await advisory(tx, derivedKey);
      await advisory(tx, orderLockKey(record.deleted_order_reference));
      await readSettlementModeActivation(tx);
      await lockPolicyRow(tx, record.policy_id, "SHARE");
      await lockResolutionRow(tx, resolutionId);
      const postLock = await tx.historical_liabilities.findUnique({ where: { idempotency_key: derivedKey } });
      if (postLock) return reconcile(postLock);

      const row = await tx.historical_ownership_resolutions.findUniqueOrThrow({ where: { id: resolutionId } });
      const evaluated = await resolutionEvaluation(tx, resolutionId);
      if (evaluated.liabilityId) {
        throw conflict("LIABILITY_ALREADY_RECORDED", "The liability of this resolution is already recorded", { liabilityId: evaluated.liabilityId });
      }
      if (evaluated.status !== "APPROVED") {
        throw conflict("RESOLUTION_NOT_APPROVED", "Only an approved resolution can be recorded as a liability", { status: evaluated.status });
      }
      if (input.resolutionDigest !== row.resolution_digest) {
        throw conflict("STALE_RESOLUTION_DIGEST", "The resolution fingerprint you confirmed no longer matches the stored resolution — reload and review again");
      }
      if (evaluated.failures.length > 0) throw evidenceInvalid("The evidence no longer validates — the liability cannot be recorded", { failures: evaluated.failures });
      const approval = await tx.historical_ownership_resolution_decisions.findFirstOrThrow({
        where: { resolution_id: resolutionId, decision: "APPROVED" },
        select: { id: true, decided_by_id: true },
      });
      if (actor.userId === row.proposed_by_id || actor.userId === approval.decided_by_id) {
        throw forbidden("RECORDER_NOT_INDEPENDENT", "The liability must be recorded by someone other than the proposer and the approver");
      }

      const id = randomUUID();
      const recognizedAmount = row.held_collection_amount;
      const liabilityDigest = computeLiabilityDigest({
        id,
        resolutionId,
        resolutionDigest: row.resolution_digest,
        approvalDecisionId: approval.id,
        approvedById: approval.decided_by_id,
        heldCollectionAmount: row.held_collection_amount,
        trackedShortfallAmount: row.tracked_shortfall_amount,
        recognizedAmount,
        recordedById: actor.userId,
      });
      await tx.historical_liabilities.create({
        data: {
          id,
          resolution_id: resolutionId,
          proposed_by_id: row.proposed_by_id,
          resolution_digest: row.resolution_digest,
          approval_decision_id: approval.id,
          approval_decision_type: "APPROVED",
          approved_by_id: approval.decided_by_id,
          held_collection_amount: row.held_collection_amount,
          tracked_shortfall_amount: row.tracked_shortfall_amount,
          recognized_amount: recognizedAmount,
          liability_digest: liabilityDigest,
          recorded_by_id: actor.userId,
          idempotency_key: derivedKey,
        },
      });
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_LIABILITY_AUDIT_ACTIONS.RECORDED,
        entityType: HISTORICAL_OWNERSHIP_AUDIT_ENTITIES.LIABILITY,
        entityId: id,
        newValues: { state: "OUTSTANDING" },
        metadata: {
          resolutionId,
          deletedOrderReference: row.deleted_order_reference,
          approvalDecisionId: approval.id,
          resolutionDigest: row.resolution_digest,
          liabilityDigest,
          recognizedAmount: recognizedAmount.toFixed(2),
          heldCollectionAmount: row.held_collection_amount.toFixed(2),
          trackedShortfallAmount: row.tracked_shortfall_amount.toFixed(2),
          // L3: a separate register — never a wallet credit, driver cash
          // movement, payout, settlement or revenue posting.
          postings: [],
        },
      });
      const after = await resolutionEvaluation(tx, resolutionId);
      if (after.liabilityId !== id || after.failures.length > 0 || after.status !== "APPROVED") {
        throw evidenceInvalid("The recorded liability did not validate", { failures: after.failures });
      }
      return { resolutionId, liabilityId: id };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

export interface ReviewResult {
  resolutionId: string;
  reviewId: string;
}

// L7: an append-only periodic Finance review of an outstanding liability.
export async function reviewHistoricalLiability(
  liabilityId: string,
  input: ReviewLiabilityInput,
  actor: WorkflowActor,
  rawIdempotencyKey: string
): Promise<ReviewResult> {
  assertRole(actor, "FINANCE");
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-liability-review", actor.userId, rawIdempotencyKey);
  const note = input.note.trim();
  const liability = await prisma.historical_liabilities.findUnique({ where: { id: liabilityId }, select: { resolution_id: true } });
  if (!liability) throw notFound("Historical liability not found");
  const reconcile = (existing: { id: string; liability_id: string; note: string }) => {
    if (existing.liability_id === liabilityId && existing.note === note) return { resolutionId: liability.resolution_id, reviewId: existing.id };
    throw idempotencyReused();
  };
  const replay = await prisma.historical_liability_reviews.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) return reconcile(replay);

  try {
    return await prisma.$transaction(async (tx) => {
      await advisory(tx, derivedKey);
      const postLock = await tx.historical_liability_reviews.findUnique({ where: { idempotency_key: derivedKey } });
      if (postLock) return reconcile(postLock);
      const evaluated = await resolutionEvaluation(tx, liability.resolution_id);
      if (!evaluated.assertsApproval) {
        throw conflict("LIABILITY_NOT_OUTSTANDING", "Only an outstanding liability can be reviewed", { status: evaluated.status });
      }
      const review = await tx.historical_liability_reviews.create({
        data: { liability_id: liabilityId, reviewed_by_id: actor.userId, note, idempotency_key: derivedKey },
      });
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_LIABILITY_AUDIT_ACTIONS.REVIEWED,
        entityType: HISTORICAL_OWNERSHIP_AUDIT_ENTITIES.LIABILITY,
        entityId: liabilityId,
        metadata: { reviewId: review.id, resolutionId: liability.resolution_id, failures: evaluated.failures, note },
      });
      return { resolutionId: liability.resolution_id, reviewId: review.id };
    }, TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}
