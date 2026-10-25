# FR.11B — Activation UI and Final Release Readiness

Status: **implemented, pending approval** (2026-10-18). This document **supersedes the cutover
plan in `fr11a-release-readiness.md` §6** — §8 below is the authoritative runbook.

Nothing in FR.11B touched production:
- no production database access, migration, deployment or environment change
- no activation outside isolated copies
- shortfall creation stays disabled
- no commits

---

## 1. Admin activation interface

Settings → **Financial Release** tab (`?tab=financial-release`).
- It is listed and rendered for the **ADMIN role only**: `visibleSettingsTabs` and
  `parseSettingsTab(raw, role)`. For any other role, a deep link falls back to General.
- UX only. Every endpoint is `requireRole("ADMIN")` server-side.
- Code:
  - `client/src/pages/management/settings/FinancialReleaseTab.tsx`
  - `financialReleaseActivation.ts` (pure rules)
  - `client/src/services/financialReleaseAdminApi.ts`

| Section | Shows |
|---|---|
| Status | Feature state; environment authorization ("Authorized for cutover" / "Not authorized" — the variable's value is never shown); server contract; this browser's client contract; deployed client contract (from G7); last change |
| Actions | **Activate** is disabled unless the server reports the environment authorized, a readiness report passes every gate, the report is ≤ 5 minutes old, and the browser's contract equals the server's. Each blocking reason is listed. **Deactivate** is shown whenever the feature is on and is never gated. |
| Readiness gates | Dry run G0–G7, each Passed / Failed / Not evaluated, with what it checks, how to resolve it, and the affected count with a sample. "Run readiness check" re-runs it. After a refused activation, the server's own gate evaluation is shown instead. |
| Financial reconciliation | Every R1–R13 / H / I check: kind, Pass / Fail / Review / Info, affected count |
| Historical findings | H1 / H2 counts: "always reported, never hidden, deleted or rewritten; do not block activation" |
| Database latency | On-demand probe (§3) with the recommended allocation limit |

**Confirmation:**
- **Activation** opens a modal listing the consequences. Its Activate button stays disabled until
  the Admin ticks "I confirm the production cutover for this environment was authorized and I
  reviewed the readiness report."
- **Deactivation** opens a modal stating that existing settlement-mode orders continue unchanged.
- **Outcomes:**
  - success → audited state message
  - 409 `ACTIVATION_GATE_FAILED` → "Nothing was changed" plus the server's gate list
  - 5xx or network failure → "not confirmed — state reloaded"

**Also changed:** the General tab no longer offers **Edit** for
`financial_release.settlement_mode_enabled` (the generic endpoint always refused it). It now
shows "Managed in Financial Release (Admin)".

**Browser verification** used headless Edge on the isolated `swiftdrop_fr11recon` copy:
- **Unauthorized server, 18/18 checks pass:**
  - G0 failed and G1–G7 passed; Activate disabled with its reason
  - contracts FR.11 / FR.11 / FR.11; reconciliation and H1/H2 shown
  - keyboard reaches and operates the latency probe
  - 390 px has no overflow; AA contrast holds on 181 elements
  - for FINANCE, the tab is hidden, the deep link falls back to General, and the key is marked on General
- **Scratch server on the isolated copy started with authorization, 15/15 checks pass:**
  - all gates passed and Activate was enabled
  - the acknowledgement is required; Escape cancels and returns focus
  - activated through the UI, then deactivated through the UI
  - the database ended `false`, and both changes were audited
- No console errors in either phase.

---

## 2. Database inspection and read-only production preflight

**`scripts/db-inspect.mjs`** (used by the Production build's `preflight` / `deploy` modes) now
recognizes `20261016000000_settlement_financial_release_foundation`:
- **Pending:** none of its objects may exist. Otherwise it reports "partial application —
  investigate before deploy", which blocks `deploy`.
- **Applied:** all of the following must exist:
  - 5 enums
  - 3 `OrderFinancialStatus` labels
  - 4 tables
  - 4 columns
  - 6 key unique indexes
  - the activation row as a JSON boolean
- The build log's fact summary adds `fr_objects` and `fr_activation`.

Verified on isolated copies:

| Scenario | Result |
|---|---|
| All migrations applied | applied, 0 problems |
| Pre-FR schema, FR pending, history recorded | pending, 0 problems |
| FR objects present but the history row missing | pending → **1 problem: partial application** |
| Pre-FR copy after `prisma migrate deploy` | only the FR migration applied, then applied, 0 problems |

**`scripts/fr-production-preflight.mjs`** is new and strictly read-only:
- The session is forced read-only and verified before any query. The Prisma path is forced with
  `default_transaction_read_only` and verified, and is skipped if the pooler ignores the option.
- It prints counts, sums, schema facts and verdicts only.
- Exit codes: 0 = no blocker, 2 = at least one BLOCKER, 1 = the preflight failed.

| # | Check | Blocks on |
|---|---|---|
| 1 | Session `TimeZone`, plus any role/database TimeZone override | not UTC |
| 2 | Timestamp column types (`timestamptz` / `timestamp` / `date` counts; lists any without time zone) | warns |
| 3 | `_prisma_migrations` baseline, failed migrations, per-migration state incl. FR | any problem |
| 4 | Activation setting (`false` after the migration; absent before) | anything else |
| 5 | Financial baseline (`financialSnapshot`: counts, sums, md5 fingerprints) | — (recorded) |
| 6 | Driver unattributed cash (G2), driver-cash and wallet ledger equality (G3/G4), legacy review backlog and unlinked settlements (G5), H1/H2 counts | G3/G4; warns on G2/G5/H |
| 7 | After the migration: full G0–G7 readiness and R1–R13 reconciliation through the application services | any gate except G0 (expected to fail until authorized); any invariant |

Dry run on isolated copies:
- **Baselined copy:** 2 blockers, as expected locally — LA time zone, and G7 with no `CLIENT_URL`.
  Every other gate and R1–R13 passed.
- **Non-baselined dev copy:** reports the missing migration history, the H1/H2 rows and skips
  the gates.
- **Proof it writes nothing:** `pg_stat_database` insert/update/delete counters stayed at 0/0/0
  across a full run.

**Operator commands** (separately approved preflight window; run from a checkout of the deployed
commit, `server/`, after `npm ci`):

```bash
# 1. Full preflight — direct or session-pooler URL (port 5432, as MIGRATION_DATABASE_URL)
PREFLIGHT_DATABASE_URL='<direct/session URL>' \
CLIENT_URL='https://<production client>' \
npx tsx scripts/fr-production-preflight.mjs --out preflight-direct.json

# 2. Session check on the RUNTIME path (the app's pooled DATABASE_URL, e.g. :6543)
PREFLIGHT_DATABASE_URL='<runtime pooler URL>' \
npx tsx scripts/fr-production-preflight.mjs --out preflight-runtime.json
```

Archive both JSON reports with the cutover record. They contain no credentials or customer data.

---

## 3. Production latency measurement and allocation limit

**Instrument:** `GET /api/v1/admin/financial-release/latency-probe?samples=200`. It is Admin
only and read-only (`SELECT 1` only); it is also the "Measure latency" button on the Financial
Release tab.
- It runs **inside the deployed server**, so it measures exactly the function region ↔ database
  pooler path that settlements use.
- **Single-statement series:** 5 warm-up queries, then N sequential `SELECT 1`.
- **In-transaction series:** N statements inside read-only transactions of 20 statements each.
  This is a settlement's own path, and the default 5 s timeout is never stretched.
- **Statistics:** min / p50 / **p95** / p99 / max / mean by the nearest-rank method
  (p95 = the ⌈0.95·N⌉-th smallest sample).
- **Decision input** = the larger of the two p95 values. If the in-transaction series fails,
  the verdict is "do not activate".

**Procedure (runbook step 8.4.3):**
1. Run with the feature still **disabled**, at least **3 times**: peak operating hours, off-peak,
   and after a cold start. Use N = 200 each, so each run has 10 samples above its p95.
2. Take the **maximum** decision p95 across the runs.

**Targets and the allocation-limit decision** (FR.11A model: worst case ≈ (28 + 3 × allocations)
round trips within 2 000 ms = 40 % of the unchanged 5 s timeout):

| Decision p95 | Limit | Action |
|---|---|---|
| ≤ 20 ms | **20** (current) | proceed |
| 20–64 ms | ⌊(2000 / p95 − 28) / 3⌋: 25 ms → 17, 30 → 12, 40 → 7, 50 → 4, 64 → 1 | lower `MAX_ALLOCATIONS_PER_SETTLEMENT` in code; full settlement suites; re-measure; separate approval |
| > 64 ms | 0 | **do not activate**; the transaction design needs further work |

The **20-allocation limit stays** until production measurements justify a change. The Prisma
transaction timeout is not raised.

**Concurrent settlements:**
- Settlements for the **same driver** serialize on that driver's cash-account lock.
- FR.11A measured 4 concurrent 10-allocation settlements at 20 ms finishing at 1.5 / 2.5 / 3.6 /
  4.7 s. A fifth would exceed the timeout.
- **Operating rule:** one settlement per driver at a time. A queued settlement that times out is
  safe to retry (see the next block).
- Different drivers only contend when they credit the same customer's wallet row.

**Transaction timeout behaviour** (FR.11B, implemented):
- **Server:** a Prisma interactive-transaction timeout (**P2028**, the safely recognizable
  case) returns **503 `SERVICE_UNAVAILABLE`**, `details.reason = "TRANSACTION_TIMEOUT"`,
  `retrySameRequest: true`. The message is "The operation timed out before it could be
  confirmed. Retry the same request unchanged — it will not be applied twice."
- It **never claims an outcome**. A real P2028 is exercised in `tests/auth/security.test.ts`.
- Every other unexpected error remains a sanitized 500.
- **Client (settlement dialog):** `TRANSACTION_TIMEOUT`, **any 5xx** and transport failures are
  all **ambiguous** (`isAmbiguousSettlementFailure`).
  - The dialog stays on the confirm step.
  - The Idempotency-Key stays bound and **locked to the same body**: "Retry settlement" replays,
    and a changed body is refused until the dialog closes.
  - It **never** submits an ambiguous settlement under a new key.
- **Why it changed:** previously a 5xx was treated as definitive, so editing and resubmitting
  minted a new key. A 5xx can follow a commit (for example, the post-commit response read
  failing), so that could in principle record a second settlement.
- **Corrections were already safe:** void and both reversals use deterministic server keys.

---

## 4. Production time-zone preflight plan

- **Commands:** §2, steps 1 and 2. Both connection paths must report `UTC`.
- **Alternative:** the operator may run the read-only SQL in `fr11a-release-readiness.md` §2 in
  the Supabase SQL editor.

| Finding | Meaning | Decision |
|---|---|---|
| `UTC` on both paths, no override | stored instants correct; UTC report day boundaries correct; the dev-only shifts do not exist | proceed. Optionally pin `-c TimeZone=UTC` in `src/db/prisma.ts` later as a **separate** change (a no-op on UTC; it reinterprets local dev copies, so dev data must be rebuilt or accepted) |
| non-UTC on either path | every app-written timestamp is shifted by the offset; spring-forward hour corrupted; report day boundaries wrong | **STOP.** No activation. A separate, approved remediation proposal is required (timestamp rebase or compatibility mode). Not designed or implemented here |
| a role/database override differs from the session | a connection path may differ | treat as non-UTC until explained |

---

## 5. Shortfall policy — decisions P1–P8 with recommendations

New shortfalls remain **refused** (403 `SHORTFALL_POLICY_NOT_APPROVED`). Accounting rules are
unchanged. These are recommendations only, for approval.

| # | Decision | Recommendation |
|---|---|---|
| P1 Authorization | Who may record a shortfall | FINANCE (`finance.adjust`) **records**; approval is **ADMIN role** (role-gated like activation, because permissions are grantable) |
| P2 Separation of duties | Maker / checker | A shortfall takes effect only on approval by a **different** user who is **not** the settlement's `received_by_id`. The recorder may not be the receiver either, unless an Admin approves an exception with a reason |
| P3 Evidence | What must accompany it | A mandatory evidence reference (cash count sheet / handover record id) and a reason of at least 20 characters. Attachments only once a file store exists (none in V1) |
| P4 Driver notification | How the driver learns of the debt | The pending and approved shortfall appear on the driver's Cash page (amount, settlement, reason). The driver's acknowledgement is recorded |
| P5 Disputes | Driver disagreement | A dispute within 7 days freezes collection of that obligation until an Admin resolves it: uphold, or correct (a reasoned debit adjustment capped at `U`, as today) |
| P6 Deadline | When it may be recorded | Within 2 UTC business days of the settlement; later only by ADMIN with an escalation reason |
| P7 Responsibility | Who bears the money | Unchanged (contract §8.1): the driver owes the shortfall as unattributed cash; released customer credits stand. The company bears a loss only through P8 |
| P8 Write-off and audit | Uncollectable debt | An ADMIN-only write-off with reason and evidence that clears the driver obligation and records a **company loss** category. Every step is audited (record, approve, dispute, resolve, write-off) |

**Consequences:**
- P2, P4, P5 and P8 need **new schema** (a pending-approval state, a dispute record, a loss
  category) and new accounting rules. They require their own approved sub-phase and are **not**
  implemented.
- Shortfall stays disabled until then.
- This does **not** block activation: shortfall is a correction tool, not part of the
  settlement-release lifecycle.

**Related finding (not changed):**
- The pre-existing Phase 8.8 endpoint `POST /finance/driver-cash/:driverId/adjust` with
  `direction: "CREDIT"` (`finance.adjust`, reason required) can **also** create a driver
  obligation on one person's word.
- The brief forbade disturbing other correction workflows, so it is unchanged.
- **Recommended P9:** apply the same P1–P3 controls to driver-cash credit adjustments.

---

## 6. Historical anomalies H1 / H2 (40 rows, −$200.00)

| Question | Finding |
|---|---|
| What | 40 `company_financial_transactions` rows: `DELIVERY_FEE_REVENUE`, amount **−5.00** each (Σ **−200.00**), `order_id`, `created_by_id`, `payment_method_id`, `notes`, `idempotency_key` and `reversal_of_id` all NULL. Each row is counted by both H1 (no order) and H2 (non-positive revenue) |
| Origin (verified) | `server/tests/finance/finance-correction.test.ts` test **44** ("Company revenue row with amount <= 0 → 500"). Since the initial commit (2026-08-29) it inserts exactly this row and, in the committed version, never deletes it. One row leaked per suite run against the shared dev database: 40 runs, created 2026-09-06 … 2026-10-11. The uncommitted FR.8 stabilization fix tracks and deletes it; the 2,272- and FR.11B-test runs added none |
| Where | Local dev database (and copies) only. **Production should contain none.** Preflight §2 reports the production H1/H2 count; any non-zero value has a different origin and must be investigated before cutover |
| Impact on totals | Reduces any dev company-revenue total that sums `DELIVERY_FEE_REVENUE` over 2026-09-06 … 10-11 without an order filter by $200. No wallet, driver cash, payout or settlement effect. Order / driver / customer reports are unaffected (no order) |
| Settlement mode | Unrelated: legacy, order-less, never linked to a release. R1–R13 unaffected |
| Activation integrity | Not affected. G6 passes; H1/H2 are reported in every readiness report, the Admin tab, the reconciliation table and the activation audit metadata — never suppressed |
| Action | None. **Not deleted, backfilled or rewritten.** If dev data is ever rebuilt, start from a clean copy instead |

---

## 7. Accessibility corrections

The measured failures were app-wide text tokens:
- `ink-muted` `#6e7686`: 4.04–4.57:1
- `ink-subtle` `#9aa1ae`: 2.30–2.60:1, used for small labels, separators and **placeholders**

| Token | Before | After | Ratio after (white / canvas / sunken / neutral-50) |
|---|---|---|---|
| `--color-ink-muted` | `#6e7686` | `#5c6473` | 5.96 / 5.51 / 5.61 / 5.27 |
| `--color-ink-subtle` | `#9aa1ae` | `#666e7d` | 5.13 / 4.75 / 4.83 / 4.54 |

- The hue is the same, and the secondary (`#39404e`) > muted > subtle order is kept.
- Nothing else changed. The dark sidebar's `chrome-ink` keeps `#9aa1ae` (7.02:1 on the sidebar).
- **Verified unchanged and passing:**
  - status tones on their tints: success 4.64, warning 4.67, danger 5.82, info 7.86, neutral 9.22
  - error text (danger-700 on white) 6.47
  - primary and danger buttons 6.59 / 6.47
- **Disabled controls** (`opacity-50`) are exempt under WCAG 1.4.3 and were not changed.
- **Re-audit with the new tokens:**
  - every visible text element below AA: settlement detail 0/55, order detail 0/196, wallet
    detail 0/85, finance 0/322, Financial Release tab 0/181
  - keyboard, focus trap and restore, labels (54 controls), 390 px layouts and network recovery
    all pass
- **Limitations:** headless Edge only; no screen reader; mobile emulated.

---

## 8. Production cutover runbook (FINAL — do not execute without separate authorization)

Owners:
- **OPS:** deployment / environment operator
- **ADMIN:** application administrator
- **FIN:** finance lead
- **APPROVER:** the business owner who authorizes the cutover

Every step records who, when and its result in the cutover log. Each go/no-go point is a hard stop.

### 8.1 Preconditions (APPROVER)

1. FR.1–FR.11B approved; the deployed commit has passed full backend and frontend regression.
2. Shortfall: either the policy is approved and implemented, or it is explicitly accepted as
   **disabled** at cutover.
3. A decision on H1/H2 handling (§6); production expected to have none.
4. A low-traffic window scheduled; FIN available to settle drivers.

### 8.2 Backup and restore verification (OPS)

1. Create a Supabase backup or PITR recovery point. Record its id and timestamp.
2. Restore it into a **non-production** project. There:
   - run the preflight (§2)
   - compare the `financial baseline` block with production's (counts and sums must match the
     recovery point)
3. **Go/no-go:** the restore succeeded and the baselines match.

### 8.3 Pre-deployment preflight (OPS, read-only)

1. Run §2 command 1 (direct URL) and command 2 (runtime pooler URL). Archive both reports.
2. **Go/no-go:**
   - `session time zone` is OK on both paths (§4) — otherwise **STOP**
   - `migration history` is OK
   - the FR migration is `pending` with 0 partial objects, or `applied` with 0 problems
   - `activation setting` is OK
   - ledgers G3/G4 are OK. FR.12A.4 changes how G3 is judged. Once the historical reconciliation
     migration is applied, G3 uses the **residual** rule:
     `stored − ledger net − approved valid historical reconciliation = 0`, with no invalid approval.
     The raw discrepancy is always printed beside it. Before that migration only the raw rule can be
     evaluated. A raw mismatch then allows the *migration* go/no-go **only** if it is exactly the
     documented, approved incident: same account, same amount
     (`docs/fr12a2-historical-ledger-reconciliation-design.md` §12). It never allows *activation*,
     which needs the residual rule to pass and G5 to show no unresolved historical ownership.
3. Alternatively or additionally, run the build's own `PRISMA_MIGRATE_MODE=preflight` on a
   Production deployment. It is read-only, and its log now includes `fr_objects` / `fr_activation`.

### 8.4 Deployment (OPS) — the activation flag stays OFF

1. **Server first:** a Production deployment with `PRISMA_MIGRATE_MODE=deploy`. `build.mjs`:
   - runs its guard checks (now including the FR state check)
   - runs `prisma migrate deploy` (applies only `20261016000000_…`)
   - runs `migrate status`
   - runs the post-migration checks
   - compares the financial snapshot (must be unchanged) and checks the id sets

   Any failure fails the build and the previous deployment keeps serving. The server code
   requires the FR schema, so it can never run without the migration.
2. **Client second:** a Production deployment of the client containing `version.json` with
   `financialReleaseContract: "FR.11"`. Set `CLIENT_URL` (server, Production scope) to its origin.
   - In the window between the two deployments, the old client still works: settlement-mode
     money cannot exist while activation is off, so the server keeps accepting the legacy
     settlement format.
3. **Latency (§3):** ADMIN runs "Measure latency" at least 3 times. Apply the limit table.
   - If the limit must drop: **STOP**. Ship the code change, run the regression, re-measure.
4. **Verify, ADMIN:** the Financial Release tab shows Disabled, Not authorized, contracts FR.11
   everywhere, G1 and G7 passed, R1–R13 pass.
5. **Smoke test with the flag off:** one legacy delivery, settlement and payout on test records
   behave exactly as before (immediate posting).

### 8.5 Financial baseline and driver cash (FIN)

1. Freeze the baseline: rerun the preflight. Archive the snapshot sums for driver cash, wallets
   and company revenue by type.
2. Settle **every** driver's cash to zero through normal settlements (legacy format, still
   allowed). Resolve every legacy collection-difference review.
3. Investigate any G3/G4/G6 finding. **Nothing is repaired automatically or edited directly**;
   only authorized correction workflows are used.
4. **Go/no-go:** the readiness dry run shows only **G0** failing.

### 8.6 Activation authorization and controlled activation

1. **APPROVER** gives written authorization for this environment and window.
2. **OPS** sets `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED=true` (server, Production scope only)
   and redeploys the server.
3. **ADMIN** opens Settings → Financial Release, runs the readiness check (all eight gates pass,
   ≤ 5 minutes old), reviews the historical findings, ticks the acknowledgement and activates.
   - The server re-evaluates every gate under locks. Any failure → 409, nothing changes; return
     to 8.5.
4. **Verify:**
   - the state shows Enabled and the audit log has `FINANCIAL_RELEASE_ACTIVATED` with the gate
     report
   - the first live cash delivery shows `ON_SETTLEMENT` / Awaiting settlement
   - the first settlement allocates and releases correctly
5. **OPS** removes `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED` and redeploys. Deactivation and all
   processing work without it, and this prevents accidental re-activation.

### 8.7 Monitoring

- **Daily for 2 weeks, then weekly:**
  - the reconciliation table on the Financial Release tab: R1–R13 must stay 0, and H1/H2 must
    not grow
  - pending-settlement ages (I1)
  - review backlog
- **Logs:**
  - `[error] transaction timeout (P2028)`
  - HTTP 503 `TRANSACTION_TIMEOUT` and 500 rates on `POST /driver-settlements`
  - settlement durations against the measured p95
- Re-run the latency probe after any infrastructure change (region, pooler, plan).

### 8.8 Failure handling

| Event | Action |
|---|---|
| Gate failure at activation | Nothing changed. Fix through normal workflows; re-run readiness |
| Settlement 503 `TRANSACTION_TIMEOUT` / 5xx | Retry the **same** settlement from the open dialog (same key); check settlement history if the dialog was closed. Never re-enter it as a new settlement |
| Repeated timeouts | Lower the allocation limit (§3 table); settle one driver at a time |
| A reconciliation invariant fails | Deactivate if the cause is unknown; investigate; correct only through the dedicated correction workflows |
| Wrong release / collection / settlement | Void collection, release reversal or settlement reversal (audited, idempotent) |
| Unexpected behaviour | **Deactivate** (always allowed, immediate, audited). Future deliveries revert to immediate release; existing settlement-mode orders continue through settlement / resolution / corrections |

### 8.9 Deactivation and rollback restrictions

| Rollback | Allowed when |
|---|---|
| Deactivate (setting) | Always. Future deliveries only; no balance changes |
| Server code to a pre-FR build | Only **before the first ON_SETTLEMENT delivery**, or when **every** release is terminal (RELEASED / VOIDED / RELEASE_REVERSED — check I1 on the reconciliation table). Otherwise pending customer money would never be released |
| Client to a pre-FR.9 build | Only while no release is PENDING (the server refuses legacy-format settlements for drivers with pending releases); re-activation is also blocked by G7 |
| Schema | **Never.** The additive objects hold financial history |
| Database restore (8.2 point) | Last resort, separate incident decision: it discards every later delivery, payout and settlement |
