# FR.12A.4 — Evidence Validation and Financial Reconciliation Integration

Status: **implemented locally, pending review.** Isolated databases only. Production, the local
development database and git were not touched. No reconciliation was proposed, approved or
written outside test fixtures. No endpoint, activation or shortfall was enabled.

Builds on `docs/fr12a2-historical-ledger-reconciliation-design.md` (§7, the V1–V7 checks) and
`docs/fr12a3-historical-reconciliation-foundation.md`.

---

## 1. FR.12A.3 foundation re-validation

| Property | Result |
|---|---|
| Migration only through Prisma Migrate | `prisma migrate status` on a fresh chain reports it up to date; `migrate diff` against the schema is empty |
| Evidence cannot be silently replaced after approval | the digest CHECK, plus the `ON UPDATE RESTRICT` composite FK from every decision, enforce it (re-tested) |
| Decisions append-only | DB-enforced for every decision another row references (revoked approvals, decisions cited by a re-proposal) |
| No approval by existence | status is derived from the decisions; a record without decisions is PROPOSED |
| Duplicate evidence prevented | root partial uniques + linear supersession chain |
| Correct account / driver | composite FKs on the account, anchor, predecessor and settlement |

No material defect was found. One known limit (not material): a decision row that nothing
references, such as a lone REJECTED, can be rewritten by direct SQL. That is the same threat
class as inserting an approval directly; recommended mitigation for FR.12A.5 in §9.

## 2. One SQL definition

`server/src/modules/historical-reconciliation/historical-reconciliation.sql.ts` holds plain SQL
strings, shared verbatim by:
- gate G3;
- reconciliation R1, H3 and I3;
- gate G5;
- the as-of driver cash component;
- the read-only preflight script.

They therefore cannot disagree. `historical-reconciliation.service.ts` runs this SQL in the
caller's transaction (one snapshot); it is read-only.

All comparisons run in PostgreSQL on stored values:
- **Timestamps** are compared stored-to-stored. They never pass through application-side UTC
  parsing (see `docs/timezone-investigation.md`).
- **Audit amounts** are `Decimal.toString()` text. They are compared as exact NUMERIC after a
  strict `^-?[0-9]+(\.[0-9]+)?$` check. `"110"` and `"110.00"` are equal. `"110.001"` and
  `"1.1e2"` are mismatches; they fail closed and never raise a query error.

Before the FR.12A.3 migration, an empty relation replaces the reconciliation tables. Every
account then behaves exactly as before.

## 3. Evidence validity (per record; every failure code is reported)

| Code | Check |
|---|---|
| `INVALID_DECISION_HISTORY` | Decisions do not form one valid lifecycle: more than one outcome, more than one revocation, or a revocation that does not end this record's approval. Status becomes `INVALID_HISTORY`. |
| `ACCOUNT_MISMATCH` | The account is missing or belongs to another driver. |
| V1 `ANCHOR_NOT_FOUND` | The anchor or predecessor is missing, or on another account. |
| V2 `JUMP_MISMATCH` | `anchor.balance_before − coalesce(predecessor.balance_after, 0) ≠ amount`, or `observed_jump ≠ amount`. |
| V3 `ORDERING_AMBIGUOUS` | The predecessor and anchor share a timestamp, or another row of the account shares either one. Adjacency cannot be proven, so the check **fails closed**. |
| V3 `ROWS_INSIDE_GAP` | A row lies strictly between the predecessor and the anchor, or before the anchor for a gap at the start, or the two rows are out of order. |
| V3 `EVIDENCE_TIME_OUTSIDE_GAP` | The audit's stored `created_at` is outside `[predecessor, anchor]`. |
| V4 `MISSING_TRANSACTION_PRESENT` | A row with the missing id, or with key `delivery:<order>:driver-collection`, exists (for example after a restore). |
| V5 `SOURCE_AUDIT_MISMATCH` | The audit is missing, or its action, entity, cash row id, order type, actual, expected or difference amount does not match **exactly**. |
| V5 `DIFFERENCE_RESOLUTION_FOUND` | A resolution or finalization audit for the order, or any wallet/company row keyed `delivery:<order>:…`, exists. |
| V6 `DELETED_ORDER_PRESENT` | The order exists again. |
| V7 `REVIEWER_NOT_INDEPENDENT` | The approver is the proposer. |
| `EVIDENCE_DIGEST_MISMATCH` | The approval is not bound to the stored digest or proposer. |
| `APPROVAL_AUDIT_MISSING` | Added in FR.12A.5: the approval has no same-transaction workflow audit (same reconciliation, approver, decision id and digest). |
| `OVERLAPPING_EXPLANATION` | Another live record covers the same anchor, missing row, audit, order or predecessor. |

An approved record **contributes** to A only when its status is `APPROVED` and no failure applies.
A record **blocks** when it asserts an approval with any failure, or when its history is invalid.

## 4. G3 and R1 (shared residual rule)

For every account (none excluded): S stored, N raw ledger net, `D = S − N`, A (contributing only),
`R = D − A`, and X (blocking records).

- **G3 fails** when `R ≠ 0`, `X > 0`, or (unchanged) the latest row does not end at S. Each
  blocking record is its own finding (`DRIVER_CASH_HISTORICAL_RECONCILIATION`).
- **R1 fails** on the same account rule, plus the same invalid-record findings. The per-row
  movement check is unchanged.
- **Accounts without reconciliation records** produce exactly the previous findings and text
  (test 24).
- **Visibility:** D, A, R and X are always shown:
  - the G3 finding text for reconciled accounts;
  - R1's `expected` value, `(N + A)` with its parts;
  - the I3 check;
  - the additive `driverCashHistoricalReconciliation` summary on the readiness report and the
    reconciliation report;
  - the G3 pass detail when A ≠ 0.
- **G1 now also requires** the historical-reconciliation schema: 21 more objects, 69 in total.
  The server code reads those tables, so it can never run without that migration. The
  reconciliation endpoint detects a missing schema at runtime and falls back to the raw rule, so a
  not-yet-migrated local database keeps working.
- **R2–R13, H1, H2, I1 and I2 are unchanged** (test 20).

## 5. G5: historical ownership

G5 adds one `DELETED_ORDER` finding per deleted order, grouped by order. It comes from either of:
- a surviving `COLLECTION_DIFFERENCE_RECORDED` audit whose order no longer exists and which has no
  `COLLECTION_DIFFERENCE_RESOLVED` audit. This needs no reconciliation record, so it works before
  the migration and restores what the deletion removed from G5;
- any reconciliation with `ownership_status = UNRESOLVED`, **whatever its decision status**.

Approving, rejecting, withdrawing or revoking a ledger reconciliation never clears it.
`isUnresolvedHistoricalOwnership` now ignores the status. This replaces the FR.12A.3 "live records
only" draft, per the FR.12A.4 instruction.

**Lifting this blocker needs a future approved extension; nothing here can do it:**
- an append-only ownership-resolution record linked to the reconciliation and the incident, with
  the outcome (customer liability or company revenue), the amount split for the 110.00, and an
  independent approver;
- the postings it authorizes, under the existing idempotency keys;
- a migration relaxing `dchr_ownership_unresolved_chk` (or deriving ownership from that record).

For the audit-only source, the matching resolution evidence must also exist. G5 deliberately has
no bypass.

## 6. Chain gaps (H3, HISTORICAL — reported, non-blocking)

Every `balance_before ≠ previous balance_after` in `(created_at, id)` order that no valid approved
reconciliation explains is reported, classified as:
- `UNEXPLAINED_GAP`;
- `AMBIGUOUS_ORDER` — the row and its predecessor, or another row and either of them, share a
  timestamp. The order is not provable, so it is labelled "requires further evidence" rather than
  corruption.

The **money** in any unexplained gap is still blocking through R. H3 only localises it. It stays
non-blocking (design D5) because healthy concurrent rows can tie on timestamp.

## 7. Reporting, preflight, Query A

| Surface | Change |
|---|---|
| `GET /finance/summary` | Additive `driverCashOutstandingComponents`: `basis` (`CURRENT_BALANCE`/`LEDGER_AS_OF`), `ledgerNet`, `approvedHistoricalReconciliation` (valid approvals with evidence time before the range end), `explainedLedgerTotal`. `driverCashOutstanding`, collections and revenue are **unchanged**. The reconciliation is never a collection or revenue. Whether the headline figure should use the explained total is open question Q2 (§9). |
| Readiness / reconciliation reports | Additive `driverCashHistoricalReconciliation` summary (bounded to 50 accounts and 50 records, with `…Truncated` flags) |
| `scripts/fr-production-preflight.mjs` | Check 6 G3 applies the shared residual rule once the historical migration is applied, and the raw rule (with an explanation) before it; always prints D, A, R and X. G5 counts unresolved historical ownership. Verified on two isolated databases. |
| Query A (`docs/fr12a-operator-preflight.md`) | Adds `cash.raw_discrepancy_total`, `hr.tables`, `G5.deleted_orders_unresolved_difference`. It still runs before any migration (verified on three databases; on the `swiftdrop_g3lab` lab copy it detects the simulated incident). The residual rule is evaluated only by the preflight script and the readiness dry run. |
| Runbook §8.3 (`docs/fr11b-release-readiness.md`) | G3 go/no-go amended to the residual rule; raw-only exception limited to the documented incident and the migration go/no-go |
| Contract §11 / §12.1 | R1 definition, H3 and I3 |

No client code changed. Every response change is additive, and the client does not read the new
fields yet (UI is FR.12A.6).

## 8. Tests

`server/tests/historical-reconciliation/`:
- `historical-reconciliation-validation.test.ts` (new): the 24 requested cases, plus the as-of
  component and a concurrency case.
- `historical-reconciliation-schema.test.ts` (FR.12A.3): its "gates unchanged" test was
  **converted** to the new rule, not removed. It now asserts G3 and R1 each drop by exactly one
  account when the valid approval lands.
- `reconciliation-fixtures.ts`: fixtures shared by both suites.
- `historical-reconciliation-calculation.test.ts`: covers `INVALID_HISTORY` and the new ownership
  rule.

States the database forbids are created only in transactions that are always rolled back
(`session_replication_role = replica` or one dropped constraint). This needs a superuser on the
isolated test database.

Results (isolated `swiftdrop_fr12a4_reg`, a copy of local dev with the FR.12A.3 migration
applied): **2,327 / 2,327** backend tests passed (2,275 baseline + 31 FR.12A.3 + 21 FR.12A.4), with
0 failed, 0 skipped and 0 cancelled. Afterwards it held 0 reconciliation rows, 0 incidents and 0
orphaned difference audits.

Also:
- frontend 296 / 296;
- backend and client typecheck, and backend build: pass;
- `prisma migrate status`: up to date;
- `migrate diff`: empty.

## 9. Open issues and FR.12A.5 dependencies

- **Q1 — Decision tamper evidence.** Every decision written by the FR.12A.5 endpoints should carry
  a same-transaction audit row. Validity could then require that audit, so an approval inserted
  or rewritten by direct SQL would fail V7.
- **Q2 — Headline as-of figure.** Should FR.12A.6 replace the as-of `driverCashOutstanding` with
  `explainedLedgerTotal`, or keep showing the components separately?
- **Q3 — H3.** Keep it non-blocking (current), or block on `UNEXPLAINED_GAP` only?
- **Q4 — Ownership resolution design** (§5) before any activation.
- FR.12A.5 must:
  - lock the driver cash account `FOR NO KEY UPDATE` when proposing or approving (activation
    holds it `FOR SHARE`);
  - require the reviewer to submit the evidence digest they reviewed;
  - derive every evidence field server-side using this module's SQL, rejecting anything that
    would not evaluate as valid;
  - write the audit actions from design §9.
