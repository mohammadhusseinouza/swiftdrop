# FR.12A.3 — Driver Cash Historical Reconciliation: Database Foundation

Status: **implemented locally, pending review.** Local development only. Production was not accessed.
The migration has been applied only to isolated databases. It was not applied to the local dev
database or to production. Nothing was committed or deployed.

Builds on `docs/fr12a2-historical-ledger-reconciliation-design.md` (option B: an evidence-only
record for a genuinely missing driver-cash collection). This document lists where FR.12A.3
departs from that design.

---

## 1. What was added

| Item | Location |
|---|---|
| Migration (additive, guarded, re-runnable) | `server/prisma/migrations/20261025000000_driver_cash_historical_reconciliation_foundation/` |
| Prisma models / enums | `server/prisma/schema.prisma` (FR.12A.3 section) |
| Domain types | `server/src/modules/historical-reconciliation/historical-reconciliation.types.ts` |
| Pure helpers | `server/src/modules/historical-reconciliation/historical-reconciliation.calculation.ts` |
| Deploy-guard state checks | `server/scripts/db-inspect.mjs` (`HISTORICAL_RECONCILIATION_MIGRATION`) |
| Test cleanup helper | `server/tests/helpers/fixtures.ts` (`cleanupHistoricalReconciliationRows`) |
| Tests | `server/tests/historical-reconciliation/` |

There is no endpoint or service write path, and G3, R1, G5 and preflight are unchanged. There is
no activation bypass.

## 2. Data model

```
financial_ledger_incidents                 immutable incident record
   1 ──< driver_cash_historical_reconciliations          immutable evidence + proposal
            1 ──< driver_cash_historical_reconciliation_decisions   append-only lifecycle
            └── supersedes (same evidence keys) + terminal decision of the superseded record
```

### Enums
- `FinancialLedgerIncidentCause` = `MANUAL_DATABASE_DELETION`
- `DriverCashHistoricalReconciliationKind` = `MISSING_COLLECTION`
- `HistoricalReconciliationAccountingTreatment` = `EVIDENCE_ONLY_NO_CASH_EFFECT`
- `HistoricalOwnershipStatus` = `UNRESOLVED` (the only value; a CHECK also pins it)
- `HistoricalReconciliationDecisionType` = `APPROVED | REJECTED | WITHDRAWN | REVOKED`

### Reconciliation evidence (`driver_cash_historical_reconciliations`)
- Account and driver: composite FK `(account_id, driver_id)` → `driver_cash_accounts(id, driver_id)`.
- Gap anchors:
  - composite FKs `(predecessor_transaction_id, account_id)` and `(anchor_transaction_id, account_id)`
    → `driver_cash_transactions(id, account_id)`;
  - `missing_transaction_id` has no FK, because that row was deleted.
- Source audit: FK to `audit_logs` (`RESTRICT`). The cited audit can no longer be deleted.
- Related settlement: composite FK `(related_settlement_id, driver_id)` (same driver).
- Amounts: `NUMERIC(14,2)`. CHECKs: `amount > 0`, `observed_jump = amount`, `actual_amount = amount`,
  `collection_difference = actual − expected ≠ 0`.
- Snapshot: `order_type`, `expected_amount`, `actual_amount` and `collection_difference` come from
  the audit. The audit's free-text `collectionDifferenceReason` is **not** copied, and no
  customer or receiver data is stored.
- `ownership_status = UNRESOLVED` and `accounting_treatment = EVIDENCE_ONLY_NO_CASH_EFFECT`.
- `evidence_digest`: SHA-256 of a canonical evidence string. A CHECK recomputes it, using
  IMMUTABLE functions only.
- `reason` must be at least 20 characters. `idempotency_key` is unique.

### Decisions (`driver_cash_historical_reconciliation_decisions`)
- `is_terminal = (decision ≠ APPROVED)` (CHECK).
- `APPROVED` and `REJECTED` require `decided_by_id ≠ proposed_by_id`. The `proposed_by_id` copy is
  pinned by FK, so it cannot be faked.
- Only one outcome (`APPROVED`, `REJECTED` or `WITHDRAWN`) is allowed per reconciliation (partial
  unique index).
- `REVOKED` must reference an `APPROVED` decision of the **same** reconciliation (composite FK on
  `(id, reconciliation_id, decision)`). An approval can be revoked at most once.
- Non-approval decisions need a reason of at least 20 characters. Every decision has a unique
  idempotency key.

## 3. Approval lifecycle

The status is **derived** from the decisions (`deriveHistoricalReconciliationStatus`) and is never
stored:

| Decisions | Status | Live |
|---|---|---|
| none | PROPOSED | yes |
| APPROVED | APPROVED | yes |
| REJECTED / WITHDRAWN | REJECTED / WITHDRAWN | no |
| APPROVED + REVOKED | REVOKED | no |

A record existing does not make it approved. Only an `APPROVED` decision by a different person
does.

**Re-proposal after a terminal decision.** A new record sets `supersedes_reconciliation_id`, which
has a composite FK on the same `(account, anchor, missing row, audit)`. It also sets
`supersedes_decision_id`, which must be a **terminal** decision of that record (composite FK on
`(id, reconciliation_id, is_terminal = true)`). `supersedes_reconciliation_id` is unique, and only
chain roots are unique per anchor, missing row and audit. Together these mean each evidence key
has a single linear chain, and only its head can be live. Two live explanations of one gap are
impossible at the database level.

## 4. Immutability without triggers

The database has no user triggers. FR.12A.3 does not add the first one, because constraints are
sufficient:

| Protection | Mechanism |
|---|---|
| Evidence column changed without the digest | `dchr_evidence_digest_chk` fails |
| Evidence changed with a consistently recomputed digest, after any decision | decision FK `(reconciliation_id, proposed_by_id, evidence_digest)` is `ON UPDATE RESTRICT` |
| Proposer changed after a decision | same FK |
| A revoked approval rewritten | revocation FK `ON UPDATE RESTRICT` |
| Anchor / predecessor / audit / settlement deleted | `ON DELETE RESTRICT` |
| Two live explanations of one gap | supersession chain + root partial unique indexes |

Known limits, enforced by application convention rather than the database:
- A PROPOSED record without decisions can still be updated by direct SQL, provided the digest is
  recomputed. FR.12A.5 must have the approver submit the digest they reviewed. The decision FK
  then guarantees the approval binds exactly that evidence.
- An approval that has not been revoked could be rewritten or deleted by direct SQL.
- The incident row and the `reason` text are outside the digest.

A trigger would close these gaps against application bugs. It would not stop anyone with direct
database write access (that person can drop a trigger), which is the incident's actual threat
model (design §14). For that reason I recommend no trigger, plus restricting production write
access.

## 5. Departures from the FR.12A.2 design

| Design | FR.12A.3 | Why |
|---|---|---|
| mutable `status`, `approved_*`, `ended_*` columns | append-only decisions table | requested append-only transitions |
| partial unique indexes `WHERE status IN (PROPOSED, APPROVED)` | supersession chain + root uniques | status is no longer a column |
| no REJECTED | REJECTED added | requested |
| `effective_at` snapshot column | **removed**; the evidence time is the cited audit's `created_at` | timestamps bound by `@prisma/adapter-pg` are stored shifted by the session time zone (`docs/timezone-investigation.md`; the local session is `America/Los_Angeles`), so a DB digest over a stored timestamp can never match an application digest. Comparisons happen stored-to-stored in SQL (FR.12A.4) |
| incident operator acknowledgment (set once) | not modelled | would mutate an immutable row; see open question Q3 |
| SQL mirror in `server/migrations/` | Prisma migration only | that directory is superseded (`server/migrations/README.md`) |

## 6. Domain helpers (pure, exact Decimal)

- `calculateRawDiscrepancy(S, N)`: returns D = S − N.
- `calculateUnexplainedResidual(D, A)`: returns R = D − A.
- `calculateObservedJump(predecessor.after | null, anchor.before)`.
- `reconcileDriverCashAccount`: computes D, A, R and X. A counts only APPROVED records whose
  `evidenceValidity` is valid. Invalid approvals are reported in
  `invalidApprovedReconciliationIds` and never counted. The result is **not** a gate result.
- `deriveHistoricalReconciliationStatus` and `isLiveHistoricalReconciliationStatus`. An
  inconsistent decision history throws; it is never treated as approved.
- `isUnresolvedHistoricalOwnership`: a live record with ownership `UNRESOLVED` stays a future
  activation blocker (design D3; wired in FR.12A.4).
- `buildEvidenceCanonicalString` and `computeEvidenceDigest` mirror `dchr_evidence_digest_chk`
  character for character. They refuse any amount that NUMERIC(14,2) would round.
- `EvidenceValidityFailure` holds the V1–V7 codes and `EVIDENCE_DIGEST_MISMATCH` for FR.12A.4.

## 7. Open questions

- **Q1:** Should a revocation require a person other than the approver? It is not enforced. Revoking
  only fails closed, so restricting it may slow an urgent rollback.
- **Q2:** Which statuses count as the G5 ownership blocker? The helper uses live records (PROPOSED,
  APPROVED). After an authentic restore, the restored order carries the difference itself.
- **Q3:** Operator acknowledgment: an append-only acknowledgment record, an audit-only entry, or
  dropped?
- **Q4:** Add `effective_at` back into the digest (v2) once a UTC session time zone is guaranteed
  (contract §14 item 0)?
- **Q5:** D2 (Finance-role approver, no Admin fallback) is a service rule for FR.12A.5. The database
  only enforces that the approver is a different person.

## 8. Dependencies for FR.12A.4

- A single SQL validity function or CTE (V1–V7 + digest) that compares stored instants only: the
  evidence time is `audit_logs.created_at` of `source_audit_log_id`, and the window is
  `predecessor.created_at ≤ audit.created_at ≤ anchor.created_at`.
- Compare audit metadata amounts numerically (`metadata->>'actualAmount'` is a
  `Decimal.toString()` string, e.g. `"110"`), and `entity_id` as text against
  `deleted_order_reference::text`.
- Apply the residual rule to G3, R1, preflight check 6 and Query A. Always report D, A, R and X.
- Extend G5 using `isUnresolvedHistoricalOwnership`.
- Full backend regression at that point.

## 9. Verification (isolated databases only)

- `swiftdrop_fr12a3_fresh2` (empty): `prisma migrate deploy` of the full chain succeeded and a
  re-run was a no-op. `prisma migrate diff` against `schema.prisma` reported an empty migration.
- `swiftdrop_fr12a3_reg2` (copy of local dev): the migration was applied twice with
  `prisma db execute`. `migrate diff` shows only a pre-existing, unrelated drift:
  `orders.actual_collection_payment_method_id` exists in local dev but not in Prisma.
- db-inspect reports `applied` with no problems on fresh2 and `pending` with no problems on
  `swiftdrop_fr2_fresh`.
- `swiftdrop_fr12a3_reg` and `swiftdrop_fr12a3_fresh` are superseded copies of the first draft
  (it had `effective_at`) and can be dropped.
