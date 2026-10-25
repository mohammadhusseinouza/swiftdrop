// Read-only inspection of a database managed by Prisma Migrate.
// Used by scripts/build.mjs (Vercel production builds). Never prints credentials,
// and never prints individual customer/driver records (only counts + fingerprints).
//
// Every query runs in a read-only session: nothing here can modify the database.

import pg from "pg";

export const BASELINE_MIGRATION = "0_init";
export const NUMBERING_MIGRATION = "20260922000000_customer_driver_sequential_numbers";
export const DIRECT_COLLECTIONS_MIGRATION = "20260923000000_payment_method_bypass_driver_cash";
export const FINANCIAL_RELEASE_MIGRATION = "20261016000000_settlement_financial_release_foundation";
export const FINANCIAL_RELEASE_SETTING_KEY = "financial_release.settlement_mode_enabled";
export const HISTORICAL_RECONCILIATION_MIGRATION = "20261025000000_driver_cash_historical_reconciliation_foundation";
export const HISTORICAL_OWNERSHIP_MIGRATION = "20261026000000_historical_ownership_liability_foundation";

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

// FR.2 settlement-based financial release (additive). The runtime gate G1 checks the
// full 48-object list; this is the build-time presence check per migration state.
const FR_TYPES = ["FinancialReleaseMode", "FinancialReleaseStatus", "FinancialReleaseReviewStatus", "DriverSettlementCorrectionType", "OrderFinancialReleaseCorrectionType"];
const FR_STATUS_LABELS = ["AWAITING_SETTLEMENT", "COLLECTION_VOIDED", "RELEASE_REVERSED"];
const FR_TABLES = ["order_financial_releases", "driver_settlement_allocations", "driver_settlement_corrections", "order_financial_release_corrections"];
const FR_COLUMNS = ["orders.financial_release_mode", "driver_settlements.allocated_total", "driver_settlements.unattributed_amount", "driver_settlements.unattributed_reason"];
const FR_UNIQUE_INDEXES = [
  "order_financial_releases_order_id_key",
  "order_financial_releases_collection_transaction_id_key",
  "driver_settlement_allocations_settlement_id_release_id_key",
  "dsc_one_reversal_per_settlement_uq",
  "order_financial_release_corrections_release_id_key",
  "driver_settlements_id_driver_id_key",
];

// FR.12A.3 driver cash historical reconciliation (additive, evidence only).
const HR_TYPES = [
  "FinancialLedgerIncidentCause",
  "DriverCashHistoricalReconciliationKind",
  "HistoricalReconciliationAccountingTreatment",
  "HistoricalOwnershipStatus",
  "HistoricalReconciliationDecisionType",
];
const HR_TABLES = ["financial_ledger_incidents", "driver_cash_historical_reconciliations", "driver_cash_historical_reconciliation_decisions"];
const HR_UNIQUE_INDEXES = [
  "driver_cash_accounts_id_driver_id_key",
  "driver_cash_transactions_id_account_id_key",
  "dchr_root_anchor_uq",
  "dchr_root_missing_transaction_uq",
  "dchr_root_source_audit_uq",
  "dchr_supersedes_reconciliation_id_key",
  "dchrd_one_outcome_per_reconciliation_uq",
  "dchrd_revokes_decision_id_key",
];
const HR_CONSTRAINTS = ["dchr_evidence_digest_chk", "dchr_ownership_unresolved_chk", "dchrd_independent_reviewer_chk", "dchrd_reconciliation_evidence_fkey"];

// FR.12A.9 historical ownership / company-assumed liability (additive; posts nothing).
const HO_TYPES = ["HistoricalOwnershipOutcome", "HistoricalCollectionVerification", "HistoricalOwnershipEvidenceKind"];
const HO_TABLES = [
  "historical_liability_policies",
  "historical_liability_policy_decisions",
  "historical_ownership_resolutions",
  "historical_ownership_resolution_evidence",
  "historical_ownership_resolution_decisions",
  "historical_liabilities",
  "historical_liability_reviews",
];
const HO_UNIQUE_INDEXES = ["hor_root_deleted_order_uq", "hord_one_outcome_per_resolution_uq", "hlpd_one_outcome_per_policy_uq", "hl_resolution_id_key"];
const HO_CONSTRAINTS = [
  "hlp_policy_digest_chk",
  "hor_resolution_digest_chk",
  "hor_l1_full_collection_held_chk",
  "hor_l2_shortfall_tracked_chk",
  "hord_independent_revoker_chk",
  "hl_independent_recorder_chk",
  "hl_liability_digest_chk",
  "hl_resolution_binding_fkey",
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
    [FINANCIAL_RELEASE_MIGRATION]: applied.has(FINANCIAL_RELEASE_MIGRATION) ? "applied" : "pending",
    [HISTORICAL_RECONCILIATION_MIGRATION]: applied.has(HISTORICAL_RECONCILIATION_MIGRATION) ? "applied" : "pending",
    [HISTORICAL_OWNERSHIP_MIGRATION]: applied.has(HISTORICAL_OWNERSHIP_MIGRATION) ? "applied" : "pending",
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
    // settlement-based financial release (FR.2)
    fr_types: (await rows(`select typname from pg_type where typnamespace='public'::regnamespace and typname in (${FR_TYPES.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.typname),
    fr_status_labels: (await rows(`select e.enumlabel from pg_enum e join pg_type t on t.oid=e.enumtypid where t.typname='OrderFinancialStatus' and e.enumlabel in (${FR_STATUS_LABELS.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.enumlabel),
    fr_tables: (await rows(`select t from unnest(array[${FR_TABLES.map((t) => "'" + t + "'").join(",")}]) t where to_regclass('public.'||t) is not null order by 1`)).map((r) => r.t),
    fr_columns: (await rows(`select table_name||'.'||column_name c from information_schema.columns where table_schema='public' and table_name||'.'||column_name in (${FR_COLUMNS.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.c),
    fr_unique_indexes: (await rows(`select c.relname from pg_index i join pg_class c on c.oid=i.indexrelid where c.relnamespace='public'::regnamespace and i.indisunique and c.relname in (${FR_UNIQUE_INDEXES.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.relname),
    fr_setting: (await rows(`select jsonb_typeof(value::jsonb) type, value::text value from system_settings where key='${FINANCIAL_RELEASE_SETTING_KEY}'`))[0] ?? null,
    // driver cash historical reconciliation (FR.12A.3)
    hr_types: (await rows(`select typname from pg_type where typnamespace='public'::regnamespace and typname in (${HR_TYPES.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.typname),
    hr_tables: (await rows(`select t from unnest(array[${HR_TABLES.map((t) => "'" + t + "'").join(",")}]) t where to_regclass('public.'||t) is not null order by 1`)).map((r) => r.t),
    hr_unique_indexes: (await rows(`select c.relname from pg_index i join pg_class c on c.oid=i.indexrelid where c.relnamespace='public'::regnamespace and i.indisunique and c.relname in (${HR_UNIQUE_INDEXES.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.relname),
    hr_constraints: (await rows(`select conname from pg_constraint where connamespace='public'::regnamespace and conname in (${HR_CONSTRAINTS.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.conname),
    hr_triggers: await val(`select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relname in (${HR_TABLES.map((t) => "'" + t + "'").join(",")})`),
    // historical ownership / liability (FR.12A.9)
    ho_types: (await rows(`select typname from pg_type where typnamespace='public'::regnamespace and typname in (${HO_TYPES.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.typname),
    ho_tables: (await rows(`select t from unnest(array[${HO_TABLES.map((t) => "'" + t + "'").join(",")}]) t where to_regclass('public.'||t) is not null order by 1`)).map((r) => r.t),
    ho_unique_indexes: (await rows(`select c.relname from pg_index i join pg_class c on c.oid=i.indexrelid where c.relnamespace='public'::regnamespace and i.indisunique and c.relname in (${HO_UNIQUE_INDEXES.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.relname),
    ho_constraints: (await rows(`select conname from pg_constraint where connamespace='public'::regnamespace and conname in (${HO_CONSTRAINTS.map((t) => "'" + t + "'").join(",")}) order by 1`)).map((r) => r.conname),
    ho_triggers: await val(`select count(*)::int from pg_trigger t join pg_class c on c.oid=t.tgrelid where not t.tgisinternal and c.relname in (${HO_TABLES.map((t) => "'" + t + "'").join(",")})`),
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

  const frPresent = facts.fr_types.length + facts.fr_status_labels.length + facts.fr_tables.length + facts.fr_columns.length + facts.fr_unique_indexes.length + (facts.fr_setting ? 1 : 0);
  if (state[FINANCIAL_RELEASE_MIGRATION] === "pending") {
    if (frPresent) problems.push(`financial-release migration pending but ${frPresent} of its objects already exist (partial application — investigate before deploy)`);
  } else {
    for (const t of FR_TYPES) if (!facts.fr_types.includes(t)) problems.push(`financial-release migration applied but enum ${t} is missing`);
    for (const l of FR_STATUS_LABELS) if (!facts.fr_status_labels.includes(l)) problems.push(`financial-release migration applied but OrderFinancialStatus.${l} is missing`);
    for (const t of FR_TABLES) if (!facts.fr_tables.includes(t)) problems.push(`financial-release migration applied but table ${t} is missing`);
    for (const c of FR_COLUMNS) if (!facts.fr_columns.includes(c)) problems.push(`financial-release migration applied but column ${c} is missing`);
    for (const i of FR_UNIQUE_INDEXES) if (!facts.fr_unique_indexes.includes(i)) problems.push(`financial-release migration applied but unique index ${i} is missing`);
    if (!facts.fr_setting) problems.push(`financial-release migration applied but the ${FINANCIAL_RELEASE_SETTING_KEY} setting row is missing`);
    else if (facts.fr_setting.type !== "boolean") problems.push(`${FINANCIAL_RELEASE_SETTING_KEY} is not a JSON boolean`);
  }

  const hrPresent = facts.hr_types.length + facts.hr_tables.length + facts.hr_unique_indexes.length + facts.hr_constraints.length;
  if (state[HISTORICAL_RECONCILIATION_MIGRATION] === "pending") {
    if (hrPresent) problems.push(`historical-reconciliation migration pending but ${hrPresent} of its objects already exist (partial application — investigate before deploy)`);
  } else {
    for (const t of HR_TYPES) if (!facts.hr_types.includes(t)) problems.push(`historical-reconciliation migration applied but enum ${t} is missing`);
    for (const t of HR_TABLES) if (!facts.hr_tables.includes(t)) problems.push(`historical-reconciliation migration applied but table ${t} is missing`);
    for (const i of HR_UNIQUE_INDEXES) if (!facts.hr_unique_indexes.includes(i)) problems.push(`historical-reconciliation migration applied but unique index ${i} is missing`);
    for (const c of HR_CONSTRAINTS) if (!facts.hr_constraints.includes(c)) problems.push(`historical-reconciliation migration applied but constraint ${c} is missing`);
    if (facts.hr_triggers) problems.push(`historical-reconciliation tables carry ${facts.hr_triggers} trigger(s); none are expected`);
  }

  const hoPresent = facts.ho_types.length + facts.ho_tables.length + facts.ho_unique_indexes.length + facts.ho_constraints.length;
  if (state[HISTORICAL_OWNERSHIP_MIGRATION] === "pending") {
    if (hoPresent) problems.push(`historical-ownership migration pending but ${hoPresent} of its objects already exist (partial application — investigate before deploy)`);
  } else {
    if (state[HISTORICAL_RECONCILIATION_MIGRATION] !== "applied") problems.push("historical-ownership migration applied before the historical-reconciliation migration");
    for (const t of HO_TYPES) if (!facts.ho_types.includes(t)) problems.push(`historical-ownership migration applied but enum ${t} is missing`);
    for (const t of HO_TABLES) if (!facts.ho_tables.includes(t)) problems.push(`historical-ownership migration applied but table ${t} is missing`);
    for (const i of HO_UNIQUE_INDEXES) if (!facts.ho_unique_indexes.includes(i)) problems.push(`historical-ownership migration applied but unique index ${i} is missing`);
    for (const c of HO_CONSTRAINTS) if (!facts.ho_constraints.includes(c)) problems.push(`historical-ownership migration applied but constraint ${c} is missing`);
    if (facts.ho_triggers) problems.push(`historical-ownership tables carry ${facts.ho_triggers} trigger(s); none are expected`);
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
    fr_objects: `${f.fr_types.length}/${FR_TYPES.length} enums, ${f.fr_status_labels.length}/${FR_STATUS_LABELS.length} labels, ${f.fr_tables.length}/${FR_TABLES.length} tables, ${f.fr_columns.length}/${FR_COLUMNS.length} columns, ${f.fr_unique_indexes.length}/${FR_UNIQUE_INDEXES.length} unique indexes`,
    fr_activation: f.fr_setting ? f.fr_setting.value : "absent",
    hr_objects: `${f.hr_types.length}/${HR_TYPES.length} enums, ${f.hr_tables.length}/${HR_TABLES.length} tables, ${f.hr_unique_indexes.length}/${HR_UNIQUE_INDEXES.length} unique indexes, ${f.hr_constraints.length}/${HR_CONSTRAINTS.length} constraints`,
    ho_objects: `${f.ho_types.length}/${HO_TYPES.length} enums, ${f.ho_tables.length}/${HO_TABLES.length} tables, ${f.ho_unique_indexes.length}/${HO_UNIQUE_INDEXES.length} unique indexes, ${f.ho_constraints.length}/${HO_CONSTRAINTS.length} constraints`,
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
