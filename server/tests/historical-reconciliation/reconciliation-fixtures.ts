import "../helpers/setup";
import assert from "node:assert/strict";
import { randomInt, randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import {
  computeEvidenceDigest,
  deriveHistoricalReconciliationStatus,
} from "../../src/modules/historical-reconciliation/historical-reconciliation.calculation";
import type { HistoricalReconciliationEvidence } from "../../src/modules/historical-reconciliation/historical-reconciliation.types";
import {
  cleanupHistoricalReconciliationRows,
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  seedDriverRecord,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Shared fixtures for the historical reconciliation suites (FR.12A.3 / .4).
// Not a test file (the runner only picks up *.test.ts).
//
// A fixture is a driver cash ledger with one balance-chain gap — exactly the
// incident's shape — plus the surviving COLLECTION_DIFFERENCE_RECORDED audit
// and the settlement that handed the missing cash over. Every row is created
// here and removed by cleanupGapFixture / cleanupReconciliationFixtures —
// never shared data. Reconciliation rows are inserted directly: the API that
// proposes / decides them is FR.12A.5.
// ============================================================

export const d = (v: string) => new Prisma.Decimal(v);

export interface GapFixture {
  driverUserId: string;
  driverId: string;
  accountId: string;
  predecessorId: string;
  anchorId: string;
  spareTransactionId: string;
  settlementId: string;
  auditId: string;
  spareAuditId: string;
  missingTransactionId: string;
  deletedOrderId: string;
  gapAmount: string;
  // stored instants of the predecessor, the evidence (audit) and the anchor
  predecessorAt: Date;
  evidenceAt: Date;
  anchorAt: Date;
}

export const actors = {} as { proposer: TestUser; reviewer: TestUser; secondAdmin: TestUser };
let cashMethodId = "";
const fixtures: GapFixture[] = [];
const incidentIds: string[] = [];

export async function initReconciliationFixtures(): Promise<void> {
  actors.proposer = await createTestUser("ADMIN");
  actors.reviewer = await createTestUser("FINANCE");
  actors.secondAdmin = await createTestUser("ADMIN");
  cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
}

export function pgFailure(err: unknown): string {
  const e = err as { message?: string; meta?: unknown };
  return `${e.message ?? ""} ${JSON.stringify(e.meta ?? {})}`;
}

export async function rejectsWith(promise: Promise<unknown>, constraint: string): Promise<void> {
  await assert.rejects(promise, (err) => {
    assert.match(pgFailure(err), new RegExp(constraint), `expected violation of ${constraint}, got: ${pgFailure(err)}`);
    return true;
  });
}

export async function cashTransaction(
  fx: { driverId: string; accountId: string },
  data: { type: "COLLECTION" | "SETTLEMENT"; amount: string; before: string; after: string; at: Date; settlementId?: string; id?: string }
): Promise<string> {
  const row = await prisma.driver_cash_transactions.create({
    data: {
      ...(data.id ? { id: data.id } : {}),
      account_id: fx.accountId,
      driver_id: fx.driverId,
      type: data.type,
      amount: d(data.amount),
      balance_before: d(data.before),
      balance_after: d(data.after),
      settlement_id: data.settlementId,
      notes: "FR.12A fixture",
      created_at: data.at,
    },
  });
  return row.id;
}

export interface AuditMetadataOverrides {
  orderType?: string;
  expectedAmount?: string;
  actualAmount?: string;
  difference?: string;
}

async function collectionDifferenceAudit(
  deletedOrderId: string,
  missingTransactionId: string,
  at: Date,
  metadata: AuditMetadataOverrides
): Promise<string> {
  const row = await prisma.audit_logs.create({
    data: {
      actor_user_id: actors.proposer.id,
      action: "COLLECTION_DIFFERENCE_RECORDED",
      entity_type: "ORDER",
      entity_id: deletedOrderId,
      previous_values: { status: "OUT_FOR_DELIVERY", financialStatus: "PENDING" },
      new_values: { status: "DELIVERED", financialStatus: "REVIEW_REQUIRED" },
      metadata: {
        orderType: metadata.orderType ?? "DELIVERY_ONLY",
        expectedAmount: metadata.expectedAmount ?? "210",
        actualAmount: metadata.actualAmount ?? "110",
        difference: metadata.difference ?? "-100",
        driverCashTransactionId: missingTransactionId,
      },
      created_at: at,
    },
  });
  return row.id;
}

// Ledger: COLLECTION +50 (0 -> 50) | [deleted COLLECTION +gap] | SETTLEMENT 50+gap (-> 0)
// | COLLECTION +5 | SETTLEMENT 5. Stored 0.00, raw ledger net −gap, jump +gap.
// `ledgerJump` lets the ledger's jump differ from the audit's amount.
export async function createGapFixture(
  opts: { gapAmount?: string; ledgerJump?: string; audit?: AuditMetadataOverrides } = {}
): Promise<GapFixture> {
  const gapAmount = opts.gapAmount ?? "110.00";
  const jump = d(opts.ledgerJump ?? gapAmount);
  const user = await createTestUser("DRIVER");
  const driverId = await seedDriverRecord(user.id);
  const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
  const fx = { driverId, accountId: account.id };
  const predecessorAt = new Date(Date.UTC(2026, 9, 1, 9, 0, 0, 0));
  const evidenceAt = new Date(Date.UTC(2026, 9, 2, 14, 30, 15, 456));
  const anchorAt = new Date(Date.UTC(2026, 9, 3, 18, 0, 0, 0));
  const settled = d("50").plus(jump).toFixed(2);

  const predecessorId = await cashTransaction(fx, { type: "COLLECTION", amount: "50", before: "0", after: "50", at: predecessorAt });
  const settlement = await prisma.driver_settlements.create({
    data: {
      settlement_number: `FR12A-${randomUUID().slice(0, 12)}`,
      driver_id: driverId,
      balance_before: d(settled),
      amount_received: d(settled),
      balance_after: d("0"),
      payment_method_id: cashMethodId,
      received_by_id: actors.reviewer.id,
      created_at: anchorAt,
    },
  });
  const anchorId = await cashTransaction(fx, { type: "SETTLEMENT", amount: settled, before: settled, after: "0", at: anchorAt, settlementId: settlement.id });
  // A second surviving row and audit, used to vary one evidence key at a time.
  const spareTransactionId = await cashTransaction(fx, { type: "COLLECTION", amount: "5", before: "0", after: "5", at: new Date(anchorAt.getTime() + 60_000) });
  await cashTransaction(fx, { type: "SETTLEMENT", amount: "5", before: "5", after: "0", at: new Date(anchorAt.getTime() + 120_000) });

  const missingTransactionId = randomUUID();
  const deletedOrderId = randomUUID();
  const auditId = await collectionDifferenceAudit(deletedOrderId, missingTransactionId, evidenceAt, {
    actualAmount: gapAmount,
    expectedAmount: d(gapAmount).plus(100).toFixed(2),
    ...opts.audit,
  });
  const spareAuditId = await collectionDifferenceAudit(randomUUID(), randomUUID(), evidenceAt, {});

  const fixture: GapFixture = {
    driverUserId: user.id,
    driverId,
    accountId: account.id,
    predecessorId,
    anchorId,
    spareTransactionId,
    settlementId: settlement.id,
    auditId,
    spareAuditId,
    missingTransactionId,
    deletedOrderId,
    gapAmount,
    predecessorAt,
    evidenceAt,
    anchorAt,
  };
  fixtures.push(fixture);
  return fixture;
}

// Incidents created through the FR.12A.5 API (not by createIncident) are
// registered here so cleanupGapFixtures removes them too.
export function trackIncident(incidentId: string): void {
  if (!incidentIds.includes(incidentId)) incidentIds.push(incidentId);
}

export async function createIncident(): Promise<string> {
  const incident = await prisma.financial_ledger_incidents.create({
    data: {
      // Year 1999: fixture numbers never collide with LI-<current year>-NNNN,
      // which the FR.12A.5 proposal workflow generates.
      incident_number: `LI-1999-${String(randomInt(1000, 10000))}`,
      cause: "MANUAL_DATABASE_DELETION",
      summary: "Order and its driver cash collection deleted directly in PostgreSQL (test fixture).",
      discovered_at: new Date(),
      missing_records: { orders: 1, driver_cash_transactions: 1, delivery_attempts: "unknown" },
      remaining_uncertainties: "Exact deletion time; ownership of the collected amount.",
      evidence: { queries: ["I1", "I10"], resultDigest: "0".repeat(64) },
      reported_by_id: actors.proposer.id,
    },
  });
  incidentIds.push(incident.id);
  return incident.id;
}

export function evidenceFor(
  fx: GapFixture,
  incidentId: string,
  overrides: Partial<HistoricalReconciliationEvidence> = {}
): HistoricalReconciliationEvidence {
  const gap = d(fx.gapAmount);
  return {
    incidentId,
    accountId: fx.accountId,
    driverId: fx.driverId,
    kind: "MISSING_COLLECTION",
    accountingTreatment: "EVIDENCE_ONLY_NO_CASH_EFFECT",
    amount: gap,
    observedJump: gap,
    predecessorTransactionId: fx.predecessorId,
    anchorTransactionId: fx.anchorId,
    missingTransactionId: fx.missingTransactionId,
    sourceAuditLogId: fx.auditId,
    deletedOrderReference: fx.deletedOrderId,
    orderType: "DELIVERY_ONLY",
    expectedAmount: gap.plus(100),
    actualAmount: gap,
    collectionDifference: d("-100.00"),
    relatedSettlementId: fx.settlementId,
    ...overrides,
  };
}

export interface ProposalOptions {
  digest?: string;
  reason?: string;
  proposedById?: string;
  supersedes?: { reconciliationId: string; decisionId: string; isTerminal?: boolean | null };
  idempotencyKey?: string;
}

export function propose(e: HistoricalReconciliationEvidence, opts: ProposalOptions = {}, db: Prisma.TransactionClient | typeof prisma = prisma) {
  return db.driver_cash_historical_reconciliations.create({
    data: {
      incident_id: e.incidentId,
      account_id: e.accountId,
      driver_id: e.driverId,
      kind: e.kind,
      accounting_treatment: e.accountingTreatment,
      ownership_status: "UNRESOLVED",
      amount: e.amount,
      observed_jump: e.observedJump,
      predecessor_transaction_id: e.predecessorTransactionId,
      anchor_transaction_id: e.anchorTransactionId,
      missing_transaction_id: e.missingTransactionId,
      source_audit_log_id: e.sourceAuditLogId,
      deleted_order_reference: e.deletedOrderReference,
      order_type: e.orderType,
      expected_amount: e.expectedAmount,
      actual_amount: e.actualAmount,
      collection_difference: e.collectionDifference,
      related_settlement_id: e.relatedSettlementId,
      evidence_digest: opts.digest ?? computeEvidenceDigest(e),
      reason: opts.reason ?? "Restores the explanation for the documented ledger gap of this fixture.",
      proposed_by_id: opts.proposedById ?? actors.proposer.id,
      idempotency_key: opts.idempotencyKey ?? `historical-reconciliation:driver-cash:${randomUUID()}`,
      supersedes_reconciliation_id: opts.supersedes?.reconciliationId,
      supersedes_decision_id: opts.supersedes?.decisionId,
      supersedes_decision_is_terminal: opts.supersedes ? (opts.supersedes.isTerminal ?? true) : undefined,
    },
  });
}

export type Proposal = Awaited<ReturnType<typeof propose>>;

export interface DecisionOptions {
  decidedById?: string;
  reason?: string | null;
  revokesDecisionId?: string;
  isTerminal?: boolean;
  proposedById?: string;
  evidenceDigest?: string;
  // An APPROVED fixture decision writes the same corroborating audit row the
  // FR.12A.5 workflow writes; false leaves it out (APPROVAL_AUDIT_MISSING).
  audit?: boolean;
}

export async function decide(
  rec: Proposal,
  decision: "APPROVED" | "REJECTED" | "WITHDRAWN" | "REVOKED",
  opts: DecisionOptions = {},
  db: Prisma.TransactionClient | typeof prisma = prisma
) {
  const defaultReason = decision === "APPROVED" ? null : `${decision} for a documented reason in this test.`;
  const decidedById = opts.decidedById ?? actors.reviewer.id;
  const row = await db.driver_cash_historical_reconciliation_decisions.create({
    data: {
      reconciliation_id: rec.id,
      decision,
      is_terminal: opts.isTerminal ?? decision !== "APPROVED",
      proposed_by_id: opts.proposedById ?? rec.proposed_by_id,
      evidence_digest: opts.evidenceDigest ?? rec.evidence_digest,
      revokes_decision_id: opts.revokesDecisionId,
      revokes_decision_type: opts.revokesDecisionId ? "APPROVED" : undefined,
      decided_by_id: decidedById,
      reason: opts.reason === undefined ? defaultReason : opts.reason,
      idempotency_key: `historical-reconciliation-decision:${randomUUID()}`,
    },
  });
  if (decision === "APPROVED" && opts.audit !== false) {
    await db.audit_logs.create({
      data: {
        actor_user_id: decidedById,
        action: "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED",
        entity_type: "DRIVER_CASH_HISTORICAL_RECONCILIATION",
        entity_id: rec.id,
        metadata: { decisionId: row.id, evidenceDigest: row.evidence_digest },
      },
    });
  }
  return row;
}

// Proposal + independent approval in one call (the common valid case).
export async function approvedReconciliation(fx: GapFixture, overrides: Partial<HistoricalReconciliationEvidence> = {}) {
  const rec = await propose(evidenceFor(fx, await createIncident(), overrides));
  const approval = await decide(rec, "APPROVED");
  return { rec, approval };
}

export async function statusOf(reconciliationId: string) {
  const decisions = await prisma.driver_cash_historical_reconciliation_decisions.findMany({
    where: { reconciliation_id: reconciliationId },
    select: { id: true, decision: true, revokes_decision_id: true },
  });
  return deriveHistoricalReconciliationStatus(decisions.map((x) => ({ id: x.id, decision: x.decision, revokesDecisionId: x.revokes_decision_id })));
}

// Whole-database fingerprint of every balance and ledger the incident could
// touch: counts, sums and an md5 over every row.
export async function financialSnapshot(): Promise<Record<string, string>> {
  const tables = [
    "driver_cash_accounts",
    "driver_cash_transactions",
    "driver_settlements",
    "customer_wallets",
    "wallet_transactions",
    "customer_payouts",
    "company_financial_transactions",
    "company_direct_collections",
    "order_financial_releases",
    "driver_settlement_allocations",
    "orders",
  ];
  const out: Record<string, string> = {};
  for (const t of tables) {
    const rows = await prisma.$queryRawUnsafe<{ v: string }[]>(
      `SELECT count(*)::text || ':' || coalesce(md5(string_agg(x::text, ',' ORDER BY x.id)), '') AS v FROM ${t} x`
    );
    out[t] = rows[0].v;
  }
  return out;
}

export async function accountTotals(accountId: string) {
  const [row] = await prisma.$queryRaw<{ stored: Prisma.Decimal; net: Prisma.Decimal }[]>`
    SELECT a.current_balance AS stored, COALESCE(SUM(t.balance_after - t.balance_before), 0)::numeric(14,2) AS net
    FROM driver_cash_accounts a LEFT JOIN driver_cash_transactions t ON t.account_id = a.id
    WHERE a.id = ${accountId}::uuid GROUP BY a.id`;
  return { stored: new Prisma.Decimal(row.stored), net: new Prisma.Decimal(row.net) };
}

// Runs `fn` in a transaction that is ALWAYS rolled back — for states the
// database normally forbids (FKs off via session_replication_role, or a
// dropped constraint). Requires a superuser on the isolated test database.
const ROLLBACK = Symbol("rollback");
export async function inRolledBackTransaction(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await prisma
    .$transaction(async (tx) => {
      await fn(tx);
      throw ROLLBACK;
    })
    .catch((e) => {
      if (e !== ROLLBACK) throw e;
    });
}

export async function cleanupGapFixture(fx: GapFixture): Promise<void> {
  await cleanupHistoricalReconciliationRows({ driverId: fx.driverId });
  await prisma.audit_logs.deleteMany({ where: { id: { in: [fx.auditId, fx.spareAuditId] } } });
  await cleanupTestDriverRecord(fx.driverId);
  await cleanupTestUser(fx.driverUserId);
  const i = fixtures.indexOf(fx);
  if (i >= 0) fixtures.splice(i, 1);
}

// Every gap fixture and incident created so far (actors are kept), leaf first.
export async function cleanupGapFixtures(): Promise<void> {
  for (const fx of [...fixtures]) await cleanupGapFixture(fx);
  await cleanupHistoricalReconciliationRows({ incidentIds });
  incidentIds.length = 0;
}

// Everything this module created, leaf first.
export async function cleanupReconciliationFixtures(): Promise<void> {
  await cleanupGapFixtures();
  for (const u of [actors.proposer, actors.reviewer, actors.secondAdmin]) if (u) await cleanupTestUser(u.id);
}
