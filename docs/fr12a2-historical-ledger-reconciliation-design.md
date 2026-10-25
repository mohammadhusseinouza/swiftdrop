# FR.12A.2 — Historical Driver Cash Ledger Reconciliation Design

Status: **DESIGN ONLY — not implemented, not approved.** No schema, migration, service, gate,
balance, ledger row or production data was changed. Production figures in §2 are the operator's
read-only I1–I10 results as reported; this session did not access production.

Related: `docs/g3-driver-cash-discrepancy-investigation.md` (FR.12A.1 investigation, queries
I1–I10), `docs/fr11b-release-readiness.md` §8 (cutover runbook),
`docs/settlement-financial-release-contract.md` §11 (R1–R13).

---

## 1. Executive summary

An order (DELIVERY_ONLY, expected 210.00, actual 110.00, unresolved −100.00 difference) and its
related records were deleted directly in PostgreSQL. Its driver-cash COLLECTION (+110.00) went
with it. The driver later handed that cash over in a surviving 572.00 settlement, so the stored
balance (0.00) is **true** and the ledger is **incomplete**: Σ movements = −110.00, G3 = +110.00.

No authentic copy of the deleted rows is known to exist (option A unavailable unless one is
found), and every existing correction type would misstate history or invent an obligation.

**Recommendation:** a new, narrowly scoped, **evidence-only** record —
a *driver cash historical reconciliation* — linked to a documented ledger incident. It:
- never changes `current_balance`, any ledger row, wallets, revenue or the settlement;
- is **anchored** to one specific, located balance-chain discontinuity and to the surviving
  audit that names the missing cash row, so its amount cannot be chosen freely;
- requires two different authorized people (Admin proposes, Finance approves), behind an
  environment flag that is on only during the maintenance window;
- changes G3 / R1 from `stored = raw net` to `stored − raw net − approved valid reconciliation = 0`,
  while always reporting the raw discrepancy, the approved amount and the residual;
- keeps the original −100.00 collection difference **unresolved** and visible (it re-enters G5).

The FR.12B migration stays blocked until this approach, the backup requirements and the open
decisions in §13 are approved.

---

## 2. Confirmed historical evidence (production, operator-reported)

| Fact | Value |
|---|---|
| Affected driver cash accounts | 1 |
| Stored `current_balance` | 0.00 |
| Raw ledger net Σ(`balance_after − balance_before`) | −110.00 |
| G3 raw discrepancy (stored − net) | +110.00 |
| Surviving transactions on the account | 118 |
| Balance-chain discontinuities | exactly 1, jump +110.00; none elsewhere |
| Deleted order | DELIVERY_ONLY; expected 210.00; actual 110.00; difference −100.00 |
| Original collection transaction | deleted (named by the surviving audit's `driverCashTransactionId`, which no longer exists) |
| `COLLECTION_DIFFERENCE_RECORDED` audit | survives |
| `COLLECTION_DIFFERENCE_RESOLVED` audit | not found → the difference was never resolved, so no wallet credit or revenue was ever posted for it |
| Surviving settlement | 2026-10-16, 572.00, includes the missing 110.00, matches its cash row, leaves 0.00 |
| Driver's 28 settlements | all match their cash rows |
| Row integrity (all 518 production cash rows) | pass |
| G4 / wallet chains | pass / no gaps |
| Orphaned company revenue / idempotency keys naming deleted orders | none |

Interpretation:
- The +110 jump, the audit's `actualAmount = 110`, the missing referenced cash row and the
  settlement's `balance_before` agree independently. High confidence.
- Because the difference was unresolved, the deletion removed **only** operational rows and the
  driver-cash COLLECTION — no wallet or company row existed to delete. This matches G4 passing and
  no orphaned revenue.
- **Side effect not visible in G3:** the order was `REVIEW_REQUIRED`. Deleting it removed an
  unresolved legacy difference from G5, which now passes for the wrong reason.
- **Ownership of the 110.00 is undetermined.** The company holds it (via the settlement) with
  neither a customer liability nor revenue recorded. The audit does not carry the customer's
  identity; identifying the customer needs other surviving audits (e.g. order creation) or
  business records.

---

## 3. Current financial model analysis

### 3.1 Driver cash

- `driver_cash_accounts.current_balance` — cached balance, updated in the same transaction as
  every ledger row under the account lock.
- `driver_cash_transactions` — append-only ledger: `type` (COLLECTION / SETTLEMENT / ADJUSTMENT /
  REVERSAL), positive `amount`, `balance_before`, `balance_after`; direction is derived from
  `balance_after − balance_before` (Phase 8.1 convention). Links: `order_id` (RESTRICT),
  `settlement_id` (unique), `reversal_of_id` (RESTRICT), unique `idempotency_key`.
- Keys: `delivery:<orderId>:driver-collection`, `reversal:driver-cash:<id>`,
  `request:settlement:<hash>`, `settlement-shortfall:<id>`.

### 3.2 How G3 reconstructs driver cash

`financial-release-activation.service.ts` (G3) and the reconciliation service (R1) use the same
predicate; the preflight script (`fr-production-preflight.mjs`, check 6) and Query A
(`G3`) repeat it:

```
fail  if  current_balance ≠ Σ (balance_after − balance_before)          (all rows of the account)
      or  no row at the latest created_at has balance_after = current_balance   (G3 only)
```

With rows ordered along the chain and `after₀ = 0`:

```
last.balance_after = Σᵢ (afterᵢ − beforeᵢ) + Σᵢ (beforeᵢ − afterᵢ₋₁)
                   = raw_net               + Σ chain jumps
```

When the second G3 condition holds (`last.balance_after = current_balance`):

```
raw discrepancy D = current_balance − raw_net = Σ chain jumps
```

An intact ledger has no jumps, so D = 0. Deleting rows leaves every surviving row's recorded
balances in place: each deleted run of rows becomes one jump equal to its net movement. Here the
deleted COLLECTION (+110) became a +110 jump, raw net fell to −110 and D = +110.

### 3.3 Other consumers of the ledger reconstruction

| Consumer | Effect of the gap today |
|---|---|
| G3 (activation) | fails → activation blocked |
| R1 (reconciliation invariant, monitoring + G6 after the migration) | fails → G6 fails too |
| Preflight check 6 / Query A | reports 1 mismatch (runbook §8.3 go/no-go) |
| `getDriverCashOutstandingSnapshot(endExclusive)` (finance summary as of a date) | rebuilds from the ledger sum → **understated by 110.00 for every as-of date after the deleted collection** (after the 10-16 settlement it contributes −110.00) |
| Current figures (dashboard, finance report `currentDriverCashOutstanding`) | use `current_balance` → correct |
| Collected-cash-by-period figures | the 110.00 collection is missing from its period |
| G5 | no longer counts the deleted `REVIEW_REQUIRED` order |

### 3.4 Existing concepts that could be reused

| Concept | Exists? | Fit |
|---|---|---|
| Opening balance / historical baseline | **No** (no column, type, table or rule in code, schema or `requirements.md`) | — |
| Driver cash ADJUSTMENT (`POST /finance/driver-cash/:driverId/adjust`) | yes | changes `current_balance`; a +110 CREDIT invents a 110 driver obligation; −110 is not possible (balance 0, debits capped at U) |
| REVERSAL | yes | needs the original row (deleted) |
| Settlement reversal / shortfall | yes / disabled | would re-open a settled obligation — false |
| H1/H2 historical findings | yes | reporting-only, not part of any equality; cannot make an equality pass |

None represents "ledger history is missing but the balance is right" without misstating an event.

---

## 4. Comparison of solutions

### A. Authentic record recovery

| Source | Can it supply the deleted rows? |
|---|---|
| Supabase scheduled backup / PITR from before the deletion | only if one exists within retention and predates the deletion — **not confirmed** |
| Retained logical dump / historical export | none known (V1 has no Excel/PDF export) |
| Vercel / application logs | no row data; insufficient |
| Audit metadata | partial (amounts, ids) — **not** a source for recreating rows (requirement 7) |

If an authentic source is found, A remains the best option: restore the exact rows (same ids,
timestamps, keys) after a rehearsal; G3 then passes with no new concept. Because the order's
difference was never resolved, the restored order would also re-enter G5 correctly. **Assumed
unavailable** for this design.

### B. Dedicated historical reconciliation record (recommended)

An evidence record, outside the ledger, that explains one located discontinuity:

| Question | Answer |
|---|---|
| Separate table or ledger event? | **Separate table.** A ledger row must chain (`balance_before` = previous `balance_after`) and moves the cached balance; an evidence record does neither. Keeping it out of `driver_cash_transactions` keeps every ledger sum, type count and feed truthful |
| Affects balance reconstruction? | **Only in reconciliation**, as an explicit, separately reported term (§7). Raw net is never altered |
| Affects historical reports? | Raw figures unchanged; as-of driver cash outstanding gains an explicit, labeled component (decision D6); period figures get a disclosure line |
| Affects available driver cash? | **No.** `current_balance`, U, G2, settlement limits unchanged |
| Affects G3? | Yes, through the residual: G3 passes only if `D − approved valid amount = 0` and the raw D stays visible |

### C. Controlled historical baseline

A signed snapshot ("at time T the ledger was accepted as is"), with G3 comparing only movements
after T, or an approved per-account offset.

| | B. Anchored reconciliation | C. Baseline |
|---|---|---|
| What is explained | one specific discontinuity: location, amount, missing row id, source audit | everything before T, whatever it was |
| Amount freely chosen? | no — must equal the observed jump and the audit's actual amount | the offset/snapshot absorbs any value |
| Future corruption before T (e.g. another historical row deleted later) | shows as a new jump → residual ≠ 0 → G3 fails | silently absorbed if the baseline re-sums history; or missed if only post-T rows are checked |
| Direct edit of `current_balance` | no jump → not coverable → G3 fails | absorbed if an offset is per-account and re-approved; otherwise fails |
| Granularity | per incident | per account / global |
| Reporting | exact effective time → correct as-of figures | no event time → as-of figures before T stay wrong |
| Precedent risk | narrow (one kind, evidence-gated) | broad ("accept history") |

C is simpler but turns a known, explained gap into an unexplained accepted state and weakens
detection. **Rejected.** B is preferred.

### How B avoids hiding future corruption

- The approved amount is tied to a jump measured between two **named** surviving rows; a new
  deletion anywhere else creates a new jump that no record covers.
- Validity is re-checked every time G3 / R1 runs; any change to the anchor rows, reappearance of
  the missing row, or deletion of the source audit invalidates the record and fails G3.
- No account is excluded or whitelisted; `current_balance` edits still fail.
- Creation is impossible outside a flagged maintenance window and two-person approval.

---

## 5. Recommended architecture

1. **`financial_ledger_incidents`** — the documented incident (cause, scope, missing records,
   uncertainties, acknowledgments).
2. **`driver_cash_historical_reconciliations`** — one row per located discontinuity, linked to the
   incident; status PROPOSED → APPROVED (→ REVOKED / WITHDRAWN); evidence-only, no cash effect.
3. **Validation function** (single SQL source shared by G3, R1, preflight and the read API) that
   recomputes the anchored jump and the audit evidence each time.
4. **G3 / R1 residual rule** (§7) reporting raw D, approved A and residual R.
5. **G5 extension**: an incident reconciliation whose `ownership_status = UNRESOLVED` counts as an
   outstanding legacy obligation (decision D3).
6. **Reporting**: raw ledger figures unchanged; explicit labeled reconciliation component and
   disclosures (§9).
7. **Write path**: two Admin/Finance endpoints behind `DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED`
   (default absent = disabled), used once in a maintenance window; read endpoints always on for
   ADMIN/FINANCE.

Out of scope (decision D4): resolving the ownership of the 110.00 (wallet credit vs revenue). It
needs its own approved design because the order no longer exists.

---

## 6. Data model proposal (not applied)

### 6.1 Enums

```prisma
enum FinancialLedgerIncidentCause {
  MANUAL_DATABASE_DELETION
}

enum DriverCashHistoricalReconciliationKind {
  MISSING_COLLECTION        // the only kind in V1; requires a surviving COLLECTION_DIFFERENCE_RECORDED
}                           // audit naming the missing cash row, and no COLLECTION_DIFFERENCE_RESOLVED

enum HistoricalReconciliationStatus {
  PROPOSED
  APPROVED
  WITHDRAWN                 // PROPOSED, never approved
  REVOKED                   // APPROVED, later revoked (e.g. authentic rows restored)
}

enum HistoricalOwnershipStatus {
  UNRESOLVED                // V1 value; a future approved workflow may add RESOLVED
}
```

### 6.2 `financial_ledger_incidents`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `incident_number` | varchar(30) unique | e.g. `LI-2026-0001` |
| `cause` | `FinancialLedgerIncidentCause` | |
| `summary` | text | ≥ 20 chars; no customer PII |
| `discovered_at` | timestamptz | |
| `occurred_not_before`, `occurred_not_after` | timestamptz NULL | deletion window if known |
| `missing_records` | jsonb | per table: count or `"unknown"` (e.g. `orders: 1, driver_cash_transactions: 1, delivery_attempts: "unknown"`) |
| `remaining_uncertainties` | text | |
| `evidence` | jsonb | query ids (I1–I10), run timestamps, result digests (sha256 of the exported result set), reviewer |
| `reported_by_id` | uuid FK users | |
| `operator_acknowledged_by_id`, `operator_acknowledged_at` | FK users / timestamptz NULL | the person who performed the deletion (or ops lead) |
| `created_at` | timestamptz | |

Append-only except the acknowledgment pair (set once).

### 6.3 `driver_cash_historical_reconciliations`

| Column | Type | Rule |
|---|---|---|
| `id` | uuid PK | |
| `incident_id` | uuid FK → incidents, RESTRICT | |
| `account_id` | uuid FK → `driver_cash_accounts`, RESTRICT | |
| `kind` | enum | `MISSING_COLLECTION` |
| `amount` | NUMERIC(14,2) | signed net movement of the missing rows; CHECK `amount <> 0`; here +110.00 |
| `predecessor_transaction_id` | uuid NULL | last surviving row before the gap (NULL if the gap is at the start); composite FK `(predecessor_transaction_id, account_id)` → `driver_cash_transactions(id, account_id)` |
| `anchor_transaction_id` | uuid NOT NULL | first surviving row after the gap; composite FK `(anchor_transaction_id, account_id)` |
| `observed_jump` | NUMERIC(14,2) | `anchor.balance_before − coalesce(predecessor.balance_after, 0)` at proposal; CHECK `observed_jump = amount` |
| `missing_transaction_id` | uuid NOT NULL | the deleted cash row's id from the audit; no FK (it does not exist) |
| `source_audit_log_id` | uuid FK → `audit_logs(id)`, RESTRICT | the surviving `COLLECTION_DIFFERENCE_RECORDED` |
| `deleted_order_reference` | uuid NOT NULL | the audit's `entity_id`; no FK |
| `order_type`, `expected_amount`, `actual_amount`, `collection_difference` | snapshot from the audit | CHECK `actual_amount = amount` for `MISSING_COLLECTION` |
| `effective_at` | timestamptz | the audit's `created_at` (same delivery transaction); service check `predecessor.created_at ≤ effective_at ≤ anchor.created_at` |
| `related_settlement_id` | uuid FK → `driver_settlements`, RESTRICT | the 2026-10-16 settlement (evidence) |
| `accounting_treatment` | varchar fixed `EVIDENCE_ONLY_NO_CASH_EFFECT` (CHECK) | |
| `ownership_status` | `HistoricalOwnershipStatus` | `UNRESOLVED` |
| `reason` | text | CHECK length(trim) ≥ 20 |
| `status` | enum | |
| `proposed_by_id`, `proposed_at` | FK users / timestamptz | |
| `approved_by_id`, `approved_at` | NULL until approved | CHECK `approved_by_id <> proposed_by_id`; CHECK status/field consistency |
| `ended_by_id`, `ended_at`, `end_reason` | NULL unless WITHDRAWN/REVOKED | end_reason ≥ 20 chars |
| `idempotency_key` | varchar(200) unique | `historical-reconciliation:driver-cash:<missing_transaction_id>` |
| `created_at`, `updated_at` | timestamptz | `updated_at` used for compare-and-set |

Indexes and constraints:
- `UNIQUE (anchor_transaction_id) WHERE status IN ('PROPOSED','APPROVED')` — one live explanation per gap.
- `UNIQUE (missing_transaction_id) WHERE status IN ('PROPOSED','APPROVED')`.
- `UNIQUE (source_audit_log_id) WHERE status IN ('PROPOSED','APPROVED')`.
- `INDEX (account_id, status)`, `INDEX (incident_id)`.
- New additive unique index `driver_cash_transactions (id, account_id)` to support the composite FKs
  (no existing row changes).
- Rows are never deleted. Evidence columns are immutable after insert (service-enforced; optional
  `BEFORE UPDATE` trigger — decision D8).

Migration: one additive migration, applied **after** the FR migration in the same release or a
following one; SQL mirror in `server/migrations/` per project convention; Prisma kept in sync.
No backfill, no change to existing tables' data.

### 6.4 Prisma sketch

```prisma
model driver_cash_historical_reconciliations {
  id                         String                                  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  incident_id                String                                  @db.Uuid
  account_id                 String                                  @db.Uuid
  kind                       DriverCashHistoricalReconciliationKind
  amount                     Decimal                                 @db.Decimal(14, 2)
  predecessor_transaction_id String?                                 @db.Uuid
  anchor_transaction_id      String                                  @db.Uuid
  observed_jump              Decimal                                 @db.Decimal(14, 2)
  missing_transaction_id     String                                  @db.Uuid
  source_audit_log_id        String                                  @db.Uuid
  deleted_order_reference    String                                  @db.Uuid
  order_type                 OrderType
  expected_amount            Decimal                                 @db.Decimal(14, 2)
  actual_amount              Decimal                                 @db.Decimal(14, 2)
  collection_difference      Decimal                                 @db.Decimal(14, 2)
  effective_at               DateTime                                @db.Timestamptz(3)
  related_settlement_id      String?                                 @db.Uuid
  accounting_treatment       String                                  @db.VarChar(40)
  ownership_status           HistoricalOwnershipStatus
  reason                     String
  status                     HistoricalReconciliationStatus
  proposed_by_id             String                                  @db.Uuid
  proposed_at                DateTime                                @db.Timestamptz(3)
  approved_by_id             String?                                 @db.Uuid
  approved_at                DateTime?                               @db.Timestamptz(3)
  ended_by_id                String?                                 @db.Uuid
  ended_at                   DateTime?                               @db.Timestamptz(3)
  end_reason                 String?
  idempotency_key            String                                  @unique @db.VarChar(200)
  created_at                 DateTime                                @default(now()) @db.Timestamptz(3)
  updated_at                 DateTime                                @default(now()) @db.Timestamptz(3)
  // relations, composite FKs and partial unique indexes as in §6.3 (partial indexes in SQL)
}
```

---

## 7. Reconciliation equations

Per driver cash account `a` (all values exact NUMERIC(14,2); no rounding):

```
S  = a.current_balance                                   stored balance
N  = Σ (balance_after − balance_before)  over rows of a  raw ledger net
D  = S − N                                               raw discrepancy (always reported)

valid(r) for an APPROVED reconciliation r of a  ⇔
  V1  anchor (and predecessor, if any) exist and belong to a
  V2  anchor.balance_before − coalesce(predecessor.balance_after, 0) = r.amount = r.observed_jump
  V3  no row of a has created_at strictly between predecessor.created_at and anchor.created_at
      (predecessor NULL ⇒ no row of a before anchor)
  V4  no driver_cash_transactions row has id = r.missing_transaction_id
  V5  source audit exists; action = COLLECTION_DIFFERENCE_RECORDED; entity_type = 'ORDER';
      entity_id = r.deleted_order_reference; metadata.driverCashTransactionId = r.missing_transaction_id;
      metadata.actualAmount = r.amount; and no COLLECTION_DIFFERENCE_RESOLVED audit exists for that
      entity_id (an exact delivery — *_FINANCE_FINALIZED, field actualAmountCollected — would also
      have had wallet/revenue rows deleted: a different incident kind, out of scope)
  V6  no orders row has id = r.deleted_order_reference
  V7  approved_by_id ≠ proposed_by_id, both present

A  = Σ r.amount over APPROVED r of a with valid(r)        approved historical reconciliation
X  = count of APPROVED r of a with ¬valid(r)              invalid approvals
R  = D − A                                               unexplained residual

G3(a) / R1(a) pass  ⇔  R = 0  ∧  X = 0  ∧  (latest-row condition, unchanged, G3)
```

Properties:
- No reconciliation ⇒ A = 0 ⇒ R = D ⇒ identical to today (backward compatible).
- D, A and R are always reported, even when R = 0; the raw discrepancy never disappears.
- A cannot exceed what a located jump shows, and an invalid approval fails the gate instead of
  being ignored.
- A restored authentic row makes V4 false ⇒ X = 1 ⇒ fail, forcing the record to be REVOKED.
- PROPOSED / WITHDRAWN / REVOKED rows never count.

Production expectation after approval: S = 0.00, N = −110.00, D = +110.00, A = +110.00, R = 0.00, X = 0.

As-of reconstruction (finance summary, decision D6, recommended):

```
driverCashOutstanding(T) = Σ ledger movements with created_at < T            (ledgerNet, unchanged)
                         + Σ A-amounts of valid approved r with effective_at < T   (historicalReconciliation)
```

Both components are returned; the total is labeled as including a historical reconciliation.

---

## 8. Security and authorization

| Action | Who | Mechanism |
|---|---|---|
| Read incidents / reconciliations / D-A-R | ADMIN, FINANCE | `requireRole` (role, not grantable permission) |
| Create incident | ADMIN | `requireRole("ADMIN")` |
| Propose reconciliation | ADMIN | `requireRole("ADMIN")` + flag |
| Approve | FINANCE (role) and **not** the proposer; decision D2 whether an ADMIN may approve when no separate FINANCE user exists | `requireRole("FINANCE")` + flag + CHECK |
| Withdraw (PROPOSED) | proposer or ADMIN | flag |
| Revoke (APPROVED) | ADMIN, different from approver | flag; always allowed while the flag is on (fail-closed effect) |
| Operator acknowledgment on the incident | the named operator's own account | authenticated |

- Flag: `DRIVER_CASH_HISTORICAL_RECONCILIATION_ENABLED=true` required for every write (403
  `HISTORICAL_RECONCILIATION_DISABLED` otherwise); set only for the maintenance window and removed
  afterwards, like `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED`.
- The server derives every evidence field itself (jump, audit amounts, order reference,
  settlement); the client supplies only ids of the anchor/predecessor/audit, the incident and the
  reason. Any mismatch → 409 `RECONCILIATION_EVIDENCE_MISMATCH`.
- Only `MISSING_COLLECTION` with a qualifying audit is accepted; there is no "free amount" path.
- Responses expose ids, amounts and dates only; no receiver/customer details.

Concurrency:
- Propose and approve lock the account row `FOR NO KEY UPDATE` (global lock order: advisory →
  activation row → driver cash account → …). Activation's G3 evaluation holds the accounts
  `FOR SHARE`, so an approval cannot land mid-evaluation.
- Approve is a compare-and-set on `(status = 'PROPOSED', updated_at = expected)`; concurrent
  approvals → one succeeds, the other gets 409 `STALE_RECONCILIATION` (or idempotent success if
  it is the same approver retrying the same request).
- Propose is idempotent on `idempotency_key`: same body → return the existing record; different
  body → 409 `IDEMPOTENCY_KEY_REUSED`. Partial unique indexes arbitrate races.

---

## 9. Audit and reporting behavior

Audit actions (all in the same transaction as the change, with the full D/A/R before and after):
`LEDGER_INCIDENT_RECORDED`, `LEDGER_INCIDENT_ACKNOWLEDGED`,
`DRIVER_CASH_HISTORICAL_RECONCILIATION_PROPOSED` / `_APPROVED` / `_WITHDRAWN` / `_REVOKED`.
Metadata: incident number, account/driver id, amount, observed jump, anchor/predecessor ids,
missing transaction id, source audit id, settlement id, validity result, D/A/R. No PII.

| Surface | Treatment |
|---|---|
| `current_balance`, driver portal cash, U, G2, settlement limits | unchanged |
| Driver cash ledger feeds (management, driver portal) | unchanged rows; Driver Detail (management only) shows a "Historical reconciliation — no cash effect" panel with incident number, amount, effective date, status |
| G3 / R1 / Admin Financial Release tab / preflight | report D, A, R, X per account and the incident number |
| As-of driver cash outstanding | ledgerNet + historicalReconciliation, both returned (D6) |
| Period "collected" / driver collection reports | raw ledger figures unchanged; disclosure line "includes no record of 110.00 collected on <date> (incident LI-…)" for periods containing `effective_at` (D7) |
| Company revenue, wallets, payouts, order reports | unchanged (no revenue or credit was ever posted; ownership unresolved) |
| G5 | counts reconciliations with `ownership_status = UNRESOLVED` as outstanding legacy obligations (D3) |
| Reconciliation endpoint | new informational check: count of chain breaks not covered by a valid approved reconciliation (diagnostic; ordering by `created_at` can mis-sequence concurrent rows, so not blocking — D5) |

---

## 10. Implementation plan (each step its own session and review gate; none started)

| Step | Scope |
|---|---|
| FR.12A.3 | Schema: enums, two tables, partial unique indexes, composite FKs, `(id, account_id)` index; Prisma + SQL mirror; additive migration; db-inspect knows the objects |
| FR.12A.4 | Validation SQL (V1–V7) as one shared function; D/A/R/X in G3, R1, preflight check 6, Query A; read API; G5 extension; unit + integration tests |
| FR.12A.5 | Incident + propose / approve / withdraw / revoke endpoints behind the flag; audit; idempotency; concurrency tests |
| FR.12A.6 | Reporting (as-of components, disclosures) and management UI panel; frontend tests |
| FR.12A.7 | Full regression; rehearsal on a restored copy of a current production backup; runbook §8.3 updated to the residual rule |
| FR.12A.8 | Production remediation window (§12), separately authorized |

---

## 11. Test strategy

Lab setup for integration tests: a fixture account with a real collection and settlement, then
the collection row (and its order) removed inside the test's own fixture to create a +110 jump —
never on shared data.

| # | Test | Expected |
|---|---|---|
| 1 | Unmodified legacy accounts | D = 0, A = 0, R = 0; G3/R1 results byte-identical to current behavior |
| 2 | Documented +110 missing collection | before approval: D = 110, R = 110, G3 fails; after: D = 110, A = 110, R = 0, G3 passes |
| 3 | Raw discrepancy visible | D present in G3 detail, R1 row, read API, Admin tab, preflight after approval |
| 4 | Approved amount matches the gap | propose with wrong anchor, wrong predecessor, audit with other amount, existing missing id, existing order → 409 `RECONCILIATION_EVIDENCE_MISMATCH` |
| 5 | New unexplained discrepancy | second deletion elsewhere, direct `current_balance` edit, modified anchor row → R ≠ 0 or X > 0 → G3/R1 fail |
| 6 | Unauthorized | DISPATCHER/DRIVER/CUSTOMER 403; FINANCE cannot propose; ADMIN with `finance.*` permissions but no FINANCE role cannot approve (per D2); flag off → 403 |
| 7 | Duplicate reconciliation | same gap / same missing id / same audit while PROPOSED or APPROVED → 409 (partial unique) |
| 8 | Idempotent retries | same propose body → same record, one audit; approve retry by the same approver → same result, one audit |
| 9 | Concurrent approvals | two approvers in parallel → exactly one APPROVED, one 409; one audit |
| 10 | Audit integrity | every transition has exactly one audit with D/A/R before/after; rollback on audit failure leaves nothing |
| 11 | Normal collections | delivery after approval posts COLLECTION; R stays 0 |
| 12 | Normal settlements | settlement after approval debits cash; R stays 0; U unaffected by A |
| 13 | Driver cash unchanged | `financialSnapshot` before/after propose+approve identical (counts, sums, hashes) |
| 14 | Wallets unchanged | wallet sums/hashes identical; G4 unchanged |
| 15 | Company revenue unchanged | company sums identical |
| 16 | Activation readiness | G3 fails before approval, passes after; G5 fails while ownership UNRESOLVED (D3); revoke → G3 fails again; activation with an invalid approval → 409 |
| 17 | Reporting consistency | as-of outstanding = ledgerNet + historicalReconciliation for T before/at/after `effective_at` and after the settlement; period disclosures appear only for the containing period |
| 18 | Regression | full backend (2,275 + new) and frontend suites; build; typecheck |

No test requiring the new schema is run in this phase.

---

## 12. Production remediation procedure (requires separate authorization at each step)

1. **Approvals**: this design, D1–D9, and the accounting treatment `EVIDENCE_ONLY_NO_CASH_EFFECT`
   in writing (APPROVER + FIN).
2. **Backup**: create and record a verified backup / PITR point of the **current** production
   database (OPS). Confirm whether any pre-deletion backup still exists (option A); if one does,
   stop and re-evaluate A.
3. **Restore rehearsal**: restore it into an isolated non-production project; run I1–I10 and the
   preflight; results must match production (same D, same single jump, same evidence).
4. **Rehearse remediation** there with the released code: create incident → propose → approve with
   two different users → verify D = 110, A = 110, R = 0, X = 0, `financialSnapshot` identical
   before/after, G4 unchanged, G5 shows the unresolved ownership.
5. **Finance review** of the rehearsal evidence; FIN signs the incident record.
6. **Deploy** the code + additive migration (with the FR migration per the runbook sequence, flag
   off).
7. **Maintenance window**: set the flag; record the incident (ADMIN); operator acknowledgment;
   propose (ADMIN); approve (FINANCE, different user); remove the flag; redeploy.
8. **Post-verification**: preflight + reconciliation + Admin tab: G3/R1 pass with D = 110 visible;
   `financialSnapshot` identical to the pre-window baseline; no other account changed.
9. **Rollback**: revoke the reconciliation (gate fails again; no balance effect). Schema is never
   rolled back; restoring the step-2 backup is a last-resort incident decision.
10. **Close**: incident document (§13 template) archived with query results and digests.

The FR.12B production migration remains **blocked** until steps 1–2 are approved and the
runbook §8.3 G3 rule is amended accordingly.

### Incident record template (no customer PII)

| Field | Content |
|---|---|
| Incident id | `LI-2026-0001` |
| Affected account | driver cash account id / driver id (UUIDs) |
| Original audit | `COLLECTION_DIFFERENCE_RECORDED`, audit id, timestamp |
| Amounts | expected 210.00, actual 110.00, difference −100.00 (from the audit) |
| Missing records | order (UUID from audit), driver-cash COLLECTION (id from audit); attempts, assignments, status history: counts unknown |
| Related settlement | settlement id, 2026-10-16, 572.00, cash row id, balance before / after |
| Evidence | I1–I10 run timestamps, operator, result digests; jump location (predecessor/anchor ids and timestamps) |
| Uncertainties | exact deletion time; whether other audit rows were deleted; customer identity; ownership of 110.00 |
| Acknowledgment | operator name/role, date |
| Approval | Finance approver, Admin proposer, dates |

---

## 13. Outstanding business decisions

| # | Decision | Recommendation |
|---|---|---|
| D1 | Adopt B (anchored evidence-only reconciliation) over C (baseline) | B |
| D2 | Who approves; may an ADMIN approve if no separate FINANCE user exists | FINANCE role, different person; no Admin fallback |
| D3 | Does the unresolved ownership of 110.00 block activation via G5 | yes — the deletion removed an unresolved legacy difference; G5 should see it again |
| D4 | How and when the ownership is resolved (customer credit vs company revenue, identifying the customer without the order) | separate approved design; not part of this remediation |
| D5 | Uncovered chain breaks: informational or blocking | informational (ordering heuristic), with R blocking |
| D6 | As-of driver cash outstanding includes the reconciliation as a labeled component | yes |
| D7 | Period collection reports: disclosure only (no figure change) | yes |
| D8 | DB trigger enforcing immutability of evidence columns | yes, if the project accepts its first trigger; otherwise service-level only |
| D9 | Ship with the FR release or as a separate later release | same release train, separate migration, before activation |

---

## 14. Risks and limitations

- **Evidence depends on audit integrity.** Anyone with direct database write access could forge an
  audit row; the design narrows but cannot remove that risk. Restricting production write access
  is a prerequisite.
- **Chain ordering by `created_at`.** The column's DB default is `CURRENT_TIMESTAMP`, but Prisma
  Client supplies the value per statement (rows written in one transaction differ by
  milliseconds), so clock skew across server instances could mis-sequence rows. The anchored check uses explicit row ids,
  but the "uncovered breaks" diagnostic can produce false positives (hence non-blocking).
- **Ownership remains open.** The company holds 110.00 that is neither liability nor revenue; the
  customer may be owed money. This design deliberately does not decide it.
- **New concept for one incident.** Two tables and gate logic for a single historical event; the
  narrow kind and the flag limit precedent, but future incidents will reuse it.
- **Reporting nuance.** Period collection totals for the incident period stay understated by
  110.00 (disclosed, not altered).
- **Operational details of the deletion are unknown** (exact time; whether other audit rows were
  deleted); recorded as uncertainties.
- **If an authentic pre-deletion backup is later found**, option A is better: restore, then revoke
  the reconciliation (V4 forces it).
