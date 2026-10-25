import "../helpers/setup";
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Prisma } from "../../src/generated/prisma/client";
import {
  buildEvidenceCanonicalString,
  calculateObservedJump,
  calculateRawDiscrepancy,
  calculateUnexplainedResidual,
  computeEvidenceDigest,
  deriveHistoricalReconciliationStatus,
  isLiveHistoricalReconciliationStatus,
  isUnresolvedHistoricalOwnership,
  reconcileDriverCashAccount,
} from "../../src/modules/historical-reconciliation/historical-reconciliation.calculation";
import type {
  HistoricalReconciliationContribution,
  HistoricalReconciliationDecisionRecord,
  HistoricalReconciliationEvidence,
  HistoricalReconciliationEvaluatedStatus,
} from "../../src/modules/historical-reconciliation/historical-reconciliation.types";

// ============================================================
// FR.12A.3 — Historical reconciliation pure helpers (no database)
// Design: docs/fr12a2-historical-ledger-reconciliation-design.md §7
// ============================================================

const d = (v: string) => new Prisma.Decimal(v);
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const VALID = { valid: true } as const;
const INVALID = { valid: false, failures: ["MISSING_TRANSACTION_PRESENT"] } as const;

function contribution(
  id: string,
  status: HistoricalReconciliationEvaluatedStatus,
  amount: string,
  evidenceValidity: HistoricalReconciliationContribution["evidenceValidity"] = VALID
): HistoricalReconciliationContribution {
  return { reconciliationId: id, accountId: ACCOUNT, status, amount: d(amount), evidenceValidity };
}

function evidence(overrides: Partial<HistoricalReconciliationEvidence> = {}): HistoricalReconciliationEvidence {
  return {
    incidentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    accountId: ACCOUNT,
    driverId: "22222222-2222-4222-8222-222222222222",
    kind: "MISSING_COLLECTION",
    accountingTreatment: "EVIDENCE_ONLY_NO_CASH_EFFECT",
    amount: d("110.00"),
    observedJump: d("110.00"),
    predecessorTransactionId: "33333333-3333-4333-8333-333333333333",
    anchorTransactionId: "44444444-4444-4444-8444-444444444444",
    missingTransactionId: "55555555-5555-4555-8555-555555555555",
    sourceAuditLogId: "66666666-6666-4666-8666-666666666666",
    deletedOrderReference: "77777777-7777-4777-8777-777777777777",
    orderType: "DELIVERY_ONLY",
    expectedAmount: d("210.00"),
    actualAmount: d("110.00"),
    collectionDifference: d("-100.00"),
    relatedSettlementId: "88888888-8888-4888-8888-888888888888",
    ...overrides,
  };
}

describe("Historical reconciliation calculation (FR.12A.3)", () => {
  describe("raw discrepancy and residual", () => {
    test("D = S − N and R = D − A, exactly", () => {
      assert.equal(calculateRawDiscrepancy(d("0.00"), d("-110.00")).toFixed(2), "110.00");
      assert.equal(calculateUnexplainedResidual(d("110.00"), d("110.00")).toFixed(2), "0.00");
      assert.equal(calculateUnexplainedResidual(d("110.00"), d("0")).toFixed(2), "110.00");
    });

    test("no floating point drift at the cent or at the column limit", () => {
      assert.equal(calculateRawDiscrepancy(d("0.30"), d("0.10")).minus(d("0.20")).isZero(), true);
      const big = calculateRawDiscrepancy(d("999999999999.99"), d("-0.01"));
      assert.equal(big.toFixed(2), "1000000000000.00");
      assert.equal(calculateUnexplainedResidual(big, d("0.01")).toFixed(2), "999999999999.99");
    });

    test("observed jump is anchor.balance_before − predecessor.balance_after (0 at the start)", () => {
      assert.equal(calculateObservedJump(d("50.00"), d("160.00")).toFixed(2), "110.00");
      assert.equal(calculateObservedJump(null, d("110.00")).toFixed(2), "110.00");
      assert.equal(calculateObservedJump(d("10.00"), d("10.00")).isZero(), true);
    });
  });

  describe("account reconciliation (D, A, R, X)", () => {
    test("without reconciliations A = 0 and R = D (backward compatible)", () => {
      const r = reconcileDriverCashAccount({ accountId: ACCOUNT, storedBalance: d("0"), rawLedgerNet: d("-110"), reconciliations: [] });
      assert.equal(r.rawDiscrepancy.toFixed(2), "110.00");
      assert.equal(r.approvedHistoricalAmount.toFixed(2), "0.00");
      assert.equal(r.unexplainedResidual.toFixed(2), "110.00");
      assert.deepEqual(r.invalidApprovedReconciliationIds, []);
    });

    test("production expectation: S 0.00, N −110.00 → D 110.00, A 110.00, R 0.00, X 0", () => {
      const r = reconcileDriverCashAccount({
        accountId: ACCOUNT,
        storedBalance: d("0.00"),
        rawLedgerNet: d("-110.00"),
        reconciliations: [contribution("r1", "APPROVED", "110.00")],
      });
      assert.equal(r.rawDiscrepancy.toFixed(2), "110.00");
      assert.equal(r.approvedHistoricalAmount.toFixed(2), "110.00");
      assert.equal(r.unexplainedResidual.toFixed(2), "0.00");
      assert.deepEqual(r.approvedValidReconciliationIds, ["r1"]);
      assert.deepEqual(r.invalidApprovedReconciliationIds, []);
    });

    test("only APPROVED records count — PROPOSED / REJECTED / WITHDRAWN / REVOKED never do", () => {
      for (const status of ["PROPOSED", "REJECTED", "WITHDRAWN", "REVOKED"] as const) {
        const r = reconcileDriverCashAccount({
          accountId: ACCOUNT,
          storedBalance: d("0"),
          rawLedgerNet: d("-110"),
          reconciliations: [contribution("r1", status, "110.00")],
        });
        assert.equal(r.approvedHistoricalAmount.isZero(), true, status);
        assert.equal(r.unexplainedResidual.toFixed(2), "110.00", status);
      }
    });

    test("an APPROVED record whose evidence is no longer valid contributes nothing and is reported", () => {
      const r = reconcileDriverCashAccount({
        accountId: ACCOUNT,
        storedBalance: d("0"),
        rawLedgerNet: d("-110"),
        reconciliations: [contribution("r1", "APPROVED", "110.00", INVALID)],
      });
      assert.equal(r.approvedHistoricalAmount.isZero(), true);
      assert.equal(r.unexplainedResidual.toFixed(2), "110.00");
      assert.deepEqual(r.invalidApprovedReconciliationIds, ["r1"]);
    });

    test("an unexplained second gap stays in the residual", () => {
      const r = reconcileDriverCashAccount({
        accountId: ACCOUNT,
        storedBalance: d("0"),
        rawLedgerNet: d("-135.50"),
        reconciliations: [contribution("r1", "APPROVED", "110.00")],
      });
      assert.equal(r.unexplainedResidual.toFixed(2), "25.50");
    });

    test("an invalid decision history never contributes and always counts as blocking", () => {
      const r = reconcileDriverCashAccount({
        accountId: ACCOUNT,
        storedBalance: d("0"),
        rawLedgerNet: d("-110"),
        reconciliations: [contribution("r1", "INVALID_HISTORY", "110.00")],
      });
      assert.equal(r.approvedHistoricalAmount.isZero(), true);
      assert.deepEqual(r.invalidApprovedReconciliationIds, ["r1"]);
    });

    test("a reconciliation of another account is refused", () => {
      assert.throws(
        () =>
          reconcileDriverCashAccount({
            accountId: ACCOUNT,
            storedBalance: d("0"),
            rawLedgerNet: d("0"),
            reconciliations: [{ ...contribution("r1", "APPROVED", "1"), accountId: "99999999-9999-4999-8999-999999999999" }],
          }),
        /another driver cash account/
      );
    });
  });

  describe("lifecycle derived from append-only decisions", () => {
    const approval: HistoricalReconciliationDecisionRecord = { id: "a", decision: "APPROVED", revokesDecisionId: null };

    test("no decision = PROPOSED; one outcome = that outcome; revocation of the approval = REVOKED", () => {
      assert.equal(deriveHistoricalReconciliationStatus([]), "PROPOSED");
      assert.equal(deriveHistoricalReconciliationStatus([approval]), "APPROVED");
      for (const decision of ["REJECTED", "WITHDRAWN"] as const) {
        assert.equal(deriveHistoricalReconciliationStatus([{ id: "x", decision, revokesDecisionId: null }]), decision);
      }
      assert.equal(
        deriveHistoricalReconciliationStatus([approval, { id: "r", decision: "REVOKED", revokesDecisionId: "a" }]),
        "REVOKED"
      );
    });

    test("an inconsistent history throws instead of counting as approved", () => {
      const reject = { id: "x", decision: "REJECTED", revokesDecisionId: null } as const;
      assert.throws(() => deriveHistoricalReconciliationStatus([approval, reject]), /more than one review outcome/);
      assert.throws(
        () => deriveHistoricalReconciliationStatus([{ id: "r", decision: "REVOKED", revokesDecisionId: "a" }]),
        /does not end its approval/
      );
      assert.throws(
        () => deriveHistoricalReconciliationStatus([approval, { id: "r", decision: "REVOKED", revokesDecisionId: "other" }]),
        /does not end its approval/
      );
      assert.throws(
        () =>
          deriveHistoricalReconciliationStatus([
            approval,
            { id: "r1", decision: "REVOKED", revokesDecisionId: "a" },
            { id: "r2", decision: "REVOKED", revokesDecisionId: "a" },
          ]),
        /does not end its approval/
      );
    });

    test("only PROPOSED and APPROVED are live", () => {
      assert.equal(isLiveHistoricalReconciliationStatus("PROPOSED"), true);
      assert.equal(isLiveHistoricalReconciliationStatus("APPROVED"), true);
      for (const s of ["REJECTED", "WITHDRAWN", "REVOKED"] as const) assert.equal(isLiveHistoricalReconciliationStatus(s), false);
    });
  });

  describe("ownership is never resolved by a ledger reconciliation", () => {
    test("UNRESOLVED ownership blocks whatever the decision status (FR.12A.4 G5 rule)", () => {
      for (const status of ["PROPOSED", "APPROVED", "REJECTED", "WITHDRAWN", "REVOKED", "INVALID_HISTORY"] as const) {
        assert.equal(isUnresolvedHistoricalOwnership({ reconciliationId: "r", status, ownershipStatus: "UNRESOLVED" }), true, status);
      }
    });
  });

  describe("evidence digest (mirrors dchr_evidence_digest_chk)", () => {
    test("canonical form: version, lowercase ids, NUMERIC(14,2) text, '' for NULL ids, no timestamp", () => {
      const s = buildEvidenceCanonicalString(
        evidence({ predecessorTransactionId: null, relatedSettlementId: null, accountId: ACCOUNT.toUpperCase() })
      );
      assert.equal(
        s,
        [
          "dchr-evidence-v1",
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          ACCOUNT,
          "22222222-2222-4222-8222-222222222222",
          "MISSING_COLLECTION",
          "EVIDENCE_ONLY_NO_CASH_EFFECT",
          "110.00",
          "110.00",
          "",
          "44444444-4444-4444-8444-444444444444",
          "55555555-5555-4555-8555-555555555555",
          "66666666-6666-4666-8666-666666666666",
          "77777777-7777-4777-8777-777777777777",
          "DELIVERY_ONLY",
          "210.00",
          "110.00",
          "-100.00",
          "",
        ].join("|")
      );
      assert.equal(/^[\x20-\x7e]+$/.test(s) && !s.includes("\\"), true, "ASCII without backslashes");
    });

    test("digest is the sha256 of the canonical string and changes with any evidence field", () => {
      const base = evidence();
      const digest = computeEvidenceDigest(base);
      assert.equal(digest, createHash("sha256").update(buildEvidenceCanonicalString(base)).digest("hex"));
      assert.match(digest, /^[0-9a-f]{64}$/);
      assert.equal(computeEvidenceDigest(evidence()), digest, "deterministic");
      assert.notEqual(computeEvidenceDigest(evidence({ amount: d("110.01") })), digest);
      assert.notEqual(computeEvidenceDigest(evidence({ missingTransactionId: "55555555-5555-4555-8555-555555555556" })), digest);
      assert.notEqual(computeEvidenceDigest(evidence({ predecessorTransactionId: null })), digest);
    });

    test("money is printed exactly; values a NUMERIC(14,2) column would round are refused", () => {
      assert.match(buildEvidenceCanonicalString(evidence({ expectedAmount: d("0"), amount: d("110") })), /\|110\.00\|110\.00\|.*\|0\.00\|/);
      assert.match(buildEvidenceCanonicalString(evidence({ expectedAmount: d("-0") })), /\|0\.00\|110\.00\|-100\.00\|/);
      assert.throws(() => buildEvidenceCanonicalString(evidence({ amount: d("110.005") })), /amount is not an exact NUMERIC\(14,2\)/);
      assert.throws(() => buildEvidenceCanonicalString(evidence({ amount: d("1000000000000") })), /amount/);
      assert.throws(() => buildEvidenceCanonicalString(evidence({ amount: d("NaN") })), /amount/);
    });

    test("malformed ids are refused", () => {
      assert.throws(() => buildEvidenceCanonicalString(evidence({ anchorTransactionId: "not-a-uuid" })), /anchorTransactionId/);
      assert.throws(() => buildEvidenceCanonicalString(evidence({ relatedSettlementId: "" })), /relatedSettlementId/);
    });
  });
});
