// Apply a hand-authored SQL migration to $DATABASE_URL inside one transaction.
//
//   node migrations/apply.mjs migrations/<file>.sql
//
// Guard: a file whose SQL contains the marker line `-- IDEMPOTENT` is safe to
// run repeatedly and is always applied. Otherwise the Phase 11.17.2 bootstrap
// migration is guarded by the presence of the "ParcelIntakeMethod" enum
// (present => already applied => SKIP).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Parse .env directly to stay build-independent (load-env is a .ts helper).
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) {
  try {
    const env = readFileSync(path.join(serverDir, ".env"), "utf8");
    const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) process.env.DATABASE_URL = m[1];
  } catch {
    /* ignore */
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const file = process.argv[2];
if (!file) {
  console.error("usage: node migrations/apply.mjs <path-to.sql>");
  process.exit(1);
}

const sql = readFileSync(path.resolve(file), "utf8");

const pg = (await import("pg")).default;
const client = new pg.Client({ connectionString });
await client.connect();

try {
  const idempotent = /^--\s*IDEMPOTENT\b/m.test(sql);
  if (!idempotent) {
    const guard = await client.query(
      "SELECT 1 FROM pg_type WHERE typname = 'ParcelIntakeMethod' AND typnamespace = 'public'::regnamespace",
    );
    if (guard.rowCount > 0) {
      console.log("SKIP: ParcelIntakeMethod enum already present — bootstrap migration appears applied.");
      console.log("      (Nothing changed.)");
      process.exit(0);
    }
  }

  console.log(`Applying ${path.basename(file)} ...`);
  // The file already contains BEGIN/COMMIT.
  await client.query(sql);
  console.log("OK: migration committed.");
} catch (err) {
  console.error("FAILED — transaction rolled back by PostgreSQL.");
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
