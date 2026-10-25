import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import request from "supertest";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { AppError } from "../../src/shared/errors/app-error";
import { getFinanceSummary } from "../../src/modules/finance/finance-summary.service";
import { runReconciliationChecks } from "../../src/modules/financial-release/financial-release-reconciliation.service";
import { evaluateHistoricalReconciliations } from "../../src/modules/historical-reconciliation/historical-reconciliation.service";
import {
  HISTORICAL_OWNERSHIP_WRITES_ENV,
  approveLiabilityPolicy,
  approveOwnershipResolution,
  proposeLiabilityPolicy,
  proposeOwnershipResolution,
  recordHistoricalLiability,
  rejectOwnershipResolution,
  reviewHistoricalLiability,
  revokeLiabilityPolicy,
  revokeOwnershipResolution,
  type WorkflowActor,
} from "../../src/modules/historical-ownership/historical-ownership-workflow.service";
import { evaluateResolutions, getHistoricalDispositions, getHistoricalLiabilitySnapshot } from "../../src/modules/historical-ownership/historical-ownership.service";
import { unresolvedHistoricalOwnershipSql } from "../../src/modules/historical-ownership/historical-ownership.sql";
import {
  cleanupHistoricalOwnershipRows,
  cleanupHistoricalReconciliationRows,
  cleanupLiabilityPolicies,
  cleanupTestUser,
  createTestUser,
  historicalOwnershipTablesPresent,
  loginTestUser,
  type TestUser,
} from "../helpers/fixtures";
import {
  actors,
  approvedReconciliation,
  cleanupReconciliationFixtures,
  createGapFixture,
  financialSnapshot,
  initReconciliationFixtures,
  inRolledBackTransaction,
  type GapFixture,
} from "../historical-reconciliation/reconciliation-fixtures";

// ============================================================
// FR.12A.9–11 — company-assumed historical liability: separation of duties,
// amounts, idempotency / concurrency, duplicate resolutions, policies,
// tampering, G5 and R14 — and no financial balance ever changes.
// Every row is created here on an isolated test database and removed after.
// ============================================================

type Db = Prisma.TransactionClient | typeof prisma;

const admin = (u: TestUser): WorkflowActor => ({ userId: u.id, roleCode: "ADMIN" });
const finance = (u: TestUser): WorkflowActor => ({ userId: u.id, roleCode: "FINANCE" });
const key = () => randomUUID();
const sha = () => randomBytes(32).toString("hex");

let recorder: TestUser;
let recorder2: TestUser;
const policyIds: string[] = [];
const gapFixtures: GapFixture[] = [];

async function rejects(promise: Promise<unknown>, status: number, reason?: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.statusCode, status, err.message);
    if (reason) assert.equal((err.details as { reason?: string } | undefined)?.reason, reason, err.message);
    return true;
  });
}

async function dbRejects(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    const e = err as { message?: string; meta?: unknown };
    assert.match(`${e.message ?? ""} ${JSON.stringify(e.meta ?? {})}`, pattern);
    return true;
  });
}

async function unresolvedRefs(db: Db = prisma): Promise<string[]> {
  const rows = await db.$queryRaw<{ order_ref: string }[]>(Prisma.raw(`SELECT u.order_ref FROM (${unresolvedHistoricalOwnershipSql(true, true)}) u`));
  return rows.map((r) => r.order_ref);
}

async function r14(db: Prisma.TransactionClient) {
  return (await runReconciliationChecks(db)).find((c) => c.id === "R14")!;
}

async function inReadSnapshot<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(fn, { timeout: 30_000 });
}

async function approvedPolicy(): Promise<{ id: string; digest: string }> {
  const id = await proposeLiabilityPolicy(
    {
      policyCode: `TEST_HL_${randomBytes(4).toString("hex").toUpperCase()}`,
      title: "Company-assumed historical liability (test)",
      summary: "Test policy: the full verified collected amount is held as a liability.",
      documentSha256: sha(),
      documentReference: "vault://finance/policies/test.pdf",
      reviewIntervalDays: 30,
      unclaimedFundsHandling: "Hold until a beneficiary is evidenced; no expiry is assumed.",
    },
    admin(actors.proposer),
    key()
  );
  policyIds.push(id);
  const row = await prisma.historical_liability_policies.findUniqueOrThrow({ where: { id } });
  await approveLiabilityPolicy(id, { policyDigest: row.policy_digest }, finance(actors.reviewer), key());
  return { id, digest: row.policy_digest };
}

interface Scenario {
  fx: GapFixture;
  reconciliationId: string;
  incidentId: string;
  policyId: string;
}

async function scenario(policyId?: string): Promise<Scenario> {
  const fx = await createGapFixture();
  gapFixtures.push(fx);
  const { rec } = await approvedReconciliation(fx);
  return { fx, reconciliationId: rec.id, incidentId: rec.incident_id, policyId: policyId ?? (await approvedPolicy()).id };
}

const proposalInput = (s: Scenario) => ({
  incidentId: s.incidentId,
  policyId: s.policyId,
  sourceAuditLogId: s.fx.auditId,
  ledgerReconciliationId: s.reconciliationId,
  evidence: [
    { kind: "INVESTIGATION_REPORT" as const, documentSha256: sha(), reference: "vault://incident/fr12a8.pdf", description: "FR.12A.8 evidence report" },
    { kind: "FINANCE_MEMO" as const, documentSha256: sha(), reference: "vault://finance/memo.pdf", description: "Finance acceptance memo" },
  ],
  rationale: "Finance assumes the unresolved historical obligation; the beneficiary cannot be identified from surviving records.",
});

async function proposed(s: Scenario) {
  const id = await proposeOwnershipResolution(proposalInput(s), admin(actors.proposer), key());
  const row = await prisma.historical_ownership_resolutions.findUniqueOrThrow({ where: { id } });
  return { id, digest: row.resolution_digest };
}

async function approved(s: Scenario) {
  const r = await proposed(s);
  await approveOwnershipResolution(r.id, { resolutionDigest: r.digest }, finance(actors.reviewer), key());
  return r;
}

async function recorded(s: Scenario) {
  const r = await approved(s);
  const { liabilityId } = await recordHistoricalLiability(r.id, { resolutionDigest: r.digest }, finance(recorder), key());
  return { ...r, liabilityId };
}

const evaluation = async (id: string, db: Db = prisma) => (await evaluateResolutions(db, { resolutionIds: [id] }))[0];

describe("FR.12A.9–11 company-assumed historical liability", () => {
  before(async () => {
    process.env[HISTORICAL_OWNERSHIP_WRITES_ENV] = "true";
    await initReconciliationFixtures();
    recorder = await createTestUser("FINANCE");
    recorder2 = await createTestUser("FINANCE");
  });

  after(async () => {
    delete process.env[HISTORICAL_OWNERSHIP_WRITES_ENV];
    for (const fx of gapFixtures) await cleanupHistoricalOwnershipRows({ source_audit_log_id: fx.auditId });
    await cleanupLiabilityPolicies(policyIds);
    await cleanupReconciliationFixtures();
    for (const u of [recorder, recorder2]) if (u) await cleanupTestUser(u.id);
  });

  test("1. propose -> approve -> record: G5 releases only once recorded; no balance changes; the ledger reconciliation is unchanged", async () => {
    const s = await scenario();
    const balancesBefore = await financialSnapshot();
    const snapshotBefore = await getHistoricalLiabilitySnapshot(prisma);
    assert.ok((await unresolvedRefs()).includes(s.fx.deletedOrderId), "unresolved before");

    const r = await proposed(s);
    assert.equal((await evaluation(r.id)).status, "PROPOSED");
    assert.ok((await unresolvedRefs()).includes(s.fx.deletedOrderId), "a proposal never clears G5");

    await approveOwnershipResolution(r.id, { resolutionDigest: r.digest }, finance(actors.reviewer), key());
    const afterApproval = await evaluation(r.id);
    assert.equal(afterApproval.status, "APPROVED");
    assert.deepEqual(afterApproval.failures, []);
    assert.equal(afterApproval.releasesG5, false);
    assert.ok((await unresolvedRefs()).includes(s.fx.deletedOrderId), "an approval alone never clears G5");

    const { liabilityId } = await recordHistoricalLiability(r.id, { resolutionDigest: r.digest }, finance(recorder), key());
    const liability = await prisma.historical_liabilities.findUniqueOrThrow({ where: { id: liabilityId } });
    assert.equal(liability.recognized_amount.toFixed(2), "110.00", "L1: the full verified collected amount");
    assert.equal(liability.held_collection_amount.toFixed(2), "110.00");
    assert.equal(liability.tracked_shortfall_amount.toFixed(2), "100.00", "L2: shortfall tracked, not recognized");

    const recordedEval = await evaluation(r.id);
    assert.deepEqual(recordedEval.failures, []);
    assert.equal(recordedEval.releasesG5, true);
    assert.equal((await unresolvedRefs()).includes(s.fx.deletedOrderId), false, "recorded liability releases this deleted order");
    assert.ok((await getHistoricalDispositions(prisma)).some((d) => d.liabilityId === liabilityId && d.outstandingAmount === "110.00"));

    // Nothing posted anywhere: every wallet, driver cash, payout, settlement,
    // company and release row is byte-identical.
    assert.deepEqual(await financialSnapshot(), balancesBefore);
    const snapshotAfter = await getHistoricalLiabilitySnapshot(prisma);
    assert.equal(new Prisma.Decimal(snapshotAfter.outstanding).minus(snapshotBefore.outstanding).toFixed(2), "110.00");
    assert.equal(new Prisma.Decimal(snapshotAfter.trackedShortfall).minus(snapshotBefore.trackedShortfall).toFixed(2), "100.00");

    // The approved ledger reconciliation is untouched and still valid.
    const { entries } = await evaluateHistoricalReconciliations(prisma, { reconciliationIds: [s.reconciliationId] });
    assert.equal(entries[0].status, "APPROVED");
    assert.deepEqual(entries[0].failures, []);
    assert.equal(entries[0].ownershipStatus, "UNRESOLVED");

    // Reported separately in the finance summary.
    const summary = await getFinanceSummary({ basis: "released" });
    assert.equal(summary.historicalLiabilities.outstanding, snapshotAfter.outstanding);
    // R14 passes for this liability.
    const check = await inReadSnapshot(r14);
    assert.equal(check.findings.some((f) => f.entityId === liabilityId), false);

    // L7: a periodic review is append-only and changes nothing financial.
    await reviewHistoricalLiability(liabilityId, { note: "Quarterly review: beneficiary still unidentified." }, finance(actors.reviewer), key());
    assert.deepEqual(await financialSnapshot(), balancesBefore);
  });

  test("2. separation of duties: roles, independent reviewer, recorder and revoker (service and database)", async () => {
    const s = await scenario();
    await rejects(proposeOwnershipResolution(proposalInput(s), finance(actors.reviewer), key()), 403);
    const r = await proposed(s);
    await rejects(approveOwnershipResolution(r.id, { resolutionDigest: r.digest }, admin(actors.secondAdmin), key()), 403);
    await rejects(approveOwnershipResolution(r.id, { resolutionDigest: "0".repeat(64) }, finance(actors.reviewer), key()), 409, "STALE_RESOLUTION_DIGEST");
    // DB: an approval by the proposer is impossible even bypassing the service.
    await dbRejects(
      prisma.historical_ownership_resolution_decisions.create({
        data: {
          resolution_id: r.id,
          decision: "APPROVED",
          is_terminal: false,
          proposed_by_id: actors.proposer.id,
          resolution_digest: r.digest,
          decided_by_id: actors.proposer.id,
          idempotency_key: key(),
        },
      }),
      /hord_independent_reviewer_chk/
    );
    await approveOwnershipResolution(r.id, { resolutionDigest: r.digest }, finance(actors.reviewer), key());
    // The approver cannot record (D8).
    await rejects(recordHistoricalLiability(r.id, { resolutionDigest: r.digest }, finance(actors.reviewer), key()), 403, "RECORDER_NOT_INDEPENDENT");
    await rejects(recordHistoricalLiability(r.id, { resolutionDigest: r.digest }, admin(actors.secondAdmin), key()), 403);
    const { liabilityId } = await recordHistoricalLiability(r.id, { resolutionDigest: r.digest }, finance(recorder), key());
    // DB: a liability recorded by its approver violates hl_independent_recorder_chk.
    const approval = await prisma.historical_ownership_resolution_decisions.findFirstOrThrow({ where: { resolution_id: r.id, decision: "APPROVED" } });
    await inRolledBackTransaction(async (tx) => {
      await tx.historical_liabilities.delete({ where: { id: liabilityId } });
      await dbRejects(
        tx.$executeRaw`INSERT INTO historical_liabilities (resolution_id, proposed_by_id, resolution_digest, approval_decision_id, approval_decision_type,
                         approved_by_id, held_collection_amount, tracked_shortfall_amount, recognized_amount, liability_digest, recorded_by_id, idempotency_key)
                       VALUES (${r.id}::uuid, ${actors.proposer.id}::uuid, ${r.digest}, ${approval.id}::uuid, 'APPROVED',
                               ${actors.reviewer.id}::uuid, 110, 100, 110, ${"0".repeat(64)}, ${actors.reviewer.id}::uuid, ${key()})`,
        /hl_independent_recorder_chk/
      );
    });
    // Revoker: never the proposer, approver or recorder.
    await rejects(revokeOwnershipResolution(r.id, { reason: "Revocation attempt by the proposer in this test." }, admin(actors.proposer), key()), 403, "REVOKER_NOT_INDEPENDENT");
    await rejects(revokeOwnershipResolution(r.id, { reason: "Revocation attempt by finance in this test case." }, finance(recorder2), key()), 403);
  });

  test("3. amounts are server-derived and pinned: L1 / L2 CHECKs, digest and FK binding", async () => {
    const s = await scenario();
    const { id, liabilityId } = await recorded(s);
    // Client payloads carry no amount (strict schema); the stored amounts are
    // bound by CHECK, digest and ON UPDATE RESTRICT FKs.
    await dbRejects(prisma.historical_ownership_resolutions.update({ where: { id }, data: { held_collection_amount: "50.00" } }), /hor_l1_full_collection_held_chk|hor_resolution_digest_chk/);
    await dbRejects(
      prisma.historical_ownership_resolutions.update({ where: { id }, data: { tracked_shortfall_amount: "0.00" } }),
      /hor_l2_shortfall_tracked_chk|hor_resolution_digest_chk/
    );
    await dbRejects(prisma.historical_liabilities.update({ where: { id: liabilityId }, data: { recognized_amount: "210.00" } }), /hl_recognized_equals_held_chk|hl_liability_digest_chk/);
    await dbRejects(
      prisma.historical_liabilities.update({ where: { id: liabilityId }, data: { held_collection_amount: "210.00", recognized_amount: "210.00" } }),
      /hl_resolution_binding_fkey|hl_liability_digest_chk|foreign key/i
    );
  });

  test("4. duplicates, idempotency and concurrency: one live resolution, one liability", async () => {
    const s = await scenario();
    const input = proposalInput(s);
    // Concurrent proposals for the same deleted order: exactly one wins.
    const results = await Promise.allSettled([
      proposeOwnershipResolution(input, admin(actors.proposer), key()),
      proposeOwnershipResolution(input, admin(actors.secondAdmin), key()),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const id = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<string>).value;
    await rejects(proposeOwnershipResolution(input, admin(actors.proposer), key()), 409, "RESOLUTION_ALREADY_PROPOSED");
    // Replay with the same key returns the same record; a different body is refused.
    const k = key();
    const s2 = await scenario(s.policyId);
    // One request object (proposalInput mints fresh evidence fingerprints per call).
    const input2 = proposalInput(s2);
    const first = await proposeOwnershipResolution(input2, admin(actors.proposer), k);
    assert.equal(await proposeOwnershipResolution(input2, admin(actors.proposer), k), first);
    await rejects(proposeOwnershipResolution({ ...input2, rationale: `${input2.rationale} (edited)` }, admin(actors.proposer), k), 409, "IDEMPOTENCY_KEY_REUSED");

    const row = await prisma.historical_ownership_resolutions.findUniqueOrThrow({ where: { id } });
    await approveOwnershipResolution(id, { resolutionDigest: row.resolution_digest }, finance(actors.reviewer), key());
    // Concurrent recording by two independent Finance users: exactly one liability.
    const recs = await Promise.allSettled([
      recordHistoricalLiability(id, { resolutionDigest: row.resolution_digest }, finance(recorder), key()),
      recordHistoricalLiability(id, { resolutionDigest: row.resolution_digest }, finance(recorder2), key()),
    ]);
    assert.equal(recs.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(await prisma.historical_liabilities.count({ where: { resolution_id: id } }), 1);
    const rk = key();
    const winner = recs.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ liabilityId: string }>;
    await rejects(recordHistoricalLiability(id, { resolutionDigest: row.resolution_digest }, finance(recorder2), rk), 409);
    assert.ok(winner.value.liabilityId);
  });

  test("5. invalid or revoked policies: no proposal without an approved policy; revoking the policy re-blocks G5 and fails R14", async () => {
    const unapproved = await proposeLiabilityPolicy(
      {
        policyCode: `TEST_HL_${randomBytes(4).toString("hex").toUpperCase()}`,
        title: "Unapproved historical liability policy",
        summary: "This version is never approved in this test.",
        documentSha256: sha(),
        documentReference: "vault://finance/policies/draft.pdf",
        unclaimedFundsHandling: "Hold until a beneficiary is evidenced; no expiry is assumed.",
      },
      admin(actors.proposer),
      key()
    );
    policyIds.push(unapproved);
    const s = await scenario(unapproved);
    await rejects(proposeOwnershipResolution(proposalInput(s), admin(actors.proposer), key()), 409, "POLICY_NOT_APPROVED");

    const policy = await approvedPolicy();
    const s2 = await scenario(policy.id);
    const { id, liabilityId } = await recorded(s2);
    assert.equal((await unresolvedRefs()).includes(s2.fx.deletedOrderId), false);
    // The policy approver / proposer cannot revoke it.
    await rejects(revokeLiabilityPolicy(policy.id, { reason: "Revocation attempt by the proposer in this test." }, admin(actors.proposer), key()), 403, "REVOKER_NOT_INDEPENDENT");
    await revokeLiabilityPolicy(policy.id, { reason: "Policy withdrawn by Finance governance in this test." }, admin(actors.secondAdmin), key());
    const e = await evaluation(id);
    assert.ok(e.failures.includes("POLICY_NOT_APPROVED"));
    assert.equal(e.releasesG5, false);
    assert.ok((await unresolvedRefs()).includes(s2.fx.deletedOrderId), "G5 blocks again");
    assert.ok((await inReadSnapshot(r14)).findings.some((f) => f.entityId === liabilityId), "R14 reports the liability");
  });

  test("6. tampered entries re-block G5 and fail R14 (each in a rolled-back transaction)", async () => {
    const s = await scenario();
    const { id, liabilityId } = await recorded(s);
    const cases: [string, (tx: Prisma.TransactionClient) => Promise<unknown>][] = [
      ["LIABILITY_AUDIT_MISSING", (tx) => tx.audit_logs.deleteMany({ where: { entity_type: "HISTORICAL_LIABILITY", entity_id: liabilityId, action: "HISTORICAL_LIABILITY_RECORDED" } })],
      ["EVIDENCE_MANIFEST_MISMATCH", (tx) => tx.historical_ownership_resolution_evidence.updateMany({ where: { resolution_id: id, ordinal: 1 }, data: { description: "Altered description" } })],
      ["RATIONALE_DIGEST_MISMATCH", (tx) => tx.historical_ownership_resolutions.update({ where: { id }, data: { rationale: "A different rationale that is long enough to pass the length CHECK constraint." } })],
      ["APPROVAL_AUDIT_MISSING", (tx) => tx.audit_logs.deleteMany({ where: { entity_type: "HISTORICAL_OWNERSHIP_RESOLUTION", entity_id: id, action: "HISTORICAL_OWNERSHIP_RESOLUTION_APPROVED" } })],
      [
        "UNEXPECTED_LEDGER_POSTING",
        (tx) =>
          tx.$executeRaw`INSERT INTO company_financial_transactions (type, amount, idempotency_key, notes)
                         VALUES ('ADJUSTMENT', 110, ${`historical-liability:${liabilityId}:tamper`}, 'tamper test')`,
      ],
      [
        "COLLECTION_NOT_VERIFIED",
        (tx) =>
          tx.audit_logs.deleteMany({
            where: { entity_type: "DRIVER_CASH_HISTORICAL_RECONCILIATION", entity_id: s.reconciliationId, action: "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED" },
          }),
      ],
      // Review M2: the anchor settlement no longer hands over the whole balance.
      ["SETTLEMENT_INCLUSION_NOT_ESTABLISHED", (tx) => tx.driver_cash_transactions.update({ where: { id: s.fx.anchorId }, data: { balance_after: "5.00" } })],
    ];
    for (const [failure, tamper] of cases) {
      await inRolledBackTransaction(async (tx) => {
        await tamper(tx);
        const e = await evaluation(id, tx);
        assert.ok(e.failures.includes(failure), `${failure}: got ${e.failures.join(", ")}`);
        assert.equal(e.releasesG5, false, failure);
        assert.ok((await unresolvedRefs(tx)).includes(s.fx.deletedOrderId), `${failure}: G5 blocks`);
        const check = await r14(tx);
        assert.equal(check.status, "FAIL", failure);
      });
    }
    // Untampered again after every rollback.
    assert.deepEqual((await evaluation(id)).failures, []);
  });

  test("7. revoking a recorded resolution re-blocks G5 and removes it from the outstanding amount (no reversal needed: nothing was posted)", async () => {
    const s = await scenario();
    const { id, liabilityId } = await recorded(s);
    const before = await getHistoricalLiabilitySnapshot(prisma);
    const balances = await financialSnapshot();
    await rejects(revokeOwnershipResolution(id, { reason: "Revocation attempt by the recorder in this test." }, admin(actors.proposer), key()), 403, "REVOKER_NOT_INDEPENDENT");
    await revokeOwnershipResolution(id, { reason: "New evidence identified the beneficiary in this test." }, admin(actors.secondAdmin), key());
    const e = await evaluation(id);
    assert.equal(e.status, "REVOKED");
    assert.ok((await unresolvedRefs()).includes(s.fx.deletedOrderId));
    const afterSnap = await getHistoricalLiabilitySnapshot(prisma);
    assert.equal(new Prisma.Decimal(before.outstanding).minus(afterSnap.outstanding).toFixed(2), "110.00");
    assert.equal((await inReadSnapshot(r14)).findings.some((f) => f.entityId === liabilityId), false, "a revoked liability is not an R14 violation");
    assert.deepEqual(await financialSnapshot(), balances);
    // The register row stays (append-only history).
    assert.equal(await prisma.historical_liabilities.count({ where: { id: liabilityId } }), 1);
    // A rejected re-proposal path: a new resolution can supersede the revoked one.
    const next = await proposed(s);
    await rejectOwnershipResolution(next.id, { reason: "Rejected for a documented reason in this test." }, finance(actors.reviewer), key());
  });

  test("8. writes are disabled unless the flag is set", async () => {
    const s = await scenario();
    delete process.env[HISTORICAL_OWNERSHIP_WRITES_ENV];
    try {
      await rejects(proposeOwnershipResolution(proposalInput(s), admin(actors.proposer), key()), 403, "HISTORICAL_OWNERSHIP_DISABLED");
    } finally {
      process.env[HISTORICAL_OWNERSHIP_WRITES_ENV] = "true";
    }
  });
  test("9. HTTP: role gates, Idempotency-Key, strict bodies (never an amount from the client)", async () => {
    const app = createApp();
    const BASE = "/api/v1/finance/historical-ownership";
    const dispatcher = await createTestUser("DISPATCHER");
    try {
      const token = async (u: TestUser) => (await loginTestUser(app, u.email, u.password)).accessToken as string;
      const [fin, adm, disp] = [await token(actors.reviewer), await token(actors.proposer), await token(dispatcher)];
      const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
      assert.equal((await request(app).get(`${BASE}/summary`)).status, 401);
      assert.equal((await request(app).get(`${BASE}/summary`).set(auth(disp))).status, 403, "DISPATCHER never reads");
      const summary = await request(app).get(`${BASE}/summary`).set(auth(fin));
      assert.equal(summary.status, 200);
      assert.equal(summary.body.data.writesEnabled, true);
      assert.equal((await request(app).get(`${BASE}/resolutions`).set(auth(adm))).status, 200);
      const s = await scenario();
      const body = proposalInput(s);
      assert.equal((await request(app).post(`${BASE}/resolutions`).set(auth(adm)).send(body)).status, 400, "Idempotency-Key required");
      assert.equal((await request(app).post(`${BASE}/resolutions`).set(auth(fin)).set("Idempotency-Key", key()).send(body)).status, 403, "FINANCE cannot propose");
      const withAmount = await request(app).post(`${BASE}/resolutions`).set(auth(adm)).set("Idempotency-Key", key()).send({ ...body, collectedAmount: "1.00" });
      // Review M2: the surviving-collection-row route no longer exists.
      const { ledgerReconciliationId: _omit, ...withoutLedger } = body;
      void _omit;
      const rowOnly = await request(app)
        .post(`${BASE}/resolutions`)
        .set(auth(adm))
        .set("Idempotency-Key", key())
        .send({ ...withoutLedger, collectionTransactionId: s.fx.anchorId });
      assert.equal(rowOnly.status, 400, "a proposal without an approved ledger reconciliation is refused");
      assert.equal(withAmount.status, 400, "a client amount is rejected by the strict schema");
      const created = await request(app).post(`${BASE}/resolutions`).set(auth(adm)).set("Idempotency-Key", key()).send(body);
      assert.equal(created.status, 201);
      assert.equal(created.body.data.heldCollectionAmount, "110.00");
      assert.equal(created.body.data.trackedShortfallAmount, "100.00");
      assert.equal(created.body.data.releasesG5, false);
      const approveByAdmin = await request(app)
        .post(`${BASE}/resolutions/${created.body.data.id}/approve`)
        .set(auth(adm))
        .set("Idempotency-Key", key())
        .send({ resolutionDigest: created.body.data.resolutionDigest });
      assert.equal(approveByAdmin.status, 403, "ADMIN cannot approve");
    } finally {
      await cleanupTestUser(dispatcher.id);
    }
  });

  test("10. M2: a reconciliation that does not establish a full settlement handover cannot be proposed", async () => {
    const s = await scenario();
    // The settlement after the gap left a balance: inclusion of the collection is not established.
    await prisma.driver_cash_transactions.update({ where: { id: s.fx.anchorId }, data: { balance_after: "5.00" } });
    await assert.rejects(proposeOwnershipResolution(proposalInput(s), admin(actors.proposer), key()), (err: unknown) => {
      assert.ok(err instanceof AppError);
      assert.equal(err.statusCode, 409);
      assert.ok(((err.details as { failures?: string[] }).failures ?? []).includes("SETTLEMENT_INCLUSION_NOT_ESTABLISHED"));
      return true;
    });
    assert.equal(await prisma.historical_ownership_resolutions.count({ where: { source_audit_log_id: s.fx.auditId } }), 0);
  });

  test("11. L1: a reused key with different content is refused; the identical request replays", async () => {
    const policyInput = {
      policyCode: `TEST_HL_${randomBytes(4).toString("hex").toUpperCase()}`,
      title: "Replay policy for the idempotency test",
      summary: "Policy proposed twice with the same key in this test.",
      documentSha256: sha(),
      documentReference: "vault://finance/policies/replay.pdf",
      reviewIntervalDays: 30,
      unclaimedFundsHandling: "Hold until a beneficiary is evidenced; no expiry is assumed.",
    };
    const pk = key();
    const policyId = await proposeLiabilityPolicy(policyInput, admin(actors.proposer), pk);
    policyIds.push(policyId);
    assert.equal(await proposeLiabilityPolicy({ ...policyInput }, admin(actors.proposer), pk), policyId, "identical replay");
    for (const changed of [
      { documentReference: "vault://finance/policies/other.pdf" },
      { reviewIntervalDays: 60 },
      { unclaimedReviewAfterDays: 365 },
      { unclaimedFundsHandling: "A different unclaimed-funds handling description." },
    ]) {
      await rejects(proposeLiabilityPolicy({ ...policyInput, ...changed }, admin(actors.proposer), pk), 409, "IDEMPOTENCY_KEY_REUSED");
    }

    const sc = await scenario();
    const input = proposalInput(sc);
    const rk = key();
    const id = await proposeOwnershipResolution(input, admin(actors.proposer), rk);
    const identical = { ...input, evidence: input.evidence.map((e) => ({ ...e })) };
    assert.equal(await proposeOwnershipResolution(identical, admin(actors.proposer), rk), id, "identical replay");
    const alter = (i: number, patch: Partial<(typeof input.evidence)[number]>) => ({
      ...input,
      evidence: input.evidence.map((e, j) => (j === i ? { ...e, ...patch } : e)),
    });
    for (const changed of [
      alter(0, { reference: "vault://incident/other.pdf" }),
      alter(1, { description: "A different evidence description" }),
      alter(0, { kind: "FINANCE_MEMO" as const }),
      alter(1, { documentSha256: sha() }),
      { ...input, evidence: [...input.evidence].reverse() },
    ]) {
      await rejects(proposeOwnershipResolution(changed, admin(actors.proposer), rk), 409, "IDEMPOTENCY_KEY_REUSED");
    }
    assert.equal(await prisma.historical_ownership_resolutions.count({ where: { source_audit_log_id: sc.fx.auditId } }), 1);
  });

  test("12. L2: a revocation decided by the recorder is detected by R14", async () => {
    const s = await scenario();
    const { id, liabilityId } = await recorded(s);
    const approval = await prisma.historical_ownership_resolution_decisions.findFirstOrThrow({ where: { resolution_id: id, decision: "APPROVED" } });
    const row = await prisma.historical_ownership_resolutions.findUniqueOrThrow({ where: { id } });
    await inRolledBackTransaction(async (tx) => {
      // The database allows it (the recorder is neither proposer nor approver) ...
      await tx.historical_ownership_resolution_decisions.create({
        data: {
          resolution_id: id,
          decision: "REVOKED",
          is_terminal: true,
          proposed_by_id: row.proposed_by_id,
          resolution_digest: row.resolution_digest,
          revokes_decision_id: approval.id,
          revokes_decision_type: "APPROVED",
          revoked_approver_id: approval.decided_by_id,
          decided_by_id: recorder.id,
          reason: "Revocation by the recorder, bypassing the service, in this test.",
          idempotency_key: key(),
        },
      });
      // ... but R14 reports it, and G5 stays blocked (a revocation never releases anything).
      const check = await r14(tx);
      assert.equal(check.status, "FAIL");
      assert.ok(check.findings.some((f) => f.entityId === liabilityId && /recorded its liability/.test(f.detail)));
      assert.ok((await unresolvedRefs(tx)).includes(s.fx.deletedOrderId));
    });
  });

  test("13. M1: fixture cleanup works without the ownership tables and never masks other errors", async () => {
    const s = await scenario();
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE historical_ownership_resolutions RENAME TO historical_ownership_resolutions_hidden_m1");
      assert.equal(await historicalOwnershipTablesPresent(tx), false);
      await cleanupHistoricalReconciliationRows({ driverId: s.fx.driverId }, tx);
      assert.equal(await tx.driver_cash_historical_reconciliations.count({ where: { driver_id: s.fx.driverId } }), 0);
    });
    await inRolledBackTransaction(async (tx) => {
      await tx.$executeRawUnsafe("ALTER TABLE driver_cash_historical_reconciliations RENAME TO dchr_hidden_m1");
      await assert.rejects(cleanupHistoricalReconciliationRows({ driverId: s.fx.driverId }, tx), "an unrelated missing table still fails");
    });
    assert.equal(await historicalOwnershipTablesPresent(), true);
    assert.equal(await prisma.driver_cash_historical_reconciliations.count({ where: { driver_id: s.fx.driverId } }), 1, "rolled back");
  });
});
