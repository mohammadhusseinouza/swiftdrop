// Settlement-based financial release — READ-ONLY production preflight (FR.11B).
//
// For an AUTHORIZED operator during a separately approved preflight window.
// It never writes: every connection is forced read-only and verified before any
// query, and it prints only counts, sums, schema facts and gate verdicts — never
// credentials, customer data or individual records.
//
//   PREFLIGHT_DATABASE_URL="<direct or session-pooler URL, port 5432>" \
//   CLIENT_URL="https://<deployed client>"            # optional, for gate G7 \
//   npx tsx scripts/fr-production-preflight.mjs [--out preflight.json]
//
// Run it a second time with PREFLIGHT_DATABASE_URL set to the RUNTIME pooler URL
// (the one the app uses) to confirm the session time zone on that path too; the
// script detects the transaction pooler and limits itself to the session checks
// that are safe there.
//
// Exit code: 0 = no blocker, 2 = at least one BLOCKER, 1 = the preflight failed.
//
// FR.12A.4 — once the historical reconciliation migration is applied, check 6
// applies the SAME residual rule as gate G3 / R1 (shared SQL in
// src/modules/historical-reconciliation/historical-reconciliation.sql.ts) and
// always prints the raw discrepancy, the approved historical amount, the
// residual and any invalid approval. Before that migration the raw rule
// applies unchanged. G5 also counts deleted orders whose collection difference
// was never resolved (historical ownership), with or without the migration.

import { writeFileSync } from "node:fs";
import { ACCOUNT_RESIDUAL_FAILS, driverCashReconciliationWith } from "../src/modules/historical-reconciliation/historical-reconciliation.sql.ts";
import {
  INVALID_RESOLUTIONS_WHERE,
  REVOKED_BY_RECORDER_SQL,
  OUTSTANDING_LIABILITY_WHERE,
  historicalOwnershipWith,
  unresolvedHistoricalOwnershipSql,
} from "../src/modules/historical-ownership/historical-ownership.sql.ts";
import {
  FINANCIAL_RELEASE_MIGRATION,
  FINANCIAL_RELEASE_SETTING_KEY,
  HISTORICAL_OWNERSHIP_MIGRATION,
  HISTORICAL_RECONCILIATION_MIGRATION,
  connectReadOnly,
  describeTarget,
  financialSnapshot,
  historyProblems,
  identity,
  migrationHistory,
  migrationStateChecks,
  summarizeFacts,
} from "./db-inspect.mjs";

const results = [];
const add = (area, verdict, detail, data) => {
  results.push({ area, verdict, detail, ...(data !== undefined ? { data } : {}) });
  console.log(`${verdict.padEnd(7)} ${area} — ${detail}`);
};

function withReadOnlyOption(url) {
  const u = new URL(url);
  const existing = u.searchParams.get("options");
  u.searchParams.set("options", [existing, "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
  return u.toString();
}

async function one(client, sql) {
  return (await client.query(sql)).rows[0];
}

async function main() {
  const raw = process.env.PREFLIGHT_DATABASE_URL?.trim();
  if (!raw) throw new Error("PREFLIGHT_DATABASE_URL is not set");
  const target = describeTarget(raw);
  const transactionPooler = target.port === "6543" || /pgbouncer=true/i.test(raw);
  console.log(`[preflight] target ${target.host}:${target.port}/${target.database}${transactionPooler ? " (transaction pooler)" : ""} — read-only`);

  const db = await connectReadOnly(raw);
  try {
    // ---- 0. the session must be read-only before anything else runs
    const ro = (await one(db, "SHOW transaction_read_only")).transaction_read_only;
    if (ro !== "on") throw new Error("the session is not read-only — aborting before any query");

    // ---- 1. identity and session time zone (contract §14 item 0)
    const id = await identity(db);
    const utc = ["UTC", "Etc/UTC", "Etc/UCT", "UCT", "Zulu", "Etc/Zulu", "Universal", "Etc/Universal"].includes(id.timezone);
    add("session time zone", utc ? "OK" : "BLOCKER", `TimeZone=${id.timezone} (PostgreSQL ${id.postgres})${utc ? "" : " — must be UTC before activation (docs/timezone-investigation.md)"}`, id);
    const roleTz = (
      await db.query(
        "select coalesce(r.rolname, '<all roles>') as role, array_to_string(s.setconfig, ', ') as config from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole where (s.setdatabase = (select oid from pg_database where datname = current_database()) or s.setdatabase = 0) and array_to_string(s.setconfig, ',') ilike '%timezone%'",
      )
    ).rows;
    add("time zone overrides", "INFO", roleTz.length ? roleTz.map((r) => `${r.role}: ${r.config}`).join("; ") : "no role/database TimeZone override", roleTz);

    if (transactionPooler) {
      add("scope", "INFO", "transaction pooler: session checks only. Rerun on the direct / session-pooler URL for the full preflight.");
      return;
    }

    // ---- 2. timestamp column types
    const ts = (
      await db.query(
        "select data_type, count(*)::int as n, string_agg(table_name || '.' || column_name, ', ' order by table_name, column_name) filter (where data_type = 'timestamp without time zone') as without_tz from information_schema.columns where table_schema = 'public' and data_type in ('timestamp with time zone', 'timestamp without time zone', 'date') group by data_type",
      )
    ).rows;
    const withoutTz = ts.find((r) => r.data_type === "timestamp without time zone");
    add("timestamp columns", withoutTz ? "WARN" : "OK", ts.map((r) => `${r.data_type}: ${r.n}`).join(", ") + (withoutTz ? ` — without time zone: ${withoutTz.without_tz}` : ""), ts);

    // ---- 3. migration state (incl. the FR.2 migration)
    const history = await migrationHistory(db);
    const checks = await migrationStateChecks(db, history);
    const problems = [...historyProblems(history), ...checks.problems];
    const frState = checks.state[FINANCIAL_RELEASE_MIGRATION];
    add("migration history", problems.length ? "BLOCKER" : "OK", problems.length ? problems.join("; ") : `baselined; ${JSON.stringify(checks.state)}`, {
      applied: (history ?? []).map((h) => `${h.migration_name}${h.finished && !h.rolled_back ? "" : " (NOT APPLIED)"}`),
      facts: summarizeFacts(checks.facts),
    });
    add("financial-release migration", "INFO", `${FINANCIAL_RELEASE_MIGRATION}: ${frState}`);
    const hrApplied = checks.state[HISTORICAL_RECONCILIATION_MIGRATION] === "applied";
    const hoApplied = hrApplied && checks.state[HISTORICAL_OWNERSHIP_MIGRATION] === "applied";
    add("historical-reconciliation migration", "INFO", `${HISTORICAL_RECONCILIATION_MIGRATION}: ${checks.state[HISTORICAL_RECONCILIATION_MIGRATION]}`);
    add("historical-ownership migration", "INFO", `${HISTORICAL_OWNERSHIP_MIGRATION}: ${checks.state[HISTORICAL_OWNERSHIP_MIGRATION]}`);

    // ---- 4. activation setting
    const setting = await one(db, `select value::text as value from system_settings where key = '${FINANCIAL_RELEASE_SETTING_KEY}'`);
    if (frState === "applied") {
      add("activation setting", setting?.value === "false" ? "OK" : "BLOCKER", `value=${setting?.value ?? "missing"} (must be false before cutover)`);
    } else {
      add("activation setting", setting ? "BLOCKER" : "OK", setting ? `row exists before the migration (value=${setting.value})` : "absent (expected before the migration)");
    }

    // ---- 5. financial baseline (counts and sums only)
    add("financial baseline", "INFO", "counts / sums / fingerprints recorded in the output file", await financialSnapshot(db));

    // ---- 6. driver cash, ledgers and legacy obligations (work before and after the migration)
    const frApplied = frState === "applied";
    const cash = await one(
      db,
      frApplied
        ? `select count(*) filter (where a.current_balance - coalesce(o.outstanding, 0) <> 0)::int as drivers_with_unattributed,
                  coalesce(sum(a.current_balance - coalesce(o.outstanding, 0)), 0)::text as unattributed_total,
                  coalesce(sum(a.current_balance), 0)::text as cash_total
           from driver_cash_accounts a
           left join (select r.driver_id, sum(r.collection_amount - r.allocated_amount) as outstanding
                      from order_financial_releases r
                      where r.release_status = 'PENDING'
                        and not exists (select 1 from driver_cash_transactions x where x.reversal_of_id = r.collection_transaction_id)
                      group by r.driver_id) o on o.driver_id = a.driver_id`
        : `select count(*) filter (where current_balance <> 0)::int as drivers_with_unattributed,
                  coalesce(sum(current_balance), 0)::text as unattributed_total, coalesce(sum(current_balance), 0)::text as cash_total
           from driver_cash_accounts`,
    );
    add(
      "driver cash (gate G2)",
      cash.drivers_with_unattributed === 0 ? "OK" : "WARN",
      `${cash.drivers_with_unattributed} driver(s) hold unattributed cash, total ${cash.unattributed_total} (all driver cash ${cash.cash_total}). Must be settled to zero before activation.`,
      cash,
    );
    const ledgers = await one(
      db,
      `select
         (select count(*)::int from driver_cash_accounts a
            left join (select account_id, sum(balance_after - balance_before) net from driver_cash_transactions group by account_id) t on t.account_id = a.id
            where a.current_balance <> coalesce(t.net, 0)) as driver_cash_mismatches,
         (select count(*)::int from customer_wallets w
            left join (select wallet_id, sum(credit - debit) net from wallet_transactions group by wallet_id) t on t.wallet_id = w.id
            where w.available_balance <> coalesce(t.net, 0)) as wallet_mismatches,
         (select count(*)::int from orders o where o.status = 'DELIVERED' and o.financial_status = 'REVIEW_REQUIRED'
            ${frApplied ? "and o.financial_release_mode is null" : ""}) as legacy_review_required,
         (select count(*)::int from driver_settlements d where not exists (select 1 from driver_cash_transactions x where x.settlement_id = d.id)) as settlements_without_cash_row`,
    );
    // G3 — the raw discrepancy is always reported; with the historical
    // reconciliation schema the verdict follows the shared residual rule.
    const g3 = await one(
      db,
      `${driverCashReconciliationWith(hrApplied)}
       select count(*) filter (where d.raw_discrepancy <> 0)::int as raw_mismatches,
              coalesce(sum(d.raw_discrepancy), 0)::text as raw_discrepancy,
              coalesce(sum(d.approved_historical_amount), 0)::text as approved_historical,
              coalesce(sum(d.unexplained_residual), 0)::text as residual,
              count(*) filter (where ${ACCOUNT_RESIDUAL_FAILS})::int as residual_accounts,
              coalesce(sum(d.invalid_approved_count), 0)::int as invalid_approvals
       from dc_accounts d`,
    );
    const g3Blocked = g3.residual_accounts !== 0 || g3.invalid_approvals !== 0;
    add(
      "driver cash ledger (G3)",
      g3Blocked ? "BLOCKER" : "OK",
      `${g3.residual_accounts} account(s) fail the residual rule; raw discrepancy ${g3.raw_discrepancy} on ${g3.raw_mismatches} account(s), approved historical reconciliation ${g3.approved_historical}, unexplained residual ${g3.residual}, invalid historical approvals ${g3.invalid_approvals}` +
        (hrApplied ? "" : " — historical reconciliation migration not applied: raw rule (a documented incident can only be reconciled after it; runbook §8.3)"),
      { ...g3, historicalReconciliationSchema: hrApplied, rawRuleMismatches: ledgers.driver_cash_mismatches },
    );
    add("wallet ledger (G4)", ledgers.wallet_mismatches === 0 ? "OK" : "BLOCKER", `${ledgers.wallet_mismatches} wallet(s) differ from their ledger`);
    const ownership = await one(db, `select count(*)::int as unresolved from (${unresolvedHistoricalOwnershipSql(hrApplied, hoApplied)}) u`);
    // FR.12A.10 — recorded company-assumed liabilities (released from G5) and
    // R14, always reported beside G5.
    const liabilities = hoApplied
      ? await one(
          db,
          `${historicalOwnershipWith()}
           select (select count(*)::int from ho_released) as released,
                  (select coalesce(sum(h.recognized_amount), 0)::numeric(14,2)::text from ho_evaluated h where ${OUTSTANDING_LIABILITY_WHERE}) as outstanding,
                  (select coalesce(sum(h.tracked_shortfall_amount), 0)::numeric(14,2)::text from ho_evaluated h where ${OUTSTANDING_LIABILITY_WHERE}) as tracked_shortfall,
                  (select count(*)::int from ho_evaluated h where ${INVALID_RESOLUTIONS_WHERE})
                    + (select count(*)::int from (${REVOKED_BY_RECORDER_SQL}) rr) as r14_invalid`,
        )
      : { released: 0, outstanding: "0.00", tracked_shortfall: "0.00", r14_invalid: 0 };
    add(
      "legacy obligations (G5)",
      ledgers.legacy_review_required === 0 && ledgers.settlements_without_cash_row === 0 && ownership.unresolved === 0 ? "OK" : "WARN",
      `${ledgers.legacy_review_required} delivered order(s) await collection-difference review; ${ledgers.settlements_without_cash_row} settlement(s) lack their cash row; ${ownership.unresolved} deleted order(s) with unresolved historical ownership; ${liabilities.released} resolved by recorded historical liabilities (outstanding ${liabilities.outstanding}, tracked shortfall ${liabilities.tracked_shortfall}). Resolve before activation.` +
        (hoApplied ? "" : " — historical-ownership migration not applied: no deleted order can be resolved"),
      { ...ledgers, unresolvedHistoricalOwnership: ownership.unresolved, historicalLiabilities: liabilities },
    );
    add(
      "historical liability register (R14)",
      liabilities.r14_invalid === 0 ? "OK" : "BLOCKER",
      `${liabilities.r14_invalid} approved resolution(s) / recorded liabilities fail validation`,
    );
    const hist = await one(
      db,
      `select
         (select count(*)::int from company_financial_transactions where type in ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') and order_id is null) as h1_company,
         (select count(*)::int from wallet_transactions where type = 'ORDER_CREDIT' and order_id is null) as h1_wallet,
         (select count(*)::int from company_financial_transactions where type in ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') and amount <= 0) as h2,
         (select coalesce(sum(amount), 0)::text from company_financial_transactions where type in ('DELIVERY_FEE_REVENUE', 'COMPANY_ORDER_PRODUCT_REVENUE') and (order_id is null or amount <= 0)) as h_amount`,
    );
    const hCount = hist.h1_company + hist.h1_wallet + hist.h2;
    add(
      "historical anomalies (H1/H2)",
      hCount === 0 ? "OK" : "WARN",
      hCount === 0
        ? "none"
        : `H1 ${hist.h1_company} company + ${hist.h1_wallet} wallet row(s) without an order; H2 ${hist.h2} non-positive revenue row(s); amount ${hist.h_amount}. Production has no known source of these (the dev rows came from a test) — investigate, never delete.`,
      hist,
    );
  } finally {
    await db.end();
  }

  // ---- 7. full gate report + reconciliation, through the application services
  const frApplied = results.find((r) => r.area === "financial-release migration")?.detail.endsWith("applied");
  if (!frApplied) {
    add("readiness gates / reconciliation", "INFO", "skipped — the financial-release migration is not applied yet (rerun after deployment)");
    return;
  }
  process.env.DATABASE_URL = withReadOnlyOption(raw);
  const { prisma } = await import("../src/db/prisma.ts");
  try {
    const guard = await prisma.$queryRawUnsafe("SHOW default_transaction_read_only");
    if (guard[0]?.default_transaction_read_only !== "on") {
      add("readiness gates / reconciliation", "WARN", "skipped — this connection path does not honour the read-only startup option");
      return;
    }
    const { getFinancialReleaseReadiness } = await import("../src/modules/financial-release/financial-release-activation.service.ts");
    const { getFinancialReleaseReconciliation } = await import("../src/modules/financial-release/financial-release-reconciliation.service.ts");
    const readiness = await getFinancialReleaseReadiness();
    for (const g of readiness.gates) {
      // G0 is expected to fail until the cutover is authorized.
      const verdict = g.passed ? "OK" : g.id === "G0" ? "INFO" : "BLOCKER";
      add(`gate ${g.id} ${g.title}`, verdict, `${g.detail}${g.affectedCount ? ` (${g.affectedCount} affected)` : ""}`);
    }
    const rec = await getFinancialReleaseReconciliation();
    add(
      "reconciliation R1–R13",
      rec.summary.invariantChecksFailed === 0 ? "OK" : "BLOCKER",
      `${rec.summary.invariantChecksFailed} invariant check(s) failed; ${rec.summary.historicalAnomalies} historical anomaly row(s)`,
      rec.checks.map((c) => ({ id: c.id, kind: c.kind, status: c.status, affected: c.affectedCount })),
    );
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .then(() => {
    const blockers = results.filter((r) => r.verdict === "BLOCKER").length;
    const outIdx = process.argv.indexOf("--out");
    const out = outIdx > 0 ? process.argv[outIdx + 1] : `fr-preflight-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), blockers, results }, null, 2));
    console.log(`[preflight] ${blockers} blocker(s); report written to ${out}`);
    process.exit(blockers ? 2 : 0);
  })
  .catch((error) => {
    console.error(`[preflight] FAILED: ${error?.message ?? error}`);
    process.exit(1);
  });
