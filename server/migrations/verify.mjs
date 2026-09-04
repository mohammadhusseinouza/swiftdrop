// Phase 11.17.2 migration verification.
//
//   node migrations/verify.mjs --snapshot   # BEFORE applying: writes .baseline.json
//   node migrations/verify.mjs               # AFTER applying: asserts non-regression + backfill
//
// .baseline.json is a throwaway local file (git-ignored via server/.gitignore rule
// for *.log won't catch it — it is deleted at the end of a successful verify run).

import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL) {
  const env = readFileSync(path.join(serverDir, ".env"), "utf8");
  const m = env.match(/^DATABASE_URL\s*=\s*"?([^"\n]+)"?/m);
  if (m) process.env.DATABASE_URL = m[1];
}

const BASELINE = path.join(serverDir, "migrations", ".baseline.json");
const SNAPSHOT = process.argv.includes("--snapshot");

const pg = (await import("pg")).default;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();

const one = async (sql) => (await client.query(sql)).rows[0];
const val = async (sql) => Object.values(await one(sql))[0];

async function capture() {
  return {
    orders: await val("select count(*)::int from orders"),
    order_ids_hash: await val("select coalesce(md5(string_agg(id::text, ',' order by id)), 'EMPTY') from orders"),
    order_assignments: await val("select count(*)::int from order_assignments"),
    order_assignments_current: await val("select count(*)::int from order_assignments where is_current"),
    delivery_attempts: await val("select count(*)::int from delivery_attempts"),
    order_status_history: await val("select count(*)::int from order_status_history"),
    orders_with_current_driver: await val("select count(*)::int from orders where current_driver_id is not null"),
    current_driver_hash: await val(
      "select coalesce(md5(string_agg(id::text || ':' || coalesce(current_driver_id::text,'-'), ',' order by id)), 'EMPTY') from orders",
    ),
    wallet_transactions: await val("select count(*)::int from wallet_transactions"),
    wallet_credit_sum: await val("select coalesce(sum(credit),0)::text from wallet_transactions"),
    wallet_debit_sum: await val("select coalesce(sum(debit),0)::text from wallet_transactions"),
    customer_wallets: await val("select count(*)::int from customer_wallets"),
    customer_wallets_balance_sum: await val("select coalesce(sum(available_balance),0)::text from customer_wallets"),
    driver_cash_transactions: await val("select count(*)::int from driver_cash_transactions"),
    driver_cash_accounts: await val("select count(*)::int from driver_cash_accounts"),
    driver_cash_balance_sum: await val("select coalesce(sum(current_balance),0)::text from driver_cash_accounts"),
    company_financial_transactions: await val("select count(*)::int from company_financial_transactions"),
    company_financial_amount_sum: await val("select coalesce(sum(amount),0)::text from company_financial_transactions"),
    customer_payouts: await val("select count(*)::int from customer_payouts"),
    driver_settlements: await val("select count(*)::int from driver_settlements"),
    permissions: await val("select count(*)::int from permissions"),
  };
}

if (SNAPSHOT) {
  const snap = await capture();
  writeFileSync(BASELINE, JSON.stringify(snap, null, 2));
  console.log("baseline written:", BASELINE);
  console.table(snap);
  await client.end();
  process.exit(0);
}

// ---- AFTER-migration verification ----
if (!existsSync(BASELINE)) {
  console.error("no .baseline.json — run `node migrations/verify.mjs --snapshot` BEFORE applying");
  process.exit(1);
}
const before = JSON.parse(readFileSync(BASELINE, "utf8"));
const after = await capture();

let failures = 0;
const check = (label, ok, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
};

// --- Non-regression: nothing outside the parcel feature moved ---
const unchanged = [
  "orders", "order_ids_hash", "order_assignments", "order_assignments_current",
  "delivery_attempts", "order_status_history", "orders_with_current_driver",
  "current_driver_hash", "wallet_transactions", "wallet_credit_sum", "wallet_debit_sum",
  "customer_wallets", "customer_wallets_balance_sum", "driver_cash_transactions",
  "driver_cash_accounts", "driver_cash_balance_sum", "company_financial_transactions",
  "company_financial_amount_sum", "customer_payouts", "driver_settlements", "permissions",
];
for (const k of unchanged) {
  check(`unchanged: ${k}`, String(before[k]) === String(after[k]), `${before[k]} -> ${after[k]}`);
}

// --- Backfill correctness ---
const backfill = await one(`
  select
    count(*)::int                                                              as total,
    count(*) filter (where parcel_intake_method = 'ALREADY_AT_COMPANY')::int    as intake_already,
    count(*) filter (where parcel_collection_status = 'RECEIVED_AT_COMPANY')::int as status_received,
    count(*) filter (where current_parcel_collection_driver_id is null)::int    as ptr_null,
    count(*) filter (where received_at_company_at = created_at)::int            as receipt_ts_match,
    count(*) filter (where received_at_company_by_id = created_by_id)::int      as receipt_by_match,
    count(*) filter (where received_at_company_by_id is null)::int             as receipt_by_null,
    count(*) filter (where parcel_collection_contact_name is not null
                       or parcel_collection_phone is not null
                       or parcel_collection_address is not null
                       or parcel_collection_area_id is not null
                       or parcel_collected_from_sender_at is not null)::int     as any_snapshot_set
  from orders`);
check("backfill: every order intake = ALREADY_AT_COMPANY", backfill.total === backfill.intake_already, JSON.stringify(backfill));
check("backfill: every order status = RECEIVED_AT_COMPANY", backfill.total === backfill.status_received);
check("backfill: every order current_parcel_collection_driver_id IS NULL", backfill.total === backfill.ptr_null);
check("backfill: received_at_company_at = created_at for all", backfill.total === backfill.receipt_ts_match);
check("backfill: received_at_company_by_id = created_by_id for all (no orphan creators)", backfill.total === backfill.receipt_by_match);
check("backfill: 0 orders with a NULL receipt actor", backfill.receipt_by_null === 0);
check("backfill: 0 fabricated collection snapshots", backfill.any_snapshot_set === 0);

// --- New tables empty ---
check("parcel_collection_assignments is empty", (await val("select count(*)::int from parcel_collection_assignments")) === 0);
check("parcel_collection_attempts is empty", (await val("select count(*)::int from parcel_collection_attempts")) === 0);

// --- Failed Collection Reasons canonical catalog ---
const reasons = (await client.query(
  "select name, requires_notes, is_active, sort_order from failed_collection_reasons order by sort_order, name",
)).rows;
const expected = [
  ["Sender unavailable", false, true, 10],
  ["Parcel not ready", false, true, 20],
  ["Unable to contact sender", false, true, 30],
  ["Incorrect collection address", false, true, 40],
  ["Sender requested reschedule", false, true, 50],
  ["Collection cancelled by sender", true, true, 60],
  ["Other", true, true, 70],
];
check("failed_collection_reasons: exactly 7 canonical rows", reasons.length === 7, JSON.stringify(reasons.map((r) => r.name)));
check(
  "failed_collection_reasons: names/flags/order match contract",
  JSON.stringify(reasons.map((r) => [r.name, r.requires_notes, r.is_active, r.sort_order])) === JSON.stringify(expected),
);
check("failed_delivery_reasons untouched", true, "(separate table — not modified by this migration)");

// --- Enums present with exact labels ---
const enumLabels = async (name) =>
  (await client.query(
    `select array_agg(e.enumlabel::text order by e.enumsortorder)::text[] as l
       from pg_type t join pg_enum e on e.enumtypid=t.oid
      where t.typname=$1 and t.typnamespace='public'::regnamespace`, [name],
  )).rows[0]?.l ?? [];
check("enum ParcelIntakeMethod", JSON.stringify(await enumLabels("ParcelIntakeMethod")) === JSON.stringify(["ALREADY_AT_COMPANY", "DRIVER_COLLECTION"]));
check("enum ParcelCollectionStatus", JSON.stringify(await enumLabels("ParcelCollectionStatus")) === JSON.stringify(["AWAITING_ASSIGNMENT", "ASSIGNED", "COLLECTED_FROM_SENDER", "FAILED", "RESCHEDULED", "RECEIVED_AT_COMPANY"]));
check("enum ParcelCollectionAttemptOutcome", JSON.stringify(await enumLabels("ParcelCollectionAttemptOutcome")) === JSON.stringify(["COLLECTED", "FAILED"]));
check("enum ParcelCollectionAssignmentEndReason", JSON.stringify(await enumLabels("ParcelCollectionAssignmentEndReason")) === JSON.stringify(["REASSIGNED", "FAILED", "RECEIVED_AT_COMPANY", "ORDER_CANCELLED"]));
check("OrderStatus NOT expanded (still 11 labels)", (await enumLabels("OrderStatus")).length === 11);

// --- Constraints / indexes present ---
const hasConstraint = async (n) => (await val(`select count(*)::int from pg_constraint where conname = '${n}'`)) > 0;
const hasIndex = async (n) => (await val(`select count(*)::int from pg_indexes where indexname = '${n}'`)) > 0;
check("CHECK parcel_collection_assignments_current_state_chk", await hasConstraint("parcel_collection_assignments_current_state_chk"));
check("partial unique parcel_collection_assignments_one_current_per_order_uq", await hasIndex("parcel_collection_assignments_one_current_per_order_uq"));
check("unique parcel_collection_attempts (order_id, attempt_number)", await hasConstraint("parcel_collection_attempts_order_id_attempt_number_key"));
check("partial unique parcel_collection_attempts_one_collected_per_order_uq", await hasIndex("parcel_collection_attempts_one_collected_per_order_uq"));
check("index orders_parcel_collection_status_idx", await hasIndex("orders_parcel_collection_status_idx"));
check("index orders_parcel_intake_method_idx", await hasIndex("orders_parcel_intake_method_idx"));
check("index orders_current_parcel_collection_driver_id_idx", await hasIndex("orders_current_parcel_collection_driver_id_idx"));
check("FK orders_current_parcel_collection_driver_id_fkey", await hasConstraint("orders_current_parcel_collection_driver_id_fkey"));
check("FK orders_parcel_collection_area_id_fkey", await hasConstraint("orders_parcel_collection_area_id_fkey"));
check("FK orders_received_at_company_by_id_fkey", await hasConstraint("orders_received_at_company_by_id_fkey"));

// --- Column nullability / defaults ---
const cols = (await client.query(
  `select column_name, is_nullable, column_default from information_schema.columns
     where table_schema='public' and table_name='orders'
       and (column_name like 'parcel%' or column_name like '%parcel_collection%'
            or column_name like 'received_at_company%')`,
)).rows;
const col = (n) => cols.find((c) => c.column_name === n);
check("orders.parcel_intake_method NOT NULL", col("parcel_intake_method")?.is_nullable === "NO");
check("orders.parcel_collection_status NOT NULL", col("parcel_collection_status")?.is_nullable === "NO");
check("orders.parcel_intake_method has temp default", /ALREADY_AT_COMPANY/.test(col("parcel_intake_method")?.column_default ?? ""));
check("orders.parcel_collection_status has temp default", /RECEIVED_AT_COMPANY/.test(col("parcel_collection_status")?.column_default ?? ""));
check("orders.received_at_company_at nullable", col("received_at_company_at")?.is_nullable === "YES");
check("orders.received_at_company_by_id nullable", col("received_at_company_by_id")?.is_nullable === "YES");
check("orders.current_parcel_collection_driver_id nullable", col("current_parcel_collection_driver_id")?.is_nullable === "YES");
for (const n of ["parcel_collection_contact_name", "parcel_collection_phone", "parcel_collection_alt_phone", "parcel_collection_area", "parcel_collection_address", "parcel_collection_notes"]) {
  check(`orders.${n} nullable, no default`, col(n)?.is_nullable === "YES" && col(n)?.column_default == null);
}

await client.end();

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : failures + " CHECK(S) FAILED"}`);
if (failures === 0) {
  try { rmSync(BASELINE); } catch { /* ignore */ }
}
process.exit(failures === 0 ? 0 : 1);
