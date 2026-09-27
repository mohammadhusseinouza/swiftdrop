// Read-only inspection of a database managed by Prisma Migrate.
// Used by scripts/build.mjs (Vercel production builds). Never prints credentials,
// and never prints individual customer/driver records (only counts + fingerprints).
//
// Every query runs in a read-only session: nothing here can modify the database.

import pg from "pg";

export const BASELINE_MIGRATION = "0_init";
export const NUMBERING_MIGRATION = "20260922000000_customer_driver_sequential_numbers";
export const DIRECT_COLLECTIONS_MIGRATION = "20260923000000_payment_method_bypass_driver_cash";

/** Hostname / database only — never user, password or query parameters. */
export function describeTarget(url) {
  const u = new URL(url);
  return { host: u.hostname, port: u.port || "5432", database: u.pathname.replace(/^\//, "") };
}

export async function connectReadOnly(url) {
  const client = new pg.Client({ connectionString: url });
  // pg parses connection strings differently from `new URL()` (used for the logged target).
  // Refuse to connect anywhere other than the host that was logged.
  const expected = describeTarget(url).host;
  if (client.host !== expected) {
    throw new Error(
      `pg resolved host "${client.host}" but the connection URL's host is "${expected}" — ` +
        "the URL likely contains whitespace or unencoded special characters",
    );
  }
  await client.connect();
  await client.query("SET default_transaction_read_only = on");
  return client;
}

const rowsOf = (client) => async (sql) => (await client.query(sql)).rows;
const valOf = (client) => async (sql) => Object.values((await client.query(sql)).rows[0])[0];

export async function identity(client) {
  return (
    await client.query(
      "select current_database() database, current_schema() schema, current_setting('search_path') search_path, current_setting('TimeZone') timezone, split_part(version(), ' ', 2) postgres",
    )
  ).rows[0];
}

/** _prisma_migrations as recorded in the database (null when the table does not exist). */
export async function migrationHistory(client) {
  const val = valOf(client);
  if (!(await val("select to_regclass('public._prisma_migrations')::text"))) return null;
  return rowsOf(client)(
    "select migration_name, finished_at is not null finished, rolled_back_at is not null rolled_back, applied_steps_count from _prisma_migrations order by started_at",
  );
}

/** Names of migrations recorded as successfully applied. */
export function appliedMigrations(history) {
  return new Set((history ?? []).filter((h) => h.finished && !h.rolled_back).map((h) => h.migration_name));
}

/**
 * Hard gate before `prisma migrate deploy` on production: the database must already be
 * baselined (0_init recorded as applied) and carry no failed migration. Otherwise
 * migrate deploy would try to CREATE the whole existing schema again, or stack new
 * migrations on top of a broken one.
 */
export function historyProblems(history) {
  if (history === null) return ["_prisma_migrations does not exist — database is not baselined for Prisma Migrate"];
  const problems = [];
  const init = history.find((h) => h.migration_name === BASELINE_MIGRATION);
  if (!init) problems.push(`${BASELINE_MIGRATION} is not recorded in _prisma_migrations`);
  else if (!init.finished || init.rolled_back) problems.push(`${BASELINE_MIGRATION} is recorded but not successfully applied`);
  for (const h of history) {
    if (!h.finished && !h.rolled_back) problems.push(`migration ${h.migration_name} is recorded as FAILED / in progress`);
  }
  return problems;
}

const CDC_CONSTRAINTS = [
  "company_direct_collections_pkey:p",
  "company_direct_collections_idempotency_key_key:u",
  "company_direct_collections_amount_positive:c",
  "company_direct_collections_order_id_fkey:f",
  "company_direct_collections_driver_id_fkey:f",
  "company_direct_collections_payment_method_id_fkey:f",
  "company_direct_collections_created_by_id_fkey:f",
];
const CDC_INDEXES = [
  "company_direct_collections_pkey",
  "company_direct_collections_idempotency_key_key",
  "company_direct_collections_created_at_idx",
  "company_direct_collections_order_id_idx",
  "company_direct_collections_driver_id_created_at_idx",
];

/**
 * State-aware checks for the migrations that follow the 0_init baseline.
 *
 *   pending  -> none of the migration's objects may exist (no partial application), and
 *               for the numbering migration no row may already use the new format
 *               (its backfill is skipped entirely if any row matches -> sequence collisions).
 *   applied  -> every object the migration creates must exist as defined.
 *
 * Returns { state, facts, problems }. Any problem blocks `deploy`.
 */
export async function migrationStateChecks(client, history) {
  const val = valOf(client);
  const rows = rowsOf(client);
  const applied = appliedMigrations(history);
  const state = {
    [NUMBERING_MIGRATION]: applied.has(NUMBERING_MIGRATION) ? "applied" : "pending",
    [DIRECT_COLLECTIONS_MIGRATION]: applied.has(DIRECT_COLLECTIONS_MIGRATION) ? "applied" : "pending",
  };

  const cdcTable = !!(await val("select to_regclass('public.company_direct_collections')::text"));
  const facts = {
    dependency_tables: await val(
      "select count(*)::int from unnest(array['orders','drivers','payment_methods','users','customers']) t where to_regclass('public.'||t) is not null",
    ),
    gen_random_uuid: (await val("select count(*)::int from pg_proc where proname='gen_random_uuid'")) > 0,
    // numbering (5152)
    number_sequences: (
      await rows(
        "select relname from pg_class where relkind='S' and relnamespace='public'::regnamespace and relname in ('customer_number_seq','driver_number_seq') order by 1",
      )
    ).map((r) => r.relname),
    customer_number_default: await val(
      "select column_default from information_schema.columns where table_schema='public' and table_name='customers' and column_name='customer_number'",
    ),
    driver_number_default: await val(
      "select column_default from information_schema.columns where table_schema='public' and table_name='drivers' and column_name='driver_number'",
    ),
    customers_new_format: await val("select count(*)::int from customers where customer_number ~ '^CUST-[0-9]{6,}$'"),
    drivers_new_format: await val("select count(*)::int from drivers where driver_number ~ '^DRV-[0-9]{6,}$'"),
    // direct collections (0923)
    cdc_table: cdcTable,
    cdc_objects: (
      await rows(
        "select relname n from pg_class where relnamespace='public'::regnamespace and relname like 'company_direct_collections%' union select conname from pg_constraint where conname like 'company_direct_collections%' order by 1",
      )
    ).map((r) => r.n),
    cdc_column_count: cdcTable
      ? await val("select count(*)::int from information_schema.columns where table_schema='public' and table_name='company_direct_collections'")
      : 0,
    cdc_constraints: cdcTable
      ? (await rows("select conname||':'||contype::text c from pg_constraint where conrelid='public.company_direct_collections'::regclass")).map((r) => r.c)
      : [],
    cdc_indexes: cdcTable
      ? (await rows("select indexname from pg_indexes where schemaname='public' and tablename='company_direct_collections'")).map((r) => r.indexname)
      : [],
    bypass_driver_cash_column:
      (
        await rows(
          "select data_type, is_nullable, column_default from information_schema.columns where table_schema='public' and table_name='payment_methods' and column_name='bypass_driver_cash'",
        )
      )[0] ?? null,
  };

  const problems = [];
  if (facts.dependency_tables !== 5) problems.push("a dependency table (orders/drivers/payment_methods/users/customers) is missing");
  if (!facts.gen_random_uuid) problems.push("gen_random_uuid() is not available");

  if (state[NUMBERING_MIGRATION] === "pending") {
    if (facts.number_sequences.length) problems.push(`numbering migration pending but sequences exist: ${facts.number_sequences.join(", ")}`);
    if (facts.customer_number_default) problems.push("numbering migration pending but customers.customer_number already has a default");
    if (facts.driver_number_default) problems.push("numbering migration pending but drivers.driver_number already has a default");
    if (facts.customers_new_format) problems.push(`numbering migration pending but ${facts.customers_new_format} customer(s) already use CUST-###### numbers`);
    if (facts.drivers_new_format) problems.push(`numbering migration pending but ${facts.drivers_new_format} driver(s) already use DRV-###### numbers`);
  } else {
    // Applied: CUST-/DRV- numbers are expected. Verify the generator is intact and ahead
    // of every existing number so the next insert cannot collide.
    if (facts.number_sequences.length !== 2) problems.push("numbering migration applied but a number sequence is missing");
    if (!/customer_number_seq/.test(facts.customer_number_default ?? "")) problems.push("numbering migration applied but customers.customer_number default is not the sequence");
    if (!/driver_number_seq/.test(facts.driver_number_default ?? "")) problems.push("numbering migration applied but drivers.driver_number default is not the sequence");
    if (facts.number_sequences.length === 2) {
      const behind = await rows(`
        select 'customer' k from customer_number_seq s
          where (select coalesce(max(substring(customer_number from 6)::bigint),0) from customers where customer_number ~ '^CUST-[0-9]{6,}$')
                > (case when s.is_called then s.last_value else 0 end)
        union all
        select 'driver' from driver_number_seq s
          where (select coalesce(max(substring(driver_number from 5)::bigint),0) from drivers where driver_number ~ '^DRV-[0-9]{6,}$')
                > (case when s.is_called then s.last_value else 0 end)`);
      for (const b of behind) problems.push(`${b.k}_number_seq is behind the highest existing ${b.k} number (next insert would collide)`);
    }
  }

  if (state[DIRECT_COLLECTIONS_MIGRATION] === "pending") {
    if (facts.cdc_table || facts.cdc_objects.length) problems.push(`direct-collections migration pending but objects exist: ${facts.cdc_objects.join(", ") || "company_direct_collections"}`);
    if (facts.bypass_driver_cash_column) problems.push("direct-collections migration pending but payment_methods.bypass_driver_cash exists");
  } else {
    if (!facts.cdc_table) problems.push("direct-collections migration applied but company_direct_collections is missing");
    else {
      if (facts.cdc_column_count !== 9) problems.push(`company_direct_collections has ${facts.cdc_column_count} columns, expected 9`);
      for (const c of CDC_CONSTRAINTS) if (!facts.cdc_constraints.includes(c)) problems.push(`company_direct_collections missing constraint ${c}`);
      for (const i of CDC_INDEXES) if (!facts.cdc_indexes.includes(i)) problems.push(`company_direct_collections missing index ${i}`);
    }
    const col = facts.bypass_driver_cash_column;
    if (!col || col.data_type !== "boolean" || col.is_nullable !== "NO" || col.column_default !== "false")
      problems.push("payment_methods.bypass_driver_cash missing or not BOOLEAN NOT NULL DEFAULT false");
  }

  return { state, facts, problems };
}

/** Compact, non-identifying one-line summary of the state facts for build logs. */
export function summarizeFacts(f) {
  return {
    dependency_tables: `${f.dependency_tables}/5`,
    gen_random_uuid: f.gen_random_uuid,
    number_sequences: f.number_sequences.length,
    customers_new_format: f.customers_new_format,
    drivers_new_format: f.drivers_new_format,
    company_direct_collections: f.cdc_table,
    cdc_objects: f.cdc_objects.length,
    cdc_constraints: f.cdc_constraints.length,
    cdc_indexes: f.cdc_indexes.length,
    bypass_driver_cash: f.bypass_driver_cash_column ? "present" : "absent",
  };
}

/** Counts, sums and hashes that no schema migration may change. */
export async function financialSnapshot(client) {
  const val = valOf(client);
  return {
    orders: await val("select count(*)::int from orders"),
    orders_financial_hash: await val(
      "select coalesce(md5(string_agg(concat_ws('|',id,status,financial_status,amount_to_collect,actual_amount_collected), ',' order by id)),'EMPTY') from orders",
    ),
    orders_relationship_hash: await val(
      "select coalesce(md5(string_agg(concat_ws('|',id,customer_id,current_driver_id), ',' order by id)),'EMPTY') from orders",
    ),
    order_assignments_hash: await val(
      "select coalesce(md5(string_agg(concat_ws('|',id,order_id,driver_id), ',' order by id)),'EMPTY') from order_assignments",
    ),
    customers: await val("select count(*)::int from customers"),
    customer_ids_hash: await val("select coalesce(md5(string_agg(id::text, ',' order by id)),'EMPTY') from customers"),
    drivers: await val("select count(*)::int from drivers"),
    driver_ids_hash: await val("select coalesce(md5(string_agg(id::text||':'||user_id, ',' order by id)),'EMPTY') from drivers"),
    customer_wallets: await val("select count(*)::int from customer_wallets"),
    wallet_available_sum: await val("select coalesce(sum(available_balance),0)::text from customer_wallets"),
    wallet_transactions: await val("select count(*)::int from wallet_transactions"),
    wallet_credit_sum: await val("select coalesce(sum(credit),0)::text from wallet_transactions"),
    wallet_debit_sum: await val("select coalesce(sum(debit),0)::text from wallet_transactions"),
    customer_payouts: await val("select count(*)::int from customer_payouts"),
    payouts_sum: await val("select coalesce(sum(amount),0)::text from customer_payouts"),
    driver_cash_accounts: await val("select count(*)::int from driver_cash_accounts"),
    driver_cash_balance_sum: await val("select coalesce(sum(current_balance),0)::text from driver_cash_accounts"),
    driver_cash_transactions: await val("select count(*)::int from driver_cash_transactions"),
    driver_settlements: await val("select count(*)::int from driver_settlements"),
    settlements_sum: await val("select coalesce(sum(amount_received),0)::text from driver_settlements"),
    company_financial_transactions: await val("select count(*)::int from company_financial_transactions"),
    company_financial_sum: await val("select coalesce(sum(amount),0)::text from company_financial_transactions"),
  };
}

/** Full id -> business number mapping, oldest first. Kept in memory only — never logged. */
export async function numberMapping(client) {
  const rows = rowsOf(client);
  return {
    customers: await rows("select id, customer_number number from customers order by created_at, id"),
    drivers: await rows("select id, driver_number number from drivers order by created_at, id"),
  };
}

/**
 * Non-identifying fingerprint of a mapping: row count + md5 over "id:number" (sorted by id).
 * Recomputing it from a backup proves the backup holds exactly this pre-migration mapping,
 * without the build log ever containing an individual record.
 */
export async function mappingFingerprint(client) {
  const val = valOf(client);
  return {
    customers: await val("select count(*)::text||':'||coalesce(md5(string_agg(id::text||':'||customer_number, ',' order by id)),'EMPTY') from customers"),
    drivers: await val("select count(*)::text||':'||coalesce(md5(string_agg(id::text||':'||driver_number, ',' order by id)),'EMPTY') from drivers"),
  };
}

/**
 * Summarise how a deployment changed business numbers, without listing records:
 * same id set? how many renumbered? does every row match the migration's oldest-first
 * rule (PREFIX + rank by created_at, id)?
 */
export function mappingChangeSummary(before, after) {
  const out = {};
  for (const [kind, prefix] of [["customers", "CUST-"], ["drivers", "DRV-"]]) {
    const a = new Map(after[kind].map((r) => [r.id, r.number]));
    const sameIds = before[kind].length === after[kind].length && before[kind].every((r) => a.has(r.id));
    const changed = before[kind].filter((r) => a.get(r.id) !== r.number).length;
    const oldestFirst = after[kind].every((r, i) => r.number === prefix + String(i + 1).padStart(6, "0"));
    out[kind] = { rows: after[kind].length, same_ids: sameIds, renumbered: changed, sequential_oldest_first: oldestFirst };
  }
  return out;
}

export function compareSnapshots(before, after) {
  return Object.keys(before).map((k) => ({ key: k, before: String(before[k]), after: String(after[k]), same: String(before[k]) === String(after[k]) }));
}
