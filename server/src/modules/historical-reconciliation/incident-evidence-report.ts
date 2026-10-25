// ============================================================
// FR.12A.8b — Historical incident evidence-recovery report (READ ONLY).
//
// Offline investigation aid for Finance: given the reference of an order that
// was deleted while its collection difference was unresolved, it gathers the
// surviving evidence (the difference audit, every other audit naming the
// order, the driver cash chain jump and the settlement around it, the
// driver's surviving deliveries that UTC day) and lists POTENTIAL replacement
// orders with the individual signals that matched, plus their ledger
// movements, assignment history, the payouts of their customers and the
// incident driver's settlements.
//
// It never identifies a replacement. A candidate is only an order that shows
// at least one content signal (amount, nothing to collect, back-entered,
// mentions the deleted reference, replacement wording) inside the window;
// driver identity and order type are annotations, never selection criteria.
// `replacementIdentified` is always false: identification is a Finance
// decision on documentary evidence (docs/fr12a8-… §5, F1).
//
// Every statement is a single SELECT bound to ($1 order reference, $2 days
// before, $3 days after the recorded delivery). The same text is what
// renderOperatorSql() prints for an authorized operator. No receiver,
// customer or user names, phones, addresses or free text are selected —
// free text only feeds boolean signals.
// ============================================================

export type EvidenceQuery = (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>;

export interface EvidenceWindow {
  daysBefore: number;
  daysAfter: number;
}

export const DEFAULT_EVIDENCE_WINDOW: EvidenceWindow = { daysBefore: 7, daysAfter: 30 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_WINDOW_DAYS = 366;

export function validateEvidenceInput(orderRef: string, window: EvidenceWindow): void {
  if (!UUID_RE.test(orderRef)) throw new Error("order reference must be a lowercase UUID");
  for (const [k, v] of Object.entries(window)) {
    if (!Number.isInteger(v) || v < 0 || v > MAX_WINDOW_DAYS) throw new Error(`${k} must be an integer between 0 and ${MAX_WINDOW_DAYS}`);
  }
}

// Generated SQL is kept to short lines, one select item per line: operators
// copy it from terminals and documents that wrap long lines, and a wrap at a
// token boundary can drop the separating space (SELECTto_at → 42601).
const num = (expr: string) => `CASE WHEN (${expr}) ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (${expr})::numeric END`;
const utc = (expr: string) => `to_char((${expr}) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// The surviving, unresolved collection-difference audit of the deleted order
// (earliest one if several — E1S then reports STOP).
const INCIDENT_CTE = `
inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    ${num("l.metadata ->> 'expectedAmount'")} AS expected_amount,
    ${num("l.metadata ->> 'actualAmount'")} AS actual_amount,
    abs(${num("l.metadata ->> 'difference'")}) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = $1::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = $1::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => $2::int) AS from_at,
    recorded_at + make_interval(days => $3::int) AS to_at
  FROM inc
)`;

const ORDER_TEXT = `concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes)`;
const HISTORY_TEXT = `(SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id)`;
const DRIVER_MATCH = "x.order_id = o.id AND x.driver_id = inc.driver_id";

// Orders created inside the window, each signal computed independently.
const CANDIDATE_CTE = `
${INCIDENT_CTE},
win_orders AS (
  SELECT
    o.*,
    (EXISTS (SELECT 1 FROM order_assignments x WHERE ${DRIVER_MATCH})
      OR EXISTS (SELECT 1 FROM delivery_attempts x WHERE ${DRIVER_MATCH}))
      AS s_incident_driver_delivery,
    EXISTS (SELECT 1 FROM parcel_collection_assignments x
            WHERE ${DRIVER_MATCH})
      AS s_incident_driver_collection,
    (o.order_type::text = inc.order_type) AS s_same_order_type,
    (o.amount_to_collect = inc.expected_amount
      OR o.order_amount + o.delivery_fee = inc.expected_amount) AS s_expected_total,
    (o.amount_to_collect = inc.actual_amount
      OR o.actual_amount_collected = inc.actual_amount) AS s_actual_amount,
    (o.amount_to_collect = inc.difference_abs
      OR o.actual_amount_collected = inc.difference_abs) AS s_difference_amount,
    (o.amount_to_collect = 0 OR o.payment_type = 'ALREADY_PAID') AS s_nothing_to_collect,
    (o.delivered_at IS NOT NULL
      AND o.delivered_at - o.created_at <= interval '30 minutes') AS s_back_entered,
    (${ORDER_TEXT}
        ILIKE '%' || left($1::text, 8) || '%'
      OR coalesce(${HISTORY_TEXT}, '')
        ILIKE '%' || left($1::text, 8) || '%'
      OR EXISTS (
        SELECT 1 FROM audit_logs z
        WHERE z.entity_type = 'ORDER' AND z.entity_id = o.id::text
          AND concat_ws(' ', z.metadata::text, z.previous_values::text, z.new_values::text)
            LIKE '%' || $1::text || '%'))
      AS s_mentions_deleted_reference,
    (concat_ws(' ', ${ORDER_TEXT},
        ${HISTORY_TEXT})
      ~* '(replac|re-?enter|re-?creat|duplicat|delet|resubmit)') AS s_replacement_wording
  FROM orders o
  CROSS JOIN inc
  CROSS JOIN win
  WHERE o.created_at >= win.from_at
    AND o.created_at < win.to_at
    AND o.id::text <> $1::text
),
cand AS (
  SELECT * FROM win_orders
  WHERE s_expected_total OR s_actual_amount OR s_difference_amount
     OR s_nothing_to_collect OR s_back_entered
     OR s_mentions_deleted_reference OR s_replacement_wording
)`;

export interface EvidenceQueryDef {
  id: string;
  title: string;
  sql: string;
}

export const INCIDENT_EVIDENCE_QUERIES: EvidenceQueryDef[] = [
  {
    id: "E1S",
    title: "Unresolved collection-difference audit(s) of the deleted order (must be exactly one)",
    sql: `
SELECT
  l.id::text AS audit_id,
  ${utc("l.created_at")} AS recorded_at_utc,
  l.metadata ->> 'orderType' AS order_type,
  l.metadata ->> 'expectedAmount' AS expected_amount,
  l.metadata ->> 'actualAmount' AS actual_amount,
  l.metadata ->> 'difference' AS difference,
  l.metadata ->> 'driverCashTransactionId' AS original_cash_transaction_id,
  EXISTS (SELECT 1 FROM driver_cash_transactions x
          WHERE x.id::text = l.metadata ->> 'driverCashTransactionId') AS cash_row_still_exists,
  EXISTS (SELECT 1 FROM orders o WHERE o.id::text = l.entity_id) AS order_still_exists,
  EXISTS (SELECT 1 FROM audit_logs z
          WHERE z.entity_type = 'ORDER' AND z.entity_id = l.entity_id
            AND z.action = 'COLLECTION_DIFFERENCE_RESOLVED') AS resolved,
  l.metadata ->> 'collectionRoute' AS collection_route,
  r.code AS actor_role,
  dr.id::text AS driver_id,
  dr.driver_number
FROM audit_logs l
LEFT JOIN users u ON u.id = l.actor_user_id
LEFT JOIN roles r ON r.id = u.role_id
LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
  AND l.entity_type = 'ORDER'
  AND l.entity_id = $1::text
  AND $2::int >= 0
  AND $3::int >= 0
ORDER BY l.created_at, l.id`,
  },
  {
    id: "E3S",
    title: "Every surviving audit that names the deleted order (no payload content)",
    sql: `
SELECT
  l.id::text AS audit_id,
  ${utc("l.created_at")} AS at_utc,
  l.action,
  l.entity_type,
  r.code AS actor_role,
  (l.entity_id = $1::text) AS is_entity,
  (coalesce(l.metadata::text, '')
    LIKE '%' || $1::text || '%') AS in_metadata,
  (concat_ws(' ', l.previous_values::text, l.new_values::text)
    LIKE '%' || $1::text || '%') AS in_values
FROM audit_logs l
LEFT JOIN users u ON u.id = l.actor_user_id
LEFT JOIN roles r ON r.id = u.role_id
WHERE $2::int >= 0
  AND $3::int >= 0
  AND (l.entity_id = $1::text
    OR concat_ws(' ', l.metadata::text, l.previous_values::text, l.new_values::text)
      LIKE '%' || $1::text || '%')
ORDER BY l.created_at, l.id`,
  },
  {
    id: "E5S",
    title: "Balance-chain jumps on the incident driver's cash account, with the settlement row they fall on",
    sql: `
WITH ${INCIDENT_CTE},
seq AS (
  SELECT
    t.*,
    lag(t.balance_after) OVER (ORDER BY t.created_at, t.id) AS prev_after
  FROM driver_cash_transactions t
  JOIN inc ON inc.account_id = t.account_id
)
SELECT
  s.id::text AS ledger_row_id,
  ${utc("s.created_at")} AS at_utc,
  s.type::text AS type,
  s.amount::text AS amount,
  s.balance_before::text AS balance_before,
  s.balance_after::text AS balance_after,
  (s.balance_before - coalesce(s.prev_after, 0))::text AS chain_jump,
  ((s.balance_before - coalesce(s.prev_after, 0)) = inc.actual_amount) AS jump_equals_actual_amount,
  (s.created_at >= inc.recorded_at) AS after_recorded_delivery,
  ds.settlement_number,
  ds.amount_received::text AS settlement_amount_received
FROM seq s
CROSS JOIN inc
LEFT JOIN driver_settlements ds ON ds.id = s.settlement_id
WHERE s.balance_before <> coalesce(s.prev_after, 0)
ORDER BY s.created_at, s.id`,
  },
  {
    id: "E6S",
    title: "Surviving deliveries by the incident driver on the same UTC day (corroboration only)",
    sql: `
WITH ${INCIDENT_CTE}
SELECT
  o.order_number,
  c.customer_number,
  o.order_type::text AS order_type,
  o.payment_type::text AS payment_type,
  o.order_amount::text AS order_amount,
  o.delivery_fee::text AS delivery_fee,
  o.amount_to_collect::text AS amount_to_collect,
  o.actual_amount_collected::text AS actual_amount_collected,
  ${utc("o.created_at")} AS created_at_utc,
  ${utc("o.delivered_at")} AS delivered_at_utc
FROM orders o
CROSS JOIN inc
JOIN customers c ON c.id = o.customer_id
WHERE o.delivered_at IS NOT NULL
  AND (o.delivered_at AT TIME ZONE 'UTC')::date = (inc.recorded_at AT TIME ZONE 'UTC')::date
  AND (o.current_driver_id = inc.driver_id
    OR EXISTS (SELECT 1 FROM delivery_attempts x
               WHERE x.order_id = o.id AND x.driver_id = inc.driver_id
                 AND x.outcome = 'DELIVERED'))
ORDER BY o.delivered_at, o.id`,
  },
  {
    id: "E7",
    title: "POTENTIAL replacement orders in the window, with every signal shown separately (not identification)",
    sql: `
WITH ${CANDIDATE_CTE}
SELECT
  c.id::text AS order_id,
  c.order_number,
  cu.customer_number,
  c.order_type::text AS order_type,
  c.payment_type::text AS payment_type,
  c.status::text AS status,
  c.financial_status::text AS financial_status,
  c.financial_release_mode::text AS release_mode,
  c.order_amount::text AS order_amount,
  c.delivery_fee::text AS delivery_fee,
  c.prepaid_order_amount::text AS prepaid_order_amount,
  c.prepaid_delivery_fee::text AS prepaid_delivery_fee,
  c.amount_to_collect::text AS amount_to_collect,
  c.actual_amount_collected::text AS actual_amount_collected,
  ${utc("c.created_at")} AS created_at_utc,
  ${utc("c.delivered_at")} AS delivered_at_utc,
  c.s_expected_total,
  c.s_actual_amount,
  c.s_difference_amount,
  c.s_nothing_to_collect,
  c.s_back_entered,
  c.s_mentions_deleted_reference,
  c.s_replacement_wording,
  c.s_incident_driver_delivery,
  c.s_incident_driver_collection,
  c.s_same_order_type
FROM cand c
JOIN customers cu ON cu.id = c.customer_id
ORDER BY c.created_at, c.id`,
  },
  {
    id: "E8",
    title: "Ledger movements of the potential matches (driver cash, wallet, company, direct, release)",
    sql: `
WITH ${CANDIDATE_CTE}
SELECT
  m.order_number,
  m.ledger,
  m.type,
  m.amount,
  m.party,
  m.settlement_ref,
  m.settlement_basis,
  ${utc("m.at")} AS at_utc
FROM (
  SELECT
    c.order_number,
    'DRIVER_CASH' AS ledger,
    t.type::text AS type,
    t.amount::text AS amount,
    dr.driver_number AS party,
    coalesce(ds.settlement_number, nx.settlement_number) AS settlement_ref,
    CASE WHEN ds.id IS NOT NULL THEN 'linked'
         WHEN nx.settlement_number IS NOT NULL
           THEN 'next settlement on the account (positional only)'
    END AS settlement_basis,
    t.created_at AS at
  FROM cand c
  JOIN driver_cash_transactions t ON t.order_id = c.id
  JOIN drivers dr ON dr.id = t.driver_id
  LEFT JOIN driver_settlements ds ON ds.id = t.settlement_id
  LEFT JOIN LATERAL (
    SELECT s2.settlement_number
    FROM driver_cash_transactions n
    JOIN driver_settlements s2 ON s2.id = n.settlement_id
    WHERE n.account_id = t.account_id
      AND n.type = 'SETTLEMENT'
      AND (n.created_at, n.id) > (t.created_at, t.id)
    ORDER BY n.created_at, n.id
    LIMIT 1
  ) nx ON t.type = 'COLLECTION'
  UNION ALL
  SELECT c.order_number, 'CUSTOMER_WALLET', w.type::text, (w.credit - w.debit)::text,
         cu.customer_number, NULL, NULL, w.created_at
  FROM cand c
  JOIN wallet_transactions w ON w.order_id = c.id
  JOIN customers cu ON cu.id = w.customer_id
  UNION ALL
  SELECT c.order_number, 'COMPANY', f.type::text, f.amount::text,
         NULL, NULL, NULL, f.created_at
  FROM cand c
  JOIN company_financial_transactions f ON f.order_id = c.id
  UNION ALL
  SELECT c.order_number, 'DIRECT_COMPANY_COLLECTION', 'DIRECT', k.amount::text,
         NULL, NULL, NULL, k.created_at
  FROM cand c
  JOIN company_direct_collections k ON k.order_id = c.id
  UNION ALL
  SELECT c.order_number, 'FINANCIAL_RELEASE',
         r.release_status::text || '/' || r.review_status::text, r.collection_amount::text,
         NULL, NULL, NULL, r.created_at
  FROM cand c
  JOIN order_financial_releases r ON r.order_id = c.id
) m
ORDER BY m.order_number, m.at, m.ledger`,
  },
  {
    id: "E9",
    title: "Assignment, delivery-attempt and status history of the potential matches (no notes)",
    sql: `
WITH ${CANDIDATE_CTE}
SELECT
  e.order_number,
  e.kind,
  e.driver_number,
  ${utc("e.at")} AS at_utc,
  ${utc("e.ended")} AS ended_utc,
  e.detail,
  e.is_incident_driver
FROM (
  SELECT c.order_number, 'DELIVERY_ASSIGNMENT' AS kind, dr.driver_number,
         x.assigned_at AS at, x.ended_at AS ended, x.end_reason AS detail,
         (x.driver_id = inc.driver_id) AS is_incident_driver
  FROM cand c
  CROSS JOIN inc
  JOIN order_assignments x ON x.order_id = c.id
  JOIN drivers dr ON dr.id = x.driver_id
  UNION ALL
  SELECT c.order_number, 'COLLECTION_ASSIGNMENT', dr.driver_number,
         x.assigned_at, x.ended_at, x.end_reason::text,
         (x.driver_id = inc.driver_id)
  FROM cand c
  CROSS JOIN inc
  JOIN parcel_collection_assignments x ON x.order_id = c.id
  JOIN drivers dr ON dr.id = x.driver_id
  UNION ALL
  SELECT c.order_number, 'DELIVERY_ATTEMPT', dr.driver_number,
         x.started_at, x.completed_at,
         x.outcome::text || ' expected ' || x.expected_collection::text
           || ' actual ' || coalesce(x.actual_collection::text, '-'),
         (x.driver_id = inc.driver_id)
  FROM cand c
  CROSS JOIN inc
  JOIN delivery_attempts x ON x.order_id = c.id
  JOIN drivers dr ON dr.id = x.driver_id
  UNION ALL
  SELECT c.order_number, 'STATUS', NULL,
         h.created_at, NULL,
         coalesce(h.from_status::text, '-') || ' -> ' || h.to_status::text,
         NULL
  FROM cand c
  JOIN order_status_history h ON h.order_id = c.id
) e
ORDER BY e.order_number, e.at, e.kind`,
  },
  {
    id: "E10",
    title: "Payouts to the potential matches' customers since the window start (wallet-level, not order-linked)",
    sql: `
WITH ${CANDIDATE_CTE}
SELECT
  p.payout_number,
  cu.customer_number,
  p.amount::text AS amount,
  p.status::text AS status,
  ${utc("p.created_at")} AS created_at_utc,
  w.balance_before::text AS wallet_balance_before,
  w.balance_after::text AS wallet_balance_after
FROM customer_payouts p
CROSS JOIN win
JOIN customers cu ON cu.id = p.customer_id
LEFT JOIN wallet_transactions w ON w.payout_id = p.id AND w.type = 'PAYOUT'
WHERE p.customer_id IN (SELECT customer_id FROM cand)
  AND p.created_at >= win.from_at
ORDER BY p.created_at, p.id`,
  },
  {
    id: "E11",
    title: "Incident driver's settlements from the window start",
    sql: `
WITH ${INCIDENT_CTE}
SELECT
  s.settlement_number,
  ${utc("s.created_at")} AS created_at_utc,
  s.balance_before::text AS balance_before,
  s.amount_received::text AS amount_received,
  s.balance_after::text AS balance_after,
  s.allocated_total::text AS allocated_total,
  s.unattributed_amount::text AS unattributed_amount,
  (s.allocated_total IS NULL) AS amount_only_legacy_format
FROM driver_settlements s
CROSS JOIN inc
CROSS JOIN win
WHERE s.driver_id = inc.driver_id
  AND s.created_at >= win.from_at
ORDER BY s.created_at, s.id`,
  },
  {
    id: "E12",
    title: "Coverage: window orders, potential matches, incident-driver orders without a content signal",
    sql: `
WITH ${CANDIDATE_CTE}
SELECT
  (SELECT count(*) FROM win_orders)::int AS orders_in_window,
  (SELECT count(*) FROM cand)::int AS potential_matches,
  (SELECT count(*)
   FROM win_orders w
   WHERE (w.s_incident_driver_delivery OR w.s_incident_driver_collection)
     AND w.id NOT IN (SELECT id FROM cand))::int AS incident_driver_orders_without_content_signal,
  ${utc("win.from_at")} AS window_from_utc,
  ${utc("win.to_at")} AS window_to_utc
FROM (SELECT 1) AS one
LEFT JOIN win ON true`,
  },
];

// ------------------------------------------------------------ report

type Row = Record<string, unknown>;

export interface Fact {
  statement: string;
  source: string;
}

export interface PotentialMatch {
  orderNumber: string;
  customerNumber: string;
  signals: string[];
  annotations: string[];
  row: Row;
}

export interface IncidentEvidenceReport {
  orderReference: string;
  window: EvidenceWindow;
  status: "STOP" | "POTENTIAL_MATCHES_FOR_FINANCE_REVIEW" | "NO_POTENTIAL_MATCHES_IN_WINDOW";
  replacementIdentified: false;
  confirmedFacts: Fact[];
  potentialMatches: PotentialMatch[];
  missingEvidence: string[];
  unresolvedAssumptions: string[];
  results: Record<string, Row[]>;
}

const CONTENT_SIGNALS: Record<string, string> = {
  s_expected_total: "amount to collect or order + fee equals the recorded expected amount",
  s_actual_amount: "amount to collect or actual collected equals the recorded actual amount",
  s_difference_amount: "amount to collect or actual collected equals the recorded difference",
  s_nothing_to_collect: "nothing to collect / ALREADY_PAID",
  s_back_entered: "delivered within 30 minutes of creation",
  s_mentions_deleted_reference: "order text, status history or its audits mention the deleted order reference",
  s_replacement_wording: "order text or status history uses replacement / duplicate / deleted wording",
};
const ANNOTATIONS: Record<string, string> = {
  s_incident_driver_delivery: "delivered or assigned to the incident driver",
  s_incident_driver_collection: "parcel collection assigned to the incident driver",
  s_same_order_type: "same order type as the deleted order",
};

const BASE_MISSING = [
  "Customer of the deleted order: not recorded in any surviving system row (no order-creation audit; the order row is gone).",
  "Order amount / delivery fee / prepaid split of the deleted order: only the combined expected total survives.",
  "Any system link between a replacement order and the deleted order: no field records one.",
  "Payout ↔ order linkage: payouts debit the wallet, not an order, so E10 cannot show which order a payout paid out.",
  "Legacy settlements are amount-only: which collections a legacy settlement covered is positional, not recorded.",
  "Deletion time: no audit records the deletion.",
];

const BASE_ASSUMPTIONS = [
  "A replacement order exists (owner-reported; not established by any record).",
  "If it exists, it was created inside the searched window.",
  "The customer payout and settlement for the replacement were completed (owner-reported; not established).",
  "E6S groups by UTC calendar day; the business day may differ if the operating day is not UTC.",
  "Text signals use English wording only; other languages are not detected.",
];

export async function buildIncidentEvidenceReport(
  query: EvidenceQuery,
  orderRef: string,
  window: EvidenceWindow = DEFAULT_EVIDENCE_WINDOW
): Promise<IncidentEvidenceReport> {
  validateEvidenceInput(orderRef, window);
  const params = [orderRef, window.daysBefore, window.daysAfter];
  const results: Record<string, Row[]> = {};
  for (const q of INCIDENT_EVIDENCE_QUERIES) results[q.id] = await query(q.sql, params);

  const facts: Fact[] = [];
  const missing = [...BASE_MISSING];
  const assumptions = [...BASE_ASSUMPTIONS];
  const audits = results.E1S;
  const base = { orderReference: orderRef, window, replacementIdentified: false as const, results };

  if (audits.length !== 1 || audits[0].order_still_exists === true || audits[0].resolved === true) {
    const why =
      audits.length !== 1
        ? `${audits.length} collection-difference audits name this reference (exactly one is required)`
        : audits[0].order_still_exists === true
          ? "the order row still exists — it is not a deleted order"
          : "the collection difference was resolved";
    return {
      ...base,
      status: "STOP",
      confirmedFacts: [{ statement: `STOP: ${why}. Re-investigate the incident scope before anything else.`, source: "E1S" }],
      potentialMatches: [],
      missingEvidence: missing,
      unresolvedAssumptions: assumptions,
    };
  }

  const a = audits[0];
  facts.push(
    { statement: `Exactly one unresolved COLLECTION_DIFFERENCE_RECORDED audit (${a.audit_id}) recorded at ${a.recorded_at_utc}.`, source: "E1S" },
    { statement: "The order row no longer exists and no COLLECTION_DIFFERENCE_RESOLVED audit exists.", source: "E1S" },
    { statement: `Recorded ${a.order_type}: expected ${a.expected_amount}, actual ${a.actual_amount}, difference ${a.difference}.`, source: "E1S" },
    {
      statement: a.cash_row_still_exists
        ? "The original driver cash COLLECTION row still exists."
        : "The original driver cash COLLECTION row no longer exists.",
      source: "E1S",
    }
  );
  if (a.actor_role === "DRIVER" && a.driver_id) {
    facts.push({ statement: `The difference was recorded by driver ${a.driver_number} (the incident driver).`, source: "E1S" });
  } else {
    missing.push("The audit actor is not a driver, so the incident driver and their cash account cannot be derived (E5S, E6S, E11 are empty).");
  }

  const jumps = results.E5S;
  const matching = jumps.filter((j) => j.jump_equals_actual_amount === true && j.after_recorded_delivery === true);
  if (matching.length === 1) {
    const j = matching[0];
    facts.push({
      statement: `One balance-chain jump of ${j.chain_jump} (equal to the actual amount) after the delivery, on ledger row ${j.ledger_row_id}${
        j.settlement_number ? `, settlement ${j.settlement_number} (amount received ${j.settlement_amount_received})` : ""
      }.`,
      source: "E5S",
    });
  } else {
    missing.push(`Expected exactly one chain jump equal to the actual amount after the delivery; found ${matching.length} (of ${jumps.length} jumps).`);
  }
  facts.push({
    statement: `${results.E3S.length} surviving audit(s) name the deleted order; ${results.E6S.length} surviving same-day delivery(ies) by the incident driver.`,
    source: "E3S / E6S",
  });

  const potentialMatches: PotentialMatch[] = results.E7.map((row) => ({
    orderNumber: String(row.order_number),
    customerNumber: String(row.customer_number),
    signals: Object.keys(CONTENT_SIGNALS).filter((k) => row[k] === true).map((k) => CONTENT_SIGNALS[k]),
    annotations: Object.keys(ANNOTATIONS).filter((k) => row[k] === true).map((k) => ANNOTATIONS[k]),
    row,
  }));
  const coverage = results.E12[0] ?? {};
  if (Number(coverage.incident_driver_orders_without_content_signal ?? 0) > 0) {
    assumptions.push(
      `${coverage.incident_driver_orders_without_content_signal} incident-driver order(s) in the window show no content signal and are not listed; a replacement with no matching amount, wording or timing would be among them or outside the window.`
    );
  }

  return {
    ...base,
    status: potentialMatches.length ? "POTENTIAL_MATCHES_FOR_FINANCE_REVIEW" : "NO_POTENTIAL_MATCHES_IN_WINDOW",
    confirmedFacts: facts,
    potentialMatches,
    missingEvidence: missing,
    unresolvedAssumptions: assumptions,
  };
}

// Operator copy of every query with the inputs bound as validated literals.
export function renderOperatorSql(orderRef: string, window: EvidenceWindow = DEFAULT_EVIDENCE_WINDOW): string {
  validateEvidenceInput(orderRef, window);
  const bind = (sql: string) =>
    sql
      .replaceAll("$1::text", `'${orderRef}'::text`)
      .replaceAll("$2::int", `${window.daysBefore}::int`)
      .replaceAll("$3::int", `${window.daysAfter}::int`);
  const body = INCIDENT_EVIDENCE_QUERIES.map((q) => `-- ${q.id} — ${q.title}\n${bind(q.sql).trim()};`).join("\n\n");
  return `BEGIN TRANSACTION READ ONLY;\n\n${body}\n\nROLLBACK;\n`;
}
