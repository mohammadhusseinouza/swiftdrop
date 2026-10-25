import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { reconcileDriverCashAccount } from "../../src/modules/historical-reconciliation/historical-reconciliation.calculation";
import {
  evaluateHistoricalReconciliations,
  getDriverCashAccountReconciliations,
} from "../../src/modules/historical-reconciliation/historical-reconciliation.service";
import { UNEXPLAINED_CHAIN_BREAKS, driverCashReconciliationWith } from "../../src/modules/historical-reconciliation/historical-reconciliation.sql";
import type { HistoricalReconciliationEvaluationEntry } from "../../src/modules/historical-reconciliation/historical-reconciliation.types";
import { getFinancialReleaseReadiness } from "../../src/modules/financial-release/financial-release-activation.service";
import { getFinancialReleaseReconciliation, runReconciliationChecks } from "../../src/modules/financial-release/financial-release-reconciliation.service";
import { applyDriverCashTransaction } from "../../src/modules/driver-cash/driver-cash-ledger.service";
import { getFinanceSummary } from "../../src/modules/finance/finance-summary.service";
import {
  actors,
  approvedReconciliation,
  cashTransaction,
  cleanupGapFixtures,
  cleanupReconciliationFixtures,
  createGapFixture,
  createIncident,
  d,
  decide,
  evidenceFor,
  financialSnapshot,
  inRolledBackTransaction,
  initReconciliationFixtures,
  propose,
  type GapFixture,
} from "./reconciliation-fixtures";

// ============================================================
// FR.12A.4 — Evidence validation (V1–V7) and the historical reconciliation
// residual rule in G3 / R1, the G5 historical ownership blocker, chain-gap
// classification and the as-of driver cash component.
//
// Isolated database only. States the database itself forbids (a missing
// audit / anchor, an impossible decision history, a duplicate explanation)
// are created inside transactions that are ALWAYS rolled back, with foreign
// keys suspended (session_replication_role = replica) or one constraint
// dropped — never committed.
// ============================================================

type Db = Prisma.TransactionClient | typeof prisma;

async function accountOf(fx: GapFixture, db: Db = prisma) {
  const { entries } = await getDriverCashAccountReconciliations(db, { accountIds: [fx.accountId] });
  assert.equal(entries.length, 1);
  return entries[0];
}

async function evaluationOf(reconciliationId: string, db: Db = prisma): Promise<HistoricalReconciliationEvaluationEntry> {
  const { entries } = await evaluateHistoricalReconciliations(db, { reconciliationIds: [reconciliationId] });
  assert.equal(entries.length, 1);
  return entries[0];
}

const residualOf = async (fx: GapFixture, db: Db = prisma) => {
  const a = await accountOf(fx, db);
  return [a.rawDiscrepancy, a.approvedHistoricalAmount, a.unexplainedResidual, a.invalidApprovedCount];
};

// Exact affected counts (never the bounded finding sample).
async function gateCounts() {
  const readiness = await getFinancialReleaseReadiness();
  const report = await getFinancialReleaseReconciliation();
  const gate = (id: string) => readiness.gates.find((g) => g.id === id)!;
  const checks = Object.fromEntries(report.checks.map((c) => [c.id, c.affectedCount]));
  return { readiness, report, g3: gate("G3").affectedCount, g5: gate("G5").affectedCount, checks };
}

async function suspendForeignKeys(tx: Prisma.TransactionClient) {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
}

async function breaksOf(fx: GapFixture, db: Db = prisma) {
  return db.$queryRaw<{ id: string; jump: Prisma.Decimal; ambiguous_order: boolean }[]>`
    ${Prisma.raw(driverCashReconciliationWith(true))}, ${Prisma.raw(UNEXPLAINED_CHAIN_BREAKS)}
    SELECT id, jump, ambiguous_order FROM dc_breaks WHERE account_id = ${fx.accountId}::uuid
  `;
}

const today = new Date().toISOString().slice(0, 10);

describe("Historical reconciliation validation and gate integration (FR.12A.4)", () => {
  let baseline: { g5: number; h3: number; tables: number[] };

  before(async () => {
    await initReconciliationFixtures();
    const c = await gateCounts();
    baseline = {
      g5: c.g5,
      h3: c.checks.H3,
      tables: await Promise.all([
        prisma.financial_ledger_incidents.count(),
        prisma.driver_cash_historical_reconciliations.count(),
        prisma.driver_cash_historical_reconciliation_decisions.count(),
      ]),
    };
  });

  afterEach(cleanupGapFixtures);

  after(async () => {
    await cleanupReconciliationFixtures();
    await prisma.$disconnect();
  });

  test("1. a valid, independently approved reconciliation explains exactly its gap (SQL and TS rule agree)", async () => {
    const fx = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);

    const e = await evaluationOf(rec.id);
    assert.deepEqual(
      { status: e.status, failures: e.failures, contributes: e.contributes, blocking: e.blocking, amount: e.amount },
      { status: "APPROVED", failures: [], contributes: true, blocking: false, amount: "110.00" }
    );
    const a = await accountOf(fx);
    assert.deepEqual(
      [a.storedBalance, a.rawLedgerNet, a.rawDiscrepancy, a.approvedHistoricalAmount, a.unexplainedResidual, a.invalidApprovedCount, a.latestBalanceMatches],
      ["0.00", "-110.00", "110.00", "110.00", "0.00", 0, true]
    );
    const mirror = reconcileDriverCashAccount({
      accountId: fx.accountId,
      storedBalance: d(a.storedBalance),
      rawLedgerNet: d(a.rawLedgerNet),
      reconciliations: [{ reconciliationId: rec.id, accountId: fx.accountId, status: e.status, amount: d(e.amount), evidenceValidity: { valid: true } }],
    });
    assert.equal(mirror.unexplainedResidual.toFixed(2), a.unexplainedResidual);
    assert.equal(mirror.approvedHistoricalAmount.toFixed(2), a.approvedHistoricalAmount);
  });

  test("2-5. unapproved, rejected, withdrawn and revoked records never contribute", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    const e = evidenceFor(fx, incidentId);
    const unexplained = ["110.00", "0.00", "110.00", 0];

    const first = await propose(e);
    assert.equal((await evaluationOf(first.id)).status, "PROPOSED");
    assert.deepEqual(await residualOf(fx), unexplained, "PROPOSED");

    const rejection = await decide(first, "REJECTED");
    assert.equal((await evaluationOf(first.id)).status, "REJECTED");
    assert.deepEqual(await residualOf(fx), unexplained, "REJECTED");

    const second = await propose(e, { supersedes: { reconciliationId: first.id, decisionId: rejection.id } });
    const withdrawal = await decide(second, "WITHDRAWN", { decidedById: actors.proposer.id });
    assert.equal((await evaluationOf(second.id)).status, "WITHDRAWN");
    assert.deepEqual(await residualOf(fx), unexplained, "WITHDRAWN");

    const third = await propose(e, { supersedes: { reconciliationId: second.id, decisionId: withdrawal.id } });
    const approval = await decide(third, "APPROVED");
    assert.deepEqual(await residualOf(fx), ["110.00", "110.00", "0.00", 0], "APPROVED head of the chain");

    await decide(third, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });
    const revoked = await evaluationOf(third.id);
    assert.deepEqual([revoked.status, revoked.contributes, revoked.blocking], ["REVOKED", false, false]);
    assert.deepEqual(await residualOf(fx), unexplained, "REVOKED");
  });

  test("6. an impossible decision history is INVALID_HISTORY: never contributes, always blocks (G3 rule and R1)", async () => {
    const fx = await createGapFixture();
    const other = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);
    const { approval: otherApproval } = await approvedReconciliation(other);

    // Two review outcomes.
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe("DROP INDEX dchrd_one_outcome_per_reconciliation_uq");
      await decide(rec, "REJECTED", {}, tx);
      const ev = await evaluationOf(rec.id, tx);
      assert.deepEqual([ev.status, ev.contributes, ev.blocking], ["INVALID_HISTORY", false, true]);
      assert.ok(ev.failures.includes("INVALID_DECISION_HISTORY"));
      assert.deepEqual(await residualOf(fx, tx), ["110.00", "0.00", "110.00", 1]);
      const r1 = (await runReconciliationChecks(tx)).find((c) => c.id === "R1")!;
      assert.ok(r1.blocksActivation);
      assert.ok(r1.findings.some((f) => f.entityType === "DRIVER_CASH_HISTORICAL_RECONCILIATION" && f.entityId === rec.id));
    });
    // A revocation of ANOTHER reconciliation's approval.
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE driver_cash_historical_reconciliation_decisions DROP CONSTRAINT dchrd_revokes_decision_fkey");
      await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: otherApproval.id }, tx);
      const ev = await evaluationOf(rec.id, tx);
      assert.deepEqual([ev.status, ev.blocking], ["INVALID_HISTORY", true]);
    });
    assert.equal((await evaluationOf(rec.id)).status, "APPROVED", "rolled back");
  });

  test("7. incorrect amounts: the audit's amount or the ledger jump differ from the claim", async () => {
    const auditDiffers = await createGapFixture({ audit: { actualAmount: "111" } });
    const jumpDiffers = await createGapFixture({ ledgerJump: "100.00" });
    const a = await approvedReconciliation(auditDiffers);
    const b = await approvedReconciliation(jumpDiffers);

    const ea = await evaluationOf(a.rec.id);
    assert.deepEqual([ea.failures, ea.blocking], [["SOURCE_AUDIT_MISMATCH"], true]);
    assert.deepEqual(await residualOf(auditDiffers), ["110.00", "0.00", "110.00", 1]);

    const eb = await evaluationOf(b.rec.id);
    assert.deepEqual([eb.failures, eb.blocking], [["JUMP_MISMATCH"], true]);
    assert.deepEqual(await residualOf(jumpDiffers), ["100.00", "0.00", "100.00", 1]);
  });

  test("8-10. missing audit, missing anchor, anchor on another account, account of another driver", async () => {
    const fx = await createGapFixture();
    const other = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);

    const failuresAfter = async (mutate: (tx: Prisma.TransactionClient) => Promise<unknown>) => {
      let failures: string[] = [];
      await inRolledBackTransaction(async (tx) => {
        await suspendForeignKeys(tx);
        await mutate(tx);
        const ev = await evaluationOf(rec.id, tx);
        assert.equal(ev.blocking, true);
        assert.equal(ev.contributes, false);
        failures = ev.failures;
      });
      return failures;
    };

    assert.deepEqual(await failuresAfter((tx) => tx.$executeRaw`DELETE FROM audit_logs WHERE id = ${fx.auditId}::uuid`), ["SOURCE_AUDIT_MISMATCH"]);
    assert.ok((await failuresAfter((tx) => tx.$executeRaw`DELETE FROM driver_cash_transactions WHERE id = ${fx.anchorId}::uuid`)).includes("ANCHOR_NOT_FOUND"));
    assert.ok((await failuresAfter((tx) => tx.$executeRaw`DELETE FROM driver_cash_transactions WHERE id = ${fx.predecessorId}::uuid`)).includes("ANCHOR_NOT_FOUND"));
    assert.ok(
      (
        await failuresAfter((tx) => tx.$executeRaw`UPDATE driver_cash_transactions SET account_id = ${other.accountId}::uuid WHERE id = ${fx.anchorId}::uuid`)
      ).includes("ANCHOR_NOT_FOUND")
    );
    assert.ok(
      (
        await failuresAfter(async (tx) => {
          const stranger = await tx.drivers.create({ data: { user_id: actors.secondAdmin.id, driver_number: `FR12A4-${randomUUID().slice(0, 8)}` } });
          await tx.$executeRaw`UPDATE driver_cash_accounts SET driver_id = ${stranger.id}::uuid WHERE id = ${fx.accountId}::uuid`;
        })
      ).includes("ACCOUNT_MISMATCH")
    );
    assert.equal((await evaluationOf(rec.id)).contributes, true, "rolled back: still valid");
  });

  test("11-12. adjacency: a row inside the gap breaks it; a shared timestamp makes it ambiguous (fail closed)", async () => {
    const fx = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);

    await inRolledBackTransaction(async (tx) => {
      await tx.driver_cash_transactions.create({
        data: { account_id: fx.accountId, driver_id: fx.driverId, type: "COLLECTION", amount: d("1"), balance_before: d("50"), balance_after: d("51"), created_at: new Date(fx.evidenceAt.getTime() + 3_600_000) },
      });
      assert.ok((await evaluationOf(rec.id, tx)).failures.includes("ROWS_INSIDE_GAP"));
    });
    await inRolledBackTransaction(async (tx) => {
      await tx.driver_cash_transactions.create({
        data: { account_id: fx.accountId, driver_id: fx.driverId, type: "COLLECTION", amount: d("1"), balance_before: d("0"), balance_after: d("1"), created_at: fx.anchorAt },
      });
      const ev = await evaluationOf(rec.id, tx);
      assert.ok(ev.failures.includes("ORDERING_AMBIGUOUS"));
      assert.equal(ev.contributes, false);
    });
    assert.deepEqual((await evaluationOf(rec.id)).failures, []);
  });

  test("12b. H3: an unexplained gap is UNEXPLAINED_GAP; a gap at a shared timestamp needs further evidence; an explained gap is not reported", async () => {
    const fx = await createGapFixture();
    const before = await breaksOf(fx);
    assert.deepEqual(before.map((b) => [b.id, d(b.jump.toString()).toFixed(2), b.ambiguous_order]), [[fx.anchorId, "110.00", false]]);

    await inRolledBackTransaction(async (tx) => {
      await tx.driver_cash_transactions.create({
        data: { account_id: fx.accountId, driver_id: fx.driverId, type: "COLLECTION", amount: d("1"), balance_before: d("160"), balance_after: d("161"), created_at: fx.anchorAt },
      });
      const breaks = await breaksOf(fx, tx);
      assert.ok(breaks.length > 0);
      assert.ok(breaks.every((b) => b.ambiguous_order), "every break at the shared timestamp is classified as ambiguous");
    });

    await approvedReconciliation(fx);
    assert.deepEqual(await breaksOf(fx), [], "a valid approval explains its own gap");
  });

  test("13 + 16. a restored original collection invalidates the approval, which then blocks G3 and R1", async () => {
    const fx = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);
    const explained = await gateCounts();

    // An authentic restore of the deleted row (same id, its place in the chain).
    await cashTransaction(fx, { id: fx.missingTransactionId, type: "COLLECTION", amount: "110", before: "50", after: "160", at: fx.evidenceAt });

    const ev = await evaluationOf(rec.id);
    assert.ok(ev.failures.includes("MISSING_TRANSACTION_PRESENT"));
    assert.equal(ev.blocking, true);
    assert.deepEqual(await residualOf(fx), ["0.00", "0.00", "0.00", 1], "no raw discrepancy left, but the stale approval blocks");
    const restored = await gateCounts();
    assert.equal(restored.g3, explained.g3 + 2, "G3: the account and the invalid approval");
    assert.equal(restored.checks.R1, explained.checks.R1 + 2, "R1: the account and the invalid approval");
    assert.equal(restored.readiness.gates.find((g) => g.id === "G3")!.passed, false);
    assert.ok(restored.readiness.gates.find((g) => g.id === "G3")!.findings.some((f) => f.entityId === rec.id));
  });

  test("14. a new discrepancy on an explained account remains blocking", async () => {
    const fx = await createGapFixture();
    await approvedReconciliation(fx);
    const explained = await gateCounts();
    await prisma.driver_cash_accounts.update({ where: { id: fx.accountId }, data: { current_balance: d("5") } });
    try {
      assert.deepEqual(await residualOf(fx), ["115.00", "110.00", "5.00", 0]);
      const after = await gateCounts();
      assert.equal(after.g3, explained.g3 + 1);
      assert.equal(after.checks.R1, explained.checks.R1 + 1);
    } finally {
      await prisma.driver_cash_accounts.update({ where: { id: fx.accountId }, data: { current_balance: d("0") } });
    }
  });

  test("15. a duplicate / overlapping explanation explains nothing (no double count)", async () => {
    const fx = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);
    const incidentId = await createIncident();
    await inRolledBackTransaction(async (tx) => {
      for (const ix of ["dchr_root_anchor_uq", "dchr_root_missing_transaction_uq", "dchr_root_source_audit_uq"]) await tx.$executeRawUnsafe(`DROP INDEX ${ix}`);
      const dup = await propose(evidenceFor(fx, incidentId), {}, tx);
      await decide(dup, "APPROVED", {}, tx);
      for (const id of [rec.id, dup.id]) {
        const ev = await evaluationOf(id, tx);
        assert.ok(ev.failures.includes("OVERLAPPING_EXPLANATION"), id);
        assert.equal(ev.contributes, false);
      }
      assert.deepEqual(await residualOf(fx, tx), ["110.00", "0.00", "110.00", 2]);
    });
  });

  test("17. the raw discrepancy stays visible next to the approved amount and residual", async () => {
    const fx = await createGapFixture();
    await approvedReconciliation(fx);
    const { readiness, report } = await gateCounts();
    const expected = { rawDiscrepancy: "110.00", approvedHistoricalAmount: "110.00", unexplainedResidual: "0.00", invalidApprovedCount: 0 };
    for (const summary of [readiness.driverCashHistoricalReconciliation, report.driverCashHistoricalReconciliation]) {
      assert.ok(summary?.schemaPresent);
      const row = summary.accounts.find((x) => x.accountId === fx.accountId);
      assert.ok(row, "account listed although explained");
      assert.deepEqual(
        { rawDiscrepancy: row.rawDiscrepancy, approvedHistoricalAmount: row.approvedHistoricalAmount, unexplainedResidual: row.unexplainedResidual, invalidApprovedCount: row.invalidApprovedCount },
        expected
      );
    }
    const i3 = report.checks.find((c) => c.id === "I3")!;
    const finding = i3.findings.find((f) => f.entityId === fx.driverId);
    assert.ok(finding);
    assert.equal(finding.expected, "raw discrepancy 110.00");
    assert.match(finding.actual ?? "", /approved historical reconciliation 110\.00, unexplained residual 0\.00, invalid historical approvals 0/);
  });

  test("18. exact decimals: cents preserved; trailing zeros equal; extra precision or exponent notation fail closed", async () => {
    const cents = await createGapFixture({ gapAmount: "110.37", audit: { actualAmount: "110.370" } });
    const tooPrecise = await createGapFixture({ gapAmount: "110.37", audit: { actualAmount: "110.371" } });
    const exponent = await createGapFixture({ gapAmount: "110.37", audit: { actualAmount: "1.1037e2" } });
    const a = await approvedReconciliation(cents);
    const b = await approvedReconciliation(tooPrecise);
    const c = await approvedReconciliation(exponent);
    assert.deepEqual((await evaluationOf(a.rec.id)).failures, []);
    assert.deepEqual(await residualOf(cents), ["110.37", "110.37", "0.00", 0]);
    assert.deepEqual((await evaluationOf(b.rec.id)).failures, ["SOURCE_AUDIT_MISMATCH"]);
    assert.deepEqual((await evaluationOf(c.rec.id)).failures, ["SOURCE_AUDIT_MISMATCH"]);
  });

  test("19. normal driver cash accounting after approval keeps the residual at 0", async () => {
    const fx = await createGapFixture();
    const { rec } = await approvedReconciliation(fx);
    const explained = await gateCounts();
    await prisma.$transaction((tx) =>
      applyDriverCashTransaction(tx, { driverId: fx.driverId, type: "COLLECTION", direction: "CREDIT", amount: d("40"), notes: "FR.12A.4 normal collection" })
    );
    await prisma.$transaction((tx) =>
      applyDriverCashTransaction(tx, { driverId: fx.driverId, type: "ADJUSTMENT", direction: "DEBIT", amount: d("15"), notes: "FR.12A.4 normal adjustment" })
    );
    const a = await accountOf(fx);
    assert.deepEqual(
      [a.storedBalance, a.rawLedgerNet, a.rawDiscrepancy, a.approvedHistoricalAmount, a.unexplainedResidual, a.latestBalanceMatches],
      ["25.00", "-85.00", "110.00", "110.00", "0.00", true]
    );
    assert.deepEqual((await evaluationOf(rec.id)).failures, []);
    const after = await gateCounts();
    assert.equal(after.g3, explained.g3);
    assert.equal(after.checks.R1, explained.checks.R1);
  });

  test("20. R2–R13, H1, H2, I1, I2 are unaffected by an approval; the check list only gains H3 and I3", async () => {
    const fx = await createGapFixture();
    const before = await gateCounts();
    await approvedReconciliation(fx);
    const after = await gateCounts();
    for (const id of ["R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "H1", "H2", "I1", "I2"]) {
      assert.equal(after.checks[id], before.checks[id], id);
    }
    assert.deepEqual(
      after.report.checks.map((c) => c.id),
      ["R1", "R2", "R3", "R4", "R5", "R6", "R7", "R8", "R9", "R10", "R11", "R12", "R13", "H1", "H2", "H3", "I1", "I2", "I3"]
    );
  });

  test("21. G5: unresolved historical ownership blocks before, during and after approval, and after revocation", async () => {
    const start = (await gateCounts()).g5;
    const fx = await createGapFixture();
    // Detected from the surviving audit alone (the fixture's audit + its spare audit).
    assert.equal((await gateCounts()).g5, start + 2);

    const rec = await propose(evidenceFor(fx, await createIncident()));
    assert.equal((await gateCounts()).g5, start + 2, "same deleted order: one finding");
    const approval = await decide(rec, "APPROVED");
    const approved = await gateCounts();
    assert.equal(approved.g5, start + 2, "an approved LEDGER reconciliation does not resolve ownership");
    const g5 = approved.readiness.gates.find((g) => g.id === "G5")!;
    assert.equal(g5.passed, false);
    const finding = g5.findings.find((f) => f.entityId === fx.deletedOrderId);
    assert.ok(finding);
    assert.equal(finding.entityType, "DELETED_ORDER");
    assert.match(finding.detail, /surviving COLLECTION_DIFFERENCE_RECORDED audit/);
    assert.match(finding.detail, new RegExp(`historical reconciliation ${rec.id}`));

    await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });
    assert.equal((await gateCounts()).g5, start + 2, "revocation changes nothing about ownership");

    // A difference that WAS resolved (surviving resolution audit) is not an open obligation.
    const spare = await prisma.audit_logs.findUniqueOrThrow({ where: { id: fx.spareAuditId } });
    const resolved = await prisma.audit_logs.create({
      data: { actor_user_id: actors.reviewer.id, action: "COLLECTION_DIFFERENCE_RESOLVED", entity_type: "ORDER", entity_id: spare.entity_id },
    });
    try {
      assert.equal((await gateCounts()).g5, start + 1);
    } finally {
      await prisma.audit_logs.delete({ where: { id: resolved.id } });
    }
  });

  test("22. evaluation, gates, reconciliation and reports post nothing and change no balance", async () => {
    const fx = await createGapFixture();
    await approvedReconciliation(fx);
    const before = await financialSnapshot();
    const auditCount = await prisma.audit_logs.count();
    await gateCounts();
    await getFinanceSummary({ basis: "released", to: today });
    await evaluateHistoricalReconciliations(prisma);
    assert.deepEqual(await financialSnapshot(), before);
    assert.equal(await prisma.audit_logs.count(), auditCount);
  });

  test("as-of driver cash: the approved historical reconciliation is a labelled component, never a collection", async () => {
    const fx = await createGapFixture();
    const summary = (to: string) => getFinanceSummary({ basis: "released", to });
    const beforeEvidence = "2026-10-01";
    const afterSettlement = "2026-10-04";
    const [b1, b2] = [await summary(beforeEvidence), await summary(afterSettlement)];
    await approvedReconciliation(fx);
    const [a1, a2] = [await summary(beforeEvidence), await summary(afterSettlement)];

    // The headline figure and its ledger component never change.
    assert.equal(a2.driverCashOutstanding, b2.driverCashOutstanding);
    assert.equal(a2.driverCashOutstandingComponents.ledgerNet, b2.driverCashOutstandingComponents.ledgerNet);
    assert.equal(a2.driverCollected, b2.driverCollected, "not a collection");
    assert.equal(a2.companyRevenue, b2.companyRevenue, "not revenue");
    assert.equal(a2.driverCashOutstandingComponents.basis, "LEDGER_AS_OF");
    // The explanatory component counts only evidence dated before the range end.
    const delta = (x: string, y: string) => d(x).minus(d(y)).toFixed(2);
    assert.equal(delta(a2.driverCashOutstandingComponents.approvedHistoricalReconciliation, b2.driverCashOutstandingComponents.approvedHistoricalReconciliation), "110.00");
    assert.equal(delta(a1.driverCashOutstandingComponents.approvedHistoricalReconciliation, b1.driverCashOutstandingComponents.approvedHistoricalReconciliation), "0.00");
    const c = a2.driverCashOutstandingComponents;
    assert.equal(d(c.explainedLedgerTotal).toFixed(2), d(c.ledgerNet).plus(d(c.approvedHistoricalReconciliation)).toFixed(2));
    assert.equal((await getFinanceSummary({ basis: "released" })).driverCashOutstandingComponents.basis, "CURRENT_BALANCE");
  });

  test("24. accounts without historical reconciliation behave exactly as before (same findings, same text)", async () => {
    const fx = await createGapFixture();
    const { readiness, report } = await gateCounts();
    const g3 = readiness.gates.find((g) => g.id === "G3")!;
    assert.ok(g3.findings.length < 20, "sample is not truncated in this isolated run");
    const g3Finding = g3.findings.find((f) => f.entityId === fx.driverId);
    assert.deepEqual(g3Finding, { entityType: "DRIVER_CASH_ACCOUNT", entityId: fx.driverId, detail: "cached 0.00, ledger net -110.00" });
    const r1 = report.checks.find((c) => c.id === "R1")!;
    const r1Finding = r1.findings.find((f) => f.entityId === fx.driverId);
    assert.ok(r1Finding);
    assert.deepEqual(
      { expected: r1Finding.expected, actual: r1Finding.actual, detail: r1Finding.detail },
      { expected: "-110.00", actual: "0.00", detail: "cached current_balance differs from the net of the driver cash ledger" }
    );
    assert.deepEqual(await residualOf(fx), ["110.00", "0.00", "110.00", 0]);
  });

  test("concurrency: every snapshot shows the explained account consistently while normal postings commit", async () => {
    const fx = await createGapFixture();
    await approvedReconciliation(fx);
    const posting = (direction: "CREDIT" | "DEBIT") => () =>
      prisma.$transaction((tx) =>
        applyDriverCashTransaction(tx, { driverId: fx.driverId, type: "ADJUSTMENT", direction, amount: d("10"), notes: "FR.12A.4 concurrency" })
      );
    const work: (() => Promise<unknown>)[] = [];
    for (let i = 0; i < 4; i++) work.push(posting("CREDIT"), posting("DEBIT"));
    const results = await Promise.allSettled([
      ...work.map((w) => w()),
      getFinancialReleaseReadiness(),
      getFinancialReleaseReconciliation(),
      getFinancialReleaseReadiness(),
      getFinancialReleaseReconciliation(),
    ]);
    // A debit may legitimately fail (insufficient balance) when it runs first; never a torn read.
    for (const r of results.slice(work.length)) {
      assert.equal(r.status, "fulfilled");
      const value = (r as PromiseFulfilledResult<Awaited<ReturnType<typeof getFinancialReleaseReconciliation>>>).value;
      const row = value.driverCashHistoricalReconciliation!.accounts.find((x) => x.accountId === fx.accountId);
      assert.ok(row);
      assert.deepEqual([row.rawDiscrepancy, row.approvedHistoricalAmount, row.unexplainedResidual], ["110.00", "110.00", "0.00"]);
    }
    const a = await accountOf(fx);
    assert.deepEqual([a.rawDiscrepancy, a.unexplainedResidual, a.latestBalanceMatches], ["110.00", "0.00", true]);
  });

  test("23. no test data leaks: every reconciliation row, audit and ownership finding is gone after cleanup", async () => {
    const fx = await createGapFixture();
    await approvedReconciliation(fx);
    await cleanupGapFixtures();
    const c = await gateCounts();
    assert.equal(c.g5, baseline.g5);
    assert.equal(c.checks.H3, baseline.h3);
    assert.deepEqual(
      await Promise.all([
        prisma.financial_ledger_incidents.count(),
        prisma.driver_cash_historical_reconciliations.count(),
        prisma.driver_cash_historical_reconciliation_decisions.count(),
      ]),
      baseline.tables
    );
    assert.equal(await prisma.audit_logs.count({ where: { action: "COLLECTION_DIFFERENCE_RECORDED", actor_user_id: actors.proposer.id } }), 0);
  });
});
