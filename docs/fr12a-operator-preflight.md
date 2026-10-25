# FR.12A.1 — Human-Assisted Production Preflight (operator checklist)

Status: **prepared, not executed.** Every step here is read-only. Nothing in this document
authorizes a migration, deployment, environment-variable change, backup/restore, activation,
commit, push or merge.

Rules for the operator:
- Never paste a connection string, password, token or key into a report, chat, ticket or log.
- Report **presence**, **scope**, **port / pooler type** and **non-secret values** only.
- Report counts, sums and verdicts only; never customer, receiver or driver names, phones or
  addresses.
- Change nothing. If a screen offers Save / Redeploy / Promote / Rollback / Restore — do not click.

Evidence is recorded in the table in §5 as **PASS / FAIL / NOT VERIFIED**.

---

## 1. Vercel Dashboard (read-only)

There are two Vercel projects connected to `github.com/mohammadhusseinouza/swiftdrop`:
- **API project** (root directory `server/`, production alias `swiftdrop-api-omega.vercel.app`)
- **Client project** (root directory `client/`; its production domain is not recorded in the
  repo)

### 1.1 API project

| # | Where | Record |
|---|---|---|
| V1 | Deployments → filter *Production* → the deployment marked **Current** | commit SHA (short), branch, created time. Expected: `8b47fd9` on `main` (pre-FR) |
| V2 | Settings → Git | connected repository; **Production Branch** name; whether *Ignored Build Step* is set (and its command) |
| V3 | Settings → Git → Deploy Hooks | how many hooks exist (names only, never the URL) |
| V4 | Settings → General → Build & Development | Root Directory; Build Command (expected `npm run build` from `server/vercel.json`) |
| V5 | Settings → Environment Variables → `PRISMA_MIGRATE_MODE` | present? which scopes (Production / Preview / Development)? **value** (`preflight` / `deploy` / `disabled` — not secret) |
| V6 | `MIGRATION_DATABASE_URL` | present? scopes? port only (5432 direct/session vs 6543 transaction pooler) — **do not reveal the value** |
| V7 | `DATABASE_URL` | present? scopes? port only. **For the Preview scope:** does it point at the **production** Supabase project or a separate one? (project ref match yes/no — do not reveal it) |
| V8 | `CLIENT_URL` | present? scopes? value (a public URL — not secret) |
| V9 | `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED`, `SETTLEMENT_SHORTFALL_POLICY_APPROVED` | must be **absent** in every scope |
| V10 | Settings → Environment Variables → *Automatically expose System Environment Variables* | enabled? (`build.mjs` refuses to build on Vercel without `VERCEL_ENV`) |
| V11 | Current Production deployment → **Build Logs** (read only — do not redeploy) | copy the `[build]` lines **with any host/database name removed**: the line `Vercel Production build; migration target …; PRISMA_MIGRATE_MODE=<mode>`, and, if the mode was `preflight` or `deploy`: the `identity:` line's `timezone` and `postgres` values, `_prisma_migrations: …`, `migration state: …`, `schema facts: …`, and the `PREFLIGHT RESULT` / post-migration lines. If the line says `PRISMA_MIGRATE_MODE=disabled` or the build failed before it, record that |

**How to read V2 + V5 (can a push migrate production?)**

| Production Branch | Ignored Build Step | `PRISMA_MIGRATE_MODE` (Production) | A push to that branch… |
|---|---|---|---|
| `main` | none | `deploy` | **builds and migrates production automatically** |
| `main` | none | `preflight` | builds and deploys new code **without** migrating — FR code would run against the pre-FR schema |
| `main` | none | `disabled` | same as `preflight`, with a warning |
| `main` | none | absent | the Production build **fails** (`build.mjs` refuses to guess); the previous deployment keeps serving |
| any | a command that skips | any | no build |

### 1.2 Client project

| # | Where | Record |
|---|---|---|
| C1 | Deployments → Production → Current | commit SHA, branch, created time |
| C2 | Settings → Domains | the production client origin (public) — this is the value `CLIENT_URL` must hold |
| C3 | Settings → Git | Production Branch; Ignored Build Step |
| C4 | Browser: `https://<client origin>/version.json` | the response. Expected today: **no** `financialReleaseContract` (the file is not yet committed; the SPA rewrite may return the HTML app shell instead of JSON) |
| C5 | Settings → Environment Variables | `VITE_API_BASE_URL` value per scope (repo default `/api/v1`, proxied by `client/vercel.json` to the API alias) |

---

## 2. Supabase Dashboard / SQL Editor (read-only)

### 2.1 Project facts (Dashboard)

| # | Where | Record |
|---|---|---|
| S1 | Project Settings → General / Billing | plan (Free / Pro / Team / Enterprise), region |
| S2 | Database → Backups (Scheduled) | latest backup timestamp; retention |
| S3 | Database → Backups → Point in Time | PITR enabled? retention window; earliest recovery point |
| S4 | (records, not the dashboard) | has a restore of a recent backup into a **non-production** project ever been performed and compared (runbook §8.2)? date, by whom |

Do **not** start a backup, restore or PITR change from these screens.

### 2.2 SQL Editor — Query A (always safe; works before and after the FR migration)

A single `SELECT`. It contains no DML/DDL and calls no side-effecting functions; it returns one
row per check with counts / sums only. Paste it alone and run it once. The SQL Editor connects
directly (not through the transaction pooler), so the runtime path is covered separately in §3.

```sql
-- FR.12A.1 Query A — read-only. Counts / sums / catalog facts only.
select * from (values
  ('tz.session',                current_setting('TimeZone')),
  ('tz.source',                 (select source from pg_settings where name = 'TimeZone')),
  ('tz.overrides',              coalesce((select string_agg(coalesce(r.rolname, '<all roles>') || ': ' || array_to_string(s.setconfig, ','), '; ')
                                   from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole
                                   where (s.setdatabase = (select oid from pg_database where datname = current_database()) or s.setdatabase = 0)
                                     and array_to_string(s.setconfig, ',') ilike '%timezone%'), 'none')),
  ('pg.version',                split_part(version(), ' ', 2)),
  ('ts.timestamptz_columns',    (select count(*)::text from information_schema.columns where table_schema = 'public' and data_type = 'timestamp with time zone')),
  ('ts.timestamp_no_tz_columns',(select count(*)::text from information_schema.columns where table_schema = 'public' and data_type = 'timestamp without time zone')),
  ('ts.date_columns',           (select count(*)::text from information_schema.columns where table_schema = 'public' and data_type = 'date')),
  ('migrations.table_exists',   (to_regclass('public._prisma_migrations') is not null)::text),
  ('fr.enums',                  (select count(*)::text || '/5' from pg_type where typnamespace = 'public'::regnamespace and typname in ('FinancialReleaseMode','FinancialReleaseStatus','FinancialReleaseReviewStatus','DriverSettlementCorrectionType','OrderFinancialReleaseCorrectionType'))),
  ('fr.status_labels',          (select count(*)::text || '/3' from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'OrderFinancialStatus' and e.enumlabel in ('AWAITING_SETTLEMENT','COLLECTION_VOIDED','RELEASE_REVERSED'))),
  ('fr.tables',                 (select count(*)::text || '/4' from unnest(array['order_financial_releases','driver_settlement_allocations','driver_settlement_corrections','order_financial_release_corrections']) t where to_regclass('public.' || t) is not null)),
  ('fr.columns',                (select count(*)::text || '/4' from information_schema.columns where table_schema = 'public' and table_name || '.' || column_name in ('orders.financial_release_mode','driver_settlements.allocated_total','driver_settlements.unattributed_amount','driver_settlements.unattributed_reason'))),
  ('fr.unique_indexes',         (select count(*)::text || '/6' from pg_index i join pg_class c on c.oid = i.indexrelid where c.relnamespace = 'public'::regnamespace and i.indisunique and c.relname in ('order_financial_releases_order_id_key','order_financial_releases_collection_transaction_id_key','driver_settlement_allocations_settlement_id_release_id_key','dsc_one_reversal_per_settlement_uq','order_financial_release_corrections_release_id_key','driver_settlements_id_driver_id_key'))),
  ('fr.activation_row',         coalesce((select value::text from system_settings where key = 'financial_release.settlement_mode_enabled'), 'absent')),
  ('cash.accounts',             (select count(*)::text from driver_cash_accounts)),
  ('cash.drivers_nonzero',      (select count(*)::text from driver_cash_accounts where current_balance <> 0)),
  ('cash.total',                (select coalesce(sum(current_balance), 0)::text from driver_cash_accounts)),
  ('cash.ledger_mismatches_G3', (select count(*)::text from driver_cash_accounts a
                                   left join (select account_id, sum(balance_after - balance_before) net from driver_cash_transactions group by account_id) t on t.account_id = a.id
                                   where a.current_balance <> coalesce(t.net, 0))),
  ('cash.raw_discrepancy_total', (select coalesce(sum(a.current_balance - coalesce(t.net, 0)), 0)::text from driver_cash_accounts a
                                   left join (select account_id, sum(balance_after - balance_before) net from driver_cash_transactions group by account_id) t on t.account_id = a.id
                                   where a.current_balance <> coalesce(t.net, 0))),
  ('hr.tables',                 (select count(*)::text || '/3' from unnest(array['financial_ledger_incidents','driver_cash_historical_reconciliations','driver_cash_historical_reconciliation_decisions']) t where to_regclass('public.' || t) is not null)),
  ('wallet.ledger_mismatches_G4',(select count(*)::text from customer_wallets w
                                   left join (select wallet_id, sum(credit - debit) net from wallet_transactions group by wallet_id) t on t.wallet_id = w.id
                                   where w.available_balance <> coalesce(t.net, 0))),
  ('G5.review_required',        (select count(*)::text from orders where status = 'DELIVERED' and financial_status = 'REVIEW_REQUIRED')),
  ('G5.deleted_orders_unresolved_difference', (select count(distinct l.entity_id)::text from audit_logs l
                                   where l.action = 'COLLECTION_DIFFERENCE_RECORDED' and l.entity_type = 'ORDER'
                                     and not exists (select 1 from orders o where o.id::text = l.entity_id)
                                     and not exists (select 1 from audit_logs z where z.entity_type = 'ORDER' and z.entity_id = l.entity_id and z.action = 'COLLECTION_DIFFERENCE_RESOLVED'))),
  ('G5.settlements_no_cash_row',(select count(*)::text from driver_settlements d where not exists (select 1 from driver_cash_transactions x where x.settlement_id = d.id))),
  ('H1.company_no_order',       (select count(*)::text from company_financial_transactions where type in ('DELIVERY_FEE_REVENUE','COMPANY_ORDER_PRODUCT_REVENUE') and order_id is null)),
  ('H1.wallet_credit_no_order', (select count(*)::text from wallet_transactions where type = 'ORDER_CREDIT' and order_id is null)),
  ('H2.nonpositive_revenue',    (select count(*)::text from company_financial_transactions where type in ('DELIVERY_FEE_REVENUE','COMPANY_ORDER_PRODUCT_REVENUE') and amount <= 0)),
  ('H.amount',                  (select coalesce(sum(amount), 0)::text from company_financial_transactions where type in ('DELIVERY_FEE_REVENUE','COMPANY_ORDER_PRODUCT_REVENUE') and (order_id is null or amount <= 0)))
) as preflight(check_name, result);
```

`G5.review_required` counts all such orders. Before the FR migration every one of them is an
older, pre-FR (legacy) review.

### 2.3 SQL Editor — Query B (migration history; run only if `migrations.table_exists = true`)

```sql
-- FR.12A.1 Query B — read-only.
select migration_name,
       finished_at is not null  as finished,
       rolled_back_at is not null as rolled_back,
       applied_steps_count
from _prisma_migrations
order by started_at;
```

Expected for a correctly baselined production running `8b47fd9`: `0_init`,
`20260922000000_customer_driver_sequential_numbers`,
`20260923000000_payment_method_bypass_driver_cash`, `20261011000000_driver_expenses_foundation`,
all `finished = true`, `rolled_back = false`; **no** `20261016000000_settlement_financial_release_foundation` row.

### 2.4 Interpreting Query A / B

| Check | PASS | FAIL → consequence |
|---|---|---|
| `tz.session`, `tz.overrides` | `UTC` (or `Etc/UTC`); no override, or only a UTC override | **STOP** — no migration/activation; separate remediation (readiness §4) |
| `ts.timestamp_no_tz_columns` | `0` (dev copies: 70 timestamptz, 2 date) | warn; list them via the preflight script |
| `migrations.table_exists` + Query B | table exists; 4 rows above, all finished, none rolled back | not baselined / failed row → **no migration** until resolved |
| `fr.*` | all `0/…` (FR pending, nothing partial) | any non-zero before the history row exists = **partial application → STOP, investigate** |
| `fr.activation_row` | `absent` | present before the migration → STOP, investigate |
| `cash.ledger_mismatches_G3`, `cash.raw_discrepancy_total` | `0` | **Raw** rule. A non-zero raw count is acceptable for the migration go/no-go **only** when it is exactly a documented, approved ledger incident (same account, same amount; see `docs/fr12a2-historical-ledger-reconciliation-design.md` §12). Activation also needs the **residual** rule (FR.12A.4). Only the preflight script (§3) and the readiness dry run evaluate it, after the historical reconciliation migration. Query A cannot evaluate it. |
| `hr.tables` | `0/3` before the historical reconciliation migration, `3/3` after it | any other value means partial application → **STOP** |
| `wallet.ledger_mismatches_G4` | `0` | blocks migration go/no-go (§8.3) |
| `G5.deleted_orders_unresolved_difference` | `0` before **activation** | A deleted order whose collection difference was never resolved: nobody has determined who owns the collected money (FR.12A.4 G5). An approved ledger reconciliation does **not** clear it. |
| `cash.drivers_nonzero`, `cash.total` | any value is acceptable for **migration**; must be `0` before **activation** (G2) | — |
| `G5.*` | `0` needed before **activation** | — |
| `H1.*`, `H2.*` | expected `0` in production | non-zero: investigate the origin before cutover; **never delete or edit** |

---

## 3. Existing preflight script — direct and runtime paths

Run by an operator who already holds the production URLs (from Vercel, without sharing them),
on a workstation with this working copy (the script and the FR-aware `db-inspect.mjs` are not yet
committed). From `server/`, after `npm ci`:

```bash
# 3.1 Direct or session-pooler path (port 5432 — the MIGRATION_DATABASE_URL kind)
PREFLIGHT_DATABASE_URL='<direct/session URL>' \
CLIENT_URL='https://<production client origin>' \
npx tsx scripts/fr-production-preflight.mjs --out preflight-direct.json

# 3.2 Runtime path (the app's DATABASE_URL, e.g. the 6543 transaction pooler) — session checks
PREFLIGHT_DATABASE_URL='<runtime pooler URL>' \
npx tsx scripts/fr-production-preflight.mjs --out preflight-runtime.json
```

- Prefix each command with a space only if the shell is configured to skip history for such
  lines; otherwise clear the history entry afterwards. Never paste the URL into a file in the repo.
- The script forces and verifies a read-only session before any query and prints counts, sums,
  schema facts and verdicts only. The target line shows host/port/database — **remove the host
  and database name** before sharing console output; the JSON files contain no credentials or
  customer data.
- Exit codes: 0 = no blocker, 2 = blocker(s), 1 = the preflight failed.
- Before the FR migration, step 7 (gates G0–G7 and R1–R13) is **skipped by design**: R1–R13 read
  the FR tables and can only run after the migration (runbook §8.4.4).

Expected pre-migration result on a healthy production: `session time zone` OK on **both** paths,
`migration history` OK, `financial-release migration … pending`, `activation setting` OK (absent),
G3/G4 OK. G2/G5/H are warnings that matter only for activation.

---

## 4. Backup verification (read-only)

| # | Question | Source |
|---|---|---|
| B1 | Does a recoverable backup or PITR point newer than the planned window exist? | S2 / S3 |
| B2 | Has a restore into a non-production project been performed and its `financial baseline` compared with production (runbook §8.2)? | records / S4 |
| B3 | Free plan? | S1 — Free projects have no dashboard-restorable scheduled backups; a logical dump would need separate authorization |

Creating a backup, changing PITR or performing a restore each needs **separate authorization**.

---

## 5. Evidence table (fill in)

| ID | Check | Result | Evidence (non-secret) |
|---|---|---|---|
| V1 | API production commit | NOT VERIFIED | |
| V2/V3 | API auto-deploy from production branch; hooks | NOT VERIFIED | |
| V5 | `PRISMA_MIGRATE_MODE` (Production) | NOT VERIFIED | |
| V6 | `MIGRATION_DATABASE_URL` present, port 5432 | NOT VERIFIED | |
| V7 | Preview `DATABASE_URL` is **not** production | NOT VERIFIED | |
| V8 | `CLIENT_URL` | NOT VERIFIED | |
| V9 | activation / shortfall vars absent | NOT VERIFIED | |
| V10 | system env vars exposed | NOT VERIFIED | |
| V11 | latest production build-log preflight | NOT VERIFIED | |
| C1–C5 | client commit / domain / auto-deploy / `version.json` | NOT VERIFIED | |
| A-tz | time zone, direct path | NOT VERIFIED | |
| R-tz | time zone, runtime path (§3.2) | NOT VERIFIED | |
| A-ts | timestamp column types | NOT VERIFIED | |
| B-mig | migration history baselined, no failures | NOT VERIFIED | |
| A-fr | FR objects 0 (pending, not partial) | NOT VERIFIED | |
| A-act | activation row absent | NOT VERIFIED | |
| A-G3/G4 | ledgers equal | NOT VERIFIED | |
| A-G2 | driver cash total / non-zero drivers | NOT VERIFIED | |
| A-G5 | open reviews / settlements without cash row | NOT VERIFIED | |
| A-H | H1 / H2 counts | NOT VERIFIED | |
| R1–R13 | reconciliation | NOT VERIFIED (only after the migration) | |
| LAT | latency probe p95 (×3) | NOT VERIFIED (only after the server deploy) | |
| B1/B2 | backup exists / restore verified | NOT VERIFIED | |

---

## 6. Deployment sequencing — proposal (for approval; nothing executed)

Hazards found in the configuration (to be confirmed by §1):
1. **Push-to-migrate.** The API builds on every push to its production branch; with
   `PRISMA_MIGRATE_MODE=deploy` that push migrates production.
2. **Code ahead of schema.** With `preflight` / `disabled`, the same push ships FR server code
   against the pre-FR schema (the FR server code requires the FR schema).
3. **Preview reaches production.** Pushing any branch creates Preview deployments of both
   projects. If the Preview `DATABASE_URL` is the production database, FR server code would run
   (and could write) against the pre-FR production schema from a preview URL.
4. **Client ahead of server.** Both projects build from the same push, so the FR client can go
   live before — or without — the FR server (the server build may fail its migration guard and
   keep the old deployment serving).
5. **Promote / Instant Rollback** reuse an existing build. Promoting a Preview build of the API
   would put FR code into production **without** running `build.mjs` in production mode, unless
   Vercel rebuilds it with `VERCEL_ENV=production` — verify the project's behaviour before
   relying on either.

Proposed strategy:
1. **Confirm the configuration first** (§1, §2, §3). Nothing is pushed until V2, V5, V7 and C3 are known.
2. **Isolate previews.** Preview scope `DATABASE_URL` must point at a non-production database
   (ideally the §8.2 restore), or preview builds of the release branch must be skipped (Ignored
   Build Step). Changing either is an environment change → separate authorization.
3. **Release branch, not `main`.** Commit FR.1–FR.11B to `release/fr` after review; run the full
   backend + frontend regression on that exact commit. `main` stays at the pre-FR production commit.
4. **Rehearsal on the restore** (non-production project): run §3 against it, then the migration
   (`prisma migrate deploy`) there, then §3 again — expect `applied`, 0 problems, unchanged
   baseline, R1–R13 = 0. Separate authorization.
5. **Cutover window** (runbook §8.4), separately authorized:
   - hold the client's production deploys (client Ignored Build Step, or a branch the client
     does not deploy) so the client cannot go live first;
   - set API `PRISMA_MIGRATE_MODE=deploy` (Production) and confirm `MIGRATION_DATABASE_URL` (5432);
   - merge `release/fr` → `main`; the API Production build runs guards → migrate → status →
     post-checks → snapshot comparison; any failure keeps the old deployment;
   - verify the server (Financial Release tab: Disabled, G1 pass, R1–R13 = 0; latency ×3);
   - then release the client (Redeploy of the `main` commit with production env), set
     `CLIENT_URL`, confirm G7.
6. **Activation** stays a separate later stage (runbook §8.5–§8.6) with written authorization.

Optional hardening for approval (FR.12B or later, not implemented): make `build.mjs` **fail** a
Production build when `PRISMA_MIGRATE_MODE` ≠ `deploy` and a committed migration is pending, so
hazard 2 becomes impossible rather than procedural.
