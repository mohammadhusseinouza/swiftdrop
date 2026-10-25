# Settlement-Based Financial Release — Finalization and Production Readiness

Status: **ready to deploy with activation OFF, once committed.**
- **Not** ready to activate.
- No production access or change was made, and nothing was committed.
- All verification used isolated local databases.

The historical $110.00 incident (`docs/fr12a8-historical-incident-evidence-recovery.md`) is
acknowledged, deferred, and reported here only as a known activation blocker.

---

## 1. Completed features

| Area | Status | Reference |
|---|---|---|
| FR.1 Contract / requirements | done | `docs/settlement-financial-release-contract.md`, `requirements.md` §55 |
| FR.2 Additive schema, activation seeded `false` | done | migration `20261016000000_…` |
| FR.3 Persisted release mode at delivery; ON_SETTLEMENT releases | done | `financial-release.service.ts`, `/deliver` |
| FR.4 Settlement allocations; release on full settlement; legacy-format guard | done | `POST /driver-settlements` |
| FR.5 Collection-difference resolution in settlement mode | done | `resolveReleaseDifference` |
| FR.6 Corrections (void collection, reverse release, reverse settlement, shortfall) + generic-reversal guards + U cap | done (**shortfall fails closed** unless its policy flag is set) | contract §8.1 |
| FR.7 Read APIs (outstanding collections, settlement detail, release detail, pending breakdown) | done | contract §9.1 |
| FR.8 Released / delivery-date reporting, dashboard snapshot, reconciliation R1–R13 + H / I checks | done | contract §11–12 |
| FR.9–FR.10.2 Management UI (allocation dialog, release panels, pending breakdown, corrections) | done (shortfall UI deliberately withheld) | client `components/finance`, settlements |
| FR.11A Batched release, Admin activation / deactivation with hard gate G0–G7, latency probe | done | `financial-release-activation.service.ts` |
| FR.11B Admin Financial Release tab, preflight script, `TRANSACTION_TIMEOUT` handling, runbook | done | `docs/fr11b-release-readiness.md` §8 |
| FR.12A.3–6 Historical ledger reconciliation (schema, V1–V7 validity, G3 / R1 residual rule, G5 ownership blocker, workflow API, Admin / Finance UI) | done; **writes disabled by default** | `docs/fr12a3`–`fr12a6` |
| FR.12A.7–8 Ownership design + evidence report | documents only (implementation deferred by decision) | `docs/fr12a7`, `fr12a8` |

**Historical reconciliation UI production-readiness.** Complete and browser-tested (FR.12A.6).
Reads work for Admin / Finance. Every write is refused (403) unless
`DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED=true`, which must stay unset outside an authorized
maintenance window. Shipping it is safe and changes no money.

**Normal operations with activation disabled.**
- Activation is seeded `false`. Every delivery then records `financial_release_mode = NULL`, the
  unchanged legacy immediate path.
- Legacy settlements stay allowed (no pending releases can exist).
- Corrections behave as before, plus the FR.6 guards (which only apply to release-linked rows).
- New shortfalls fail closed.

No unfinished code path is reachable in normal operations: the deferred work (FR.12A.9+) does not
exist in the code at all.

## 2. Outstanding implementation work

| Item | Blocks deploy? | Blocks activation? | Notes |
|---|---|---|---|
| **All FR work is uncommitted** (107 modified + ~60 untracked files, incl. both migrations, `client/public/version.json`) | **YES** | YES | production deploys from git. Commit needs your authorization. **Exclude `server/nul`**, a stray preflight report written by `--out nul` on Windows |
| Historical ownership resolution (FR.12A.9–13) | no | **yes, while the incident stays unresolved (G5)** | deferred by decision |
| Settlement shortfall: policy P1–P8 and UI | no | no (fails closed independently) | new shortfalls → 403 `SHORTFALL_POLICY_NOT_APPROVED` |
| Revoker independence enforced in the database (historical reconciliation) | no | no | service-enforced today (FR.12A.5) |
| Reconciliation list text search; "writes enabled" indicator | no | no | API contract gaps (FR.12A.6) |
| As-of driver cash headline (`explainedLedgerTotal`) decision | no | no | components already exposed |

No implementation defect was found in this phase. No code was changed.

## 3. Tests and builds (isolated databases)

| Check | Result |
|---|---|
| Backend full regression (`swiftdrop_release_reg`, a fresh copy of local dev + both migrations) | **2,356 / 2,356** passed, 0 failed / skipped / cancelled |
| Frontend full suite | **312 / 312**, 0 failed / skipped |
| Backend typecheck + build (`build.mjs`, incl. `prisma generate` + `tsc`) | pass |
| Frontend typecheck + build | pass; `dist/version.json` declares `financialReleaseContract: "FR.11"` (G7) |
| Prisma: `validate`, `migrate status`, `migrate diff` vs a fresh full chain | valid, up to date, empty diff (FR.12A.5 / this phase) |
| **Production deploy rehearsal** (`swiftdrop_release_rehearsal`: real data, history baselined to production's state through `20261011…`) | `build.mjs` `PRISMA_MIGRATE_MODE=preflight` → READY. Then `deploy`: both migrations applied in order, `migrate status` clean, all FR / HR objects verified (FR 5/5 enums, 4/4 tables, 4/4 columns, 6/6 unique indexes; HR 5/5, 3/3, 8/8, 4/4), activation `false`, **financial snapshot unchanged**, id sets identical |
| Post-deploy preflight on the rehearsal | G1, G2, G3, G4, G6 OK. Blockers only for environment / data: session time zone (local LA), G0 (not authorized, expected), G5 (one legacy review in dev data), G7 (no `CLIENT_URL` locally) |
| Code-rollback compatibility | both migrations are additive: FR adds 4 **nullable** columns, constraints that accept NULL, and one guarded `INSERT` (the activation row); HR adds tables / indexes only. No drop, rename, update or `NOT NULL` change, so the previous release's code runs on the migrated schema while activation is off |

Coverage of the lifecycle areas (test counts by suite):
- **Collection in settlement mode:** delivery-settlement-mode (26).
- **Settlement, allocation and release:** settlements (38), allocations (25), idempotency (18).
- **Difference resolution:** 22.
- **Corrections:** financial-corrections (39), finance-correction (42), correction-eligibility (6).
- **Activation / deactivation:** 14.
- **Reporting and R1–R13:** 20.
- **Read APIs:** 20.
- **Driver cash:** 33.
- **Wallets:** 50 + 25.
- **Payouts:** 39 + 19 (idempotency).
- **Financial engine integration:** 28.
- **Historical reconciliation:** 81.

Concurrency, replay and rollback cases run throughout.

## 4. Pending migrations (production)

Expected production history (Query B, `docs/fr12a-operator-preflight.md`):
`0_init`, `20260922…`, `20260923…`, `20261011…`.

| Pending | Content | Data change |
|---|---|---|
| `20261016000000_settlement_financial_release_foundation` | FR enums, 4 tables, 4 nullable columns, constraints, indexes, activation row `false` | one setting row (`ON CONFLICT DO NOTHING`) |
| `20261025000000_driver_cash_historical_reconciliation_foundation` | historical incident / reconciliation / decision tables, constraints, 2 unique indexes on existing tables | none |

Both are applied by `build.mjs` in one Production build (`PRISMA_MIGRATE_MODE=deploy`), in order,
with guard and post-checks (rehearsed above). The server code **requires both**: gate G1 needs the
historical reconciliation schema.

## 5. Production configuration

**Server (Vercel, Production scope):**

| Variable | Value |
|---|---|
| `DATABASE_URL` | runtime (pooler) connection — existing |
| `MIGRATION_DATABASE_URL` | **direct or session pooler (5432)**, never 6543 — required for migration builds |
| `PRISMA_MIGRATE_MODE` | `preflight` → `deploy` (only for the migration build) → back to `preflight` |
| `CLIENT_URL` | the deployed client origin (gate G7 reads `/version.json`) |
| Auth variables (`AUTH_*`), `NODE_ENV=production` | existing |
| `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED` | **UNSET** |
| `SETTLEMENT_SHORTFALL_POLICY_APPROVED` | **UNSET** |
| `DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED` | **UNSET** (only during an authorized maintenance window) |
| System environment variables | "Automatically expose" enabled (`VERCEL_ENV`) |

**Client:** `VITE_API_BASE_URL` as today; the build ships `version.json` (`FR.11`).

**Database:** the session `TimeZone` **must be UTC** before activation. It is unverified for
production (Query A `tz.*`; `docs/timezone-investigation.md`).

## 6. Deployment sequence (activation stays OFF)

Each step needs the named authorization. Detailed runbook: `docs/fr11b-release-readiness.md` §8.

1. **Commit** (your authorization):
   - review the diff;
   - commit everything **except `server/nul`**;
   - push to a branch, then open a PR to `main`.
2. **Preflight, production, read-only:**
   - Query A + Query B (`docs/fr12a-operator-preflight.md`) in the SQL editor;
   - `scripts/fr-production-preflight.mjs` on the direct **and** runtime URLs;
   - a Production build with `PRISMA_MIGRATE_MODE=preflight`.

   **Go only if:**
   - the time zone is UTC (otherwise STOP);
   - history is the 4 expected rows;
   - FR / HR objects are `0/…`;
   - the activation row is absent;
   - G3 / G4 are clean, or G3 shows **only** the documented incident account (+110.00), as amended
     in runbook §8.3.
3. **Backup:**
   - confirm the provider's scheduled backups / PITR, and record the latest recovery point;
   - in addition, take a logical dump through the direct URL: `pg_dump -Fc`, store it outside the
     repository, record its SHA-256, owner and time.
4. **Restore rehearsal:**
   - restore that dump into an **isolated** database (`createdb …`; `pg_restore --no-owner`; never
     into production, never `--clean` against an existing database);
   - run the preflight there; the financial baseline must equal production's;
   - optionally repeat the deploy rehearsal of §3 on it.
5. **Deploy the server:**
   - Production build with `PRISMA_MIGRATE_MODE=deploy`;
   - the build log must show both "Applying migration" lines, "financial snapshot unchanged across
     migration: OK" and identical id sets;
   - any failure fails the build, and the previous deployment keeps serving.
6. **Deploy the client:**
   - set `CLIENT_URL`;
   - set `PRISMA_MIGRATE_MODE=preflight` again.
7. **Post-deployment checks (§7).**

## 7. Post-deployment checks

1. **Preflight on both URLs:**
   - migration history = 6 applied;
   - FR / HR objects complete;
   - activation `false`;
   - G1 passes;
   - G7 passes once `CLIENT_URL` is set.
2. **Admin → Settings → Financial Release:**
   - Disabled; Not authorized;
   - contracts FR.11;
   - expected: G0 fails, **G3 / G5 fail on the documented incident**.
3. **Finance → Ledger Reconciliation:**
   - loads for Admin and Finance;
   - shows the incident account's raw discrepancy +110.00 and residual 110.00;
   - any write returns "disabled in this environment".
4. **Smoke test on designated test records** (legacy behavior): one delivery, one legacy-format
   settlement, one payout. Posting is immediate, exactly as before.
5. The financial baseline matches the pre-deploy snapshot (except for the smoke-test records).

## 8. Activation requirements (not met)

Activation (Admin → Activate) succeeds only if G0–G7 all pass in the activation transaction. The
gate never modifies money.

| Gate | Production expectation | How it clears |
|---|---|---|
| G0 | fails | set `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED=true` only for the authorized cutover window |
| G1 | passes after deploy | — |
| G2 | depends on driver cash | settle every driver to 0.00 through normal settlements |
| **G3** | **fails** (incident account +110.00) | an approved historical **ledger** reconciliation: maintenance window, Admin proposes, independent Finance approves (FR.12A.5 / 6) |
| G4 | expected to pass | — |
| **G5** | **fails** (deleted order, unresolved ownership) | **only** a resolved ownership decision (FR.12A.7 / 8). **Not implemented and deferred**, so **activation is blocked until that work and its Finance decisions are done** |
| G6 | depends on R1 (same as G3) | as G3 |
| G7 | passes after the client deploy + `CLIENT_URL` | — |

Other preconditions:
- the session time zone is UTC;
- the production latency / allocation limit is confirmed (`fr11a-release-readiness.md` §1.6);
- the H1 / H2 review decision is made;
- the shortfall policy is decided (only if shortfalls will be enabled).

## 9. Rollback and incident response

- **Deactivation** (after any future activation) is always allowed and affects future deliveries
  only.
- **Code rollback** (Vercel: previous deployment) is safe:
  - while activation is off, because the migrations are additive and nullable (§3);
  - after activation, only before the first ON_SETTLEMENT delivery, or once every release is
    terminal.
- **The schema is never rolled back.** Restoring the step-3 backup is a last-resort incident
  decision: it discards everything after the recovery point.
- **Incident response:**
  - deactivate (if active);
  - freeze settlements / corrections for affected drivers;
  - run the preflight + reconciliation endpoint (read-only);
  - correct only through the dedicated correction workflows, never by direct SQL (the incident that
    started FR.12A was a direct deletion).
- **Restrict production write access.** Direct SQL writes bypass every guard (FR.12A.5 §4).

## 10. Go / No-Go

| Dimension | Verdict | Basis |
|---|---|---|
| 1. Code completeness | **GO** for the release scope (FR.1–FR.11B + FR.12A.3–6); ownership resolution deferred | §1–2 |
| 2. Test readiness | **GO**: backend 2,356 / 2,356, frontend 312 / 312, builds and typechecks clean | §3 |
| 3. Migration readiness | **GO** | deploy rehearsal on a production-state copy passed; additive; old-code compatible |
| 4. Deployment readiness | **NO-GO until**: (a) the work is committed (authorization; exclude `server/nul`); (b) production preflight shows UTC + the expected history; (c) a backup and restore rehearsal are done | §6 |
| 5. Financial activation readiness | **NO-GO** | G3 and G5 fail on the documented incident (G5 cannot clear until the ownership work); time zone unverified; G2 / latency / H1–H2 pending |

## 11. Known blockers

1. **Uncommitted code** (deployment).
2. **Historical $110.00 incident:** G3 (needs an approved ledger reconciliation) and **G5** (needs
   an ownership resolution, deferred). Activation blocker.
3. Production session time zone unverified (activation; also date-bucketed reports).
4. Backup / PITR availability unverified (deployment safety).
5. G2 driver cash to zero; latency-based allocation limit; H1 / H2 review; shortfall policy P1–P8
   (activation / optional).

## 12. Recommended immediate next steps

1. Authorize: review + commit (excluding `server/nul`) on a branch, then a PR.
2. Operator: production read-only preflight (Query A / B, preflight script, `PRISMA_MIGRATE_MODE=preflight`).
   Confirm the time zone and the provider backups.
3. Backup + isolated restore rehearsal; then the server deploy with `deploy` mode; the client
   deploy; post-checks with activation OFF.
4. Decide separately when to schedule the historical reconciliation maintenance window (clears G3)
   and whether to fund the ownership-resolution work (clears G5). Activation waits for both.
