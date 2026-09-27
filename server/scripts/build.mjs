// Backend build: `npm run build` (local) and Vercel's automatic Git deployments
// (server/vercel.json pins Vercel's Build Command to `npm run build`).
//
//   1. prisma migrate deploy   — ONLY on Vercel Production deployments, per PRISMA_MIGRATE_MODE
//   2. prisma generate
//   3. tsc
//
// Where migrations run:
//   local / CI (no VERCEL)          never
//   Vercel Preview / Development    never
//   Vercel Production               controlled by PRISMA_MIGRATE_MODE (required):
//     preflight  read-only inspection printed to the build log; no migration; build continues
//     deploy     guard checks -> prisma migrate deploy -> status + post-migration checks;
//                any failure fails the build (Vercel keeps serving the previous deployment).
//                With nothing pending this is a no-op, so routine deploys just pass through.
//     disabled   explicit, loud skip (emergency use only)
//
// Production also requires MIGRATION_DATABASE_URL: a Supabase DIRECT or SESSION-pooler
// connection (not the transaction pooler on 6543). Missing it fails the build.
//
// Logs contain migration status, counts, sums and fingerprints only — never credentials
// and never individual customer/driver records.

import { spawnSync } from "node:child_process";
import {
  compareSnapshots,
  connectReadOnly,
  describeTarget,
  financialSnapshot,
  historyProblems,
  identity,
  mappingChangeSummary,
  mappingFingerprint,
  migrationHistory,
  migrationStateChecks,
  numberMapping,
  summarizeFacts,
} from "./db-inspect.mjs";

const MODES = ["preflight", "deploy", "disabled"];

class BuildError extends Error {}
const log = (msg) => console.log(`[build] ${msg}`);

function run(cmd, env = process.env) {
  log(`$ ${cmd}`);
  const r = spawnSync(cmd, { stdio: "inherit", shell: true, env });
  if (r.status !== 0) throw new BuildError(`command failed (exit ${r.status}): ${cmd}`);
}

function productionTarget() {
  const mode = process.env.PRISMA_MIGRATE_MODE;
  if (!mode) {
    throw new BuildError(
      "PRISMA_MIGRATE_MODE is not set for this Production deployment. Set it in Vercel " +
        `(Production scope) to one of: ${MODES.join(", ")}. Refusing to guess.`,
    );
  }
  if (!MODES.includes(mode)) throw new BuildError(`PRISMA_MIGRATE_MODE="${mode}" is invalid; expected one of: ${MODES.join(", ")}`);

  const raw = process.env.MIGRATION_DATABASE_URL;
  // Surrounding whitespace (easy to paste into Vercel) is ignored by `new URL()` but NOT by
  // pg: a leading space makes pg resolve the URL relative to its placeholder "postgres://base".
  const url = raw?.trim();
  if (!url) throw new BuildError("MIGRATION_DATABASE_URL is not set for this Production deployment.");
  if (url !== raw) log("note: MIGRATION_DATABASE_URL had leading/trailing whitespace; it was trimmed (fix the Vercel value).");
  let target;
  try {
    target = describeTarget(url);
  } catch {
    throw new BuildError("MIGRATION_DATABASE_URL is not a valid connection URL.");
  }
  if (target.port === "6543" || /pgbouncer=true/i.test(url)) {
    throw new BuildError(
      "MIGRATION_DATABASE_URL points at the Supabase transaction pooler (6543 / pgbouncer=true). " +
        "Use the direct or session-pooler connection (5432) for migrations.",
    );
  }
  return { mode, url, target };
}

async function inspect(db) {
  const history = await migrationHistory(db);
  const checks = await migrationStateChecks(db, history);
  return { history, checks, problems: [...historyProblems(history), ...checks.problems] };
}

function logInspection({ history, checks }) {
  log(
    `_prisma_migrations: ${
      history === null
        ? "DOES NOT EXIST"
        : history.map((h) => `${h.migration_name}${h.finished && !h.rolled_back ? "" : h.rolled_back ? " (rolled back)" : " (FAILED)"}`).join(", ")
    }`,
  );
  log(`migration state: ${JSON.stringify(checks.state)}`);
  log(`schema facts: ${JSON.stringify(summarizeFacts(checks.facts))}`);
}

async function preflight(url) {
  const db = await connectReadOnly(url);
  try {
    log("== PREFLIGHT (read-only; no migration will run) ==");
    log(`identity: ${JSON.stringify(await identity(db))}`);
    const result = await inspect(db);
    logInspection(result);
    log("financial baseline:");
    console.table(await financialSnapshot(db));
    log(`number mapping fingerprint (rows:md5 of id:number): ${JSON.stringify(await mappingFingerprint(db))}`);
    if (result.problems.length) {
      log("PREFLIGHT RESULT: NOT READY — do NOT switch PRISMA_MIGRATE_MODE to deploy:");
      for (const p of result.problems) log(`  - ${p}`);
    } else {
      log("PREFLIGHT RESULT: READY — switch to deploy only after a production backup / recovery point is confirmed.");
    }
  } finally {
    await db.end();
  }
}

async function deploy(url) {
  let db = await connectReadOnly(url);
  let before, mappingBefore;
  try {
    const result = await inspect(db);
    logInspection(result);
    if (result.problems.length) throw new BuildError(`migration guard failed:\n  - ${result.problems.join("\n  - ")}`);
    before = await financialSnapshot(db);
    mappingBefore = await numberMapping(db);
    log(`number mapping fingerprint BEFORE: ${JSON.stringify(await mappingFingerprint(db))}`);
  } finally {
    await db.end();
  }

  const env = { ...process.env, DATABASE_URL: url };
  run("npx --no-install prisma migrate deploy", env);
  run("npx --no-install prisma migrate status", env); // non-zero if anything is still pending/failed

  db = await connectReadOnly(url);
  try {
    // Every migration is now applied, so this verifies each one's objects exist as defined.
    const result = await inspect(db);
    logInspection(result);
    if (result.problems.length) throw new BuildError(`post-migration verification failed:\n  - ${result.problems.join("\n  - ")}`);

    const diffs = compareSnapshots(before, await financialSnapshot(db)).filter((d) => !d.same);
    if (diffs.length) {
      log("WARNING: financial snapshot changed across the migration window (live traffic can cause this) — review:");
      console.table(diffs);
    } else {
      log("financial snapshot unchanged across migration: OK");
    }

    const summary = mappingChangeSummary(mappingBefore, await numberMapping(db));
    log(`number mapping after deploy: ${JSON.stringify(summary)}`);
    log(`number mapping fingerprint AFTER: ${JSON.stringify(await mappingFingerprint(db))}`);
    for (const [kind, s] of Object.entries(summary)) {
      if (!s.same_ids) throw new BuildError(`${kind}: the set of ids changed across the migration`);
    }
  } finally {
    await db.end();
  }
}

async function main() {
  const onVercel = process.env.VERCEL === "1";
  const vercelEnv = process.env.VERCEL_ENV;
  log(`scripts/build.mjs (${onVercel ? `Vercel, VERCEL_ENV=${vercelEnv ?? "<missing>"}` : "local"})`);
  if (onVercel && !vercelEnv) {
    throw new BuildError("VERCEL=1 but VERCEL_ENV is missing — enable 'Automatically expose System Environment Variables'.");
  }

  if (vercelEnv === "production") {
    const { mode, url, target } = productionTarget();
    log(`Vercel Production build; migration target ${target.host}:${target.port}/${target.database}; PRISMA_MIGRATE_MODE=${mode}`);
    if (mode === "preflight") await preflight(url);
    else if (mode === "deploy") await deploy(url);
    else log("WARNING: PRISMA_MIGRATE_MODE=disabled — production migrations SKIPPED by explicit configuration.");
  } else {
    log(`migrations skipped (${onVercel ? `Vercel ${vercelEnv}` : "local build"}) — never migrates outside Vercel Production`);
  }

  run("npx --no-install prisma generate");
  run("npx --no-install tsc -p tsconfig.json");
}

main().catch((err) => {
  if (err instanceof BuildError) {
    console.error(`[build] FAILED: ${err.message}`);
  } else {
    // Connection errors can carry an empty message (e.g. AggregateError on ECONNREFUSED),
    // so always print the error name and code too. pg error messages never contain the URL.
    const detail = [err?.name, err?.code, err?.message, ...(err?.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`.trim())]
      .filter(Boolean)
      .join(" | ");
    console.error(`[build] FAILED: ${detail || String(err)}`);
  }
  process.exit(1);
});
