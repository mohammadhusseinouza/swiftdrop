// Historical incident evidence-recovery report — READ ONLY (FR.12A.8b).
//
// For an AUTHORIZED operator / Finance reviewer. It never writes: the session
// is forced read-only and verified, every query runs inside one READ ONLY
// transaction that is rolled back, and it selects no names, phones, addresses
// or free text (docs/fr12a8-historical-incident-evidence-recovery.md §12).
// It lists POTENTIAL replacement orders with their individual signals; it
// never identifies one.
//
//   EVIDENCE_DATABASE_URL="<direct or session URL, port 5432>" \
//   npx tsx scripts/fr12a8-incident-evidence-report.mjs --order <uuid> \
//     [--days-before 7] [--days-after 30] [--out report.json]
//
//   npx tsx scripts/fr12a8-incident-evidence-report.mjs --order <uuid> --print-sql
//     prints the same queries with the inputs bound, for psql; no connection.
//
// Exit code: 0 = report produced, 2 = STOP (the incident scope does not match),
// 1 = the report failed.

import { writeFileSync } from "node:fs";
import {
  DEFAULT_EVIDENCE_WINDOW,
  buildIncidentEvidenceReport,
  renderOperatorSql,
  validateEvidenceInput,
} from "../src/modules/historical-reconciliation/incident-evidence-report.ts";
import { connectReadOnly, describeTarget } from "./db-inspect.mjs";

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const intArg = (name, fallback) => (arg(name) === undefined ? fallback : Number(arg(name)));

function printReport(r) {
  console.log(`\nIncident evidence report — order reference ${r.orderReference}`);
  console.log(`Window: ${r.window.daysBefore} day(s) before to ${r.window.daysAfter} day(s) after the recorded delivery`);
  console.log(`Status: ${r.status}   Replacement identified: NO (identification is a Finance decision on documents)\n`);
  console.log("CONFIRMED FACTS (system records)");
  for (const f of r.confirmedFacts) console.log(`  - [${f.source}] ${f.statement}`);
  console.log(`\nPOTENTIAL MATCHES — unverified, signals are not identification (${r.potentialMatches.length})`);
  for (const m of r.potentialMatches) {
    console.log(`  - ${m.orderNumber} (customer ${m.customerNumber}), created ${m.row.created_at_utc}, collect ${m.row.amount_to_collect}`);
    for (const s of m.signals) console.log(`      signal: ${s}`);
    for (const a of m.annotations) console.log(`      note:   ${a}`);
  }
  console.log("\nMISSING EVIDENCE");
  for (const s of r.missingEvidence) console.log(`  - ${s}`);
  console.log("\nUNRESOLVED ASSUMPTIONS");
  for (const s of r.unresolvedAssumptions) console.log(`  - ${s}`);
  console.log("\nRow counts: " + Object.entries(r.results).map(([k, v]) => `${k}=${v.length}`).join(" "));
}

async function main() {
  const orderRef = arg("--order")?.trim().toLowerCase();
  if (!orderRef) throw new Error("--order <deleted order uuid> is required");
  const window = {
    daysBefore: intArg("--days-before", DEFAULT_EVIDENCE_WINDOW.daysBefore),
    daysAfter: intArg("--days-after", DEFAULT_EVIDENCE_WINDOW.daysAfter),
  };
  validateEvidenceInput(orderRef, window);

  if (process.argv.includes("--print-sql")) {
    process.stdout.write(renderOperatorSql(orderRef, window));
    return 0;
  }

  const raw = process.env.EVIDENCE_DATABASE_URL?.trim();
  if (!raw) throw new Error("EVIDENCE_DATABASE_URL is not set");
  const target = describeTarget(raw);
  console.log(`[evidence] target ${target.host}:${target.port}/${target.database} — read-only`);

  const db = await connectReadOnly(raw);
  try {
    await db.query("BEGIN TRANSACTION READ ONLY");
    const ro = (await db.query("SHOW transaction_read_only")).rows[0].transaction_read_only;
    if (ro !== "on") throw new Error("the transaction is not read-only — aborting before any query");
    const report = await buildIncidentEvidenceReport(async (sql, params) => (await db.query(sql, params)).rows, orderRef, window);
    printReport(report);
    const out = arg("--out");
    if (out) {
      writeFileSync(out, JSON.stringify(report, null, 2));
      console.log(`\n[evidence] full results written to ${out} — store it with the incident record, not in tickets or chat`);
    }
    return report.status === "STOP" ? 2 : 0;
  } finally {
    await db.query("ROLLBACK").catch(() => {});
    await db.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`[evidence] FAILED: ${e.message}`);
    process.exit(1);
  }
);
