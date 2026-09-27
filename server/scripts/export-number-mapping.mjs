// Operator tool: export the customer/driver id -> business number mapping to a private CSV
// file, for reconciliation around the numbering migration. Read-only. Never logs records.
//
//   MIGRATION_DATABASE_URL=... node scripts/export-number-mapping.mjs --out <file outside the repo>
//
// Prints only row counts and the same fingerprint the Vercel build log shows
// ("number mapping fingerprint"), so the file can be matched to that build.
// Refuses to write inside the repository so the file cannot be committed by accident.

import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectReadOnly, describeTarget, mappingFingerprint } from "./db-inspect.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const i = process.argv.indexOf("--out");
const out = i > 0 ? process.argv[i + 1] : undefined;
const url = process.env.MIGRATION_DATABASE_URL;

if (!url) {
  console.error("MIGRATION_DATABASE_URL is not set (this tool never falls back to .env).");
  process.exit(1);
}
if (!out) {
  console.error("usage: node scripts/export-number-mapping.mjs --out <file outside the repo>");
  process.exit(1);
}
const outAbs = path.resolve(out);
const rel = path.relative(repoRoot, outAbs);
if (!rel.startsWith("..") && !path.isAbsolute(rel)) {
  console.error(`REFUSING: ${outAbs} is inside the repository.`);
  process.exit(1);
}

const t = describeTarget(url);
console.log(`target: ${t.host}:${t.port}/${t.database}`);
const db = await connectReadOnly(url);
try {
  const rows = (
    await db.query(`
      select 'customer' kind, id, customer_number number, created_at from customers
      union all
      select 'driver', id, driver_number, created_at from drivers
      order by kind, created_at, id`)
  ).rows;
  const csv = ["kind,id,number,created_at", ...rows.map((r) => `${r.kind},${r.id},${r.number},${r.created_at.toISOString()}`)];
  writeFileSync(outAbs, csv.join("\n") + "\n", { mode: 0o600 });
  console.log(`wrote ${rows.length} rows to ${outAbs}`);
  console.log(`fingerprint: ${JSON.stringify(await mappingFingerprint(db))}`);
} finally {
  await db.end();
}
