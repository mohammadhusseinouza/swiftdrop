// ============================================================
// FR.12A.10 — The single SQL definition of historical ownership resolution
// validity: policy status, resolution status, evidence validity and the
// liability register. Shared VERBATIM by gate G5, reconciliation R14, the
// read APIs, the finance summary and the production preflight script, so
// they cannot disagree.
//
// Plain SQL strings without Prisma imports (the preflight runs them on a raw
// `pg` connection). Constants only — no value is ever interpolated.
//
// It builds on hr_evaluated (historical-reconciliation.sql.ts): callers use
// historicalOwnershipWith(), which already includes the driver cash
// reconciliation CTEs. Every comparison happens inside PostgreSQL on stored
// values; nothing here posts or repairs anything.
// ============================================================

import { driverCashReconciliationWith } from "../historical-reconciliation/historical-reconciliation.sql";

export const HISTORICAL_OWNERSHIP_AUDIT_ENTITIES = {
  POLICY: "HISTORICAL_LIABILITY_POLICY",
  RESOLUTION: "HISTORICAL_OWNERSHIP_RESOLUTION",
  LIABILITY: "HISTORICAL_LIABILITY",
} as const;

export const HISTORICAL_LIABILITY_POLICY_AUDIT_ACTIONS = {
  PROPOSED: "HISTORICAL_LIABILITY_POLICY_PROPOSED",
  APPROVED: "HISTORICAL_LIABILITY_POLICY_APPROVED",
  REJECTED: "HISTORICAL_LIABILITY_POLICY_REJECTED",
  WITHDRAWN: "HISTORICAL_LIABILITY_POLICY_WITHDRAWN",
  REVOKED: "HISTORICAL_LIABILITY_POLICY_REVOKED",
} as const;

export const HISTORICAL_OWNERSHIP_RESOLUTION_AUDIT_ACTIONS = {
  PROPOSED: "HISTORICAL_OWNERSHIP_RESOLUTION_PROPOSED",
  APPROVED: "HISTORICAL_OWNERSHIP_RESOLUTION_APPROVED",
  REJECTED: "HISTORICAL_OWNERSHIP_RESOLUTION_REJECTED",
  WITHDRAWN: "HISTORICAL_OWNERSHIP_RESOLUTION_WITHDRAWN",
  REVOKED: "HISTORICAL_OWNERSHIP_RESOLUTION_REVOKED",
} as const;

export const HISTORICAL_LIABILITY_AUDIT_ACTIONS = {
  RECORDED: "HISTORICAL_LIABILITY_RECORDED",
  REVIEWED: "HISTORICAL_LIABILITY_REVIEWED",
} as const;

// Ledger keys reserved for any future historical posting (none exists in
// V1: recording a liability posts nothing). A row under these prefixes is
// never legitimate today.
export const HISTORICAL_LEDGER_KEY_PREFIXES = ["historical-liability:", "historical-ownership:"] as const;

function exactDecimalEquals(textExpr: string, numericExpr: string): string {
  return `(CASE WHEN ${textExpr} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${textExpr})::numeric = ${numericExpr} ELSE false END)`;
}

// UTF-8 length-prefixed field, mirrored by lengthPrefixed() in the calculation module.
const prefixed = (expr: string) => `octet_length(convert_to(${expr}, 'UTF8'))::text || ':' || ${expr}`;

const RESOLUTION_ACTIONS = `('COLLECTION_DIFFERENCE_RESOLVED', 'DELIVERY_ONLY_FINANCE_FINALIZED', 'COMPANY_ORDER_FINANCE_FINALIZED', 'FINANCIAL_RELEASE_COMPLETED')`;

// Decision history shape shared by policies and resolutions.
const statusExpr = `CASE WHEN h.outcomes > 1 OR h.revocations > 1 OR h.stray_revocations > 0
                          OR (h.revocations > 0 AND h.outcome IS DISTINCT FROM 'APPROVED') THEN 'INVALID_HISTORY'
                     WHEN h.revocations = 1 THEN 'REVOKED'
                     WHEN h.outcomes = 0 THEN 'PROPOSED'
                     ELSE h.outcome END`;
const assertsApprovalExpr = `(h.approvals > 0 AND NOT (h.revocations = 1 AND h.outcomes = 1 AND h.outcome = 'APPROVED' AND h.stray_revocations = 0))`;

// hop_evaluated: one row per policy version — status, approved_at, failures.
// ho_evaluated:  one row per resolution — status, failures, its liability.
const HO_EVALUATED = `
hop_decisions AS (
  SELECT p.id AS policy_id,
         COUNT(d.id) FILTER (WHERE d.decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) AS outcomes,
         MAX(d.decision::text) FILTER (WHERE d.decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) AS outcome,
         COUNT(d.id) FILTER (WHERE d.decision = 'APPROVED') AS approvals,
         COUNT(d.id) FILTER (WHERE d.decision = 'REVOKED') AS revocations,
         COUNT(d.id) FILTER (WHERE d.decision = 'REVOKED' AND NOT EXISTS (
           SELECT 1 FROM historical_liability_policy_decisions a
           WHERE a.id = d.revokes_decision_id AND a.policy_id = p.id AND a.decision = 'APPROVED')) AS stray_revocations,
         MIN(d.created_at) FILTER (WHERE d.decision = 'APPROVED') AS approved_at,
         MIN(d.decided_by_id::text) FILTER (WHERE d.decision = 'APPROVED') AS approved_by_id,
         COALESCE(BOOL_OR(d.decision = 'APPROVED' AND NOT EXISTS (
           SELECT 1 FROM audit_logs al
           WHERE al.entity_type = 'HISTORICAL_LIABILITY_POLICY' AND al.entity_id = p.id::text
             AND al.action = 'HISTORICAL_LIABILITY_POLICY_APPROVED'
             AND al.actor_user_id = d.decided_by_id
             AND al.metadata ->> 'decisionId' = d.id::text
             AND al.metadata ->> 'policyDigest' = d.policy_digest::text)), false) AS approval_unaudited
  FROM historical_liability_policies p
  LEFT JOIN historical_liability_policy_decisions d ON d.policy_id = p.id
  GROUP BY p.id
),
hop_evaluated AS (
  SELECT p.id, p.policy_code, p.version, p.outcome, p.title, p.policy_digest, p.proposed_by_id,
         p.review_interval_days, p.unclaimed_review_after_days, p.created_at,
         ${statusExpr} AS status,
         ${assertsApprovalExpr} AS asserts_approval,
         h.approved_at, h.approved_by_id,
         array_remove(ARRAY[
           CASE WHEN ${statusExpr} = 'INVALID_HISTORY' THEN 'INVALID_DECISION_HISTORY' END,
           CASE WHEN p.content_sha256 <> encode(sha256(convert_to(
                       'hlp-content-v1'
                       || chr(10) || ${prefixed("p.title")}
                       || chr(10) || ${prefixed("p.summary")}
                       || chr(10) || ${prefixed("p.document_reference")}
                       || chr(10) || ${prefixed("p.unclaimed_funds_handling")}, 'UTF8')), 'hex')
                THEN 'POLICY_CONTENT_MISMATCH' END,
           CASE WHEN h.approval_unaudited THEN 'APPROVAL_AUDIT_MISSING' END
         ]::text[], NULL) AS failures
  FROM historical_liability_policies p
  JOIN hop_decisions h ON h.policy_id = p.id
),
ho_decisions AS (
  SELECT r.id AS resolution_id,
         COUNT(d.id) FILTER (WHERE d.decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) AS outcomes,
         MAX(d.decision::text) FILTER (WHERE d.decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) AS outcome,
         COUNT(d.id) FILTER (WHERE d.decision = 'APPROVED') AS approvals,
         COUNT(d.id) FILTER (WHERE d.decision = 'REVOKED') AS revocations,
         COUNT(d.id) FILTER (WHERE d.decision = 'REVOKED' AND NOT EXISTS (
           SELECT 1 FROM historical_ownership_resolution_decisions a
           WHERE a.id = d.revokes_decision_id AND a.resolution_id = r.id AND a.decision = 'APPROVED')) AS stray_revocations,
         MIN(d.created_at) FILTER (WHERE d.decision = 'APPROVED') AS approved_at,
         MIN(d.id::text) FILTER (WHERE d.decision = 'APPROVED') AS approval_decision_id,
         COALESCE(BOOL_OR(d.decision = 'APPROVED' AND d.decided_by_id = r.proposed_by_id), false) AS approver_is_proposer,
         COALESCE(BOOL_OR(d.decision = 'APPROVED'
                          AND (d.resolution_digest <> r.resolution_digest OR d.proposed_by_id <> r.proposed_by_id)), false) AS approval_unbound,
         COALESCE(BOOL_OR(d.decision = 'APPROVED' AND NOT EXISTS (
           SELECT 1 FROM audit_logs al
           WHERE al.entity_type = 'HISTORICAL_OWNERSHIP_RESOLUTION' AND al.entity_id = r.id::text
             AND al.action = 'HISTORICAL_OWNERSHIP_RESOLUTION_APPROVED'
             AND al.actor_user_id = d.decided_by_id
             AND al.metadata ->> 'decisionId' = d.id::text
             AND al.metadata ->> 'resolutionDigest' = d.resolution_digest::text)), false) AS approval_unaudited
  FROM historical_ownership_resolutions r
  LEFT JOIN historical_ownership_resolution_decisions d ON d.resolution_id = r.id
  GROUP BY r.id
),
ho_status AS (
  SELECT r.*, ${statusExpr} AS status, ${assertsApprovalExpr} AS asserts_approval,
         h.approved_at, h.approval_decision_id, h.approver_is_proposer, h.approval_unbound, h.approval_unaudited
  FROM historical_ownership_resolutions r
  JOIN ho_decisions h ON h.resolution_id = r.id
),
ho_evidence AS (
  SELECT e.resolution_id, COUNT(*)::int AS evidence_rows,
         encode(sha256(convert_to('hor-evidence-v1' || string_agg(
           chr(10) || e.ordinal::text || '|' || e.kind::text || '|' || e.document_sha256::text
           || '|' || ${prefixed("e.reference")} || '|' || ${prefixed("e.description")}, '' ORDER BY e.ordinal), 'UTF8')), 'hex') AS manifest
  FROM historical_ownership_resolution_evidence e
  GROUP BY e.resolution_id
),
ho_evaluated AS (
  SELECT s.id, s.incident_id, s.outcome, s.policy_id, s.deleted_order_reference, s.source_audit_log_id, s.order_type,
         s.expected_amount, s.collected_amount, s.collection_difference, s.verification,
         s.ledger_reconciliation_id,
         s.held_collection_amount, s.tracked_shortfall_amount, s.resolution_digest, s.proposed_by_id, s.created_at,
         s.status, s.asserts_approval, s.approved_at, s.approval_decision_id,
         l.id AS liability_id, l.recognized_amount, l.recorded_by_id, l.created_at AS recorded_at, l.liability_digest,
         array_remove(ARRAY[
           CASE WHEN s.status = 'INVALID_HISTORY' THEN 'INVALID_DECISION_HISTORY' END,
           -- the surviving audit names this order and its exact recorded amounts
           CASE WHEN aud.id IS NULL
                     OR aud.action <> 'COLLECTION_DIFFERENCE_RECORDED' OR aud.entity_type <> 'ORDER'
                     OR aud.entity_id <> s.deleted_order_reference::text
                     OR (aud.metadata ->> 'orderType') IS DISTINCT FROM s.order_type::text
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'actualAmount'", "s.collected_amount")}
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'expectedAmount'", "s.expected_amount")}
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'difference'", "s.collection_difference")}
                THEN 'SOURCE_AUDIT_MISMATCH' END,
           CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.id = s.deleted_order_reference) THEN 'DELETED_ORDER_PRESENT' END,
           -- the difference was never resolved through the normal order path
           CASE WHEN EXISTS (SELECT 1 FROM audit_logs z
                             WHERE z.entity_type = 'ORDER' AND z.entity_id = s.deleted_order_reference::text
                               AND z.action IN ${RESOLUTION_ACTIONS})
                  OR EXISTS (SELECT 1 FROM wallet_transactions w
                             WHERE w.idempotency_key LIKE 'delivery:' || s.deleted_order_reference::text || ':%')
                  OR EXISTS (SELECT 1 FROM company_financial_transactions c
                             WHERE c.idempotency_key LIKE 'delivery:' || s.deleted_order_reference::text || ':%')
                THEN 'DIFFERENCE_RESOLUTION_FOUND' END,
           -- the full collected amount is verified by an approved, currently
           -- valid ledger reconciliation of this deleted order (the only route;
           -- a surviving COLLECTION row alone is never accepted — review M2)
           CASE WHEN NOT (s.verification = 'APPROVED_LEDGER_RECONCILIATION' AND EXISTS (
                  SELECT 1 FROM hr_evaluated e
                  WHERE e.id = s.ledger_reconciliation_id AND e.status = 'APPROVED' AND cardinality(e.failures) = 0
                    AND e.amount = s.collected_amount AND e.deleted_order_reference = s.deleted_order_reference))
                THEN 'COLLECTION_NOT_VERIFIED' END,
           -- ... and it establishes that the collected amount was handed over
           -- in a historical settlement: the reconciliation's anchor (the first
           -- surviving row after the gap) IS its related settlement's cash row,
           -- and that settlement handed over the whole balance (balance_after =
           -- 0), so it necessarily included the missing collection. Any other
           -- shape is not accepted (no weaker fallback).
           CASE WHEN NOT EXISTS (
                  SELECT 1
                  FROM driver_cash_historical_reconciliations r
                  JOIN driver_cash_transactions anc ON anc.id = r.anchor_transaction_id
                  JOIN driver_settlements ds ON ds.id = r.related_settlement_id
                  WHERE r.id = s.ledger_reconciliation_id
                    AND anc.type = 'SETTLEMENT' AND anc.settlement_id = r.related_settlement_id
                    AND anc.balance_after = 0 AND anc.amount = ds.amount_received
                    AND ds.amount_received >= s.collected_amount)
                THEN 'SETTLEMENT_INCLUSION_NOT_ESTABLISHED' END,
           -- the cited policy version is approved, valid, of this outcome, and
           -- was approved before this resolution was
           CASE WHEN NOT EXISTS (
                  SELECT 1 FROM hop_evaluated p
                  WHERE p.id = s.policy_id AND p.status = 'APPROVED' AND cardinality(p.failures) = 0
                    AND p.outcome = s.outcome
                    AND (s.approved_at IS NULL OR p.approved_at <= s.approved_at))
                THEN 'POLICY_NOT_APPROVED' END,
           CASE WHEN ev.resolution_id IS NULL OR ev.evidence_rows <> s.evidence_count OR ev.manifest <> s.evidence_manifest_digest
                THEN 'EVIDENCE_MANIFEST_MISMATCH' END,
           CASE WHEN s.rationale_digest <> encode(sha256(convert_to(s.rationale, 'UTF8')), 'hex') THEN 'RATIONALE_DIGEST_MISMATCH' END,
           CASE WHEN s.approver_is_proposer THEN 'REVIEWER_NOT_INDEPENDENT' END,
           CASE WHEN s.approval_unbound THEN 'RESOLUTION_DIGEST_MISMATCH' END,
           CASE WHEN s.approval_unaudited THEN 'APPROVAL_AUDIT_MISSING' END,
           -- no other live resolution of the same deleted order
           CASE WHEN EXISTS (SELECT 1 FROM ho_status o
                             WHERE o.id <> s.id AND o.deleted_order_reference = s.deleted_order_reference
                               AND o.status IN ('PROPOSED', 'APPROVED', 'INVALID_HISTORY'))
                THEN 'CONFLICTING_RESOLUTION' END,
           -- the liability register row
           CASE WHEN l.id IS NOT NULL AND (l.recognized_amount <> s.collected_amount
                                           OR l.held_collection_amount <> s.held_collection_amount
                                           OR l.tracked_shortfall_amount <> s.tracked_shortfall_amount
                                           OR l.approval_decision_id::text IS DISTINCT FROM s.approval_decision_id)
                THEN 'LIABILITY_AMOUNT_MISMATCH' END,
           CASE WHEN l.id IS NOT NULL AND s.approved_at IS NOT NULL AND l.created_at < s.approved_at
                THEN 'LIABILITY_RECORDED_BEFORE_APPROVAL' END,
           CASE WHEN l.id IS NOT NULL AND NOT EXISTS (
                  SELECT 1 FROM audit_logs al
                  WHERE al.entity_type = 'HISTORICAL_LIABILITY' AND al.entity_id = l.id::text
                    AND al.action = 'HISTORICAL_LIABILITY_RECORDED'
                    AND al.actor_user_id = l.recorded_by_id
                    AND al.metadata ->> 'resolutionId' = s.id::text
                    AND al.metadata ->> 'liabilityDigest' = l.liability_digest::text
                    AND ${exactDecimalEquals("al.metadata ->> 'recognizedAmount'", "l.recognized_amount")})
                THEN 'LIABILITY_AUDIT_MISSING' END,
           -- recording posts nothing: no ledger row may carry this resolution's
           -- or liability's historical key namespace
           CASE WHEN EXISTS (SELECT 1 FROM wallet_transactions w
                             WHERE w.idempotency_key LIKE 'historical-ownership:' || s.id::text || ':%'
                                OR (l.id IS NOT NULL AND w.idempotency_key LIKE 'historical-liability:' || l.id::text || ':%'))
                  OR EXISTS (SELECT 1 FROM company_financial_transactions c
                             WHERE c.idempotency_key LIKE 'historical-ownership:' || s.id::text || ':%'
                                OR (l.id IS NOT NULL AND c.idempotency_key LIKE 'historical-liability:' || l.id::text || ':%'))
                  OR EXISTS (SELECT 1 FROM driver_cash_transactions x
                             WHERE x.idempotency_key LIKE 'historical-ownership:' || s.id::text || ':%'
                                OR (l.id IS NOT NULL AND x.idempotency_key LIKE 'historical-liability:' || l.id::text || ':%'))
                THEN 'UNEXPECTED_LEDGER_POSTING' END
         ]::text[], NULL) AS failures
  FROM ho_status s
  LEFT JOIN audit_logs aud ON aud.id = s.source_audit_log_id
  LEFT JOIN ho_evidence ev ON ev.resolution_id = s.id
  LEFT JOIN historical_liabilities l ON l.resolution_id = s.id
),
ho_released AS (
  -- A deleted order's historical ownership is RESOLVED only by an approved,
  -- valid resolution whose liability is recorded, with no conflicting
  -- resolution and no invalid ledger reconciliation of the same order.
  SELECT h.deleted_order_reference, h.id AS resolution_id, h.liability_id, h.recognized_amount, h.tracked_shortfall_amount, h.policy_id
  FROM ho_evaluated h
  WHERE h.status = 'APPROVED' AND cardinality(h.failures) = 0 AND h.liability_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM hr_evaluated e
                    WHERE e.deleted_order_reference = h.deleted_order_reference
                      AND ((e.asserts_approval AND cardinality(e.failures) > 0) OR e.status = 'INVALID_HISTORY'))
)`;

// "WITH hr_evaluated, dc_accounts, hop_evaluated, ho_evaluated, ho_released" —
// callers append their own SELECT. Requires both migrations.
export function historicalOwnershipWith(): string {
  return `${driverCashReconciliationWith(true)},${HO_EVALUATED}`;
}

export const HISTORICAL_OWNERSHIP_SCHEMA_PRESENT_SQL = `
  SELECT (to_regclass('public.historical_ownership_resolutions') IS NOT NULL
          AND to_regclass('public.historical_liabilities') IS NOT NULL
          AND to_regclass('public.historical_liability_policies') IS NOT NULL) AS present`;

// A liability / approval that claims validity but fails it (R14, blocking).
export const INVALID_RESOLUTIONS_WHERE = `((h.asserts_approval AND cardinality(h.failures) > 0) OR h.status = 'INVALID_HISTORY')`;

// Review L2 — "revoker ≠ recorder" is enforced by the workflow service. The
// database cannot require it without a trigger (the recorder lives in another
// table and may not exist yet at revocation time), so it is DETECTED here and
// reported by R14 instead. A revocation can only re-block G5, never release it.
export const REVOKED_BY_RECORDER_SQL = `
  SELECT l.id AS liability_id, d.id AS decision_id, d.decided_by_id
  FROM historical_liabilities l
  JOIN historical_ownership_resolution_decisions d
    ON d.resolution_id = l.resolution_id AND d.decision = 'REVOKED' AND d.decided_by_id = l.recorded_by_id`;

// A recorded liability counts as outstanding unless its resolution's approval
// was revoked (V1 has no discharge workflow: outstanding = recognized).
export const OUTSTANDING_LIABILITY_WHERE = `(h.liability_id IS NOT NULL AND h.asserts_approval)`;

// G5 (and preflight): deleted orders whose collection difference was never
// resolved — detected from the surviving audit, independently of any record,
// plus every ledger reconciliation (its ownership column is pinned to
// UNRESOLVED; a ledger reconciliation never resolves ownership). FR.12A.10: a
// reference is excluded ONLY when ho_released holds for it — an approved,
// valid resolution whose liability is recorded. An approval, an exception or
// an acknowledgment alone never excludes anything. Moved here from
// historical-reconciliation.sql.ts so there is exactly one definition.
export function unresolvedHistoricalOwnershipSql(schemaPresent: boolean, ownershipSchemaPresent = false): string {
  const fromRecords = schemaPresent
    ? `UNION
       SELECT r.deleted_order_reference::text AS order_ref, 'historical reconciliation ' || r.id::text AS source
       FROM driver_cash_historical_reconciliations r
       WHERE r.ownership_status = 'UNRESOLVED'`
    : "";
  const released = schemaPresent && ownershipSchemaPresent;
  return `
    ${released ? historicalOwnershipWith() : ""}
    SELECT u.order_ref, string_agg(DISTINCT u.source, '; ' ORDER BY u.source) AS sources
    FROM (
      SELECT l.entity_id AS order_ref, 'surviving COLLECTION_DIFFERENCE_RECORDED audit' AS source
      FROM audit_logs l
      WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED' AND l.entity_type = 'ORDER'
        AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = l.entity_id)
        AND NOT EXISTS (SELECT 1 FROM audit_logs z
                        WHERE z.entity_type = 'ORDER' AND z.entity_id = l.entity_id AND z.action = 'COLLECTION_DIFFERENCE_RESOLVED')
      ${fromRecords}
    ) u
    ${released ? "WHERE NOT EXISTS (SELECT 1 FROM ho_released x WHERE x.deleted_order_reference::text = u.order_ref)" : ""}
    GROUP BY u.order_ref`;
}
