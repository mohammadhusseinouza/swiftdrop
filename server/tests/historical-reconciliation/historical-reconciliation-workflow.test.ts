import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { computeEvidenceDigest } from "../../src/modules/historical-reconciliation/historical-reconciliation.calculation";
import { evaluateHistoricalReconciliations } from "../../src/modules/historical-reconciliation/historical-reconciliation.service";
import {
  HISTORICAL_RECONCILIATION_WRITES_ENV,
  approveHistoricalReconciliation,
  revokeHistoricalReconciliation,
} from "../../src/modules/historical-reconciliation/historical-reconciliation-workflow.service";
import { getFinancialReleaseReadiness } from "../../src/modules/financial-release/financial-release-activation.service";
import { getFinancialReleaseReconciliation } from "../../src/modules/financial-release/financial-release-reconciliation.service";
import { cleanupTestUser, createTestUser, loginTestUser, type TestUser } from "../helpers/fixtures";
import {
  actors,
  approvedReconciliation,
  cashTransaction,
  cleanupGapFixtures,
  cleanupReconciliationFixtures,
  createGapFixture,
  decide,
  evidenceFor,
  financialSnapshot,
  initReconciliationFixtures,
  trackIncident,
  type GapFixture,
} from "./reconciliation-fixtures";

// ============================================================
// FR.12A.5 — Historical reconciliation workflow over HTTP:
// propose (ADMIN) / approve + reject (FINANCE, independent, no Admin
// fallback) / withdraw (ADMIN) / revoke (ADMIN, independent of proposer and
// approver), audit, idempotency, concurrency and read APIs.
//
// Isolated database only. Writes are enabled in-process for this suite
// (DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED) and restored afterwards.
// ============================================================

const BASE = "/api/v1/finance/historical-reconciliations";
const AUDIT_ENTITY = "DRIVER_CASH_HISTORICAL_RECONCILIATION";

describe("Historical reconciliation workflow (FR.12A.5)", () => {
  let app: Express;
  let finance2: TestUser;
  let dispatcher: TestUser;
  let customer: TestUser;
  const tokens = {} as Record<"proposer" | "admin2" | "finance" | "finance2" | "dispatcher" | "customer", string>;
  const savedFlag = process.env[HISTORICAL_RECONCILIATION_WRITES_ENV];
  let baseline: { tables: number[] };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const get = (path: string, token = tokens.finance) => request(app).get(`${BASE}${path}`).set(auth(token));
  const post = (path: string, token: string, body: object, key: string = randomUUID()) =>
    request(app).post(`${BASE}${path}`).set(auth(token)).set("Idempotency-Key", key).send(body);

  const incidentBody = () => ({
    summary: "Order and its driver cash collection deleted directly in PostgreSQL (FR.12A.5 test).",
    discoveredAt: "2026-10-20T09:00:00.000Z",
    missingRecords: { orders: 1, driver_cash_transactions: 1, delivery_attempts: "unknown" },
    remainingUncertainties: "Exact deletion time; ownership of the collected amount.",
    evidence: { queries: ["I1", "I10"], resultDigest: "0".repeat(64) },
  });
  const proposalBody = (fx: GapFixture, extra: object = {}) => ({
    incident: incidentBody(),
    anchorTransactionId: fx.anchorId,
    sourceAuditLogId: fx.auditId,
    reason: "Explains the located ledger gap left by the deleted collection row.",
    ...extra,
  });

  async function propose(fx: GapFixture, extra: object = {}, key?: string) {
    const res = await post("/", tokens.proposer, proposalBody(fx, extra), key);
    if (res.status === 201) trackIncident(res.body.data.incident.id);
    return res;
  }
  async function proposed(fx: GapFixture) {
    const res = await propose(fx);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data as { reconciliationId: string; evidence: { evidenceDigest: string }; incident: { id: string } };
  }
  const approve = (id: string, digest: string, token = tokens.finance, key?: string) => post(`/${id}/approve`, token, { evidenceDigest: digest }, key);
  const reason = "A documented reason of more than twenty characters.";

  async function gateCounts() {
    const readiness = await getFinancialReleaseReadiness();
    const report = await getFinancialReleaseReconciliation();
    const gate = (id: string) => readiness.gates.find((g) => g.id === id)!;
    return { g3: gate("G3").affectedCount, g5: gate("G5"), r1: report.checks.find((c) => c.id === "R1")!.affectedCount };
  }
  const decisionsOf = (id: string) => prisma.driver_cash_historical_reconciliation_decisions.findMany({ where: { reconciliation_id: id } });
  const auditsOf = (id: string, action: string) => prisma.audit_logs.findMany({ where: { entity_type: AUDIT_ENTITY, entity_id: id, action } });

  before(async () => {
    app = createApp();
    await initReconciliationFixtures();
    finance2 = await createTestUser("FINANCE");
    dispatcher = await createTestUser("DISPATCHER");
    customer = await createTestUser("CUSTOMER");
    const login = async (u: TestUser) => (await loginTestUser(app, u.email, u.password)).accessToken as string;
    tokens.proposer = await login(actors.proposer);
    tokens.admin2 = await login(actors.secondAdmin);
    tokens.finance = await login(actors.reviewer);
    tokens.finance2 = await login(finance2);
    tokens.dispatcher = await login(dispatcher);
    tokens.customer = await login(customer);
    process.env[HISTORICAL_RECONCILIATION_WRITES_ENV] = "true";
    baseline = {
      tables: await Promise.all([
        prisma.financial_ledger_incidents.count(),
        prisma.driver_cash_historical_reconciliations.count(),
        prisma.driver_cash_historical_reconciliation_decisions.count(),
      ]),
    };
  });

  afterEach(async () => {
    process.env[HISTORICAL_RECONCILIATION_WRITES_ENV] = "true";
    await cleanupGapFixtures();
  });

  after(async () => {
    if (savedFlag === undefined) delete process.env[HISTORICAL_RECONCILIATION_WRITES_ENV];
    else process.env[HISTORICAL_RECONCILIATION_WRITES_ENV] = savedFlag;
    await cleanupReconciliationFixtures();
    for (const u of [finance2, dispatcher, customer]) await cleanupTestUser(u.id);
    await prisma.$disconnect();
  });

  describe("proposal (ADMIN)", () => {
    test("1. a valid proposal derives all evidence on the server, is audited, and explains nothing yet", async () => {
      const fx = await createGapFixture();
      const before = await gateCounts();
      const p = await proposed(fx);
      const detail = (await get(`/${p.reconciliationId}`)).body.data;

      assert.equal(detail.status, "PROPOSED");
      assert.deepEqual([detail.contributes, detail.blocking, detail.evidenceValid], [false, false, true]);
      assert.match(detail.incident.incidentNumber, /^LI-\d{4}-\d{4}$/);
      assert.deepEqual(
        {
          amount: detail.evidence.amount,
          observedJump: detail.evidence.observedJump,
          predecessor: detail.evidence.predecessorTransactionId,
          missing: detail.evidence.missingTransactionId,
          order: detail.evidence.deletedOrderReference,
          expected: detail.evidence.expectedAmount,
          difference: detail.evidence.collectionDifference,
          settlement: detail.evidence.relatedSettlementId,
        },
        {
          amount: "110.00",
          observedJump: "110.00",
          predecessor: fx.predecessorId,
          missing: fx.missingTransactionId,
          order: fx.deletedOrderId,
          expected: "210.00",
          difference: "-100.00",
          settlement: fx.settlementId,
        }
      );
      assert.equal(detail.evidence.evidenceDigest, computeEvidenceDigest(evidenceFor(fx, detail.incident.id)));
      assert.deepEqual([detail.account.rawDiscrepancy, detail.account.approvedHistoricalAmount, detail.account.unexplainedResidual], ["110.00", "0.00", "110.00"]);
      assert.deepEqual(detail.ownership, { status: "UNRESOLVED", blocksActivation: true });
      assert.equal(detail.proposedBy.id, actors.proposer.id);

      const [audit] = await auditsOf(p.reconciliationId, "DRIVER_CASH_HISTORICAL_RECONCILIATION_PROPOSED");
      assert.equal(audit.actor_user_id, actors.proposer.id);
      assert.equal((audit.metadata as Record<string, unknown>).evidenceDigest, detail.evidence.evidenceDigest);
      assert.equal(await prisma.audit_logs.count({ where: { action: "LEDGER_INCIDENT_RECORDED", entity_id: p.incident.id } }), 1);
      const after = await gateCounts();
      assert.equal(after.g3, before.g3, "a proposal never affects G3");
      assert.equal(after.r1, before.r1, "a proposal never affects R1");
    });

    test("2. missing, non-difference or inconsistent audit evidence is refused", async () => {
      const fx = await createGapFixture();
      const inconsistent = await createGapFixture({ audit: { difference: "-90" } });
      const malformed = await createGapFixture({ audit: { actualAmount: "1.1e2" } });
      const other = await prisma.audit_logs.create({ data: { actor_user_id: actors.proposer.id, action: "ORDER_CREATED", entity_type: "ORDER", entity_id: randomUUID() } });
      try {
        for (const [res, label] of [
          [await propose(fx, { sourceAuditLogId: randomUUID() }), "missing audit"],
          [await propose(fx, { sourceAuditLogId: other.id }), "not a difference audit"],
          [await propose(inconsistent), "inconsistent amounts"],
          [await propose(malformed), "malformed amount"],
        ] as const) {
          assert.equal(res.status, 409, label);
          assert.equal(res.body.error.details.reason, "RECONCILIATION_EVIDENCE_INVALID", label);
        }
      } finally {
        await prisma.audit_logs.delete({ where: { id: other.id } });
      }
      assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: { in: [fx.driverId, inconsistent.driverId, malformed.driverId] } } }), 0);
    });

    test("3. an audit amount that differs from the located gap is refused (JUMP_MISMATCH)", async () => {
      const fx = await createGapFixture({ audit: { actualAmount: "111", expectedAmount: "211" } });
      const res = await propose(fx);
      assert.equal(res.status, 409);
      assert.deepEqual(res.body.error.details.failures, ["JUMP_MISMATCH"]);
      assert.deepEqual([res.body.error.details.observedJump, res.body.error.details.auditActualAmount], ["110.00", "111.00"]);
    });

    test("4. missing anchor, an anchor without a gap, and an anchor at a shared timestamp are refused", async () => {
      const fx = await createGapFixture();
      assert.deepEqual((await propose(fx, { anchorTransactionId: randomUUID() })).body.error.details.failures, ["ANCHOR_NOT_FOUND"]);
      assert.equal((await propose(fx, { anchorTransactionId: fx.spareTransactionId })).status, 409, "no positive gap before the spare row");
      await prisma.driver_cash_transactions.create({
        data: { account_id: fx.accountId, driver_id: fx.driverId, type: "COLLECTION", amount: "1", balance_before: "0", balance_after: "1", created_at: fx.anchorAt },
      });
      assert.deepEqual((await propose(fx)).body.error.details.failures, ["ORDERING_AMBIGUOUS"]);
    });

    test("5. the client cannot supply amounts or ownership; a foreign settlement or an existing order is refused", async () => {
      const fx = await createGapFixture();
      const other = await createGapFixture();
      for (const extra of [{ amount: "110.00" }, { ownershipStatus: "RESOLVED" }, { driverId: fx.driverId }, { evidenceDigest: "0".repeat(64) }]) {
        const res = await propose(fx, extra);
        assert.equal(res.status, 400, JSON.stringify(extra));
      }
      assert.equal((await propose(fx, { relatedSettlementId: other.settlementId })).status, 409);

      // The audit names an order that exists: V6 (DELETED_ORDER_PRESENT).
      const order = await prisma.orders.findFirstOrThrow({ select: { id: true } });
      await prisma.audit_logs.update({ where: { id: fx.auditId }, data: { entity_id: order.id } });
      const res = await propose(fx);
      assert.equal(res.status, 409);
      assert.ok(res.body.error.details.failures.includes("DELETED_ORDER_PRESENT"), JSON.stringify(res.body));
    });

    test("6. duplicate proposals for one gap: refused sequentially and exactly one wins concurrently", async () => {
      const fx = await createGapFixture();
      const [a, b] = await Promise.all([propose(fx), propose(fx)]);
      assert.deepEqual([a.status, b.status].sort(), [201, 409]);
      const loser = a.status === 409 ? a : b;
      assert.ok(["RECONCILIATION_ALREADY_PROPOSED", "RECONCILIATION_CONFLICT"].includes(loser.body.error.details.reason));
      const again = await propose(fx);
      assert.equal(again.status, 409);
      assert.equal(again.body.error.details.reason, "RECONCILIATION_ALREADY_PROPOSED");
      assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: fx.driverId } }), 1);
    });
  });

  describe("approval (FINANCE, independent)", () => {
    test("7 + 22. a valid independent approval explains the gap in G3 / R1 and is audited", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      const before = await gateCounts();
      const res = await approve(p.reconciliationId, p.evidence.evidenceDigest);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.data.status, res.body.data.contributes], ["APPROVED", true]);
      assert.deepEqual([res.body.data.account.approvedHistoricalAmount, res.body.data.account.unexplainedResidual], ["110.00", "0.00"]);
      const after = await gateCounts();
      assert.equal(after.g3, before.g3 - 1);
      assert.equal(after.r1, before.r1 - 1);

      const [decision] = await decisionsOf(p.reconciliationId);
      const [audit] = await auditsOf(p.reconciliationId, "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED");
      const m = audit.metadata as Record<string, any>;
      assert.equal(audit.actor_user_id, actors.reviewer.id);
      assert.equal(m.decisionId, decision.id);
      assert.equal(m.evidenceDigest, p.evidence.evidenceDigest);
      assert.deepEqual([m.accountBefore.unexplainedResidual, m.accountAfter.unexplainedResidual, m.ownershipStatus], ["110.00", "0.00", "UNRESOLVED"]);
    });

    test("8-9. Admin cannot approve (no fallback); a proposer can never approve their own proposal", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      for (const token of [tokens.proposer, tokens.admin2, tokens.dispatcher, tokens.customer]) {
        assert.equal((await approve(p.reconciliationId, p.evidence.evidenceDigest, token)).status, 403);
      }
      // Defense in depth below the role gate: same person, FINANCE role.
      await assert.rejects(
        approveHistoricalReconciliation(p.reconciliationId, { evidenceDigest: p.evidence.evidenceDigest }, { userId: actors.proposer.id, roleCode: "FINANCE" }, randomUUID()),
        (e: any) => e.details?.reason === "REVIEWER_NOT_INDEPENDENT"
      );
      assert.equal((await decisionsOf(p.reconciliationId)).length, 0);
    });

    test("10. a stale or wrong fingerprint is refused", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      const res = await approve(p.reconciliationId, "f".repeat(64));
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "STALE_EVIDENCE_DIGEST");
      assert.equal((await approve(p.reconciliationId, "NOT-HEX")).status, 400);
      assert.equal((await decisionsOf(p.reconciliationId)).length, 0);
    });

    test("11. approval after the evidence became invalid is refused and writes nothing", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await cashTransaction(fx, { id: fx.missingTransactionId, type: "COLLECTION", amount: "110", before: "50", after: "160", at: fx.evidenceAt });
      const res = await approve(p.reconciliationId, p.evidence.evidenceDigest);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "RECONCILIATION_EVIDENCE_INVALID");
      assert.ok(res.body.error.details.failures.includes("MISSING_TRANSACTION_PRESENT"));
      assert.equal((await decisionsOf(p.reconciliationId)).length, 0);
      assert.equal((await auditsOf(p.reconciliationId, "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED")).length, 0);
    });
  });

  describe("rejection, withdrawal, revocation", () => {
    test("12. Finance rejects (independent, reasoned); a rejected proposal can no longer be approved", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      assert.equal((await post(`/${p.reconciliationId}/reject`, tokens.finance, { reason: "short" })).status, 400);
      assert.equal((await post(`/${p.reconciliationId}/reject`, tokens.proposer, { reason })).status, 403);
      const res = await post(`/${p.reconciliationId}/reject`, tokens.finance, { reason });
      assert.equal(res.status, 200);
      assert.deepEqual([res.body.data.status, res.body.data.contributes], ["REJECTED", false]);
      assert.equal((await approve(p.reconciliationId, p.evidence.evidenceDigest)).body.error.details.reason, "RECONCILIATION_NOT_PENDING");
      assert.equal((await auditsOf(p.reconciliationId, "DRIVER_CASH_HISTORICAL_RECONCILIATION_REJECTED")).length, 1);
    });

    test("13. an Admin withdraws; the same gap can then be re-proposed, superseding the withdrawn record", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      assert.equal((await post(`/${p.reconciliationId}/withdraw`, tokens.finance, { reason })).status, 403, "Finance cannot withdraw");
      const res = await post(`/${p.reconciliationId}/withdraw`, tokens.admin2, { reason });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "WITHDRAWN");
      const again = await proposed(fx);
      const detail = (await get(`/${again.reconciliationId}`)).body.data;
      assert.equal(detail.supersedesReconciliationId, p.reconciliationId);
      assert.equal(detail.status, "PROPOSED");
    });

    test("14 + 23. revocation appends REVOKED, keeps the history, and makes the gap unexplained again", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await approve(p.reconciliationId, p.evidence.evidenceDigest);
      const explained = await gateCounts();
      const res = await post(`/${p.reconciliationId}/revoke`, tokens.admin2, { reason });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const d = res.body.data;
      assert.deepEqual([d.status, d.contributes], ["REVOKED", false]);
      assert.deepEqual(
        d.decisions.map((x: { decision: string }) => x.decision),
        ["APPROVED", "REVOKED"]
      );
      assert.equal(d.decisions[1].revokesDecisionId, d.decisions[0].id);
      assert.deepEqual([d.account.rawDiscrepancy, d.account.approvedHistoricalAmount, d.account.unexplainedResidual], ["110.00", "0.00", "110.00"]);
      const after = await gateCounts();
      assert.equal(after.g3, explained.g3 + 1);
      assert.equal(after.r1, explained.r1 + 1);
      assert.equal((await auditsOf(p.reconciliationId, "DRIVER_CASH_HISTORICAL_RECONCILIATION_REVOKED")).length, 1);
    });

    test("15. revocation by the proposer, the approver or a non-Admin, or of a non-approved record, is refused", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      assert.equal((await post(`/${p.reconciliationId}/revoke`, tokens.admin2, { reason })).body.error.details.reason, "RECONCILIATION_NOT_APPROVED");
      await approve(p.reconciliationId, p.evidence.evidenceDigest);
      const byProposer = await post(`/${p.reconciliationId}/revoke`, tokens.proposer, { reason });
      assert.equal(byProposer.status, 403);
      assert.equal(byProposer.body.error.details.reason, "REVOKER_NOT_INDEPENDENT");
      assert.equal((await post(`/${p.reconciliationId}/revoke`, tokens.finance, { reason })).status, 403);
      await assert.rejects(
        revokeHistoricalReconciliation(p.reconciliationId, { reason }, { userId: actors.reviewer.id, roleCode: "ADMIN" }, randomUUID()),
        (e: any) => e.details?.reason === "REVOKER_NOT_INDEPENDENT"
      );
      assert.equal((await decisionsOf(p.reconciliationId)).length, 1);
    });
  });

  describe("concurrency and idempotency", () => {
    test("16. two Finance users approving at once: exactly one decision", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      const [a, b] = await Promise.all([
        approve(p.reconciliationId, p.evidence.evidenceDigest, tokens.finance),
        approve(p.reconciliationId, p.evidence.evidenceDigest, tokens.finance2),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      assert.equal((await decisionsOf(p.reconciliationId)).length, 1);
      assert.equal((await auditsOf(p.reconciliationId, "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED")).length, 1);
    });

    test("17. approval racing with withdrawal: one wins, the history stays consistent", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      const [a, w] = await Promise.all([
        approve(p.reconciliationId, p.evidence.evidenceDigest),
        post(`/${p.reconciliationId}/withdraw`, tokens.admin2, { reason }),
      ]);
      assert.deepEqual([a.status, w.status].sort(), [200, 409]);
      const decisions = await decisionsOf(p.reconciliationId);
      assert.equal(decisions.length, 1);
      const status = (await get(`/${p.reconciliationId}`)).body.data.status;
      assert.equal(status, a.status === 200 ? "APPROVED" : "WITHDRAWN");
    });

    test("approval racing with an evidence change never leaves a contributing invalid approval", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await Promise.all([
        approve(p.reconciliationId, p.evidence.evidenceDigest),
        cashTransaction(fx, { id: fx.missingTransactionId, type: "COLLECTION", amount: "110", before: "50", after: "160", at: fx.evidenceAt }),
      ]);
      const [e] = (await evaluateHistoricalReconciliations(prisma, { reconciliationIds: [p.reconciliationId] })).entries;
      assert.equal(e.contributes, false, "the restored row invalidates the evidence whichever committed first");
      if (e.status === "APPROVED") assert.equal(e.blocking, true, "an approval that landed first now blocks G3 / R1");
    });

    test("revocation racing with reads: every read sees one consistent state", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await approve(p.reconciliationId, p.evidence.evidenceDigest);
      const results = await Promise.all([
        post(`/${p.reconciliationId}/revoke`, tokens.admin2, { reason }),
        get(`/${p.reconciliationId}`),
        get(`/${p.reconciliationId}`),
        get("/summary"),
        get(`/${p.reconciliationId}`),
      ]);
      assert.equal(results[0].status, 200);
      for (const r of [results[1], results[2], results[4]]) {
        const d = r.body.data;
        const pair = [d.status, d.account.unexplainedResidual];
        assert.ok(JSON.stringify(pair) === JSON.stringify(["APPROVED", "0.00"]) || JSON.stringify(pair) === JSON.stringify(["REVOKED", "110.00"]), JSON.stringify(pair));
      }
    });

    test("18. retries with the same Idempotency-Key replay the original result exactly once", async () => {
      const fx = await createGapFixture();
      const key = randomUUID();
      const first = await propose(fx, {}, key);
      const second = await propose(fx, {}, key);
      assert.deepEqual([first.status, second.status], [201, 201]);
      assert.equal(second.body.data.reconciliationId, first.body.data.reconciliationId);
      assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: fx.driverId } }), 1);
      const id = first.body.data.reconciliationId;
      assert.equal((await auditsOf(id, "DRIVER_CASH_HISTORICAL_RECONCILIATION_PROPOSED")).length, 1);

      const digest = first.body.data.evidence.evidenceDigest;
      const decisionKey = randomUUID();
      const [x, y] = await Promise.all([approve(id, digest, tokens.finance, decisionKey), approve(id, digest, tokens.finance, decisionKey)]);
      assert.deepEqual([x.status, y.status], [200, 200]);
      assert.equal((await decisionsOf(id)).length, 1);
      assert.equal((await auditsOf(id, "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED")).length, 1);
    });

    test("19. reusing an Idempotency-Key for different content is refused", async () => {
      const fx = await createGapFixture();
      const other = await createGapFixture();
      const key = randomUUID();
      const p = await propose(fx, {}, key);
      assert.equal(p.status, 201);
      const reused = await propose(other, {}, key);
      assert.equal(reused.status, 409);
      assert.equal(reused.body.error.details.reason, "IDEMPOTENCY_KEY_REUSED");

      const id = p.body.data.reconciliationId;
      const decisionKey = randomUUID();
      assert.equal((await post(`/${id}/reject`, tokens.finance, { reason }, decisionKey)).status, 200);
      const changed = await post(`/${id}/reject`, tokens.finance, { reason: `${reason} (changed)` }, decisionKey);
      assert.equal(changed.status, 409);
      assert.equal(changed.body.error.details.reason, "IDEMPOTENCY_KEY_REUSED");
    });
  });

  describe("integrity", () => {
    test("20. the decision and its audit are atomic: a failing audit leaves no decision", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await prisma.$executeRawUnsafe(
        "ALTER TABLE audit_logs ADD CONSTRAINT fr12a5_block_approval_audit CHECK (action <> 'DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED') NOT VALID"
      );
      try {
        const res = await approve(p.reconciliationId, p.evidence.evidenceDigest);
        assert.equal(res.status, 500);
      } finally {
        await prisma.$executeRawUnsafe("ALTER TABLE audit_logs DROP CONSTRAINT fr12a5_block_approval_audit");
      }
      assert.equal((await decisionsOf(p.reconciliationId)).length, 0);
      assert.equal((await get(`/${p.reconciliationId}`)).body.data.status, "PROPOSED");
    });

    test("an approval without its workflow audit explains nothing (APPROVAL_AUDIT_MISSING)", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      const rec = await prisma.driver_cash_historical_reconciliations.findUniqueOrThrow({ where: { id: p.reconciliationId } });
      await decide(rec, "APPROVED", { audit: false });
      const d = (await get(`/${p.reconciliationId}`)).body.data;
      assert.deepEqual([d.status, d.contributes, d.blocking], ["APPROVED", false, true]);
      assert.deepEqual(d.failures, ["APPROVAL_AUDIT_MISSING"]);
    });

    test("21. an impossible decision history is surfaced and refuses every further decision", async () => {
      const fx = await createGapFixture();
      const other = await createGapFixture();
      const { rec } = await approvedReconciliation(fx);
      const { approval: otherApproval } = await approvedReconciliation(other);
      await prisma.$executeRawUnsafe("ALTER TABLE driver_cash_historical_reconciliation_decisions DROP CONSTRAINT dchrd_revokes_decision_fkey");
      let stray = "";
      try {
        stray = (await decide(rec, "REVOKED", { decidedById: actors.secondAdmin.id, revokesDecisionId: otherApproval.id })).id;
        const d = (await get(`/${rec.id}`)).body.data;
        assert.deepEqual([d.status, d.blocking, d.contributes], ["INVALID_HISTORY", true, false]);
        assert.ok(d.failures.includes("INVALID_DECISION_HISTORY"));
        assert.equal((await post(`/${rec.id}/revoke`, tokens.admin2, { reason })).body.error.details.reason, "RECONCILIATION_NOT_APPROVED");
        assert.equal((await post(`/${rec.id}/reject`, tokens.finance, { reason })).body.error.details.reason, "RECONCILIATION_NOT_PENDING");
      } finally {
        if (stray) await prisma.driver_cash_historical_reconciliation_decisions.delete({ where: { id: stray } });
        await prisma.$executeRawUnsafe(
          `ALTER TABLE driver_cash_historical_reconciliation_decisions ADD CONSTRAINT dchrd_revokes_decision_fkey
             FOREIGN KEY (revokes_decision_id, reconciliation_id, revokes_decision_type)
             REFERENCES driver_cash_historical_reconciliation_decisions(id, reconciliation_id, decision)
             ON DELETE RESTRICT ON UPDATE RESTRICT`
        );
      }
    });

    test("24. G5 keeps blocking after approval and after revocation — ownership is never resolved", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await approve(p.reconciliationId, p.evidence.evidenceDigest);
      for (const stage of ["approved", "revoked"]) {
        const { g5 } = await gateCounts();
        assert.equal(g5.passed, false, stage);
        assert.ok(g5.findings.some((f) => f.entityType === "DELETED_ORDER" && f.entityId === fx.deletedOrderId), stage);
        assert.deepEqual((await get(`/${p.reconciliationId}`)).body.data.ownership, { status: "UNRESOLVED", blocksActivation: true });
        if (stage === "approved") await post(`/${p.reconciliationId}/revoke`, tokens.admin2, { reason });
      }
    });

    test("25. the whole lifecycle posts nothing: wallets, revenue, settlements and driver cash unchanged", async () => {
      const fx = await createGapFixture();
      const before = await financialSnapshot();
      const p = await proposed(fx);
      await approve(p.reconciliationId, p.evidence.evidenceDigest);
      await post(`/${p.reconciliationId}/revoke`, tokens.admin2, { reason });
      assert.deepEqual(await financialSnapshot(), before);
      assert.equal(await prisma.orders.count({ where: { id: fx.deletedOrderId } }), 0, "no replacement order");
    });
  });

  describe("access and environment", () => {
    test("27. writes are refused unless the environment enables them; reads stay available", async () => {
      const fx = await createGapFixture();
      delete process.env[HISTORICAL_RECONCILIATION_WRITES_ENV];
      const res = await propose(fx);
      assert.equal(res.status, 403);
      assert.equal(res.body.error.details.reason, "HISTORICAL_RECONCILIATION_DISABLED");
      assert.equal((await get("/summary")).status, 200);
      assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: fx.driverId } }), 0);
    });

    test("reads are ADMIN / FINANCE only; Dispatcher and Customer are refused; writes need an Idempotency-Key", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      for (const path of ["/", "/summary", "/incidents", `/${p.reconciliationId}`, `/incidents/${p.incident.id}`]) {
        for (const token of [tokens.finance, tokens.proposer]) assert.equal((await get(path, token)).status, 200, path);
        for (const token of [tokens.dispatcher, tokens.customer]) assert.equal((await get(path, token)).status, 403, path);
        assert.equal((await request(app).get(`${BASE}${path}`)).status, 401, path);
      }
      const noKey = await request(app).post(`${BASE}/${p.reconciliationId}/reject`).set(auth(tokens.finance)).send({ reason });
      assert.equal(noKey.status, 400);
    });

    test("read APIs: list with filters and pagination, incidents, detail, summary", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      const list = await get(`/?driverId=${fx.driverId}&status=PROPOSED&limit=5`);
      assert.equal(list.status, 200);
      assert.deepEqual(list.body.data.map((x: { reconciliationId: string }) => x.reconciliationId), [p.reconciliationId]);
      assert.deepEqual(list.body.meta, { page: 1, limit: 5, total: 1, totalPages: 1 });
      assert.equal(list.body.data[0].incidentNumber.startsWith("LI-"), true);
      // FR.12A.6 additive read fields: driver identity and the account's figures.
      assert.equal(list.body.data[0].driver.id, fx.driverId);
      assert.match(list.body.data[0].driver.driverNumber, /\S/);
      assert.deepEqual(
        [list.body.data[0].account.rawDiscrepancy, list.body.data[0].account.approvedHistoricalAmount, list.body.data[0].account.unexplainedResidual],
        ["110.00", "0.00", "110.00"]
      );
      const ctx = (await get(`/${p.reconciliationId}`)).body.data.evidenceContext;
      assert.deepEqual(
        {
          predecessor: [ctx.predecessorTransaction.id, ctx.predecessorTransaction.balanceAfter],
          anchor: [ctx.anchorTransaction.id, ctx.anchorTransaction.balanceBefore, ctx.anchorTransaction.type],
          audit: [ctx.sourceAudit.id, ctx.sourceAudit.action, ctx.sourceAudit.entityId],
          settlement: [ctx.relatedSettlement.id, ctx.relatedSettlement.amountReceived],
        },
        {
          predecessor: [fx.predecessorId, "50.00"],
          anchor: [fx.anchorId, "160.00", "SETTLEMENT"],
          audit: [fx.auditId, "COLLECTION_DIFFERENCE_RECORDED", fx.deletedOrderId],
          settlement: [fx.settlementId, "160.00"],
        }
      );
      assert.equal((await get(`/?driverId=${fx.driverId}&status=APPROVED`)).body.meta.total, 0);
      const incident = (await get(`/incidents/${p.incident.id}`)).body.data;
      assert.equal(incident.reconciliationCount, 1);
      assert.equal(incident.reconciliations[0].reconciliationId, p.reconciliationId);
      const summary = (await get("/summary")).body.data;
      assert.ok(summary.accounts.some((a: { accountId: string; rawDiscrepancy: string }) => a.accountId === fx.accountId && a.rawDiscrepancy === "110.00"));
      assert.equal((await get(`/${randomUUID()}`)).status, 404);
    });

    test("26. no test data leaks", async () => {
      const fx = await createGapFixture();
      const p = await proposed(fx);
      await approve(p.reconciliationId, p.evidence.evidenceDigest);
      await cleanupGapFixtures();
      assert.deepEqual(
        await Promise.all([
          prisma.financial_ledger_incidents.count(),
          prisma.driver_cash_historical_reconciliations.count(),
          prisma.driver_cash_historical_reconciliation_decisions.count(),
        ]),
        baseline.tables
      );
    });
  });
});
