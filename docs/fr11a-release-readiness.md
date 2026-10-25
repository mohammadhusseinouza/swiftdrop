# FR.11A — Final Integration, Financial Readiness and Activation Safeguards

Status: **implemented, pending approval** (2026-10-18). Nothing was activated, migrated,
deployed or committed. Production was not accessed.
Related: `settlement-financial-release-contract.md` §5.3 / §6 / §10 / §14,
`fr-settlement-performance-proposal.md`, `timezone-investigation.md`.

---

## 1. Settlement transaction performance

### 1.1 Method

- Isolated database `swiftdrop_fr11perf` (copy of the idle dev database), PostgreSQL 18.6.
- In-process TCP proxy between Prisma and PostgreSQL:
  - Every server→client chunk is delayed by the simulated RTT, with order preserved.
  - Round trips are counted as `ReadyForQuery` messages, split into in-transaction and
    request totals.
  - Delays use a high-resolution pump, because Windows timers have ~15 ms granularity. With
    the pump, 44 RT × 20 ms measured 878 ms.
- Each scenario builds a new driver with N delivered `ON_SETTLEMENT` collections, then sends one
  real `POST /driver-settlements` through the HTTP stack that fully allocates all of them.
- Matrix:
  - N ∈ {1, 5, 10, 20}
  - RTT ∈ {0, 5, 10, 20} ms
  - modes: DELIVERY_ONLY with a different customer per order, DELIVERY_ONLY all for the same
    customer, and COMPANY_ORDER
  - 3 runs each, 144 settlements per code version
- Scripts (scratch, not in the repo): `proxy.ts`, `bench.ts`, `contention.ts`.

### 1.2 Where the round trips came from (profiled)

| Per fully releasing allocation (before) | RT |
|---|---|
| allocation insert + `allocated_amount` compare-and-set | 2 |
| `releaseOrder`: re-lock + read release | 2 |
| settlement-driver check, order read, COLLECTION read, reversal check | 4 |
| wallet credit (`creditWalletForOrder`: read, increment, ledger insert) | 3 |
| fee revenue (+ product revenue for COMPANY_ORDER) | 1 (2) |
| release → RELEASED, order → FINALIZED | 2 |
| audit row | 1 |
| **Total** | **15** |

### 1.3 Change (no business, key or lock-order change)

**Settlement (`settlement.service.ts`):**
- One `createMany` inserts all allocation rows.
- One `UPDATE … FROM (VALUES …) RETURNING` performs the per-row compare-and-set of
  `allocated_amount`. It requires exactly N rows, otherwise it returns 409, as before.
- The rows were already locked in id order, so the multi-row update adds no lock-order risk.

**Release (`financial-release.service.ts`):**
- `releaseOrder()` is now a thin wrapper over `releaseOrders()`, which remains the **single
  release path**. Settlement passes all releasable ids at once, with `releaseLocksHeld`.
- Each check that ran per release now runs once for the batch:
  - settlement-driver check: 1 query
  - orders: 1 query
  - COLLECTION rows: 1 query
  - reversal markers: 1 query
- The orders are now read with an explicit `FOR NO KEY UPDATE` in id order. This is contract
  lock step 5 exactly; previously the order row was first locked by its final update, after the
  wallet rows.
- Wallet credits stay on the existing primitive, one per order, in `(customer_id, id)` order.
  The ledger keeps a running balance per wallet.
- Company revenue rows use a new batch primitive, `createCompanyFinancialTransactions`
  (`createManyAndReturn`). It keeps the same validation, the same keys and the same
  P2002 → CONFLICT → integrity-failure rollback.
- The release-state updates run as one multi-row compare-and-set (`UPDATE … FROM VALUES`), and
  the order updates as one `updateMany` with a count check.
- All audit rows are written in one `createMany`, through the new `createAuditLogs` helper.
- Timestamps are written through the same adapter binding as Prisma updates. A test asserts that
  `released_at` equals the order's `updated_at` exactly.

### 1.4 Before / after (in-transaction round trips; median request ms over 3 runs)

| Mode | N | RT before → after | 0 ms | 5 ms | 10 ms | 20 ms (before → after) |
|---|---|---|---|---|---|---|
| DELIVERY_ONLY, different customers | 1 | 32 → 31 | 24 → 25 | 237 → 233 | 446 → 444 | 881 → 853 |
| | 5 | 92 → 43 | 33 → 25 | 561 → 297 | 1079 → 566 | 2114 → 1110 |
| | 10 | 167 → 58 | 52 → 31 | 989 → 380 | 1896 → 724 | 3672 → 1417 |
| | 20 | 317 → 88 | 120 → 37 | 1868 → 555 | 3525 → 1044 | **5204 (P2028, 3/3 failed) → 2038** |
| DELIVERY_ONLY, same customer | 20 | 317 → 88 | 130 → 40 | 1863 → 553 | 3573 → 1057 | **5203 (3/3 failed) → 2052** |
| COMPANY_ORDER | 20 | 277 → 28 | 129 → 25 | 1644 → 221 | 3088 → 416 | **5195 (3/3 failed) → 801** |

- **Error rates:**
  - Before: 9/144 settlements failed, all at N = 20 and 20 ms. Prisma's 5 s interactive
    transaction timeout aborted them (P2028), surfaced as HTTP 500, and rolled everything back.
  - After: 0/144 failed.
- **Model after the change:** in-transaction round trips ≈ 28 + 3 × (DELIVERY_ONLY allocations
  with a wallet amount). COMPANY_ORDER allocations add ≈ 0, and partial allocations add 0.
  Request duration ≈ (in-transaction RT + 12) × RTT.

### 1.5 Lock contention (20 ms RTT, 3 runs, 0 errors)

| Concurrent operation during a 20-allocation settlement (~2.05 s) | Result |
|---|---|
| Delivery by the **same driver** (driver cash account row) | waits for the settlement commit: ~1.86 s vs ~0.45 s alone |
| Settlement of another driver whose collection's customer is also credited by the large settlement (wallet row) | waits: ~1.79 s vs ~0.85 s alone |
| Payout for a credited customer started 400 ms in | no wait. Wallet rows are locked only from the credit to the commit (the last part of the transaction) |
| 2 / 3 / 4 concurrent 10-allocation settlements for the **same driver** | serialize on the driver's cash account: 4 concurrent → completions at 1.5 / 2.5 / 3.6 / **4.7 s**; all released (40/40) |

**Residual risk:** a 5th concurrent same-driver settlement at 20 ms RTT would exceed the 5 s
transaction timeout while waiting for the lock.
- It would return HTTP 500 and roll back cleanly. Idempotency makes a retry safe.
- In practice Finance settles one driver at a time.
- Recommendation for FR.11B: map P2028 / lock-timeout failures to a retryable 503 instead of a 500.

### 1.6 Allocation limit decision

- **`MAX_ALLOCATIONS_PER_SETTLEMENT` stays 20**, for these reasons:
  - The worst case measured at 20 ms RTT is 88 in-transaction RT = 1.76 s in the transaction
    (35 % of the 5 s timeout) and 2.04 s per request. That meets the proposal's target of
    ≤ 40 % of the timeout.
  - It does not change the FR.9 UI.
- **The transaction timeout was not raised.** It is unnecessary after the round-trip reduction,
  and it would lengthen how long the driver, release and wallet locks are held.
- **Precondition, part of the cutover plan (§6):** measure the production function ↔ database
  RTT, which is still unmeasured; earlier production P2028 incidents suggest it can be high.
  - If p95 RTT is above 20 ms, lower the limit to ⌊(2000 / RTT − 28) / 3⌋ before activation:
    25 ms → 17, 30 ms → 12, 40 ms → 7, 50 ms → 4.
  - Above ~60 ms, settlement-based release should not be activated without further work.

---

## 2. Production time zone

- **Not verified.** This environment has no approved read-only path to production:
  - The production database credentials exist only in the Vercel environment.
  - The only built-in read-only inspector is `scripts/build.mjs` in `PRISMA_MIGRATE_MODE=preflight`,
    which runs **only inside a Vercel Production deployment**. Its `identity()` logs
    `current_setting('TimeZone')`, but triggering a deployment is not authorized.
- Nothing in production was touched.
- **Read-only verification for an authorized operator** (Supabase SQL editor, or `psql`
  through **both** the runtime pooler URL and the migration URL):

  ```sql
  SHOW TimeZone;
  SELECT current_setting('TimeZone') AS session_tz, now() AS db_now, now() AT TIME ZONE 'UTC' AS utc_now;
  SELECT r.rolname, s.setconfig FROM pg_db_role_setting s
    LEFT JOIN pg_roles r ON r.oid = s.setrole
    WHERE s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database()) OR s.setdatabase = 0;
  ```

  The same query must report `UTC` through the transaction pooler that the app uses. Supavisor
  transaction mode does not carry per-connection startup options reliably, so the database or
  role default is what counts.

- **Interpretation:**

| Production session zone | Stored timestamps | Financial date boundaries | Pinning UTC on new connections | Data migration |
|---|---|---|---|---|
| `UTC` (Supabase default) | correct instants | UTC calendar labels correct; the dev-only next-day labels do not occur | no-op | none |
| non-UTC (like local dev, America/Los_Angeles) | every app-written row shifted by the zone offset; app timestamps in the spring-forward hour corrupted by +1 h | late-day activity labelled the next day in SQL-derived periods (finance and order reports, delivery-date basis, reconciliation sample text) | would make every existing row read back +7/+8 h, i.e. a reinterpretation of history | a separate, approved timestamp-rebase migration (or an explicit compatibility mode) would be required — **not proposed for implementation here** |

- **Recommendation:**
  - Make "production reports `UTC` on both connection paths" a hard cutover prerequisite (§6 step 2).
  - Only after that is confirmed, pin `options: "-c TimeZone=UTC"` in `src/db/prisma.ts` as
    defense in depth. It is a no-op on a UTC database. It is a **separate change request**,
    because it reinterprets local dev copies.
  - If production is not UTC, stop. Settlement-based release must not be activated until a
    separately approved remediation plan exists.

---

## 3. Activation endpoint and gates

**Endpoints (ADMIN role only, `requireRole("ADMIN")`):**

| Endpoint | Behavior |
|---|---|
| `GET /api/v1/admin/financial-release` | `{ enabled, environmentAuthorized, serverContractVersion: "FR.11", settingUpdatedAt }` |
| `GET /api/v1/admin/financial-release/readiness` | Dry run of G0–G7 in one REPEATABLE READ, READ ONLY snapshot; writes nothing |
| `POST /api/v1/admin/financial-release/activate` | See the activation steps below |
| `POST /api/v1/admin/financial-release/deactivate` | Always allowed, with no gates and no environment check. `FOR UPDATE`, set `false`, audit `FINANCIAL_RELEASE_DEACTIVATED`; already off → `changed:false`, no audit |

**`POST /activate` steps:**
1. If G0 fails, it returns 409 `ACTIVATION_GATE_FAILED` at once, without touching the database.
   An unauthorized environment therefore never takes the activation locks or scans the ledgers.
2. Otherwise it fetches the client contract (G7, network I/O done before any transaction).
3. Inside the transaction it locks the activation row `FOR UPDATE`. If the feature is already on,
   it returns `changed:false` with no audit.
4. It locks every `driver_cash_accounts` row `FOR SHARE`, then evaluates every gate.
5. Any failing gate → 409 `ACTIVATION_GATE_FAILED` with the full gate report. Nothing is written.
6. On success it writes the setting, `updated_by_id` and the audit row
   `FINANCIAL_RELEASE_ACTIVATED`, with the gate report and historical findings in its metadata.

**Request rules:**
- Both POSTs reject any body field.
- The generic `PATCH /system-settings/:key` still rejects the key.

**Gates:**

| Gate | Implementation |
|---|---|
| G0 | `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED` must be exactly `"true"` (`1`, `TRUE`, `yes` are rejected). Unset everywhere; documented commented-out in `server/.env.example`. |
| G1 | Catalog check of 48 objects: 5 enum types, 3 `OrderFinancialStatus` labels, 4 columns, 4 tables, 16 CHECK / composite-FK constraints, 15 unique indexes (incl. the five ledger idempotency keys), the seeded boolean setting. If G1 fails, G2–G6 are reported "not evaluated". |
| G2 | Every driver's `U = current_balance − Σ outstanding(PENDING releases holding cash) = 0` (negative too). |
| G3 | Cached driver cash = ledger net, and a latest-timestamp ledger row's `balance_after` = cached (ties in the same millisecond tolerated). |
| G4 | Wallet cached `available_balance` = Σ(credit − debit). |
| G5 | No mode-NULL DELIVERED order with `financial_status = REVIEW_REQUIRED`; every settlement linked to its cash SETTLEMENT row. |
| G6 | `runReconciliationChecks(tx)` inside the activation transaction: any INVARIANT (R1–R13) finding fails, whatever its classification, including R12's invalid (pre-FR.6 generic) collection reversals. H1/H2 are **reported** in `historicalFindings` and the activation audit; they do not block (contract §11). |
| G7 | The server declares `FINANCIAL_RELEASE_CONTRACT_VERSION = "FR.11"`. The server fetches `${CLIENT_URL}/version.json` (3 s timeout, before any transaction). The deployed client must declare `"financialReleaseContract": "FR.11"` (`client/public/version.json`, copied into `dist/` by Vite; Vercel serves static files before its SPA rewrite). Missing `CLIENT_URL`, HTTP error, bad JSON, or another version → fail. |

**Transaction bounds and measurements:**
- Activation and readiness run with `timeout 30 s, maxWait 5 s`. They are a one-time Admin
  operation that scans ledgers while holding the activation and driver cash locks, which blocks
  deliveries and settlements only for that duration.
- Measured on the dev copy: readiness 24 ms, reconciliation 35 ms.
- Production volume is unknown. Re-measure readiness there with the dry run before cutover.

---

## 4. Shortfall authorization review

**Existing controls (`POST /driver-settlements/:id/shortfall`, FR.6):**
- `finance.adjust`, held by ADMIN and FINANCE and grantable from the role matrix
- Idempotency-Key, and a reason of at least 10 characters
- Σ shortfalls ≤ `amount_received`
- not after a settlement reversal, and settlement reversal is blocked after a shortfall
- audit `DRIVER_SETTLEMENT_SHORTFALL_RECORDED`
- the corrective cash ADJUSTMENT is not generically reversible

**Findings:**
1. It creates a **driver debt on one person's word**. There is no evidence field and no second
   approver.
2. The same user who received the cash (`received_by_id`) may record a shortfall against it. A
   Finance user could therefore move their own discrepancy onto a driver; there is no
   separation of duties.
3. There is no driver notification or acknowledgement.
4. There is no time limit: any historical settlement, legacy or allocation-format, can receive
   a shortfall.
5. There is no write-off path and no company-loss category (contract §14 item 4). The
   obligation stays as unattributed driver cash.
   - That cash also blocks re-activation (G2) until it is collected.
   - A mistaken shortfall can only be offset with a reasoned debit adjustment capped at `U`.
6. The amount threshold is bounded only by the settlement amount.

**Conclusion:** the controls are insufficient for a debt-creating operation.

**Implemented fail-closed restriction:**
- New shortfalls return **403 `SHORTFALL_POLICY_NOT_APPROVED`** unless the server environment
  carries `SETTLEMENT_SHORTFALL_POLICY_APPROVED=true`, which is unset everywhere.
- The check runs after the replay lookup. A shortfall recorded earlier still replays with its
  original Idempotency-Key, so historical records, their display (`shortfallTotal`), reconciliation
  and every other correction workflow are unchanged.
- The UI never offered the action (FR.10.2).
- Existing FR.6 shortfall tests approve it in-process for that call only (`withShortfallPolicyApproved`).
- **Do not set the variable before the policy below is approved and implemented.** Enabling it
  restores exactly the FR.6 behavior.

**Policy decisions required:**

| # | Decision |
|---|---|
| P1 | Who may record a shortfall: ADMIN only, or FINANCE? |
| P2 | Maker–checker: a second approver, distinct from the recorder **and** from the settlement's `received_by_id`? |
| P3 | Required evidence: count-sheet reference, attachment, driver acknowledgement? |
| P4 | Time window after the settlement (e.g. same business day / N days)? |
| P5 | Amount threshold requiring escalation? |
| P6 | Driver notification and dispute path? |
| P7 | Write-off workflow and accounting category (company loss) for uncollectable shortfalls — contract §14 item 4. |
| P8 | Correction of a mistaken shortfall: keep the capped reasoned debit adjustment, or add a dedicated reversal? |

---

## 5. Reconciliation results

**Isolated copy `swiftdrop_fr11recon` of the dev database:**
- Contents: 32 orders (11 delivered), 0 releases, 1 driver cash account, 13 cash rows, 13 wallet
  rows, 853 company rows. Session TZ America/Los_Angeles.

| Check | Result | Classification |
|---|---|---|
| R1–R13 | **all PASS, 0 affected** | — |
| H1 | 40 `DELIVERY_FEE_REVENUE` rows without an order (−5.00 each, created 2026-09-06 … 2026-10-12) | existing historical anomaly (legacy, not settlement-mode) |
| H2 | the same 40 rows (non-positive revenue amount) | existing historical anomaly |
| I1 / I2 | no releases; no driver with unattributed cash | informational |

**Interpretation:**
- No genuine new integrity violation exists.
- The 40 rows bypass `createCompanyFinancialTransaction`, which refuses non-positive revenue.
  They are consistent with direct test inserts into a shared dev database. They were not
  modified, and production must be checked for them separately.
- **Readiness on that copy:**
  - G0 fails (not authorized). G5 fails: one legacy DELIVERY_ONLY order awaits
    collection-difference review (35.00 expected, 30.00 collected).
  - G7 fails without `CLIENT_URL`, and passes with the real `version.json`.
  - G1–G4 and G6 pass.
- Activation readiness never ignores R1–R13. H1/H2 are surfaced in every readiness report and
  in the activation audit metadata.
- **Decision requested:** should H1/H2 findings block activation, or require an explicit
  acknowledgement? Today they do neither, per contract §11.

**The full-regression database** (`swiftdrop_fr11reg`, after the 2,272-test run) also reconciles:
R1–R13 all pass, and H1/H2 show the same 40 rows (the suite added none).

---

## 6. Production cutover and rollback plan (NOT executed)

> **Superseded by `fr11b-release-readiness.md` §8 (final runbook).** Kept for history.

Each step needs its owner's explicit authorization; FR.11A executed none of them.

### 6.0 Preconditions (go / no-go)

1. FR.11A approved; FR.11B (Admin activation UI, P2028 → 503 mapping if approved, remaining
   acceptance items) approved.
2. **Production session TimeZone = UTC** on both the pooler and the direct path (§2). Otherwise STOP.
3. **Production RTT measured** (p95 over ≥ 100 round trips from the deployed function region to
   the pooler). Set `MAX_ALLOCATIONS_PER_SETTLEMENT` from §1.6; if it changes, ship the change and
   rerun the settlement suites.
4. Shortfall policy (§4) either approved and implemented, or explicitly accepted as "disabled at
   cutover".
5. A decision on H1/H2 (§5) and a production H1/H2 count.

### 6.1 Backup and baseline (read-only, before deploy)

1. Take a full Supabase backup or PITR recovery point. Record its id and timestamp. Perform a
   restore test into a **non-production** project, and run the reconciliation and readiness dry
   run there. On a restored non-production copy, G0 must fail.
2. **Historical financial baseline:**
   - Run `PRISMA_MIGRATE_MODE=preflight` on the production build. It is read-only and logs
     identity (incl. TimeZone), migration state, `financialSnapshot` (counts and sums) and the
     number-mapping fingerprint.
   - Archive the log.
   - Additionally record per-driver cash balance, total wallet balance and company revenue sums
     by type, read-only.

### 6.2 Migration validation

1. Confirm `20261016000000_settlement_financial_release_foundation` is pending (or applied) in
   `_prisma_migrations`.
2. Confirm the preflight result is READY. The migration is additive only: 3 enum labels, 5 enums,
   1 + 3 columns, 4 tables, constraints and indexes, plus 1 seeded row with value `false`.
3. Gap: `scripts/db-inspect.mjs` has no FR-specific state check (implementation plan "FR.3
   dependencies"). The post-deploy readiness G1 covers the objects. Adding an FR check to
   `migrationStateChecks` before cutover is recommended.

### 6.3 Deployment order (activation stays OFF)

1. Deploy the **server** with `PRISMA_MIGRATE_MODE=deploy`. `build.mjs` runs:
   - guard checks
   - `migrate deploy`
   - status and post-migration checks
   - a financial-snapshot comparison
   - the id-set check

   Any failure fails the build, and Vercel keeps serving the previous deployment.
   - FR code requires the FR schema (the generated client selects the new columns), so the
     server must never run without the migration.
   - The migration plus the new server code with the flag off behaves exactly like the legacy
     system: full regression green, delivery-settlement-mode group A.
2. Deploy the **client** (FR.9–FR.10 UI + `version.json`).
3. Set `CLIENT_URL` on the server (Production scope).
4. Verify with `GET /admin/financial-release`: `enabled:false`, `environmentAuthorized:false`.
5. Run the readiness dry run: G0 fails by design. Check every other gate, and confirm G7 sees FR.11.

### 6.4 Operational preparation

1. Settle every driver's cash to **zero** through normal (legacy-format) settlements, so that
   G2 passes.
2. Resolve every legacy collection difference (G5).
3. Investigate any R1–R13 finding. **Fix nothing automatically**; corrections only through
   authorized correction workflows.

### 6.5 Activation

1. Set `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED=true` (Production scope only) and redeploy the
   server, in a low-traffic window.
2. An Admin runs the readiness dry run, then `POST /activate`. The gate is re-evaluated under
   locks; any failure → 409 and nothing changes.
3. Verify the audit row `FINANCIAL_RELEASE_ACTIVATED` and `GET` state `enabled:true`.
4. Recommended: remove `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED` again. Deactivation and
   processing do not need it; this prevents accidental re-activation.

### 6.6 Monitoring (first 2 weeks daily, then weekly)

- Reconciliation endpoint: R1–R13 must stay 0, and H1/H2 counts must not grow.
- Settlement errors: HTTP 500 / P2028 / lock waits; settlement durations at the high allocation
  counts.
- `I1` release state counts: PENDING ages, AWAITING_REVIEW backlog.
- Customer pending-settlement totals vs driver attributed cash (R2).

### 6.7 Failure recovery

- **Gate failure:** nothing changed; fix the cause through normal workflows and retry.
- **Bad behavior after activation:** `POST /deactivate`. It is always allowed, audited and
  immediate. Future deliveries are recorded as legacy immediate (mode NULL). Existing
  `ON_SETTLEMENT` orders keep their persisted mode and still settle, resolve and correct
  normally (verified in FR.11A, test 12 and E2E steps 19–21).
- **A wrong release:** use the dedicated corrections (void / release reversal / settlement
  reversal). Never edit or delete ledger rows.
- **A failed deployment:** Vercel keeps the previous deployment. The additive migration stays.

### 6.8 Rollback limitations

| Rollback | When it is safe |
|---|---|
| Setting (deactivate) | Always. Affects future deliveries only. |
| Server code to a pre-FR build | **Only before the first `ON_SETTLEMENT` delivery, or once every release is terminal** (RELEASED / VOIDED / RELEASE_REVERSED). Older code does not know the new enum values or release rows: it would never release pending customer money, and a legacy-format settlement could consume reserved cash. Check `I1` before any code rollback. |
| Client to a pre-FR.9 build | Blocks allocation-format settlements (the server refuses the legacy format while releases are pending); G7 would also fail on re-activation. |
| Schema | **Never.** The additive objects stay; dropping them would destroy financial history. |
| Database restore from the §6.1 backup | Last resort only. It discards every transaction since the recovery point, including real deliveries, payouts and settlements. It requires a separate incident decision. |

---

## 7. Accessibility and browser acceptance (FR.11A)

Headless Microsoft Edge driven over the DevTools protocol against the isolated `swiftdrop_fr9vis`
stack (scratch API :3091, Vite :5191). The FINANCE role was used; activation stayed `false`.

| Area | Result |
|---|---|
| Keyboard only: Tab reaches "Process settlement", Enter opens it | PASS |
| Dialog focus: moves inside on open; 40× Tab and 5× Shift+Tab stay inside (native modal); Escape closes; focus returns to the opener | PASS |
| Dialog accessible name (`aria-labelledby`) | PASS |
| Labels: 55 controls in the settlement dialog, the correction reason field | PASS, no unnamed control |
| Error messages: a short correction reason sets `aria-invalid="true"` and `aria-describedby` → "at least 10 characters" | PASS |
| Status readability: status chips carry text; the coloured dots are decorative and `aria-hidden` | PASS |
| Responsive 390 px: settlement list, settlement detail, order detail release panel, wallet detail, finance; settlement dialog 358 px | PASS, no horizontal overflow |
| Network failure during a correction submit (offline) | **Defect found and fixed** — see below; then PASS |
| Contrast (WCAG AA 4.5:1 for normal text) | **FAIL, pre-existing design tokens** — see below |

**Network failure.**
- **Defect:**
  1. The correction mutations invalidate their tags even on failure. This is intentional,
     because an ambiguous failure may have committed.
  2. The resulting refetch also failed offline.
  3. The pages then rendered their full-page error state even though data was loaded. That
     unmounted Order Detail and the open correction dialog, together with its
     ambiguous-failure / same-key retry state.
- **Fix (frontend only):**
  - Order Detail, Settlement Detail and the Financial Release panel replace the page only when
    nothing is loaded.
  - A failed background refresh now keeps the content and any open dialog mounted.
  - The pages show a `StaleDataNotice` (`role="status"`, "Could not refresh — showing the last
    loaded data", Try again). This keeps possibly outdated financial figures from being shown
    silently.
- **Verified:**
  - Offline submit → the dialog shows "We could not confirm whether the correction was
    recorded…" with "Retry correction".
  - Back online, the retry records **one** void (release VOIDED, 1 correction row).
  - The notice disappears after recovery.
  - No console errors.

**Contrast.** These are app-wide design tokens, not introduced by the FR track:
- `text-ink-muted` measures **4.22:1** on white or card backgrounds. It is used for secondary
  text, dates, back links and helper text.
- `text-ink-subtle` measures **2.4–2.6:1**. It is used for small uppercase section labels
  ("Financial corrections", "Driver cash custody (current)") and separator dots.
- Recommendation, a separate design change for approval: darken `--color-ink-muted` to reach
  ≥ 4.5:1, and use `ink-muted` instead of `ink-subtle` for text that carries meaning.

**Limitations.**
- Headless Edge only: no Firefox or Safari, and no real screen reader (NVDA / VoiceOver).
  Accessible names and states were checked programmatically.
- Mobile was emulated with device metrics, not a physical device.
- The settlement-reversal correction dialog was not re-run in FR.11A, because driver A had no
  reversible settlement left. It uses the same `FinancialCorrectionDialog` verified through
  Void collection, and it was verified end to end in FR.10.2.
