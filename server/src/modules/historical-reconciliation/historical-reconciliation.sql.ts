// ============================================================
// FR.12A.4 — The single SQL definition of driver cash historical
// reconciliation: decision status, evidence validity (V1–V7) and the
// per-account residual rule. Shared VERBATIM by gate G3, reconciliation R1,
// gate G5, the as-of driver cash figure and the production preflight script,
// so they cannot disagree.
//
// Plain SQL strings, deliberately free of Prisma imports: the read-only
// preflight (scripts/fr-production-preflight.mjs) runs them on a raw `pg`
// connection. Constants only — no value is ever interpolated.
//
// Every comparison happens inside PostgreSQL on stored values: timestamps
// are compared stored-to-stored (application-bound timestamps are shifted by
// a non-UTC session — docs/timezone-investigation.md) and audit amounts are
// compared as exact NUMERIC after a strict format check (a malformed amount
// fails the evidence instead of aborting the query).
// ============================================================

// Exact text -> NUMERIC equality; anything that is not a plain decimal number
// is a mismatch (fail closed).
function exactDecimalEquals(textExpr: string, numericExpr: string): string {
  return `(CASE WHEN ${textExpr} ~ '^-?[0-9]+(\\.[0-9]+)?$' THEN (${textExpr})::numeric = ${numericExpr} ELSE false END)`;
}

// FR.12A.5 audit vocabulary. Every decision written by the workflow carries a
// same-transaction audit row; an APPROVED decision without its matching
// audit (same reconciliation, approver, decision id and evidence digest)
// explains nothing — it was not written by the authorized workflow.
export const HISTORICAL_RECONCILIATION_AUDIT_ENTITY = "DRIVER_CASH_HISTORICAL_RECONCILIATION";
export const HISTORICAL_RECONCILIATION_AUDIT_ACTIONS = {
  INCIDENT_RECORDED: "LEDGER_INCIDENT_RECORDED",
  PROPOSED: "DRIVER_CASH_HISTORICAL_RECONCILIATION_PROPOSED",
  APPROVED: "DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED",
  REJECTED: "DRIVER_CASH_HISTORICAL_RECONCILIATION_REJECTED",
  WITHDRAWN: "DRIVER_CASH_HISTORICAL_RECONCILIATION_WITHDRAWN",
  REVOKED: "DRIVER_CASH_HISTORICAL_RECONCILIATION_REVOKED",
} as const;

// Audit actions or ledger postings that would mean the order's collection
// difference was resolved / finalized — contradicting "ownership unresolved".
const RESOLUTION_ACTIONS = `('COLLECTION_DIFFERENCE_RESOLVED', 'DELIVERY_ONLY_FINANCE_FINALIZED', 'COMPANY_ORDER_FINANCE_FINALIZED', 'FINANCIAL_RELEASE_COMPLETED')`;

// hr_evaluated: one row per reconciliation (every status), with
//   status            PROPOSED | APPROVED | REJECTED | WITHDRAWN | REVOKED | INVALID_HISTORY
//   asserts_approval  it carries an APPROVED decision that is not validly revoked
//   failures          text[] of EvidenceValidityFailure codes (empty = valid)
//   evidence_at       the cited audit's stored created_at (the evidence time)
const HR_EVALUATED_PRESENT = `
hr_decisions AS (
  SELECT r.id AS reconciliation_id,
         COUNT(d.id) FILTER (WHERE d.decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) AS outcomes,
         MAX(d.decision::text) FILTER (WHERE d.decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN')) AS outcome,
         COUNT(d.id) FILTER (WHERE d.decision = 'APPROVED') AS approvals,
         COUNT(d.id) FILTER (WHERE d.decision = 'REVOKED') AS revocations,
         COUNT(d.id) FILTER (WHERE d.decision = 'REVOKED' AND NOT EXISTS (
           SELECT 1 FROM driver_cash_historical_reconciliation_decisions a
           WHERE a.id = d.revokes_decision_id AND a.reconciliation_id = r.id AND a.decision = 'APPROVED')) AS stray_revocations,
         COALESCE(BOOL_OR(d.decision = 'APPROVED' AND d.decided_by_id = r.proposed_by_id), false) AS approver_is_proposer,
         COALESCE(BOOL_OR(d.decision = 'APPROVED'
                          AND (d.evidence_digest <> r.evidence_digest OR d.proposed_by_id <> r.proposed_by_id)), false) AS approval_unbound,
         COALESCE(BOOL_OR(d.decision = 'APPROVED' AND NOT EXISTS (
           SELECT 1 FROM audit_logs al
           WHERE al.entity_type = 'DRIVER_CASH_HISTORICAL_RECONCILIATION' AND al.entity_id = r.id::text
             AND al.action = 'DRIVER_CASH_HISTORICAL_RECONCILIATION_APPROVED'
             AND al.actor_user_id = d.decided_by_id
             AND al.metadata ->> 'decisionId' = d.id::text
             AND al.metadata ->> 'evidenceDigest' = d.evidence_digest::text)), false) AS approval_unaudited
  FROM driver_cash_historical_reconciliations r
  LEFT JOIN driver_cash_historical_reconciliation_decisions d ON d.reconciliation_id = r.id
  GROUP BY r.id
),
hr_status AS (
  SELECT r.id, r.incident_id, r.account_id, r.driver_id, r.amount, r.observed_jump, r.ownership_status,
         r.predecessor_transaction_id, r.anchor_transaction_id, r.missing_transaction_id, r.source_audit_log_id,
         r.deleted_order_reference, r.order_type, r.expected_amount, r.actual_amount, r.collection_difference,
         h.approver_is_proposer, h.approval_unbound, h.approval_unaudited,
         CASE WHEN h.outcomes > 1 OR h.revocations > 1 OR h.stray_revocations > 0
                   OR (h.revocations > 0 AND h.outcome IS DISTINCT FROM 'APPROVED') THEN 'INVALID_HISTORY'
              WHEN h.revocations = 1 THEN 'REVOKED'
              WHEN h.outcomes = 0 THEN 'PROPOSED'
              ELSE h.outcome END AS status,
         (h.approvals > 0 AND NOT (h.revocations = 1 AND h.outcomes = 1 AND h.outcome = 'APPROVED' AND h.stray_revocations = 0)) AS asserts_approval
  FROM driver_cash_historical_reconciliations r
  JOIN hr_decisions h ON h.reconciliation_id = r.id
),
hr_evaluated AS (
  SELECT s.id, s.incident_id, s.account_id, s.driver_id, s.status, s.asserts_approval, s.amount, s.ownership_status,
         s.deleted_order_reference, s.predecessor_transaction_id, s.anchor_transaction_id, s.missing_transaction_id,
         aud.created_at AS evidence_at,
         array_remove(ARRAY[
           -- decision history
           CASE WHEN s.status = 'INVALID_HISTORY' THEN 'INVALID_DECISION_HISTORY' END,
           -- account and driver
           CASE WHEN acc.id IS NULL OR acc.driver_id <> s.driver_id THEN 'ACCOUNT_MISMATCH' END,
           -- V1 surviving rows exist on this account
           CASE WHEN anc.id IS NULL OR anc.account_id <> s.account_id
                     OR (s.predecessor_transaction_id IS NOT NULL AND (pre.id IS NULL OR pre.account_id <> s.account_id))
                THEN 'ANCHOR_NOT_FOUND' END,
           -- V2 the located jump equals the claimed amount
           CASE WHEN anc.id IS NOT NULL
                     AND (anc.balance_before - COALESCE(pre.balance_after, 0) <> s.amount OR s.observed_jump <> s.amount)
                THEN 'JUMP_MISMATCH' END,
           -- V3a adjacency must be deterministic: no other row shares the
           -- predecessor's or the anchor's timestamp, and they differ
           CASE WHEN anc.id IS NOT NULL AND (
                       (pre.id IS NOT NULL AND pre.created_at = anc.created_at)
                    OR EXISTS (SELECT 1 FROM driver_cash_transactions x
                               WHERE x.account_id = s.account_id AND x.id <> anc.id AND x.id IS DISTINCT FROM pre.id
                                 AND (x.created_at = anc.created_at OR x.created_at = pre.created_at)))
                THEN 'ORDERING_AMBIGUOUS' END,
           -- V3b nothing between predecessor and anchor (nothing before the anchor at the start)
           CASE WHEN anc.id IS NOT NULL AND (
                       (pre.id IS NOT NULL AND pre.created_at > anc.created_at)
                    OR EXISTS (SELECT 1 FROM driver_cash_transactions x
                               WHERE x.account_id = s.account_id AND x.created_at < anc.created_at
                                 AND (s.predecessor_transaction_id IS NULL OR x.created_at > pre.created_at)))
                THEN 'ROWS_INSIDE_GAP' END,
           -- V3c the evidence time lies inside the gap (stored-to-stored)
           CASE WHEN aud.id IS NOT NULL AND anc.id IS NOT NULL
                     AND (aud.created_at > anc.created_at OR (pre.id IS NOT NULL AND aud.created_at < pre.created_at))
                THEN 'EVIDENCE_TIME_OUTSIDE_GAP' END,
           -- V4 the missing collection is still missing (by id or by its delivery key)
           CASE WHEN EXISTS (SELECT 1 FROM driver_cash_transactions x
                             WHERE x.id = s.missing_transaction_id
                                OR x.idempotency_key = 'delivery:' || s.deleted_order_reference::text || ':driver-collection')
                THEN 'MISSING_TRANSACTION_PRESENT' END,
           -- V5 the surviving audit names this order, row and exact amounts
           CASE WHEN aud.id IS NULL
                     OR aud.action <> 'COLLECTION_DIFFERENCE_RECORDED' OR aud.entity_type <> 'ORDER'
                     OR aud.entity_id <> s.deleted_order_reference::text
                     OR (aud.metadata ->> 'driverCashTransactionId') IS DISTINCT FROM s.missing_transaction_id::text
                     OR (aud.metadata ->> 'orderType') IS DISTINCT FROM s.order_type::text
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'actualAmount'", "s.amount")}
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'actualAmount'", "s.actual_amount")}
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'expectedAmount'", "s.expected_amount")}
                     OR NOT ${exactDecimalEquals("aud.metadata ->> 'difference'", "s.collection_difference")}
                THEN 'SOURCE_AUDIT_MISMATCH' END,
           -- V5 no surviving evidence that the difference was ever resolved
           CASE WHEN EXISTS (SELECT 1 FROM audit_logs z
                             WHERE z.entity_type = 'ORDER' AND z.entity_id = s.deleted_order_reference::text
                               AND z.action IN ${RESOLUTION_ACTIONS})
                  OR EXISTS (SELECT 1 FROM wallet_transactions w
                             WHERE w.idempotency_key LIKE 'delivery:' || s.deleted_order_reference::text || ':%')
                  OR EXISTS (SELECT 1 FROM company_financial_transactions c
                             WHERE c.idempotency_key LIKE 'delivery:' || s.deleted_order_reference::text || ':%')
                THEN 'DIFFERENCE_RESOLUTION_FOUND' END,
           -- V6 the order is still deleted
           CASE WHEN EXISTS (SELECT 1 FROM orders o WHERE o.id = s.deleted_order_reference) THEN 'DELETED_ORDER_PRESENT' END,
           -- V7 independent approval, bound to this exact evidence
           CASE WHEN s.approver_is_proposer THEN 'REVIEWER_NOT_INDEPENDENT' END,
           CASE WHEN s.approval_unbound THEN 'EVIDENCE_DIGEST_MISMATCH' END,
           -- FR.12A.5: the approval must have its same-transaction audit row
           CASE WHEN s.approval_unaudited THEN 'APPROVAL_AUDIT_MISSING' END,
           -- no other live explanation of the same gap, row, audit or order
           CASE WHEN EXISTS (SELECT 1 FROM hr_status o
                             WHERE o.id <> s.id AND o.account_id = s.account_id
                               AND o.status IN ('PROPOSED', 'APPROVED', 'INVALID_HISTORY')
                               AND (o.anchor_transaction_id = s.anchor_transaction_id
                                    OR o.missing_transaction_id = s.missing_transaction_id
                                    OR o.source_audit_log_id = s.source_audit_log_id
                                    OR o.deleted_order_reference = s.deleted_order_reference
                                    OR o.predecessor_transaction_id IS NOT DISTINCT FROM s.predecessor_transaction_id))
                THEN 'OVERLAPPING_EXPLANATION' END
         ]::text[], NULL) AS failures
  FROM hr_status s
  LEFT JOIN driver_cash_accounts acc ON acc.id = s.account_id
  LEFT JOIN driver_cash_transactions anc ON anc.id = s.anchor_transaction_id
  LEFT JOIN driver_cash_transactions pre ON pre.id = s.predecessor_transaction_id
  LEFT JOIN audit_logs aud ON aud.id = s.source_audit_log_id
)`;

// Before the FR.12A.3 migration the tables do not exist: an empty relation
// with the same columns, so every account behaves exactly as it always did.
const HR_EVALUATED_ABSENT = `
hr_evaluated AS (
  SELECT NULL::uuid AS id, NULL::uuid AS incident_id, NULL::uuid AS account_id, NULL::uuid AS driver_id,
         NULL::text AS status, NULL::boolean AS asserts_approval, NULL::numeric AS amount, NULL::text AS ownership_status,
         NULL::uuid AS deleted_order_reference, NULL::uuid AS predecessor_transaction_id, NULL::uuid AS anchor_transaction_id,
         NULL::uuid AS missing_transaction_id, NULL::timestamptz AS evidence_at, NULL::text[] AS failures
  WHERE false
)`;

// dc_accounts: one row per driver cash account (never excluded), with
//   stored_balance S, raw_ledger_net N, raw_discrepancy D = S − N,
//   approved_historical_amount A (APPROVED and currently valid only),
//   unexplained_residual R = D − A, invalid_approved_count X,
//   latest_balance_matches (G3's unchanged second condition).
const DC_ACCOUNTS = `
hr_accounts AS (
  SELECT e.account_id,
         SUM(e.amount) FILTER (WHERE e.status = 'APPROVED' AND cardinality(e.failures) = 0) AS approved_amount,
         COUNT(*) FILTER (WHERE (e.asserts_approval AND cardinality(e.failures) > 0) OR e.status = 'INVALID_HISTORY') AS invalid_count,
         COUNT(*) AS reconciliation_count
  FROM hr_evaluated e
  GROUP BY e.account_id
),
dc_ledger AS (
  SELECT account_id, SUM(balance_after - balance_before) AS net, MAX(created_at) AS latest
  FROM driver_cash_transactions
  GROUP BY account_id
),
dc_accounts AS (
  SELECT a.id AS account_id, a.driver_id,
         a.current_balance AS stored_balance,
         COALESCE(l.net, 0) AS raw_ledger_net,
         a.current_balance - COALESCE(l.net, 0) AS raw_discrepancy,
         COALESCE(h.approved_amount, 0) AS approved_historical_amount,
         a.current_balance - COALESCE(l.net, 0) - COALESCE(h.approved_amount, 0) AS unexplained_residual,
         COALESCE(h.invalid_count, 0)::int AS invalid_approved_count,
         COALESCE(h.reconciliation_count, 0)::int AS reconciliation_count,
         (l.latest IS NULL OR EXISTS (SELECT 1 FROM driver_cash_transactions x
                                      WHERE x.account_id = a.id AND x.created_at = l.latest AND x.balance_after = a.current_balance))
           AS latest_balance_matches
  FROM driver_cash_accounts a
  LEFT JOIN dc_ledger l ON l.account_id = a.id
  LEFT JOIN hr_accounts h ON h.account_id = a.id
)`;

// "WITH hr_evaluated, dc_accounts" — callers append their own SELECT.
export function driverCashReconciliationWith(schemaPresent: boolean): string {
  return `WITH ${schemaPresent ? HR_EVALUATED_PRESENT : HR_EVALUATED_ABSENT},${DC_ACCOUNTS}`;
}

export const HISTORICAL_RECONCILIATION_SCHEMA_PRESENT_SQL = `
  SELECT (to_regclass('public.driver_cash_historical_reconciliations') IS NOT NULL
          AND to_regclass('public.driver_cash_historical_reconciliation_decisions') IS NOT NULL) AS present`;

// An account the residual rule fails: R ≠ 0, or any invalid approval.
export const ACCOUNT_RESIDUAL_FAILS = `(d.unexplained_residual <> 0 OR d.invalid_approved_count > 0)`;

// Human-readable D / A / R / X for findings (the raw discrepancy is always shown).
export const ACCOUNT_COMPONENTS_TEXT = `'stored ' || d.stored_balance::text || ', ledger net ' || d.raw_ledger_net::text
  || ', raw discrepancy ' || d.raw_discrepancy::text
  || ', approved historical reconciliation ' || d.approved_historical_amount::text
  || ', unexplained residual ' || d.unexplained_residual::text
  || ', invalid historical approvals ' || d.invalid_approved_count::text`;

// Approved reconciliations whose evidence no longer holds, or whose decision
// history is invalid: always blocking (G3 / R1).
export const INVALID_RECONCILIATIONS_WHERE = `((e.asserts_approval AND cardinality(e.failures) > 0) OR e.status = 'INVALID_HISTORY')`;

// G5 / preflight unresolved historical ownership: unresolvedHistoricalOwnershipSql
// in ../historical-ownership/historical-ownership.sql.ts (FR.12A.10).

// Balance-chain discontinuities in (created_at, id) order that no valid
// approved reconciliation explains. A break at a timestamp shared with
// another row of the account cannot be ordered deterministically: it is
// classified as needing further evidence, never as proven corruption.
export const UNEXPLAINED_CHAIN_BREAKS = `
dc_seq AS (
  SELECT t.id, t.account_id, t.driver_id, t.created_at, t.balance_before,
         LAG(t.balance_after) OVER w AS prev_after,
         LAG(t.id) OVER w AS prev_id,
         LAG(t.created_at) OVER w AS prev_created_at
  FROM driver_cash_transactions t
  WINDOW w AS (PARTITION BY t.account_id ORDER BY t.created_at, t.id)
),
dc_breaks AS (
  SELECT s.id, s.account_id, s.driver_id, s.balance_before, COALESCE(s.prev_after, 0) AS expected_before,
         s.balance_before - COALESCE(s.prev_after, 0) AS jump,
         -- another row (not this row, not its predecessor) shares either
         -- timestamp, or the two rows share one: the order is not provable
         (s.created_at = s.prev_created_at
          OR EXISTS (SELECT 1 FROM driver_cash_transactions x
                     WHERE x.account_id = s.account_id AND x.id <> s.id AND x.id IS DISTINCT FROM s.prev_id
                       AND (x.created_at = s.created_at OR x.created_at = s.prev_created_at))) AS ambiguous_order
  FROM dc_seq s
  WHERE s.balance_before <> COALESCE(s.prev_after, 0)
    AND NOT EXISTS (SELECT 1 FROM hr_evaluated e
                    WHERE e.anchor_transaction_id = s.id AND e.status = 'APPROVED' AND cardinality(e.failures) = 0)
)`;
