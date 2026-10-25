import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { prisma } from "../../src/db/prisma";
import {
  computeEvidenceDigest,
  isUnresolvedHistoricalOwnership,
  reconcileDriverCashAccount,
} from "../../src/modules/historical-reconciliation/historical-reconciliation.calculation";
import type { HistoricalReconciliationEvidence } from "../../src/modules/historical-reconciliation/historical-reconciliation.types";
import { getFinancialReleaseReadiness } from "../../src/modules/financial-release/financial-release-activation.service";
import { runReconciliationChecks } from "../../src/modules/financial-release/financial-release-reconciliation.service";
import {
  accountTotals,
  actors,
  cleanupReconciliationFixtures,
  createGapFixture,
  createIncident,
  d,
  decide,
  evidenceFor,
  financialSnapshot,
  initReconciliationFixtures,
  propose,
  rejectsWith,
  statusOf,
} from "./reconciliation-fixtures";

// ============================================================
// FR.12A.3 — Historical reconciliation database foundation.
// Migration: 20261025000000_driver_cash_historical_reconciliation_foundation
//
// Fixtures (tests/historical-reconciliation/reconciliation-fixtures.ts): a
// driver cash ledger with a +110.00 balance-chain gap, the surviving
// COLLECTION_DIFFERENCE_RECORDED audit and the settlement that handed the
// missing cash over — never shared data. Raw SQL is used where the point is
// what the DATABASE accepts or rejects.
// ============================================================

describe("Historical reconciliation foundation (FR.12A.3)", () => {
  before(initReconciliationFixtures);

  after(async () => {
    await cleanupReconciliationFixtures();
    await prisma.$disconnect();
  });

  test("the schema is additive and trigger-free", async () => {
    const [row] = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal
        AND c.relname IN ('financial_ledger_incidents', 'driver_cash_historical_reconciliations',
                          'driver_cash_historical_reconciliation_decisions')`;
    assert.equal(row.n, 0);
  });

  test("stores an evidence-only proposal with exact decimals and a database-verified digest", async () => {
    const fx = await createGapFixture();
    const e = evidenceFor(fx, await createIncident());
    const rec = await propose(e);

    const [raw] = await prisma.$queryRaw<Record<string, string>[]>`
      SELECT amount::text AS amount, observed_jump::text AS jump, expected_amount::text AS expected,
             actual_amount::text AS actual, collection_difference::text AS difference,
             evidence_digest, ownership_status::text AS ownership, accounting_treatment::text AS treatment
      FROM driver_cash_historical_reconciliations WHERE id = ${rec.id}::uuid`;
    assert.deepEqual(
      { ...raw },
      {
        amount: "110.00",
        jump: "110.00",
        expected: "210.00",
        actual: "110.00",
        difference: "-100.00",
        evidence_digest: computeEvidenceDigest(e),
        ownership: "UNRESOLVED",
        treatment: "EVIDENCE_ONLY_NO_CASH_EFFECT",
      }
    );
    assert.equal(rec.amount.equals(d("110")), true);
    assert.equal(await statusOf(rec.id), "PROPOSED", "a record alone is never approved");
  });

  test("evidence that disagrees with its digest or with itself is rejected", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    const e = evidenceFor(fx, incidentId);
    const cases: [HistoricalReconciliationEvidence, string][] = [
      [evidenceFor(fx, incidentId, { amount: d("0"), observedJump: d("0"), actualAmount: d("0"), collectionDifference: d("-210") }), "dchr_amount_positive_chk"],
      [evidenceFor(fx, incidentId, { observedJump: d("110.01") }), "dchr_observed_jump_matches_chk"],
      [evidenceFor(fx, incidentId, { actualAmount: d("100"), collectionDifference: d("-110") }), "dchr_actual_amount_matches_chk"],
      [evidenceFor(fx, incidentId, { collectionDifference: d("100") }), "dchr_collection_difference_chk"],
      [evidenceFor(fx, incidentId, { expectedAmount: d("110"), collectionDifference: d("0") }), "dchr_collection_difference_chk"],
      [evidenceFor(fx, incidentId, { predecessorTransactionId: fx.anchorId }), "dchr_anchor_not_predecessor_chk"],
    ];
    for (const [bad, constraint] of cases) await rejectsWith(propose(bad), constraint);

    await rejectsWith(propose(e, { digest: computeEvidenceDigest(evidenceFor(fx, incidentId, { amount: d("111") })) }), "dchr_evidence_digest_chk");
    await rejectsWith(propose(e, { reason: "too short" }), "dchr_reason_meaningful_chk");
    await rejectsWith(
      propose(e, { supersedes: { reconciliationId: randomUUID(), decisionId: randomUUID(), isTerminal: false } }),
      "dchr_supersession_shape_chk"
    );
    assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: fx.driverId } }), 0);
  });

  test("composite foreign keys tie every evidence row to the same account and driver", async () => {
    const fx = await createGapFixture();
    const other = await createGapFixture();
    const incidentId = await createIncident();
    await rejectsWith(propose(evidenceFor(fx, incidentId, { anchorTransactionId: other.anchorId })), "dchr_anchor_transaction_fkey");
    await rejectsWith(propose(evidenceFor(fx, incidentId, { predecessorTransactionId: other.predecessorId })), "dchr_predecessor_transaction_fkey");
    await rejectsWith(propose(evidenceFor(fx, incidentId, { driverId: other.driverId })), "dchr_account_id_driver_id_fkey");
    await rejectsWith(propose(evidenceFor(fx, incidentId, { relatedSettlementId: other.settlementId })), "dchr_related_settlement_fkey");
    await rejectsWith(propose(evidenceFor(fx, incidentId, { sourceAuditLogId: randomUUID() })), "dchr_source_audit_log_id_fkey");
    await rejectsWith(propose(evidenceFor(fx, randomUUID())), "dchr_incident_id_fkey");
  });

  test("one explanation per gap, per missing row and per source audit", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    await propose(evidenceFor(fx, incidentId));

    await rejectsWith(
      propose(evidenceFor(fx, incidentId, { missingTransactionId: randomUUID(), sourceAuditLogId: fx.spareAuditId })),
      "dchr_root_anchor_uq"
    );
    await rejectsWith(
      propose(evidenceFor(fx, incidentId, { anchorTransactionId: fx.spareTransactionId, sourceAuditLogId: fx.spareAuditId })),
      "dchr_root_missing_transaction_uq"
    );
    await rejectsWith(
      propose(evidenceFor(fx, incidentId, { anchorTransactionId: fx.spareTransactionId, missingTransactionId: randomUUID() })),
      "dchr_root_source_audit_uq"
    );
    assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: fx.driverId } }), 1);

    // A reused idempotency key is refused even for entirely different evidence.
    const key = (await prisma.driver_cash_historical_reconciliations.findFirstOrThrow({ where: { driver_id: fx.driverId } })).idempotency_key;
    const other = await createGapFixture();
    await rejectsWith(propose(evidenceFor(other, incidentId), { idempotencyKey: key }), "dchr_idempotency_key_key");
  });

  test("approval and rejection need a reviewer other than the proposer", async () => {
    const fx = await createGapFixture();
    const rec = await propose(evidenceFor(fx, await createIncident()));
    await rejectsWith(decide(rec, "APPROVED", { decidedById: actors.proposer.id }), "dchrd_independent_reviewer_chk");
    await rejectsWith(decide(rec, "REJECTED", { decidedById: actors.proposer.id }), "dchrd_independent_reviewer_chk");
    // The copy of the proposer cannot be faked to get around the CHECK.
    await rejectsWith(decide(rec, "APPROVED", { decidedById: actors.proposer.id, proposedById: actors.reviewer.id }), "dchrd_reconciliation_evidence_fkey");
    await rejectsWith(decide(rec, "APPROVED", { evidenceDigest: "f".repeat(64) }), "dchrd_reconciliation_evidence_fkey");
    await rejectsWith(decide(rec, "APPROVED", { isTerminal: true }), "dchrd_is_terminal_chk");
    await rejectsWith(decide(rec, "REJECTED", { reason: null }), "dchrd_reason_chk");
    assert.equal(await statusOf(rec.id), "PROPOSED");

    const withdrawn = await decide(rec, "WITHDRAWN", { decidedById: actors.proposer.id });
    assert.equal(withdrawn.decision, "WITHDRAWN");
    assert.equal(await statusOf(rec.id), "WITHDRAWN");
  });

  test("exactly one review outcome; only the approval can be revoked, once", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    const rec = await propose(evidenceFor(fx, incidentId));
    const approval = await decide(rec, "APPROVED");
    assert.equal(await statusOf(rec.id), "APPROVED");

    await rejectsWith(decide(rec, "APPROVED", { decidedById: actors.secondAdmin.id }), "dchrd_one_outcome_per_reconciliation_uq");
    await rejectsWith(decide(rec, "REJECTED"), "dchrd_one_outcome_per_reconciliation_uq");
    await rejectsWith(decide(rec, "WITHDRAWN", { decidedById: actors.proposer.id }), "dchrd_one_outcome_per_reconciliation_uq");
    await rejectsWith(decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id }), "dchrd_revocation_shape_chk");

    // An approval of ANOTHER reconciliation, and a decision that is not an approval.
    const otherFx = await createGapFixture();
    const otherRec = await propose(evidenceFor(otherFx, incidentId));
    const otherApproval = await decide(otherRec, "APPROVED");
    await rejectsWith(decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: otherApproval.id }), "dchrd_revokes_decision_fkey");
    const thirdFx = await createGapFixture();
    const rejectedRec = await propose(evidenceFor(thirdFx, incidentId));
    const rejection = await decide(rejectedRec, "REJECTED");
    await rejectsWith(
      decide(rejectedRec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: rejection.id }),
      "dchrd_revokes_decision_fkey"
    );

    await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });
    assert.equal(await statusOf(rec.id), "REVOKED");
    await rejectsWith(decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id }), "dchrd_revokes_decision_id_key");
  });

  test("evidence judged by a decision is frozen by the database (no trigger)", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    const e = evidenceFor(fx, incidentId);
    const rec = await propose(e);
    const approval = await decide(rec, "APPROVED");

    // Changing evidence without the digest violates the digest CHECK ...
    await rejectsWith(
      prisma.$executeRaw`UPDATE driver_cash_historical_reconciliations SET deleted_order_reference = gen_random_uuid() WHERE id = ${rec.id}::uuid`,
      "dchr_evidence_digest_chk"
    );
    // ... and a consistently recomputed digest is pinned by the approval (ON UPDATE RESTRICT).
    const tampered = evidenceFor(fx, incidentId, { amount: d("120"), observedJump: d("120"), actualAmount: d("120"), expectedAmount: d("220") });
    await rejectsWith(
      prisma.$executeRaw`UPDATE driver_cash_historical_reconciliations
                         SET amount = 120, observed_jump = 120, actual_amount = 120, expected_amount = 220,
                             evidence_digest = ${computeEvidenceDigest(tampered)}
                         WHERE id = ${rec.id}::uuid`,
      "dchrd_reconciliation_evidence_fkey"
    );
    await rejectsWith(
      prisma.$executeRaw`UPDATE driver_cash_historical_reconciliations SET proposed_by_id = ${actors.reviewer.id}::uuid WHERE id = ${rec.id}::uuid`,
      "dchrd_reconciliation_evidence_fkey"
    );
    // A revoked approval itself is pinned by its revocation.
    await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });
    await rejectsWith(
      prisma.$executeRaw`UPDATE driver_cash_historical_reconciliation_decisions SET decision = 'REJECTED', is_terminal = true, reason = 'rewritten history of this approval' WHERE id = ${approval.id}::uuid`,
      "dchrd_revokes_decision_fkey"
    );

    const stored = await prisma.driver_cash_historical_reconciliations.findUniqueOrThrow({ where: { id: rec.id } });
    assert.equal(stored.evidence_digest, computeEvidenceDigest(e));
    assert.equal(stored.amount.toFixed(2), "110.00");
  });

  test("a re-proposal supersedes only a terminal record of the same evidence, once", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    const e = evidenceFor(fx, incidentId);
    const first = await propose(e);
    const approval = await decide(first, "APPROVED");

    // A live (APPROVED) record cannot be superseded: its approval is not terminal.
    await rejectsWith(
      propose(e, { supersedes: { reconciliationId: first.id, decisionId: approval.id } }),
      "dchr_supersedes_terminal_decision_fkey"
    );
    // A root for the same evidence is still a duplicate.
    await rejectsWith(propose(e), "dchr_root_");

    const revocation = await decide(first, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });
    // The successor must explain the same gap / missing row / audit.
    await rejectsWith(
      propose(evidenceFor(fx, incidentId, { missingTransactionId: randomUUID() }), {
        supersedes: { reconciliationId: first.id, decisionId: revocation.id },
      }),
      "dchr_supersedes_reconciliation_fkey"
    );
    const second = await propose(e, { supersedes: { reconciliationId: first.id, decisionId: revocation.id } });
    assert.equal(await statusOf(second.id), "PROPOSED");
    await rejectsWith(
      propose(e, { supersedes: { reconciliationId: first.id, decisionId: revocation.id } }),
      "dchr_supersedes_reconciliation_id_key"
    );

    const withdrawal = await decide(second, "WITHDRAWN", { decidedById: actors.proposer.id });
    const third = await propose(e, { supersedes: { reconciliationId: second.id, decisionId: withdrawal.id } });
    assert.equal(await statusOf(third.id), "PROPOSED");
    const live = [];
    for (const r of [first, second, third]) if (["PROPOSED", "APPROVED"].includes(await statusOf(r.id))) live.push(r.id);
    assert.deepEqual(live, [third.id], "exactly one live record per evidence chain");
  });

  test("anchors and the source audit cannot be deleted while cited", async () => {
    const fx = await createGapFixture();
    await propose(evidenceFor(fx, await createIncident()));
    await rejectsWith(prisma.driver_cash_transactions.delete({ where: { id: fx.anchorId } }), "dchr_anchor_transaction_fkey");
    await rejectsWith(prisma.driver_cash_transactions.delete({ where: { id: fx.predecessorId } }), "dchr_predecessor_transaction_fkey");
    await rejectsWith(prisma.audit_logs.delete({ where: { id: fx.auditId } }), "dchr_source_audit_log_id_fkey");
  });

  test("propose / approve / revoke have no effect on any balance or ledger", async () => {
    const fx = await createGapFixture();
    const incidentId = await createIncident();
    const before = await financialSnapshot();
    const totalsBefore = await accountTotals(fx.accountId);

    const rec = await propose(evidenceFor(fx, incidentId));
    const approval = await decide(rec, "APPROVED");
    await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });

    assert.deepEqual(await financialSnapshot(), before);
    const totalsAfter = await accountTotals(fx.accountId);
    assert.equal(totalsAfter.stored.toFixed(2), "0.00");
    assert.equal(totalsAfter.net.toFixed(2), "-110.00");
    assert.equal(totalsAfter.stored.equals(totalsBefore.stored) && totalsAfter.net.equals(totalsBefore.net), true);
  });

  test("ownership stays unresolved: nothing is credited, recognised or recreated", async () => {
    const fx = await createGapFixture();
    const rec = await propose(evidenceFor(fx, await createIncident()));
    await decide(rec, "APPROVED");

    const stored = await prisma.driver_cash_historical_reconciliations.findUniqueOrThrow({ where: { id: rec.id } });
    assert.equal(stored.ownership_status, "UNRESOLVED");
    assert.equal(stored.collection_difference.toFixed(2), "-100.00");
    assert.equal(
      isUnresolvedHistoricalOwnership({ reconciliationId: rec.id, status: await statusOf(rec.id), ownershipStatus: stored.ownership_status }),
      true
    );
    assert.equal(await prisma.orders.count({ where: { id: fx.deletedOrderId } }), 0, "the deleted order is not recreated");
    assert.equal(await prisma.wallet_transactions.count({ where: { order_id: fx.deletedOrderId } }), 0);
    assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: fx.deletedOrderId } }), 0);
    assert.equal(await prisma.driver_cash_transactions.count({ where: { id: fx.missingTransactionId } }), 0);
    assert.equal(await prisma.order_financial_releases.count({ where: { order_id: fx.deletedOrderId } }), 0);
  });

  test("D / A / R from the live ledger: the gap stays visible; only a valid approval explains it", async () => {
    const fx = await createGapFixture();
    const rec = await propose(evidenceFor(fx, await createIncident()));
    const { stored, net } = await accountTotals(fx.accountId);
    const contribution = async (valid: boolean) => ({
      reconciliationId: rec.id,
      accountId: fx.accountId,
      status: await statusOf(rec.id),
      amount: rec.amount,
      evidenceValidity: valid ? ({ valid: true } as const) : ({ valid: false, failures: ["MISSING_TRANSACTION_PRESENT"] } as const),
    });

    let r = reconcileDriverCashAccount({ accountId: fx.accountId, storedBalance: stored, rawLedgerNet: net, reconciliations: [await contribution(true)] });
    assert.deepEqual([r.rawDiscrepancy.toFixed(2), r.approvedHistoricalAmount.toFixed(2), r.unexplainedResidual.toFixed(2)], ["110.00", "0.00", "110.00"]);

    const approval = await decide(rec, "APPROVED");
    r = reconcileDriverCashAccount({ accountId: fx.accountId, storedBalance: stored, rawLedgerNet: net, reconciliations: [await contribution(true)] });
    assert.deepEqual([r.rawDiscrepancy.toFixed(2), r.approvedHistoricalAmount.toFixed(2), r.unexplainedResidual.toFixed(2)], ["110.00", "110.00", "0.00"]);
    r = reconcileDriverCashAccount({ accountId: fx.accountId, storedBalance: stored, rawLedgerNet: net, reconciliations: [await contribution(false)] });
    assert.deepEqual([r.unexplainedResidual.toFixed(2), r.invalidApprovedReconciliationIds], ["110.00", [rec.id]]);

    await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: approval.id });
    r = reconcileDriverCashAccount({ accountId: fx.accountId, storedBalance: stored, rawLedgerNet: net, reconciliations: [await contribution(true)] });
    assert.equal(r.unexplainedResidual.toFixed(2), "110.00");
  });

  test("G3 and R1 (FR.12A.4 residual rule): the gap fails until a valid independent approval explains it", async () => {
    const fx = await createGapFixture();
    const rec = await propose(evidenceFor(fx, await createIncident()));
    const counts = async () => {
      const readiness = await getFinancialReleaseReadiness();
      const checks = await prisma.$transaction((tx) => runReconciliationChecks(tx));
      return {
        g3: readiness.gates.find((g) => g.id === "G3")?.affectedCount ?? -1,
        r1: checks.find((c) => c.id === "R1")?.affectedCount ?? -1,
      };
    };
    const proposed = await counts();
    await decide(rec, "APPROVED");
    const approved = await counts();
    assert.equal(approved.g3, proposed.g3 - 1, "G3 no longer reports the explained account");
    assert.equal(approved.r1, proposed.r1 - 1, "R1 no longer reports the explained account");
  });
});
