// ============================================================
// Settlement-Based Financial Release — reconciliation (FR.8)
//
// GET /api/v1/finance/reconciliation/financial-release   (finance.read)
// Contract: docs/settlement-financial-release-contract.md §11 (R1–R14).
//
// Strictly READ-ONLY and never repairs anything. Every check runs inside ONE
// readSnapshot() (REPEATABLE READ, READ ONLY) so cross-table comparisons see
// a single consistent instant even while settlements / deliveries commit.
//
// Each check is one bounded SQL statement: it returns the exact number of
// affected records (window COUNT) and at most SAMPLE_LIMIT example findings
// — memory use is independent of how many rows are wrong.
//
// Classification of a finding (rule-based, never a hard-coded id list):
//   FINANCIAL_RELEASE_VIOLATION — involves a settlement-mode release, order,
//     allocation or correction.
//   HISTORICAL_ANOMALY          — involves only legacy / immediate records.
// Check kinds:
//   INVARIANT (R1–R14)  — any finding blocks activation (FR.11 gates
//                         G3/G4/G6), whatever its classification.
//   HISTORICAL (H*)     — legacy ledger anomalies outside R1–R14: reported
//                         for separate review, do not block activation.
//   INFORMATIONAL (I*)  — observations, never violations.
//
// FR.12A.4 — R1 applies the historical reconciliation residual rule shared
// with gate G3 (historical-reconciliation.sql.ts): stored − ledger net −
// approved, currently valid historical reconciliation must be 0, and an
// invalid historical approval is itself a blocking finding. H3 reports chain
// breaks no valid approval explains (ambiguous ordering classified as needing
// evidence); I3 keeps the raw discrepancy visible even when R1 passes. Before
// the FR.12A.3 migration the raw rule applies unchanged.
//
// FR.12A.10 — R14 checks the historical liability register: every approved
// ownership resolution and every recorded liability whose approval stands
// must validate (shared SQL, historical-ownership.sql.ts), and no ledger row
// may carry a historical-liability / historical-ownership key (recording a
// liability posts nothing). Before the FR.12A.9 migration R14 is empty.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { readSnapshot } from "../../db/read-snapshot";
import { PENDING_RELEASE_HOLDS_CASH } from "./financial-release.service";
import {
  ACCOUNT_COMPONENTS_TEXT,
  ACCOUNT_RESIDUAL_FAILS,
  INVALID_RECONCILIATIONS_WHERE,
  UNEXPLAINED_CHAIN_BREAKS,
  driverCashReconciliationWith,
} from "../historical-reconciliation/historical-reconciliation.sql";
import {
  getDriverCashHistoricalReconciliationSummary,
  isHistoricalReconciliationSchemaPresent,
} from "../historical-reconciliation/historical-reconciliation.service";
import type { DriverCashHistoricalReconciliationSummary } from "../historical-reconciliation/historical-reconciliation.types";
import { INVALID_RESOLUTIONS_WHERE, REVOKED_BY_RECORDER_SQL, historicalOwnershipWith } from "../historical-ownership/historical-ownership.sql";
import { isHistoricalOwnershipSchemaPresent } from "../historical-ownership/historical-ownership.service";

export const RECONCILIATION_SAMPLE_LIMIT = 50;

export type CheckKind = "INVARIANT" | "HISTORICAL" | "INFORMATIONAL";
export type FindingClassification = "FINANCIAL_RELEASE_VIOLATION" | "HISTORICAL_ANOMALY" | "OBSERVATION";

export interface ReconciliationFinding {
  entityType: string;
  entityId: string;
  expected: string | null;
  actual: string | null;
  detail: string;
  classification: FindingClassification;
}

export interface ReconciliationCheckResult {
  id: string;
  title: string;
  kind: CheckKind;
  status: "PASS" | "FAIL" | "INFO";
  blocksActivation: boolean;
  affectedCount: number;
  financialReleaseViolationCount: number;
  historicalAnomalyCount: number;
  findings: ReconciliationFinding[];
  truncated: boolean;
}

export interface ReconciliationReport {
  generatedAt: string;
  consistency: "SINGLE_SNAPSHOT_REPEATABLE_READ";
  sampleLimit: number;
  summary: {
    checksRun: number;
    invariantChecksFailed: number;
    financialReleaseViolations: number;
    historicalAnomalies: number;
    // True when any INVARIANT check fails (whatever the classification).
    activationBlocked: boolean;
  };
  checks: ReconciliationCheckResult[];
  // FR.12A.4 — raw discrepancy, approved historical reconciliation, residual
  // and invalid evidence per account, side by side (from the same snapshot).
  driverCashHistoricalReconciliation: DriverCashHistoricalReconciliationSummary;
}

interface CheckDefinition {
  id: string;
  title: string;
  kind: CheckKind;
  // A SELECT producing: entity_type, entity_id, expected, actual, detail,
  // origin ('FINANCIAL_RELEASE' | 'LEGACY' | 'OBSERVATION'). A function when it
  // depends on whether the historical reconciliation / ownership schema exists.
  sql: Prisma.Sql | ((historicalSchemaPresent: boolean, ownershipSchemaPresent: boolean) => Prisma.Sql);
}

type FindingRow = {
  entity_type: string;
  entity_id: string;
  expected: string | null;
  actual: string | null;
  detail: string;
  origin: string;
  total: number;
  fr_total: number;
};

// ------------------------------------------------------------ helpers
const FR = Prisma.sql`'FINANCIAL_RELEASE'`;
const driverOrigin = (driverIdCol: Prisma.Sql) =>
  Prisma.sql`CASE WHEN EXISTS (SELECT 1 FROM order_financial_releases rr WHERE rr.driver_id = ${driverIdCol}) THEN 'FINANCIAL_RELEASE' ELSE 'LEGACY' END`;
const customerOrigin = (customerIdCol: Prisma.Sql) =>
  Prisma.sql`CASE WHEN EXISTS (SELECT 1 FROM order_financial_releases rr WHERE rr.customer_id = ${customerIdCol}) THEN 'FINANCIAL_RELEASE' ELSE 'LEGACY' END`;
const orderOrigin = (orderIdCol: Prisma.Sql) =>
  Prisma.sql`CASE WHEN EXISTS (SELECT 1 FROM order_financial_releases rr WHERE rr.order_id = ${orderIdCol})
                    OR EXISTS (SELECT 1 FROM orders oo WHERE oo.id = ${orderIdCol} AND oo.financial_release_mode = 'ON_SETTLEMENT')
               THEN 'FINANCIAL_RELEASE' ELSE 'LEGACY' END`;

// ------------------------------------------------------------ checks
const CHECKS: CheckDefinition[] = [
  {
    id: "R1",
    title: "Driver cash cached balance equals its ledger (plus approved, valid historical reconciliation)",
    kind: "INVARIANT",
    sql: (hr) => Prisma.sql`
      ${Prisma.raw(driverCashReconciliationWith(hr))}
      SELECT 'DRIVER_CASH_ACCOUNT' AS entity_type, d.driver_id::text AS entity_id,
             CASE WHEN d.reconciliation_count = 0 THEN d.raw_ledger_net::text
                  ELSE (d.raw_ledger_net + d.approved_historical_amount)::text || ' (ledger net ' || d.raw_ledger_net::text
                       || ' + approved historical reconciliation ' || d.approved_historical_amount::text || ')' END AS expected,
             d.stored_balance::text AS actual,
             CASE WHEN d.reconciliation_count = 0 THEN 'cached current_balance differs from the net of the driver cash ledger'
                  ELSE 'cached current_balance differs from the ledger net plus approved, valid historical reconciliation: '
                       || ${Prisma.raw(ACCOUNT_COMPONENTS_TEXT)} END AS detail,
             ${driverOrigin(Prisma.sql`d.driver_id`)} AS origin
      FROM dc_accounts d
      WHERE ${Prisma.raw(ACCOUNT_RESIDUAL_FAILS)}
      UNION ALL
      SELECT 'DRIVER_CASH_HISTORICAL_RECONCILIATION', e.id::text, 'valid evidence', array_to_string(e.failures, ', '),
             'approved historical reconciliation is not valid evidence: it explains nothing and blocks activation',
             ${driverOrigin(Prisma.sql`e.driver_id`)}
      FROM hr_evaluated e
      WHERE ${Prisma.raw(INVALID_RECONCILIATIONS_WHERE)}
      UNION ALL
      SELECT 'DRIVER_CASH_TRANSACTION', t.id::text, t.amount::text, abs(t.balance_after - t.balance_before)::text,
             'ledger row balance movement differs from its amount', ${driverOrigin(Prisma.sql`t.driver_id`)}
      FROM driver_cash_transactions t
      WHERE abs(t.balance_after - t.balance_before) <> t.amount
    `,
  },
  {
    id: "R2",
    title: "Driver cash covers attributed outstanding (unattributed cash U >= 0)",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'DRIVER' AS entity_type, a.driver_id::text AS entity_id,
             ('>= ' || o.outstanding::text) AS expected, a.current_balance::text AS actual,
             'driver cash is below the outstanding amount of its pending settlement-mode collections' AS detail,
             ${FR} AS origin
      FROM driver_cash_accounts a
      JOIN (SELECT r.driver_id, SUM(r.collection_amount - r.allocated_amount) AS outstanding
            FROM order_financial_releases r WHERE ${PENDING_RELEASE_HOLDS_CASH} GROUP BY r.driver_id) o
        ON o.driver_id = a.driver_id
      WHERE a.current_balance < o.outstanding
    `,
  },
  {
    id: "R3",
    title: "Release allocated amount equals its active allocations, within 0..collection",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'FINANCIAL_RELEASE' AS entity_type, r.id::text AS entity_id,
             COALESCE(s.active, 0)::text AS expected, r.allocated_amount::text AS actual,
             CASE WHEN r.allocated_amount <> COALESCE(s.active, 0) THEN 'allocated_amount differs from the sum of active allocations'
                  ELSE 'allocated_amount outside 0..collection_amount' END AS detail,
             ${FR} AS origin
      FROM order_financial_releases r
      LEFT JOIN (SELECT release_id, SUM(amount) AS active FROM driver_settlement_allocations
                 WHERE reversed_by_correction_id IS NULL GROUP BY release_id) s ON s.release_id = r.id
      WHERE r.allocated_amount <> COALESCE(s.active, 0) OR r.allocated_amount < 0 OR r.allocated_amount > r.collection_amount
    `,
  },
  {
    id: "R4",
    title: "Settlement allocated total and unattributed amount reconcile to the amount received",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'DRIVER_SETTLEMENT' AS entity_type, d.id::text AS entity_id,
             CASE WHEN d.allocated_total IS NULL THEN 'no allocations (legacy format)'
                  ELSE COALESCE(s.total, 0)::text || ' allocated; ' || d.amount_received::text || ' received' END AS expected,
             CASE WHEN d.allocated_total IS NULL THEN COALESCE(s.total, 0)::text || ' allocated'
                  ELSE d.allocated_total::text || ' + ' || d.unattributed_amount::text END AS actual,
             CASE WHEN d.allocated_total IS NULL THEN 'legacy-format settlement has allocations'
                  WHEN d.allocated_total <> COALESCE(s.total, 0) THEN 'allocated_total differs from the sum of its allocations'
                  ELSE 'amount_received differs from allocated_total + unattributed_amount' END AS detail,
             ${FR} AS origin
      FROM driver_settlements d
      LEFT JOIN (SELECT settlement_id, SUM(amount) AS total FROM driver_settlement_allocations GROUP BY settlement_id) s
        ON s.settlement_id = d.id
      WHERE (d.allocated_total IS NOT NULL AND (d.allocated_total <> COALESCE(s.total, 0)
               OR d.amount_received <> d.allocated_total + d.unattributed_amount))
         OR (d.allocated_total IS NULL AND s.total IS NOT NULL)
    `,
  },
  {
    id: "R5",
    title: "Released postings match the planned amounts exactly",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'FINANCIAL_RELEASE' AS entity_type, r.id::text AS entity_id,
             'wallet=' || COALESCE(r.planned_customer_wallet_amount::text, '?') || ' product=' || COALESCE(r.planned_company_product_amount::text, '?')
               || ' fee=' || COALESCE(r.planned_company_fee_amount::text, '?') || ' (sum=' || r.collection_amount::text || ')' AS expected,
             'wallet=' || COALESCE(w.credit::text, '-') || ' product=' || COALESCE(p.amount::text, '-') || ' fee=' || COALESCE(f.amount::text, '-') AS actual,
             'posted wallet / company rows do not match the release''s planned amounts' AS detail,
             ${FR} AS origin
      FROM order_financial_releases r
      LEFT JOIN wallet_transactions w ON w.id = r.wallet_transaction_id
      LEFT JOIN company_financial_transactions p ON p.id = r.company_product_transaction_id
      LEFT JOIN company_financial_transactions f ON f.id = r.company_fee_transaction_id
      WHERE r.release_status IN ('RELEASED', 'RELEASE_REVERSED') AND (
           r.planned_customer_wallet_amount IS NULL
        OR r.planned_customer_wallet_amount + r.planned_company_product_amount + r.planned_company_fee_amount <> r.collection_amount
        OR (r.planned_customer_wallet_amount > 0 AND (w.id IS NULL OR w.type <> 'ORDER_CREDIT' OR w.order_id IS DISTINCT FROM r.order_id
              OR w.customer_id <> r.customer_id OR w.credit <> r.planned_customer_wallet_amount))
        OR (r.planned_customer_wallet_amount = 0 AND r.wallet_transaction_id IS NOT NULL)
        OR (r.planned_company_product_amount > 0 AND (p.id IS NULL OR p.type <> 'COMPANY_ORDER_PRODUCT_REVENUE'
              OR p.order_id IS DISTINCT FROM r.order_id OR p.amount <> r.planned_company_product_amount))
        OR (r.planned_company_product_amount = 0 AND r.company_product_transaction_id IS NOT NULL)
        OR (r.planned_company_fee_amount > 0 AND (f.id IS NULL OR f.type <> 'DELIVERY_FEE_REVENUE'
              OR f.order_id IS DISTINCT FROM r.order_id OR f.amount <> r.planned_company_fee_amount))
        OR (r.planned_company_fee_amount = 0 AND r.company_fee_transaction_id IS NOT NULL)
      )
    `,
  },
  {
    id: "R6",
    title: "Settlement-mode ownership postings match the release state",
    kind: "INVARIANT",
    sql: Prisma.sql`
      WITH orig AS (
        SELECT order_id, id FROM wallet_transactions WHERE type = 'ORDER_CREDIT' AND order_id IS NOT NULL
        UNION ALL
        SELECT order_id, id FROM company_financial_transactions
        WHERE type IN ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') AND order_id IS NOT NULL
      ),
      per AS (
        SELECT r.id, r.release_status,
               num_nonnulls(r.wallet_transaction_id, r.company_product_transaction_id, r.company_fee_transaction_id) AS n_ref,
               COUNT(o.id) AS n_orig,
               COUNT(o.id) FILTER (WHERE o.id IN (r.wallet_transaction_id, r.company_product_transaction_id, r.company_fee_transaction_id)) AS n_ref_orig
        FROM order_financial_releases r LEFT JOIN orig o ON o.order_id = r.order_id
        GROUP BY r.id
      ),
      reversed AS (
        SELECT r.id,
               (r.wallet_transaction_id IS NOT NULL AND (
                  (SELECT COUNT(*) FROM wallet_transactions x WHERE x.reversal_of_id = r.wallet_transaction_id) <> 1
                  OR NOT EXISTS (SELECT 1 FROM wallet_transactions x JOIN wallet_transactions o2 ON o2.id = r.wallet_transaction_id
                                 WHERE x.id = c.wallet_reversal_transaction_id AND x.reversal_of_id = o2.id AND x.debit = o2.credit)))
            OR (r.company_product_transaction_id IS NOT NULL AND (
                  (SELECT COUNT(*) FROM company_financial_transactions x WHERE x.reversal_of_id = r.company_product_transaction_id) <> 1
                  OR NOT EXISTS (SELECT 1 FROM company_financial_transactions x JOIN company_financial_transactions o2 ON o2.id = r.company_product_transaction_id
                                 WHERE x.id = c.company_product_reversal_transaction_id AND x.reversal_of_id = o2.id AND x.amount = -o2.amount)))
            OR (r.company_fee_transaction_id IS NOT NULL AND (
                  (SELECT COUNT(*) FROM company_financial_transactions x WHERE x.reversal_of_id = r.company_fee_transaction_id) <> 1
                  OR NOT EXISTS (SELECT 1 FROM company_financial_transactions x JOIN company_financial_transactions o2 ON o2.id = r.company_fee_transaction_id
                                 WHERE x.id = c.company_fee_reversal_transaction_id AND x.reversal_of_id = o2.id AND x.amount = -o2.amount))) AS bad
        FROM order_financial_releases r
        LEFT JOIN order_financial_release_corrections c ON c.release_id = r.id
        WHERE r.release_status = 'RELEASE_REVERSED'
      ),
      released_reversed_early AS (
        SELECT r.id FROM order_financial_releases r
        WHERE r.release_status = 'RELEASED' AND (
             EXISTS (SELECT 1 FROM wallet_transactions x WHERE x.reversal_of_id = r.wallet_transaction_id)
          OR EXISTS (SELECT 1 FROM company_financial_transactions x
                     WHERE x.reversal_of_id IN (r.company_product_transaction_id, r.company_fee_transaction_id)))
      )
      SELECT 'FINANCIAL_RELEASE' AS entity_type, p.id::text AS entity_id,
             CASE WHEN p.release_status IN ('PENDING', 'VOIDED') THEN '0 ownership postings'
                  ELSE p.n_ref::text || ' referenced postings' END AS expected,
             p.n_orig::text || ' ownership postings (' || p.n_ref_orig::text || ' referenced)' AS actual,
             CASE WHEN p.release_status IN ('PENDING', 'VOIDED') THEN 'ownership postings exist although the release was never released'
                  ELSE 'ownership postings of the order are not exactly the release''s referenced postings' END AS detail,
             ${FR} AS origin
      FROM per p
      WHERE (p.release_status IN ('PENDING', 'VOIDED') AND p.n_orig > 0)
         OR (p.release_status IN ('RELEASED', 'RELEASE_REVERSED') AND (p.n_orig <> p.n_ref_orig OR p.n_ref_orig <> p.n_ref))
      UNION ALL
      SELECT 'FINANCIAL_RELEASE', v.id::text, 'one recorded reversal per posting, referenced by the correction', 'mismatch',
             'release reversal postings do not net the released postings to zero', ${FR}
      FROM reversed v WHERE v.bad
      UNION ALL
      SELECT 'FINANCIAL_RELEASE', e.id::text, 'no reversal while RELEASED', 'reversal exists',
             'a released posting was reversed outside the release-reversal workflow', ${FR}
      FROM released_reversed_early e
    `,
  },
  {
    id: "R7",
    title: "At most one original ownership posting per order and category",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'ORDER' AS entity_type, x.order_id::text AS entity_id, '1' AS expected, COUNT(*)::text AS actual,
             x.category || ' posted more than once for this order' AS detail,
             ${orderOrigin(Prisma.sql`x.order_id`)} AS origin
      FROM (
        SELECT order_id, 'ORDER_CREDIT' AS category FROM wallet_transactions WHERE type = 'ORDER_CREDIT' AND order_id IS NOT NULL
        UNION ALL
        SELECT order_id, type::text FROM company_financial_transactions
        WHERE type IN ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') AND order_id IS NOT NULL
      ) x
      GROUP BY x.order_id, x.category
      HAVING COUNT(*) > 1
    `,
  },
  {
    id: "R8",
    title: "No customer credit for a Company Order; no product revenue for a Delivery Only order",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'WALLET_TRANSACTION' AS entity_type, w.id::text AS entity_id, 'no ORDER_CREDIT' AS expected, w.credit::text AS actual,
             'customer wallet credit posted for a COMPANY_ORDER' AS detail, ${orderOrigin(Prisma.sql`o.id`)} AS origin
      FROM wallet_transactions w JOIN orders o ON o.id = w.order_id
      WHERE w.type = 'ORDER_CREDIT' AND o.order_type = 'COMPANY_ORDER'
      UNION ALL
      SELECT 'COMPANY_FINANCIAL_TRANSACTION', c.id::text, 'no product revenue', c.amount::text,
             'company product revenue posted for a DELIVERY_ONLY order', ${orderOrigin(Prisma.sql`o.id`)}
      FROM company_financial_transactions c JOIN orders o ON o.id = c.order_id
      WHERE c.type = 'COMPANY_ORDER_PRODUCT_REVENUE' AND o.order_type = 'DELIVERY_ONLY'
    `,
  },
  {
    id: "R9",
    title: "Only settlement-mode orders have financial releases",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'FINANCIAL_RELEASE' AS entity_type, r.id::text AS entity_id, 'ON_SETTLEMENT' AS expected,
             COALESCE(o.financial_release_mode::text, 'NULL (legacy)') AS actual,
             'a release exists for an order that is not in settlement mode' AS detail, ${FR} AS origin
      FROM order_financial_releases r JOIN orders o ON o.id = r.order_id
      WHERE o.financial_release_mode IS DISTINCT FROM 'ON_SETTLEMENT'
    `,
  },
  {
    id: "R10",
    title: "Release collection matches its COLLECTION row and its order",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'FINANCIAL_RELEASE' AS entity_type, r.id::text AS entity_id, r.collection_amount::text AS expected,
             'collection_row=' || COALESCE(t.amount::text, 'missing') || ' order_actual=' || COALESCE(o.actual_amount_collected::text, 'NULL') AS actual,
             'release does not match its driver cash COLLECTION row or its order (amount, order, driver, customer, type or delivery date)' AS detail,
             ${FR} AS origin
      FROM order_financial_releases r
      JOIN orders o ON o.id = r.order_id
      LEFT JOIN driver_cash_transactions t ON t.id = r.collection_transaction_id
      WHERE t.id IS NULL OR t.type <> 'COLLECTION' OR t.order_id IS DISTINCT FROM r.order_id OR t.driver_id <> r.driver_id
         OR t.amount <> r.collection_amount OR o.actual_amount_collected IS DISTINCT FROM r.collection_amount
         OR o.customer_id <> r.customer_id OR o.order_type <> r.order_type OR o.delivered_at IS DISTINCT FROM r.delivered_at
    `,
  },
  {
    id: "R11",
    title: "Settlement-mode order financial status matches its release state",
    kind: "INVARIANT",
    sql: Prisma.sql`
      WITH m AS (
        SELECT o.id, o.status, o.financial_status::text AS actual, o.needs_financial_review, r.id AS release_id,
               CASE WHEN r.id IS NULL THEN 'a financial release'
                    WHEN r.release_status = 'PENDING' AND r.review_status = 'AWAITING_REVIEW' THEN 'REVIEW_REQUIRED'
                    WHEN r.release_status = 'PENDING' THEN 'AWAITING_SETTLEMENT'
                    WHEN r.release_status = 'RELEASED' THEN 'FINALIZED'
                    WHEN r.release_status = 'VOIDED' THEN 'COLLECTION_VOIDED'
                    ELSE 'RELEASE_REVERSED' END AS expected
        FROM orders o LEFT JOIN order_financial_releases r ON r.order_id = o.id
        WHERE o.financial_release_mode = 'ON_SETTLEMENT'
      )
      SELECT 'ORDER' AS entity_type, m.id::text AS entity_id, m.expected || ' / DELIVERED' AS expected,
             m.actual || ' / ' || m.status::text || CASE WHEN m.needs_financial_review THEN ' / review flag' ELSE '' END AS actual,
             CASE WHEN m.release_id IS NULL THEN 'settlement-mode order has no financial release'
                  ELSE 'order status / financial status / review flag do not match the release state' END AS detail,
             ${FR} AS origin
      FROM m
      WHERE m.release_id IS NULL OR m.status <> 'DELIVERED' OR m.actual <> m.expected
         OR m.needs_financial_review <> (m.expected = 'REVIEW_REQUIRED')
    `,
  },
  {
    id: "R12",
    title: "Voided and reversed releases have their matching correction (and only they do)",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'FINANCIAL_RELEASE' AS entity_type, r.id::text AS entity_id,
             CASE WHEN r.release_status = 'VOIDED' THEN 'COLLECTION_VOID reversing the collection'
                  WHEN r.release_status = 'RELEASE_REVERSED' THEN 'RELEASE_REVERSAL correction'
                  WHEN c.id IS NOT NULL THEN 'no correction'
                  ELSE 'VOIDED (collection was reversed)' END AS expected,
             r.release_status::text || COALESCE(' + ' || c.correction_type::text, '') AS actual,
             CASE WHEN r.release_status NOT IN ('VOIDED', 'RELEASE_REVERSED') AND c.id IS NOT NULL THEN 'a non-terminal release carries a correction'
                  WHEN r.release_status IN ('VOIDED', 'RELEASE_REVERSED') THEN 'terminal release lacks its matching correction'
                  ELSE 'the release''s COLLECTION was reversed outside the void workflow (pre-FR.6 generic reversal)' END AS detail,
             ${FR} AS origin
      FROM order_financial_releases r
      LEFT JOIN order_financial_release_corrections c ON c.release_id = r.id
      LEFT JOIN driver_cash_transactions v ON v.id = c.driver_cash_reversal_transaction_id
      WHERE (r.release_status = 'VOIDED' AND (c.id IS NULL OR c.correction_type <> 'COLLECTION_VOID'
               OR v.reversal_of_id IS DISTINCT FROM r.collection_transaction_id))
         OR (r.release_status = 'RELEASE_REVERSED' AND (c.id IS NULL OR c.correction_type <> 'RELEASE_REVERSAL'))
         OR (r.release_status NOT IN ('VOIDED', 'RELEASE_REVERSED') AND c.id IS NOT NULL)
         OR (r.release_status <> 'VOIDED' AND EXISTS (SELECT 1 FROM driver_cash_transactions x WHERE x.reversal_of_id = r.collection_transaction_id))
    `,
  },
  {
    id: "R13",
    title: "Wallet cached balance equals its ledger; payouts and settlements touch only their own ledger",
    kind: "INVARIANT",
    sql: Prisma.sql`
      SELECT 'CUSTOMER_WALLET' AS entity_type, w.customer_id::text AS entity_id, COALESCE(t.net, 0)::text AS expected,
             w.available_balance::text AS actual, 'cached available_balance differs from the net of the wallet ledger' AS detail,
             ${customerOrigin(Prisma.sql`w.customer_id`)} AS origin
      FROM customer_wallets w
      LEFT JOIN (SELECT wallet_id, SUM(credit - debit) AS net FROM wallet_transactions GROUP BY wallet_id) t ON t.wallet_id = w.id
      WHERE w.available_balance <> COALESCE(t.net, 0)
      UNION ALL
      SELECT 'CUSTOMER_PAYOUT', p.id::text, p.amount::text || ' wallet PAYOUT debit', COALESCE(x.debit::text, 'missing'),
             'payout is not matched by exactly its wallet PAYOUT debit', ${customerOrigin(Prisma.sql`p.customer_id`)}
      FROM customer_payouts p
      LEFT JOIN wallet_transactions x ON x.payout_id = p.id AND x.type = 'PAYOUT'
      WHERE p.status IN ('COMPLETED', 'REVERSED') AND (x.id IS NULL OR x.debit <> p.amount OR x.customer_id <> p.customer_id)
      UNION ALL
      SELECT 'DRIVER_SETTLEMENT', d.id::text, d.amount_received::text || ' driver cash SETTLEMENT debit', COALESCE(x.amount::text, 'missing'),
             'settlement is not matched by exactly its driver cash SETTLEMENT debit',
             CASE WHEN d.allocated_total IS NOT NULL THEN 'FINANCIAL_RELEASE' ELSE 'LEGACY' END
      FROM driver_settlements d
      LEFT JOIN driver_cash_transactions x ON x.settlement_id = d.id
      WHERE x.id IS NULL OR x.type <> 'SETTLEMENT' OR x.amount <> d.amount_received OR x.driver_id <> d.driver_id
    `,
  },
  {
    id: "R14",
    title: "Historical liability register: approved resolutions and recorded liabilities validate; no historical ledger posting exists",
    kind: "INVARIANT",
    sql: (_hr, ho) =>
      ho
        ? Prisma.sql`
            ${Prisma.raw(historicalOwnershipWith())}
            SELECT CASE WHEN h.liability_id IS NULL THEN 'HISTORICAL_OWNERSHIP_RESOLUTION' ELSE 'HISTORICAL_LIABILITY' END AS entity_type,
                   COALESCE(h.liability_id, h.id)::text AS entity_id,
                   'valid approved evidence' AS expected,
                   array_to_string(h.failures, ', ') AS actual,
                   CASE WHEN h.liability_id IS NULL
                        THEN 'approved historical ownership resolution no longer validates (' || h.status || ')'
                        ELSE 'recorded historical liability ' || h.recognized_amount::text || ' no longer validates (' || h.status || ')' END AS detail,
                   'LEGACY' AS origin
            FROM ho_evaluated h
            WHERE ${Prisma.raw(INVALID_RESOLUTIONS_WHERE)}
            UNION ALL
            SELECT 'HISTORICAL_LIABILITY', rr.liability_id::text, 'revoked by an Admin other than the recorder', rr.decided_by_id::text,
                   'the resolution was revoked by the user who recorded its liability (separation of duties)', 'LEGACY'
            FROM (${Prisma.raw(REVOKED_BY_RECORDER_SQL)}) rr
            UNION ALL
            SELECT 'WALLET_TRANSACTION', w.id::text, 'no historical posting', w.idempotency_key,
                   'wallet row in the historical liability / ownership key namespace (recording a liability posts nothing)', 'LEGACY'
            FROM wallet_transactions w
            WHERE w.idempotency_key LIKE 'historical-liability:%' OR w.idempotency_key LIKE 'historical-ownership:%'
            UNION ALL
            SELECT 'COMPANY_FINANCIAL_TRANSACTION', c.id::text, 'no historical posting', c.idempotency_key,
                   'company row in the historical liability / ownership key namespace (recording a liability posts nothing)', 'LEGACY'
            FROM company_financial_transactions c
            WHERE c.idempotency_key LIKE 'historical-liability:%' OR c.idempotency_key LIKE 'historical-ownership:%'
            UNION ALL
            SELECT 'DRIVER_CASH_TRANSACTION', x.id::text, 'no historical posting', x.idempotency_key,
                   'driver cash row in the historical liability / ownership key namespace (recording a liability posts nothing)', 'LEGACY'
            FROM driver_cash_transactions x
            WHERE x.idempotency_key LIKE 'historical-liability:%' OR x.idempotency_key LIKE 'historical-ownership:%'
          `
        : Prisma.sql`SELECT NULL::text AS entity_type, NULL::text AS entity_id, NULL::text AS expected, NULL::text AS actual,
                            NULL::text AS detail, NULL::text AS origin WHERE false`,
  },
  {
    id: "H1",
    title: "Category postings without an order (not attributable to any delivery or release)",
    kind: "HISTORICAL",
    sql: Prisma.sql`
      SELECT 'COMPANY_FINANCIAL_TRANSACTION' AS entity_type, c.id::text AS entity_id, 'an order' AS expected, 'no order' AS actual,
             c.type::text || ' row without an order (' || c.amount::text || ', ' || to_char(c.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || ')' AS detail,
             'LEGACY' AS origin
      FROM company_financial_transactions c
      WHERE c.type IN ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') AND c.order_id IS NULL
      UNION ALL
      SELECT 'WALLET_TRANSACTION', w.id::text, 'an order', 'no order', 'ORDER_CREDIT row without an order', 'LEGACY'
      FROM wallet_transactions w WHERE w.type = 'ORDER_CREDIT' AND w.order_id IS NULL
    `,
  },
  {
    id: "H2",
    title: "Revenue postings with a non-positive amount",
    kind: "HISTORICAL",
    sql: Prisma.sql`
      SELECT 'COMPANY_FINANCIAL_TRANSACTION' AS entity_type, c.id::text AS entity_id, '> 0' AS expected, c.amount::text AS actual,
             c.type::text || ' row with a non-positive amount' AS detail,
             CASE WHEN c.order_id IS NULL THEN 'LEGACY' ELSE ${orderOrigin(Prisma.sql`c.order_id`)} END AS origin
      FROM company_financial_transactions c
      WHERE c.type IN ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') AND c.amount <= 0
    `,
  },
  {
    id: "H3",
    title: "Driver cash balance-chain discontinuities not explained by a valid approved historical reconciliation",
    kind: "HISTORICAL",
    sql: (hr) => Prisma.sql`
      ${Prisma.raw(driverCashReconciliationWith(hr))}, ${Prisma.raw(UNEXPLAINED_CHAIN_BREAKS)}
      SELECT 'DRIVER_CASH_TRANSACTION' AS entity_type, b.id::text AS entity_id,
             b.expected_before::text AS expected, b.balance_before::text AS actual,
             CASE WHEN b.ambiguous_order
                  THEN 'AMBIGUOUS_ORDER: chain discontinuity of ' || b.jump::text
                       || ' at a timestamp shared with another row of the account — ordering cannot be proven; requires further evidence'
                  ELSE 'UNEXPLAINED_GAP: chain discontinuity of ' || b.jump::text
                       || ' not covered by a valid approved historical reconciliation' END AS detail,
             ${driverOrigin(Prisma.sql`b.driver_id`)} AS origin
      FROM dc_breaks b
    `,
  },
  {
    id: "I1",
    title: "Financial releases by status (observation)",
    kind: "INFORMATIONAL",
    sql: Prisma.sql`
      SELECT 'RELEASE_STATUS' AS entity_type, r.release_status::text || '/' || r.review_status::text AS entity_id, NULL::text AS expected,
             COUNT(*)::text AS actual, 'number of releases in this state' AS detail, 'OBSERVATION' AS origin
      FROM order_financial_releases r GROUP BY r.release_status, r.review_status
    `,
  },
  {
    id: "I2",
    title: "Drivers holding unattributed cash (relevant to activation gate G2)",
    kind: "INFORMATIONAL",
    sql: Prisma.sql`
      SELECT 'DRIVER' AS entity_type, a.driver_id::text AS entity_id, NULL::text AS expected,
             (a.current_balance - COALESCE(o.outstanding, 0))::text AS actual,
             'unattributed driver cash (legacy collections, adjustments, corrections)' AS detail, 'OBSERVATION' AS origin
      FROM driver_cash_accounts a
      LEFT JOIN (SELECT r.driver_id, SUM(r.collection_amount - r.allocated_amount) AS outstanding
                 FROM order_financial_releases r WHERE ${PENDING_RELEASE_HOLDS_CASH} GROUP BY r.driver_id) o ON o.driver_id = a.driver_id
      WHERE a.current_balance - COALESCE(o.outstanding, 0) > 0
    `,
  },
  {
    id: "I3",
    title: "Driver cash raw discrepancy and approved historical reconciliation (always visible)",
    kind: "INFORMATIONAL",
    sql: (hr) => Prisma.sql`
      ${Prisma.raw(driverCashReconciliationWith(hr))}
      SELECT 'DRIVER_CASH_ACCOUNT' AS entity_type, d.driver_id::text AS entity_id,
             'raw discrepancy ' || d.raw_discrepancy::text AS expected,
             'approved historical reconciliation ' || d.approved_historical_amount::text
               || ', unexplained residual ' || d.unexplained_residual::text
               || ', invalid historical approvals ' || d.invalid_approved_count::text AS actual,
             'stored minus raw ledger net, shown even when explained; an approved historical reconciliation is evidence only and never a posting' AS detail,
             'OBSERVATION' AS origin
      FROM dc_accounts d
      WHERE d.raw_discrepancy <> 0 OR d.reconciliation_count > 0
    `,
  },
];

function classify(kind: CheckKind, origin: string): FindingClassification {
  if (kind === "INFORMATIONAL") return "OBSERVATION";
  return origin === "FINANCIAL_RELEASE" ? "FINANCIAL_RELEASE_VIOLATION" : "HISTORICAL_ANOMALY";
}

async function runCheck(
  tx: Prisma.TransactionClient,
  check: CheckDefinition,
  historicalSchemaPresent: boolean,
  ownershipSchemaPresent: boolean
): Promise<ReconciliationCheckResult> {
  const sql = typeof check.sql === "function" ? check.sql(historicalSchemaPresent, ownershipSchemaPresent) : check.sql;
  const rows = await tx.$queryRaw<FindingRow[]>`
    SELECT f.entity_type, f.entity_id, f.expected, f.actual, f.detail, f.origin,
           (COUNT(*) OVER ())::int AS total,
           (COUNT(*) FILTER (WHERE f.origin = 'FINANCIAL_RELEASE') OVER ())::int AS fr_total
    FROM (${sql}) f
    ORDER BY f.origin ASC, f.entity_type ASC, f.entity_id ASC
    LIMIT ${RECONCILIATION_SAMPLE_LIMIT}
  `;
  const total = rows[0]?.total ?? 0;
  const frTotal = rows[0]?.fr_total ?? 0;
  const isInfo = check.kind === "INFORMATIONAL";
  return {
    id: check.id,
    title: check.title,
    kind: check.kind,
    status: isInfo ? "INFO" : total === 0 ? "PASS" : "FAIL",
    blocksActivation: check.kind === "INVARIANT" && total > 0,
    affectedCount: total,
    financialReleaseViolationCount: isInfo ? 0 : frTotal,
    historicalAnomalyCount: isInfo ? 0 : total - frTotal,
    findings: rows.map((r) => ({
      entityType: r.entity_type,
      entityId: r.entity_id,
      expected: r.expected,
      actual: r.actual,
      detail: r.detail,
      classification: classify(check.kind, r.origin),
    })),
    truncated: total > rows.length,
  };
}

// Runs every check in the CALLER's transaction — the read endpoint uses a
// read-only snapshot; the FR.11 activation gate (G6) runs it inside the
// activation transaction, after its locks are taken.
export async function runReconciliationChecks(tx: Prisma.TransactionClient): Promise<ReconciliationCheckResult[]> {
  // Sequential: one connection, and a predictable statement order.
  const historicalSchemaPresent = await isHistoricalReconciliationSchemaPresent(tx);
  const ownershipSchemaPresent = historicalSchemaPresent && (await isHistoricalOwnershipSchemaPresent(tx));
  const results: ReconciliationCheckResult[] = [];
  for (const check of CHECKS) results.push(await runCheck(tx, check, historicalSchemaPresent, ownershipSchemaPresent));
  return results;
}

export async function getFinancialReleaseReconciliation(): Promise<ReconciliationReport> {
  const { checks, driverCashHistoricalReconciliation } = await readSnapshot(async (tx) => ({
    checks: await runReconciliationChecks(tx),
    driverCashHistoricalReconciliation: await getDriverCashHistoricalReconciliationSummary(tx),
  }));
  const invariant = checks.filter((c) => c.kind === "INVARIANT");
  return {
    generatedAt: new Date().toISOString(),
    consistency: "SINGLE_SNAPSHOT_REPEATABLE_READ",
    sampleLimit: RECONCILIATION_SAMPLE_LIMIT,
    summary: {
      checksRun: checks.length,
      invariantChecksFailed: invariant.filter((c) => c.status === "FAIL").length,
      financialReleaseViolations: checks.reduce((s, c) => s + c.financialReleaseViolationCount, 0),
      historicalAnomalies: checks.reduce((s, c) => s + c.historicalAnomalyCount, 0),
      activationBlocked: invariant.some((c) => c.status === "FAIL"),
    },
    checks,
    driverCashHistoricalReconciliation,
  };
}
