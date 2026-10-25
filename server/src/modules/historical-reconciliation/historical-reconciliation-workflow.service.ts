// ============================================================
// FR.12A.5 — Historical reconciliation workflow: propose, approve, reject,
// withdraw, revoke.
//
// Design: docs/fr12a2-historical-ledger-reconciliation-design.md §8;
// docs/fr12a5-historical-reconciliation-workflow.md.
//
// A historical reconciliation is EVIDENCE ONLY. Nothing here posts or moves
// money: no driver cash row, wallet transaction, company revenue, settlement
// or obligation is ever created, and ownership of the collected amount stays
// UNRESOLVED (gate G5 keeps blocking).
//
// Every write:
//   * requires DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED=true (unset =
//     disabled; set only for an authorized maintenance window);
//   * is idempotent on the Idempotency-Key header (scoped to the actor; a
//     reused key with different content is refused);
//   * takes the global lock order: advisory key -> activation row (FOR
//     SHARE) -> driver cash account (FOR NO KEY UPDATE) -> inserts, so it
//     cannot interleave with deliveries, settlements or an activation gate
//     evaluation on the same account;
//   * derives or re-checks every evidence field in PostgreSQL and accepts the
//     result only if the shared validity SQL (historical-reconciliation.sql.ts)
//     evaluates it as valid INSIDE the same transaction — otherwise it rolls
//     back;
//   * appends (never edits) and writes its audit row in the same transaction.
// ============================================================

import { randomUUID } from "node:crypto";
import { Prisma } from "../../generated/prisma/client";
import type { OrderType } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { deriveRequestIdempotencyKey } from "../../shared/idempotency/request-idempotency";
import { readSettlementModeActivation } from "../financial-release/financial-release.service";
import { computeEvidenceDigest } from "./historical-reconciliation.calculation";
import { evaluateHistoricalReconciliations, getDriverCashAccountReconciliations } from "./historical-reconciliation.service";
import { HISTORICAL_RECONCILIATION_AUDIT_ACTIONS, HISTORICAL_RECONCILIATION_AUDIT_ENTITY } from "./historical-reconciliation.sql";
import type {
  ApproveHistoricalReconciliationInput,
  ProposeHistoricalReconciliationInput,
  ReasonedDecisionInput,
} from "./historical-reconciliation.schema";
import type {
  DriverCashAccountReconciliationEntry,
  HistoricalReconciliationEvidence,
  HistoricalReconciliationEvaluationEntry,
} from "./historical-reconciliation.types";

export const HISTORICAL_RECONCILIATION_WRITES_ENV = "DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED";

// Bounded: the in-transaction evaluation aggregates the driver cash ledger
// once (hundreds of rows in production). Response DTOs are built after commit.
const WORKFLOW_TRANSACTION_OPTIONS = { timeout: 15_000, maxWait: 5_000 };

const MONEY_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MONEY_LIMIT = new Prisma.Decimal("1000000000000");
const ORDER_TYPES: readonly OrderType[] = ["COMPANY_ORDER", "DELIVERY_ONLY"];

export interface WorkflowActor {
  userId: string;
  roleCode: string;
}

export function areHistoricalReconciliationWritesEnabled(): boolean {
  return process.env[HISTORICAL_RECONCILIATION_WRITES_ENV] === "true";
}

function assertWritesEnabled(): void {
  if (!areHistoricalReconciliationWritesEnabled()) {
    throw new AppError({
      statusCode: 403,
      code: "FORBIDDEN",
      message: "Historical reconciliation changes are disabled for this environment",
      details: { reason: "HISTORICAL_RECONCILIATION_DISABLED" },
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

function idempotencyReused(): AppError {
  return conflict("IDEMPOTENCY_KEY_REUSED", "Idempotency key was already used for a different request.");
}

function evidenceInvalid(message: string, details: Record<string, unknown> = {}): AppError {
  return conflict("RECONCILIATION_EVIDENCE_INVALID", message, details);
}

// Exact NUMERIC(14,2) from audit metadata text (Decimal.toString() form).
function auditAmount(raw: unknown, label: string): Prisma.Decimal {
  if (typeof raw !== "string" || !MONEY_TEXT.test(raw)) {
    throw evidenceInvalid(`The source audit's ${label} is not an exact decimal amount`, { field: label });
  }
  const value = new Prisma.Decimal(raw);
  if (value.decimalPlaces() > 2 || value.abs().gte(MONEY_LIMIT)) {
    throw evidenceInvalid(`The source audit's ${label} is not a two-decimal ledger amount`, { field: label });
  }
  return value;
}

function accountSnapshot(a: DriverCashAccountReconciliationEntry) {
  return {
    storedBalance: a.storedBalance,
    rawLedgerNet: a.rawLedgerNet,
    rawDiscrepancy: a.rawDiscrepancy,
    approvedHistoricalAmount: a.approvedHistoricalAmount,
    unexplainedResidual: a.unexplainedResidual,
    invalidApprovedCount: a.invalidApprovedCount,
  };
}

async function accountEntry(tx: Prisma.TransactionClient, accountId: string): Promise<DriverCashAccountReconciliationEntry> {
  const { entries } = await getDriverCashAccountReconciliations(tx, { schemaPresent: true, accountIds: [accountId] });
  if (entries.length !== 1) throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Driver cash account is missing" });
  return entries[0];
}

async function evaluationOf(tx: Prisma.TransactionClient, reconciliationId: string): Promise<HistoricalReconciliationEvaluationEntry> {
  const { entries } = await evaluateHistoricalReconciliations(tx, { reconciliationIds: [reconciliationId] });
  if (entries.length !== 1) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Historical reconciliation not found" });
  return entries[0];
}

// Lock order (contract §6): advisory key -> activation row -> account.
async function takeWorkflowLocks(tx: Prisma.TransactionClient, derivedKey: string, accountId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${derivedKey})::bigint)`;
  await readSettlementModeActivation(tx);
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM driver_cash_accounts WHERE id = ${accountId}::uuid FOR NO KEY UPDATE
  `;
  if (rows.length === 0) throw evidenceInvalid("The driver cash account no longer exists");
}

// A unique / foreign-key violation that slipped past the explicit checks is
// a conflict with concurrent or inconsistent records — never a 500.
function mapWriteError(error: unknown): unknown {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2002") {
      return conflict("RECONCILIATION_CONFLICT", "A conflicting historical reconciliation or decision already exists");
    }
    if (error.code === "P2003") {
      return evidenceInvalid("A referenced evidence record does not belong to this driver cash account");
    }
  }
  return error;
}

// ------------------------------------------------------------ propose (ADMIN)

type ProposalRow = Prisma.driver_cash_historical_reconciliationsGetPayload<{ include: { incident: { select: { summary: true } } } }>;

function reconcileProposalReplay(existing: ProposalRow, input: ProposeHistoricalReconciliationInput): string {
  const sameIncident = input.incidentId !== undefined ? existing.incident_id === input.incidentId : existing.incident.summary === input.incident?.summary.trim();
  if (
    existing.anchor_transaction_id === input.anchorTransactionId &&
    existing.source_audit_log_id === input.sourceAuditLogId &&
    existing.reason === input.reason.trim() &&
    (input.relatedSettlementId === undefined || existing.related_settlement_id === input.relatedSettlementId) &&
    sameIncident
  ) {
    return existing.id;
  }
  throw idempotencyReused();
}

async function nextIncidentNumber(tx: Prisma.TransactionClient): Promise<string> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('swiftdrop.financial_ledger_incident_number', 0))`;
  const year = new Date().getUTCFullYear();
  const [row] = await tx.$queryRaw<{ n: number }[]>`
    SELECT COALESCE(MAX(substring(incident_number FROM 9)::int), 0)::int AS n
    FROM financial_ledger_incidents WHERE incident_number LIKE ${`LI-${year}-%`}
  `;
  const next = row.n + 1;
  if (next > 9999) throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Incident numbers for this year are exhausted" });
  return `LI-${year}-${String(next).padStart(4, "0")}`;
}

// The gap: the anchor's immediate predecessor in (created_at, id) order. A
// timestamp shared with another row makes the order unprovable — refused.
async function locateGap(tx: Prisma.TransactionClient, anchorId: string) {
  const rows = await tx.$queryRaw<
    { anchor_ties: number; predecessor_id: string | null; predecessor_after: Prisma.Decimal | null; predecessor_ties: number }[]
  >`
    WITH a AS (SELECT id, account_id, created_at FROM driver_cash_transactions WHERE id = ${anchorId}::uuid)
    SELECT (SELECT COUNT(*) FROM driver_cash_transactions x WHERE x.account_id = a.account_id AND x.created_at = a.created_at AND x.id <> a.id)::int AS anchor_ties,
           p.id AS predecessor_id, p.balance_after AS predecessor_after,
           COALESCE((SELECT COUNT(*) FROM driver_cash_transactions x
                     WHERE x.account_id = a.account_id AND x.created_at = p.created_at AND x.id <> p.id), 0)::int AS predecessor_ties
    FROM a
    LEFT JOIN LATERAL (
      SELECT id, balance_after, created_at FROM driver_cash_transactions x
      WHERE x.account_id = a.account_id AND x.created_at < a.created_at
      ORDER BY x.created_at DESC, x.id DESC LIMIT 1
    ) p ON true
  `;
  const r = rows[0];
  if (r.anchor_ties > 0 || r.predecessor_ties > 0) {
    throw evidenceInvalid("The gap's surviving rows share a timestamp with another row — their order cannot be proven", {
      failures: ["ORDERING_AMBIGUOUS"],
    });
  }
  return { predecessorId: r.predecessor_id, predecessorAfter: r.predecessor_after === null ? null : new Prisma.Decimal(r.predecessor_after) };
}

export async function proposeHistoricalReconciliation(
  input: ProposeHistoricalReconciliationInput,
  actor: WorkflowActor,
  rawIdempotencyKey: string
): Promise<string> {
  assertRole(actor, "ADMIN");
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-reconciliation-proposal", actor.userId, rawIdempotencyKey);
  const include = { incident: { select: { summary: true } } } as const;

  const replay = await prisma.driver_cash_historical_reconciliations.findUnique({ where: { idempotency_key: derivedKey }, include });
  if (replay) return reconcileProposalReplay(replay, input);

  const anchorAccount = await prisma.driver_cash_transactions.findUnique({
    where: { id: input.anchorTransactionId },
    select: { account_id: true },
  });
  if (!anchorAccount) throw evidenceInvalid("The anchor ledger row does not exist", { failures: ["ANCHOR_NOT_FOUND"] });

  try {
    return await prisma.$transaction(async (tx) => {
      await takeWorkflowLocks(tx, derivedKey, anchorAccount.account_id);
      const postLock = await tx.driver_cash_historical_reconciliations.findUnique({ where: { idempotency_key: derivedKey }, include });
      if (postLock) return reconcileProposalReplay(postLock, input);

      // ---- the gap, read under the account lock
      const anchor = await tx.driver_cash_transactions.findUniqueOrThrow({
        where: { id: input.anchorTransactionId },
        select: { id: true, account_id: true, driver_id: true, balance_before: true, settlement_id: true },
      });
      const account = await tx.driver_cash_accounts.findUniqueOrThrow({ where: { id: anchor.account_id }, select: { id: true, driver_id: true } });
      if (account.driver_id !== anchor.driver_id) {
        throw evidenceInvalid("The anchor ledger row and its account belong to different drivers", { failures: ["ACCOUNT_MISMATCH"] });
      }
      const gap = await locateGap(tx, anchor.id);
      const observedJump = anchor.balance_before.minus(gap.predecessorAfter ?? new Prisma.Decimal(0));
      if (!observedJump.greaterThan(0)) {
        throw evidenceInvalid("There is no positive balance-chain gap before the anchor row", { observedJump: observedJump.toFixed(2) });
      }

      // ---- the surviving audit and the exact amounts it records
      const audit = await tx.audit_logs.findUnique({ where: { id: input.sourceAuditLogId } });
      if (!audit || audit.action !== "COLLECTION_DIFFERENCE_RECORDED" || audit.entity_type !== "ORDER") {
        throw evidenceInvalid("The source audit is not a surviving COLLECTION_DIFFERENCE_RECORDED order audit", {
          failures: ["SOURCE_AUDIT_MISMATCH"],
        });
      }
      const metadata = (audit.metadata ?? {}) as Record<string, unknown>;
      const missingTransactionId = metadata.driverCashTransactionId;
      const orderType = metadata.orderType;
      if (typeof missingTransactionId !== "string" || !UUID.test(missingTransactionId) || !UUID.test(audit.entity_id)) {
        throw evidenceInvalid("The source audit does not name the missing driver cash row and order", { failures: ["SOURCE_AUDIT_MISMATCH"] });
      }
      if (typeof orderType !== "string" || !ORDER_TYPES.includes(orderType as OrderType)) {
        throw evidenceInvalid("The source audit does not record a valid order type", { failures: ["SOURCE_AUDIT_MISMATCH"] });
      }
      const actualAmount = auditAmount(metadata.actualAmount, "actualAmount");
      const expectedAmount = auditAmount(metadata.expectedAmount, "expectedAmount");
      const difference = auditAmount(metadata.difference, "difference");
      if (!actualAmount.greaterThan(0) || expectedAmount.isNegative() || difference.isZero() || !difference.equals(actualAmount.minus(expectedAmount))) {
        throw evidenceInvalid("The source audit's amounts are not a consistent recorded collection difference", {
          failures: ["SOURCE_AUDIT_MISMATCH"],
        });
      }
      if (!actualAmount.equals(observedJump)) {
        throw evidenceInvalid("The located ledger gap does not equal the audit's actual collected amount", {
          failures: ["JUMP_MISMATCH"],
          observedJump: observedJump.toFixed(2),
          auditActualAmount: actualAmount.toFixed(2),
        });
      }

      // ---- related settlement: the anchor's own, or a verified one
      if (input.relatedSettlementId && anchor.settlement_id && input.relatedSettlementId !== anchor.settlement_id) {
        throw evidenceInvalid("The anchor row belongs to a different settlement than the one named");
      }
      const relatedSettlementId = anchor.settlement_id ?? input.relatedSettlementId ?? null;

      const deletedOrderReference = audit.entity_id;
      const keys = { anchor: anchor.id, missing: missingTransactionId, audit: audit.id };

      // ---- duplicates and re-proposal (append-only supersession chain)
      const chain = await tx.driver_cash_historical_reconciliations.findMany({
        where: {
          OR: [
            { anchor_transaction_id: keys.anchor },
            { missing_transaction_id: keys.missing },
            { source_audit_log_id: keys.audit },
            { deleted_order_reference: deletedOrderReference },
          ],
        },
        select: {
          id: true,
          account_id: true,
          anchor_transaction_id: true,
          missing_transaction_id: true,
          source_audit_log_id: true,
          supersedes_reconciliation_id: true,
        },
      });
      let supersedes: { reconciliationId: string; decisionId: string } | null = null;
      if (chain.length > 0) {
        const mismatched = chain.find(
          (c) => c.account_id !== anchor.account_id || c.anchor_transaction_id !== keys.anchor || c.missing_transaction_id !== keys.missing || c.source_audit_log_id !== keys.audit
        );
        if (mismatched) {
          throw conflict("CONFLICTING_EVIDENCE", "Another historical reconciliation explains part of this evidence differently", {
            reconciliationId: mismatched.id,
          });
        }
        const { entries } = await evaluateHistoricalReconciliations(tx, { reconciliationIds: chain.map((c) => c.id) });
        const live = entries.find((e) => ["PROPOSED", "APPROVED", "INVALID_HISTORY"].includes(e.status));
        if (live) {
          throw conflict("RECONCILIATION_ALREADY_PROPOSED", "This gap already has a live historical reconciliation", {
            reconciliationId: live.reconciliationId,
            status: live.status,
          });
        }
        const supersededIds = new Set(chain.map((c) => c.supersedes_reconciliation_id).filter(Boolean));
        const head = chain.find((c) => !supersededIds.has(c.id));
        const terminal = head
          ? await tx.driver_cash_historical_reconciliation_decisions.findFirst({
              where: { reconciliation_id: head.id, is_terminal: true },
              orderBy: { created_at: "desc" },
              select: { id: true },
            })
          : null;
        if (!head || !terminal) throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Historical reconciliation chain is inconsistent" });
        supersedes = { reconciliationId: head.id, decisionId: terminal.id };
      }

      // ---- incident (existing, or recorded atomically with the proposal)
      let incidentId: string;
      let incidentNumber: string;
      let incidentRecorded = false;
      if (input.incidentId) {
        const incident = await tx.financial_ledger_incidents.findUnique({ where: { id: input.incidentId }, select: { id: true, incident_number: true } });
        if (!incident) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Ledger incident not found" });
        incidentId = incident.id;
        incidentNumber = incident.incident_number;
      } else {
        const i = input.incident!;
        incidentNumber = await nextIncidentNumber(tx);
        const created = await tx.financial_ledger_incidents.create({
          data: {
            incident_number: incidentNumber,
            cause: "MANUAL_DATABASE_DELETION",
            summary: i.summary.trim(),
            discovered_at: new Date(i.discoveredAt),
            occurred_not_before: i.occurredNotBefore ? new Date(i.occurredNotBefore) : null,
            occurred_not_after: i.occurredNotAfter ? new Date(i.occurredNotAfter) : null,
            missing_records: i.missingRecords,
            remaining_uncertainties: i.remainingUncertainties.trim(),
            evidence: i.evidence as Prisma.InputJsonValue,
            reported_by_id: actor.userId,
          },
        });
        incidentId = created.id;
        incidentRecorded = true;
      }

      const evidence: HistoricalReconciliationEvidence = {
        incidentId,
        accountId: anchor.account_id,
        driverId: anchor.driver_id,
        kind: "MISSING_COLLECTION",
        accountingTreatment: "EVIDENCE_ONLY_NO_CASH_EFFECT",
        amount: actualAmount,
        observedJump,
        predecessorTransactionId: gap.predecessorId,
        anchorTransactionId: anchor.id,
        missingTransactionId: missingTransactionId.toLowerCase(),
        sourceAuditLogId: audit.id,
        deletedOrderReference: deletedOrderReference.toLowerCase(),
        orderType: orderType as OrderType,
        expectedAmount,
        actualAmount,
        collectionDifference: difference,
        relatedSettlementId,
      };
      const evidenceDigest = computeEvidenceDigest(evidence);
      const before = await accountEntry(tx, anchor.account_id);

      const id = randomUUID();
      await tx.driver_cash_historical_reconciliations.create({
        data: {
          id,
          incident_id: evidence.incidentId,
          account_id: evidence.accountId,
          driver_id: evidence.driverId,
          kind: evidence.kind,
          accounting_treatment: evidence.accountingTreatment,
          ownership_status: "UNRESOLVED",
          amount: evidence.amount,
          observed_jump: evidence.observedJump,
          predecessor_transaction_id: evidence.predecessorTransactionId,
          anchor_transaction_id: evidence.anchorTransactionId,
          missing_transaction_id: evidence.missingTransactionId,
          source_audit_log_id: evidence.sourceAuditLogId,
          deleted_order_reference: evidence.deletedOrderReference,
          order_type: evidence.orderType,
          expected_amount: evidence.expectedAmount,
          actual_amount: evidence.actualAmount,
          collection_difference: evidence.collectionDifference,
          related_settlement_id: evidence.relatedSettlementId,
          evidence_digest: evidenceDigest,
          reason: input.reason.trim(),
          proposed_by_id: actor.userId,
          idempotency_key: derivedKey,
          supersedes_reconciliation_id: supersedes?.reconciliationId,
          supersedes_decision_id: supersedes?.decisionId,
          supersedes_decision_is_terminal: supersedes ? true : undefined,
        },
      });

      // The authoritative check: the shared V1–V7 SQL, same transaction.
      const evaluated = await evaluationOf(tx, id);
      if (evaluated.status !== "PROPOSED" || evaluated.failures.length > 0) {
        throw evidenceInvalid("The derived evidence does not validate as a historical reconciliation", { failures: evaluated.failures });
      }

      if (incidentRecorded) {
        await createAuditLog(tx, {
          actorUserId: actor.userId,
          action: HISTORICAL_RECONCILIATION_AUDIT_ACTIONS.INCIDENT_RECORDED,
          entityType: "FINANCIAL_LEDGER_INCIDENT",
          entityId: incidentId,
          newValues: { incidentNumber, cause: "MANUAL_DATABASE_DELETION" },
          metadata: { incidentNumber, missingRecords: input.incident!.missingRecords },
        });
      }
      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_RECONCILIATION_AUDIT_ACTIONS.PROPOSED,
        entityType: HISTORICAL_RECONCILIATION_AUDIT_ENTITY,
        entityId: id,
        newValues: { status: "PROPOSED" },
        metadata: {
          incidentId,
          incidentNumber,
          accountId: evidence.accountId,
          driverId: evidence.driverId,
          kind: evidence.kind,
          accountingTreatment: evidence.accountingTreatment,
          amount: evidence.amount.toFixed(2),
          observedJump: evidence.observedJump.toFixed(2),
          predecessorTransactionId: evidence.predecessorTransactionId,
          anchorTransactionId: evidence.anchorTransactionId,
          missingTransactionId: evidence.missingTransactionId,
          sourceAuditLogId: evidence.sourceAuditLogId,
          deletedOrderReference: evidence.deletedOrderReference,
          orderType: evidence.orderType,
          expectedAmount: evidence.expectedAmount.toFixed(2),
          actualAmount: evidence.actualAmount.toFixed(2),
          collectionDifference: evidence.collectionDifference.toFixed(2),
          relatedSettlementId: evidence.relatedSettlementId,
          evidenceDigest,
          supersedesReconciliationId: supersedes?.reconciliationId ?? null,
          ownershipStatus: "UNRESOLVED",
          reason: input.reason.trim(),
          // A proposal never changes the account's figures.
          account: accountSnapshot(before),
        },
      });
      return id;
    }, WORKFLOW_TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

// ------------------------------------------------------------ decisions

type DecisionKind = "APPROVED" | "REJECTED" | "WITHDRAWN" | "REVOKED";

export interface DecisionResult {
  reconciliationId: string;
  decisionId: string;
}

interface DecisionRequest {
  kind: DecisionKind;
  reason: string | null;
  // APPROVED only: the fingerprint the reviewer confirmed.
  evidenceDigest?: string;
}

const DECISION_ROLE: Record<DecisionKind, "ADMIN" | "FINANCE"> = {
  APPROVED: "FINANCE",
  REJECTED: "FINANCE",
  WITHDRAWN: "ADMIN",
  REVOKED: "ADMIN",
};

function reconcileDecisionReplay(
  existing: { id: string; reconciliation_id: string; decision: string; reason: string | null; evidence_digest: string },
  reconciliationId: string,
  request: DecisionRequest
): DecisionResult {
  if (
    existing.reconciliation_id === reconciliationId &&
    existing.decision === request.kind &&
    (existing.reason ?? null) === request.reason &&
    (request.evidenceDigest === undefined || existing.evidence_digest === request.evidenceDigest)
  ) {
    return { reconciliationId, decisionId: existing.id };
  }
  throw idempotencyReused();
}

async function decide(reconciliationId: string, request: DecisionRequest, actor: WorkflowActor, rawIdempotencyKey: string): Promise<DecisionResult> {
  assertRole(actor, DECISION_ROLE[request.kind]);
  assertWritesEnabled();
  const derivedKey = deriveRequestIdempotencyKey("historical-reconciliation-decision", actor.userId, rawIdempotencyKey);

  const replay = await prisma.driver_cash_historical_reconciliation_decisions.findUnique({ where: { idempotency_key: derivedKey } });
  if (replay) return reconcileDecisionReplay(replay, reconciliationId, request);

  const record = await prisma.driver_cash_historical_reconciliations.findUnique({
    where: { id: reconciliationId },
    select: { account_id: true },
  });
  if (!record) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Historical reconciliation not found" });

  try {
    return await prisma.$transaction(async (tx) => {
      await takeWorkflowLocks(tx, derivedKey, record.account_id);
      const postLock = await tx.driver_cash_historical_reconciliation_decisions.findUnique({ where: { idempotency_key: derivedKey } });
      if (postLock) return reconcileDecisionReplay(postLock, reconciliationId, request);

      const rec = await tx.driver_cash_historical_reconciliations.findUniqueOrThrow({
        where: { id: reconciliationId },
        select: { id: true, account_id: true, amount: true, proposed_by_id: true, evidence_digest: true },
      });
      const evaluated = await evaluationOf(tx, reconciliationId);

      let revokesDecisionId: string | null = null;
      if (request.kind === "REVOKED") {
        if (evaluated.status !== "APPROVED") {
          throw conflict("RECONCILIATION_NOT_APPROVED", "Only an approved historical reconciliation can be revoked", { status: evaluated.status });
        }
        const approval = await tx.driver_cash_historical_reconciliation_decisions.findFirstOrThrow({
          where: { reconciliation_id: reconciliationId, decision: "APPROVED" },
          select: { id: true, decided_by_id: true },
        });
        if (actor.userId === rec.proposed_by_id || actor.userId === approval.decided_by_id) {
          throw forbidden("REVOKER_NOT_INDEPENDENT", "A revocation must be made by someone other than the proposer and the approver");
        }
        revokesDecisionId = approval.id;
      } else {
        if (evaluated.status !== "PROPOSED") {
          throw conflict("RECONCILIATION_NOT_PENDING", "This historical reconciliation is no longer awaiting a decision", { status: evaluated.status });
        }
        if ((request.kind === "APPROVED" || request.kind === "REJECTED") && actor.userId === rec.proposed_by_id) {
          throw forbidden("REVIEWER_NOT_INDEPENDENT", "A proposal must be reviewed by someone other than its proposer");
        }
      }
      if (request.kind === "APPROVED") {
        if (request.evidenceDigest !== rec.evidence_digest) {
          throw conflict("STALE_EVIDENCE_DIGEST", "The evidence fingerprint you reviewed no longer matches the stored evidence — reload and review again");
        }
        if (evaluated.failures.length > 0) {
          throw evidenceInvalid("The evidence no longer validates — it cannot be approved", { failures: evaluated.failures });
        }
      }

      const before = await accountEntry(tx, rec.account_id);
      const decision = await tx.driver_cash_historical_reconciliation_decisions.create({
        data: {
          reconciliation_id: rec.id,
          decision: request.kind,
          is_terminal: request.kind !== "APPROVED",
          proposed_by_id: rec.proposed_by_id,
          evidence_digest: rec.evidence_digest,
          revokes_decision_id: revokesDecisionId,
          revokes_decision_type: revokesDecisionId ? "APPROVED" : undefined,
          decided_by_id: actor.userId,
          reason: request.reason,
          idempotency_key: derivedKey,
        },
      });

      // An approval only counts once its audit exists (APPROVAL_AUDIT_MISSING),
      // so its "after" figures are the expected ones, verified below.
      const after =
        request.kind === "APPROVED"
          ? {
              ...accountSnapshot(before),
              approvedHistoricalAmount: new Prisma.Decimal(before.approvedHistoricalAmount).plus(rec.amount).toFixed(2),
              unexplainedResidual: new Prisma.Decimal(before.unexplainedResidual).minus(rec.amount).toFixed(2),
            }
          : accountSnapshot(await accountEntry(tx, rec.account_id));

      await createAuditLog(tx, {
        actorUserId: actor.userId,
        action: HISTORICAL_RECONCILIATION_AUDIT_ACTIONS[request.kind],
        entityType: HISTORICAL_RECONCILIATION_AUDIT_ENTITY,
        entityId: rec.id,
        previousValues: { status: evaluated.status },
        newValues: { status: request.kind },
        metadata: {
          decisionId: decision.id,
          decision: request.kind,
          evidenceDigest: rec.evidence_digest,
          revokesDecisionId,
          reason: request.reason,
          amount: rec.amount.toFixed(2),
          // Ownership of the collected money is never decided here.
          ownershipStatus: "UNRESOLVED",
          accountBefore: accountSnapshot(before),
          accountAfter: after,
        },
      });

      if (request.kind === "APPROVED") {
        // Authoritative post-check, same transaction: the approved record must
        // now contribute exactly its amount, or nothing is committed.
        const result = await evaluationOf(tx, rec.id);
        const check = await accountEntry(tx, rec.account_id);
        if (!result.contributes || check.approvedHistoricalAmount !== after.approvedHistoricalAmount) {
          throw evidenceInvalid("The approved evidence did not validate", { failures: result.failures });
        }
      }
      return { reconciliationId: rec.id, decisionId: decision.id };
    }, WORKFLOW_TRANSACTION_OPTIONS);
  } catch (error) {
    throw mapWriteError(error);
  }
}

export function approveHistoricalReconciliation(
  id: string,
  input: ApproveHistoricalReconciliationInput,
  actor: WorkflowActor,
  rawIdempotencyKey: string
): Promise<DecisionResult> {
  return decide(id, { kind: "APPROVED", reason: input.note ?? null, evidenceDigest: input.evidenceDigest }, actor, rawIdempotencyKey);
}

export function rejectHistoricalReconciliation(id: string, input: ReasonedDecisionInput, actor: WorkflowActor, rawIdempotencyKey: string) {
  return decide(id, { kind: "REJECTED", reason: input.reason.trim() }, actor, rawIdempotencyKey);
}

export function withdrawHistoricalReconciliation(id: string, input: ReasonedDecisionInput, actor: WorkflowActor, rawIdempotencyKey: string) {
  return decide(id, { kind: "WITHDRAWN", reason: input.reason.trim() }, actor, rawIdempotencyKey);
}

export function revokeHistoricalReconciliation(id: string, input: ReasonedDecisionInput, actor: WorkflowActor, rawIdempotencyKey: string) {
  return decide(id, { kind: "REVOKED", reason: input.reason.trim() }, actor, rawIdempotencyKey);
}
