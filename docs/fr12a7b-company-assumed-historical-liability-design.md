# FR.12A.7b — Company-Assumed Historical Liability: Design

Status: **business direction approved by Finance (§11); implemented locally for FR.12A.9–11 (§12).**
Not committed, not deployed, no production migration, no posting, and not applied to `LI-2026-0001`.
No production access was used. §1–§10 are the original design; §11–§12 record the approval and the
implemented scope.

Extends `docs/fr12a7-historical-financial-ownership-design.md` (FR.12A.7). It uses the evidence
work in `docs/fr12a8-historical-incident-evidence-recovery.md`. Contract and invariants:
`docs/settlement-financial-release-contract.md` §11, CLAUDE.md §21 / §22 / §27 / §62 / §63.

The business owner has said that Finance is willing to accept responsibility for incident
`LI-2026-0001`, even if the replacement order is never identified. That is a willingness to bear
risk. It is **not** evidence that any party was paid, and it does **not** decide an amount or a
ledger treatment. This document designs a mechanism that can record such a decision once Finance
makes it. It records no decision.

---

## 1. Findings

### 1.1 What FR.12A.7 already supports

FR.12A.7 §6 defines five treatments. None of them is a company-assumed liability for an
unidentified beneficiary:

| FR.12A.7 treatment | Needs | Available for this incident? |
|---|---|---|
| A. Wallet credit / C. Split | identified customer (and the fee for C) | **no**: the customer is not in any surviving record |
| B. Company revenue | evidence that the fee ≥ 110.00, or an approved "other income" policy | **no**: the fee is unknown; goods value of a DELIVERY_ONLY order is never company revenue |
| D. Remain unallocated | nothing | yes, and it is the current state. **G5 keeps blocking** |
| E. Externally settled | documentary proof of an external settlement; decision D9 | **no**: the owner's report is a claim, not proof |

FR.12A.7 §14 **D5** left this exact case open: *"If the customer cannot be identified: does it stay
unallocated indefinitely (G5 keeps blocking activation), or is there an approved unclaimed-funds
policy?"* A company-assumed liability is one possible answer to D5. It is therefore a **new
outcome** that needs a Finance policy. No existing rule supplies it.

### 1.2 Constraints in the current system

- **No liability or suspense ledger** (FR.12A.7 §2.5). Company money exists only as revenue rows
  (`company_financial_transactions`). Customer liabilities exist only as wallets, which need a
  customer. Driver cash is custody, not ownership. The 110.00 the company holds is implicitly in
  suspense today: held, not booked.
- **G5 can never pass while any ledger reconciliation exists.**
  - `unresolvedHistoricalOwnershipSql` lists every `driver_cash_historical_reconciliations` row
    with `ownership_status = 'UNRESOLVED'`.
  - `dchr_ownership_unresolved_chk` pins that column to `UNRESOLVED`.
  - FR.12A.7 §10 already planned the fix: G5 counts a reference as unresolved **unless**
    `released(O)` holds, computed by one shared SQL definition.
- **Keys and audits that must stay unused:** a `delivery:<O>:…` ledger key or a
  `COLLECTION_DIFFERENCE_RESOLVED` audit for the deleted order would invalidate the approved ledger
  reconciliation (FR.12A.4 V5) and re-block G3.
- **Payouts debit wallets, never orders.** Legacy settlements record only a total. So the system
  cannot show, after the fact, which order a historical payout or settlement covered.

### 1.3 The three outcomes are kept separate

| Outcome | Meaning | Evidence standard | Ledger effect | G5 |
|---|---|---|---|---|
| **1. Verified externally settled** | the obligation was already discharged outside SwiftDrop | independent documents (receipt, signed acknowledgment) under D9 | none | releases only if D9 is approved (FR.12A.7 H6) |
| **2. Company-assumed outstanding liability** (this design) | the company recognizes that it owes an amount to a beneficiary it cannot yet identify | an approved policy + a Finance decision with evidence of the facts it relies on; **not** proof of payment | a register entry; **no** wallet, revenue or driver-cash row | releases only under §5 |
| **3. Unresolved historical incident** | not enough information or approval | — | none | blocks (current state) |

Finance's willingness to accept risk supports outcome 2 at most. It never supports outcome 1:
*"payouts were completed"* is unverified, and a liability **recognizes** that something may still
be owed. That is the opposite claim.

---

## 2. Recommended accounting disposition

### 2.1 Recommendation

Add a **historical liability register**: an append-only sub-ledger for obligations whose beneficiary
is not yet identified. It is separate from customer wallets, driver cash and company revenue
(CLAUDE.md §63: wallet ≠ driver cash ≠ revenue).

The register **is** the recorded accounting treatment. SwiftDrop has no general ledger or balance
sheet, so the register's outstanding balance is the in-system statement that *the company holds or
owes this amount for an unidentified party*.

An entry has up to two components. Each is a Finance decision, bounded by audit-derived facts and
never computed by the system:

| Component | Meaning | Bound (from the surviving audit) | Cash backing |
|---|---|---|---|
| `held_collection_amount` | collected money the company holds on behalf of a beneficiary | `0 < amount ≤ collected amount` (110.00) | yes: settled into company custody |
| `assumed_shortfall_amount` | an uncollected amount the company decides it is responsible for (for example, a driver or receiver error) | `0 ≤ amount ≤ |difference|` (100.00) | **no**: company-funded if ever discharged |

`recognized_amount = held + assumed`.

**Recommended policy rule (Finance decision L1): `held_collection_amount` must equal the full
collected amount.**
- The goods value of a DELIVERY_ONLY collection is customer money unless the fee is evidenced.
  Putting less than the full collection into the liability would move the rest into company
  ownership without evidence.
- The only route for recognizing company revenue from this collection stays the FR.12A.7 ALLOCATION
  outcome, with fee evidence.

**`assumed_shortfall_amount` defaults to 0.**
- A non-zero amount is a company loss decision (FR.12A.7 D3), with its own stated rationale.
- It has no cash behind it, so it is reported separately.

The design makes **no** assumption that 210, 110 or 100 is the liability. The proposer enters both
components. The server enforces only the bounds and the policy rules, and the approver confirms
the exact digest.

### 2.2 Alternatives

| Alternative | Assessment |
|---|---|
| Keep D (unallocated) | Correct and safe. G5 blocks indefinitely. This remains the default until Finance approves the policy |
| Wallet credit to a placeholder "unknown customer" | **Rejected.** It invents a beneficiary, pollutes customer totals and statements, and makes a payout possible to nobody |
| Company revenue or `ADJUSTMENT` for 110.00 | **Rejected.** It transfers possible customer money into revenue without evidence (the final requirement of the brief) |
| Negative company `ADJUSTMENT` for the 100.00 shortfall now | **Rejected for recognition.** No cash moved and there is no expense ledger. It may be considered only at discharge time (§2.4, decision L4) |
| Treat the approved ledger reconciliation as the resolution | **Rejected.** That reconciliation explains a missing driver-cash row. It never decides ownership (FR.12A.4 / FR.12A.7) |

### 2.3 Recognition, classification, reporting

- **Recognition** is one register row, written in one transaction with its audit, after
  independent approval (§3). There are no wallet, company or driver-cash rows, so G2, G3, G4 and
  R1–R13 are unaffected.
- **Classification:** a `HISTORICAL_UNIDENTIFIED_BENEFICIARY` liability, with its held and assumed
  components shown separately.
- **Reporting:** a separate line on the finance summary, the finance report and the reconciliation
  view: *"Historical liabilities — unidentified beneficiary: outstanding X (held collection a;
  company-assumed shortfall b)"*.
  - It is excluded from revenue (both bases), from customer wallet totals and pending amounts, and
    from driver cash.
  - It is shown in the period of recognition, with the incident reference.
  - Delivery-date reports carry a disclosure line only.
- **The approved ledger reconciliation is preserved unchanged.**
  - The register references it as evidence (FK) and never counts it as money.
  - G3 / R1 continue to use it exactly as today.
  - Nothing is written under `delivery:<O>:…`, and no `COLLECTION_DIFFERENCE_RESOLVED` audit is
    written, so V5 stays clean.

### 2.4 Discharge: later evidence, the replacement order, and double payment

The liability is reduced only by append-only **discharge** rows. Each discharge has its own
proposal, independent approval and idempotent execution. The register keeps a running balance:
each discharge stores `outstanding_before` and `outstanding_after = before − amount ≥ 0`, uses a
per-liability sequence, and is a DB CHECK-enforced chain.

| Discharge kind | When | Ledger effect | Guard |
|---|---|---|---|
| `TO_CUSTOMER_WALLET` | the beneficiary is identified by evidence meeting the D1 standard | wallet credit, `order_id` NULL, key `historical-liability:<id>:discharge:<seq>`; type per D6 | the customer's wallet is locked; the wallet tx FK is unique; the amount ≤ outstanding |
| `EXTERNAL_PAYMENT` | proof that the beneficiary was paid outside SwiftDrop | none | evidence hash required; amount ≤ outstanding |
| `SUPERSEDED_BY_ORDER` | a replacement order is identified **and** its own postings already compensated the beneficiary | none | `order_id` FK **unique across all discharges** (an order can close at most one liability); evidence required; the order must exist with its own ownership postings |
| Whole-entry supersession by an FR.12A.7 ALLOCATION | the customer and fee are later evidenced while **nothing** has been discharged | the ALLOCATION posting (FR.12A.7 §9) | allowed only while `outstanding = recognized`; the liability is revoked in the same transaction |

**Double recognition and double payment are prevented structurally:**
- one live disposition per deleted order reference (FR.12A.7's partial unique chain root, shared
  by every outcome);
- the outstanding balance can never go below zero (CHECK + running chain + the liability row lock);
- a replacement order can close at most one liability (unique FK);
- a discharge is executed exactly once (idempotency key + unique ledger FK);
- the namespaced keys never collide with `delivery:<orderId>:…`.

**Residual risk (documented, not removable by code):** a replacement order may already have
credited the same customer through its own normal posting. Discharging this liability to that
customer could then pay twice. The system cannot prove this either way (Phase A). The control is
procedural, made mandatory in the workflow:
- a `TO_CUSTOMER_WALLET` discharge must attach the digest of an FR.12A.8b evidence report covering
  that customer's orders;
- the proposer and the approver must each confirm *"no replacement order of this customer
  compensated this amount"*.

---

## 3. Finance decisions required before implementation

| # | Decision |
|---|---|
| **P1** | Adopt a written historical-liability policy, and allow this outcome to release G5 (answers FR.12A.7 D5) |
| **L1** | Held component = the full collected amount (recommended), or another rule with stated grounds |
| **L2** | Whether to recognize an assumed shortfall at all, its amount (0–100.00) and the rationale (FR.12A.7 D3) |
| **L3** | The reporting line wording and placement; delivery-date disclosure (FR.12A.7 D7) |
| **L4** | Allowed discharge kinds; the ledger type for `TO_CUSTOMER_WALLET` (`ADJUSTMENT` vs `ORDER_CREDIT` without an order, FR.12A.7 D6); how a company-funded shortfall discharge is booked |
| **L5** | The evidence standards for identifying a beneficiary (D1) and for `SUPERSEDED_BY_ORDER` / `EXTERNAL_PAYMENT` |
| **L6** | Confirmation that the owner's report is **not** treated as evidence of payment |
| **L7** | Review cadence for outstanding liabilities, and the unclaimed-funds / write-off policy (legal review; out of scope for V1) |
| **D8** | Four-eyes on execution: who records the liability and executes discharges |
| **D10** | Activation stays blocked until G5 releases under §5 (no override) |

---

## 4. Schema proposal (additive, not applied)

It builds on FR.12A.9's planned tables (`historical_ownership_resolutions`, `_evidence`,
`_acknowledgments`, `_decisions`), with FR.12A.3 conventions:
- CHECK-computed digests;
- `ON UPDATE RESTRICT` digest-binding FKs;
- independence enforced by CHECK;
- supersession chains;
- an Admin revoker who is neither the proposer nor the approver, enforced in the database.

1. **`HistoricalOwnershipOutcome`** gains `COMPANY_ASSUMED_LIABILITY`. Resolution CHECKs for this
   outcome:
   - `customer_id IS NULL`;
   - wallet and fee amounts are 0;
   - `held_collection_amount` and `assumed_shortfall_amount` are set within their bounds;
   - `policy_version_id` is NOT NULL.
2. **`historical_accounting_policies`** (append-only versions):
   - `document_sha256`, `summary`, `rules` jsonb (for example `heldMustEqualCollected`,
     `maxAssumedShortfall: "difference"`, `allowedDischargeKinds`);
   - `proposed_by_id`, `created_at`, plus a decisions table: APPROVED / REJECTED by FINANCE ≠
     proposer; REVOKED by an independent ADMIN.

   The server reads the rules; nothing is hardcoded per incident.
3. **`historical_liabilities`**: one row per approved resolution (`resolution_id` UNIQUE):
   - `approval_decision_id`, `policy_version_id`, `held_collection_amount`,
     `assumed_shortfall_amount`;
   - `recognized_amount` (CHECK = the sum, > 0), `recorded_by_id`, `idempotency_key` UNIQUE
     (`historical-liability:<resolutionId>:recognition`), `created_at`.
4. **`historical_liability_discharges`**:
   - `liability_id`, `sequence` (UNIQUE with the liability), `kind`, `amount > 0`;
   - `outstanding_before`, `outstanding_after` (CHECK after = before − amount, ≥ 0;
     sequence 1 ⇒ before = recognized, enforced by validity SQL + the lock);
   - `customer_id`, `wallet_transaction_id` UNIQUE NULL, `order_id` UNIQUE NULL (kind CHECKs);
   - `evidence_digest`, `proposed_by_id`, `approved_by_id` (CHECK ≠ proposer), `executed_by_id`;
   - `idempotency_key` UNIQUE, `created_at`;
   - plus a discharge-decisions table (APPROVED / REJECTED / REVOKED-before-execution).
5. **`historical_liability_discharge_reversals`**: a correction that never deletes. It holds the
   discharge FK UNIQUE, the reversal wallet tx FK UNIQUE, the reason and the actor, and uses the
   existing `reversal:wallet:<id>` primitive. It is refused if the wallet cannot be debited
   (never a negative wallet).

SQL and Prisma stay synchronized. The migration is additive and nullable-safe, and it must not
touch existing rows. Isolated databases only until approved.

---

## 5. G5 acceptance logic and invariants

### 5.1 Change (general, never incident-specific)

`unresolvedHistoricalOwnershipSql` (shared by G5 and `fr-production-preflight.mjs`) excludes a
reference `O` only when `released(O)` holds. Both of its sources (the surviving audit, and the
reconciliation rows still pinned `UNRESOLVED`) go through that one predicate.
`dchr_ownership_unresolved_chk` is unchanged: ownership at reconciliation time stays a historical
fact.

`released(O)` ⇔ exactly one head resolution `H` for `O` satisfies FR.12A.7 **H1** (approved,
audit-corroborated, not revoked) and **H2** (evidence valid now, `O` still absent, amounts match
the audit, digest matches), **and** one of:
- **ALLOCATION:** FR.12A.7 H3–H5 (posted, unreversed, wallet reconciled);
- **EXTERNALLY_SETTLED:** FR.12A.7 H6, only if D9 is approved;
- **COMPANY_ASSUMED_LIABILITY (H7):**
  - **H7a** the policy version is APPROVED, not revoked, and its approval predates the resolution
    approval;
  - **H7b** the resolution satisfies the policy's rules, re-evaluated now (for example, held =
    collected);
  - **H7c** exactly one `historical_liabilities` row exists for `H`, with components equal to the
    approved resolution and recognized at or after approval;
  - **H7d** the discharge chain is intact: sequences are contiguous, the first `before` equals
    `recognized`, and each `after` equals the next `before`;
  - **H7e** every executed discharge has an independent approval, and its linked wallet row exists
    with the key, amount and customer, unreversed (or its reversal is recorded);
  - **H7f** there are no `historical-liability:<id>:…` ledger rows without a record, and no
    `delivery:<O>:…` rows;
  - **H7g** any ledger reconciliation linked to `O` is still valid (G3 / R1 unchanged).

**An outstanding balance > 0 does not block G5.** The obligation is recognized, visible and
controlled. G5 reports it as resolved by liability, with the outstanding amount shown.

**G5 keeps blocking** for:
- an acknowledgment or "exception" without a recorded liability;
- approved-but-unrecorded;
- a revoked or unapproved policy;
- a policy-rule violation;
- a broken chain;
- an unlinked ledger row;
- a reversed recognition;
- a restored order;
- an invalid reconciliation.

### 5.2 Readiness reporting

The readiness report adds a `historicalDispositions` section (resolution id, outcome, recognized,
outstanding, policy version). The G5 detail line states how many references are released as
liabilities, and the outstanding total. The section is separate from pass/fail, so a liability is
never hidden inside "passed".

### 5.3 New invariant

**R14 — Historical liability register integrity** (INVARIANT, so it feeds G6):
- H7c–H7f for every liability;
- outstanding ≥ 0;
- no discharge without an approval.

**H1** (order-less `ORDER_CREDIT` / revenue rows) excludes rows linked to a valid discharge and
lists them in an informational check, as FR.12A.7 §7 (principle 5) does for postings.

---

## 6. Backend APIs, permissions, audit, idempotency

All endpoints are under `/api/v1/finance/historical-ownership`:
- gated by `requireRole` on the DB-reloaded actor (FR.12A.5 pattern, not permissions);
- writes are behind `HISTORICAL_OWNERSHIP_RESOLUTION_ENABLED` (unset by default, separate from the
  reconciliation flag) and need an `Idempotency-Key` header.

| Endpoint | Role | Effect |
|---|---|---|
| `POST /policies`, `…/:id/approve`, `/reject`, `/revoke` | propose: ADMIN; approve / reject: FINANCE ≠ proposer; revoke: independent ADMIN | policy versions |
| `POST /resolutions` (outcome `COMPANY_ASSUMED_LIABILITY`) + evidence / acknowledgments | ADMIN | immutable proposal; amounts and facts derived from the audit server-side |
| `POST /resolutions/:id/approve` / `reject` | FINANCE ≠ proposer; confirms the digest | decision only |
| `POST /resolutions/:id/record-liability` | FINANCE (D8: ≠ approver if four-eyes) | the register row, in one transaction |
| `POST /resolutions/:id/revoke` | independent ADMIN | allowed only while no discharge exists. The liability then counts as revoked; G5 re-blocks |
| `POST /liabilities/:id/discharges`, `…/approve`, `…/execute`, `…/reverse` | propose: FINANCE / ADMIN; approve: FINANCE ≠ proposer; execute: FINANCE | discharges |
| `GET` lists / details / readiness explanation | ADMIN, FINANCE | read |

- **Locks** follow the global order:
  - advisory key on `deleted_order_reference` (resolution) or liability id (discharge) →
    activation row `FOR SHARE` → customer wallet `FOR NO KEY UPDATE` (wallet discharges only) →
    the liability row `FOR NO KEY UPDATE` → inserts.
  - Recognition touches no ledger.
- **Audit** (same transaction): `HISTORICAL_LIABILITY_POLICY_*`, `HISTORICAL_OWNERSHIP_*`,
  `HISTORICAL_LIABILITY_RECORDED`, `HISTORICAL_LIABILITY_DISCHARGE_*`. Content: ids, amounts and
  digests only; never document content or personal data. Validity requires the audit (FR.12A.5
  corroboration).
- **Idempotency:** actor-scoped request keys; deterministic ledger keys
  (`historical-liability:<id>:recognition`, `…:discharge:<seq>`); a replay returns the original
  result; a P2002 on a ledger key rolls the transaction back.

---

## 7. Management UI

The Ledger Reconciliation page (`/management/finance/historical-reconciliation`) gains an
**Ownership** tab (ADMIN / FINANCE):
- policy versions;
- the resolution workflow with a digest-confirmation dialog;
- *Record liability* with an explicit confirmation stating that no customer or revenue is created;
- the liability register with outstanding balance and discharges.

Also:
- the finance summary gets the separate liability line (§2.3);
- the settings Financial Release tab shows `historicalDispositions`.

The UI is UX only; the server re-checks everything.

---

## 8. Test plan (targeted per sub-phase; full regression only at the end)

1. **Proposal:**
   - the components are bounded by the audit;
   - the policy rule held = collected is enforced;
   - a customer, wallet or fee amount on this outcome → refused;
   - client-supplied facts → rejected;
   - an existing order → refused.
2. **Independence:**
   - approver ≠ proposer, in the database and the service;
   - revoker ≠ proposer and ≠ approver;
   - an Admin cannot approve;
   - four-eyes on recording (D8).
3. **Policy:** an unapproved, revoked or later-approved policy → recording refused and G5 blocks;
   no incident id or amount literal in the activation code (static test).
4. **Acknowledgment / exception only → G5 FAIL.** Approved but not recorded → FAIL. Recorded →
   PASS with outstanding shown; G2, G3, G4 and G6 unchanged; financial snapshots unchanged (no
   wallet, revenue or driver-cash rows).
5. **Discharge, duplicate payout:**
   - two concurrent discharges whose sum exceeds the outstanding balance → exactly one succeeds;
   - a replay of the same key → one row;
   - discharging after full discharge → refused;
   - the same replacement order linked to two liabilities → refused (unique);
   - `TO_CUSTOMER_WALLET` then `SUPERSEDED_BY_ORDER` for the remaining zero → refused.
6. **Wallet discharge:**
   - the wallet increases by exactly the amount;
   - `order_id` NULL with the namespaced key;
   - driver cash and revenue unchanged;
   - a payout afterwards works;
   - reversal after payout → refused, nothing changes.
7. **Supersession by ALLOCATION** is allowed only before any discharge; afterwards it is refused.
8. **Tampering re-blocks G5 / fails R14:**
   - a deleted or edited register row;
   - a broken chain;
   - an unlinked `historical-liability:` row;
   - a `delivery:<O>:` row;
   - a restored order;
   - a revoked policy;
   - an invalidated ledger reconciliation.
9. **V5 stays clean and G3 / R1 are unchanged** after every operation.
10. **Concurrency:**
    - recording vs revocation;
    - a discharge vs a revocation of the resolution;
    - a discharge vs a payout on the same wallet;
    - recording vs activation (the activation row lock).
11. **Privacy:** no personal data in the new tables or audits.

---

## 9. Production migration, verification, rollback

1. Finance approves P1, L1–L7, D8 and D10 in writing; the policy document is hashed.
2. Implement FR.12A.9–11 plus this extension, with the flag off; run targeted tests and then the
   full regression in an isolated database.
3. Rehearse on a restored copy of a current production backup:
   - policy → resolution → approval → record;
   - verify G5 PASS with outstanding shown, the other gates unchanged, and identical financial
     snapshots.
4. Deploy (additive migration, flag unset), then run the read-only preflight.
5. In an authorized window:
   - set the flag;
   - record the policy, resolution, approval and liability;
   - verify;
   - unset the flag.

   Activation stays a separate decision under the FR.11 runbook.

**Rollback:**
- before recording: reject or revoke (no effect);
- after recording, before any discharge: revoke. G5 re-blocks; no ledger rows exist to reverse;
- after a wallet discharge: discharge reversal (refused if the funds were paid out; Finance
  procedure outside the system);
- the schema is never rolled back; code rollback is safe while the flag is unset;
- the deleted order is never recreated.

---

## 10. Sub-phases and GO / NO-GO

The smallest path is:
- **FR.12A.9** schema (resolutions, evidence, decisions, policies, liabilities, discharges);
- **FR.12A.10** `released(O)`, G5 / R14 / H1 changes and readiness disposition reporting;
- **FR.12A.11** policy, resolution and record-liability workflow;
- **FR.12A.13** UI.

Discharges (`TO_CUSTOMER_WALLET`, reversal) can follow later as their own sub-phase, because
recognition alone is enough for G5 and nothing needs paying until a beneficiary appears. The
ALLOCATION posting (FR.12A.12) is not required for this outcome.

| Item | Verdict |
|---|---|
| This design, for review | **GO** |
| Implementation | **NO-GO** until Finance approves P1, L1–L7, D8, D10 and this design passes review |
| Any posting, recognition or flag change in production | **NO-GO** (separately authorized window) |
| Financial Release activation | **NO-GO** until the disposition and the G5 criteria are approved, implemented, rehearsed and G5 passes on production data |

---

## 11. Approved policy direction (decision record)

Finance has given **business approval** to proceed with the company-assumed historical liability
approach. This authorizes local implementation and testing. It does **not** authorize production
activation, any production write, or any financial posting.

| # | Approved direction | Where it is enforced |
|---|---|---|
| **P1** | A historical company-assumed liability is a permitted resolution outcome. | outcome `COMPANY_ASSUMED_LIABILITY`; versioned `historical_liability_policies` approved by Finance |
| **L1** | The full verified collected amount is recognized as a liability, not revenue. | DB CHECK `hor_l1_full_collection_held_chk` (held = collected), `hl_recognized_equals_held_chk`; the collected amount must be verified by an approved, valid ledger reconciliation (`COLLECTION_NOT_VERIFIED`) that establishes its handover in a historical settlement (`SETTLEMENT_INCLUSION_NOT_ESTABLISHED`) — see §13 |
| **L2** | The shortfall stays separately tracked; no automatic loss posting. | DB CHECK `hor_l2_shortfall_tracked_chk` (tracked = max(expected − collected, 0)); never part of the recognized amount; nothing is posted |
| **L3** | Historical liabilities are reported separately from customer wallets and company revenue. | finance summary `historicalLiabilities`; Ownership tab; readiness `historicalDispositions` |
| **L4–L5** | Discharges require supported evidence, authorized methods and independent approval. | **Not implemented** — see §12 (decision required) |
| **L6** | An owner's statement alone is not proof of external payment. | No "externally settled" outcome is implemented; a recorded liability means money may still be owed |
| **L7** | Periodic Finance review and configurable unclaimed-funds handling; no invented legal expiry. | per policy version: `review_interval_days`, `unclaimed_funds_handling`, `unclaimed_review_after_days` (all optional or descriptive; no expiry, no automatic action); append-only `historical_liability_reviews` |
| **D8** | Separation of duties. | ADMIN proposes; FINANCE ≠ proposer approves; FINANCE ≠ proposer ≠ approver records; ADMIN ≠ proposer ≠ approver ≠ recorder revokes. **Database-enforced:** approver ≠ proposer (`hord_independent_reviewer_chk`), revoker ≠ proposer and ≠ approver (`hord_independent_revoker_chk`), recorder ≠ proposer and ≠ approver (`hl_independent_recorder_chk`). **Service-enforced, database-detected:** revoker ≠ recorder (workflow service; a violation is reported by R14 — §13) |
| **D10** | No unconditional G5 override. | G5 releases a deleted order only through `ho_released` (§5); there is no override flag or endpoint |

**Approver identity and approval date: not recorded here.** This repository does not know who
approved the direction or when, and none is invented. The authoritative record is created by the
system when the Finance policy document is entered as a policy version and approved:
- the approving Finance user and timestamp are stored in `historical_liability_policy_decisions`
  with a same-transaction `HISTORICAL_LIABILITY_POLICY_APPROVED` audit;
- the signed document's SHA-256 and storage reference are stored on the policy version.

Fill in for the change record (outside the repository if preferred):

| Field | Value |
|---|---|
| Approving person (name, role) | _to be completed by Finance_ |
| Approval date | _to be completed by Finance_ |
| Policy document SHA-256 | _to be completed when the document is signed_ |

---

## 12. Implementation record (FR.12A.9–11, local only)

Status: **implemented and tested locally on isolated databases. Not committed, not deployed, not
migrated in production, not applied to `LI-2026-0001`.** The write flag
`HISTORICAL_OWNERSHIP_RESOLUTION_ENABLED` is unset by default.

**Migration** `20261026000000_historical_ownership_liability_foundation` (additive, idempotent):
- 3 enums;
- 7 tables: policies, policy decisions, resolutions, resolution evidence, resolution decisions,
  liabilities, liability reviews.

No existing row is touched. `driver_cash_historical_reconciliations` and
`dchr_ownership_unresolved_chk` are unchanged.

**Deviations from §4 (and why):**
- **No discharge table and no discharge workflow.** L4 leaves the ledger type of a wallet discharge
  undecided (`ADJUSTMENT` vs `ORDER_CREDIT` without an order), and how a company-funded shortfall
  discharge is booked. Building a posting path would invent an accounting rule (CLAUDE.md §62).
  Outstanding therefore always equals recognized until a discharge design is approved.
- **No assumed-shortfall component.** L2 says the shortfall is tracked separately with no loss
  posting. It is carried as `tracked_shortfall_amount` and never recognized.
- **The proposer enters no amounts.** Both components are derived from the surviving audit (L1 / L2).
- **Revocation after recording needs no reversal**, because recording posts nothing. The register
  row stays as append-only history; its state becomes `REVOKED`, G5 blocks again, and it leaves the
  outstanding total.

**Decision required before any discharge can be built:**
1. The wallet ledger type for crediting an identified beneficiary.
2. Whether an `EXTERNAL_PAYMENT` / `SUPERSEDED_BY_ORDER` closure is allowed, and its evidence
   standard.
3. How a company-funded shortfall is booked, if Finance ever decides to recognize one.
4. Whether a discharged-to-zero liability keeps G5 released.

---

## 13. Code-review fixes (local, not committed)

**M2 — collection verification.** The surviving-collection-row route is removed (enum value,
column and FK dropped from the not-yet-applied migration). The only accepted verification is an
approved, currently valid ledger reconciliation of the deleted order that **also establishes the
handover in a historical settlement**:
- the reconciliation's anchor (the first surviving row after the gap) is the SETTLEMENT cash row
  of its related settlement;
- that settlement handed over the whole balance (`balance_after = 0`, amount = amount received);
- the amount received is at least the collected amount.

Otherwise the validity failure is `SETTLEMENT_INCLUSION_NOT_ESTABLISHED`, and the resolution can be
neither approved nor recorded, and never releases G5.

**Limitation (deliberate, no weaker fallback):** a deleted collection followed by other ledger rows
before its settlement, or settled only partially, cannot be resolved by this outcome. That needs a
separately approved evidence rule. Before recording for `LI-2026-0001`, confirm read-only in
production that the approved reconciliation's anchor is the 572.00 settlement's cash row with
`balance_after = 0` (FR.12A.8b E5S shows the jump row and its settlement).

**L2 — revoker ≠ recorder.**
- The rule is enforced by the workflow service.
- A database constraint is not feasible without a trigger. The recorder lives in another table and
  may not exist yet at revocation time, and the project uses no triggers.
- Instead it is detected: R14 reports any revocation decided by the liability's recorder
  (`REVOKED_BY_RECORDER_SQL`), which blocks G6.
- A revocation can only re-block G5; it never releases anything.

**L5 — policy revocation.** Revoking a policy version invalidates every resolution citing it
(`POLICY_NOT_APPROVED`):
- recorded liabilities no longer release G5;
- approved resolutions, recorded or not, become R14 findings, so G6 blocks too;
- outstanding liabilities stay in the outstanding total and are counted as invalid until each one is
  revoked by an independent Admin, or re-proposed under a newly approved policy version.

This is intended: a liability must always rest on a currently approved policy.

**L3 / L4 — UI.**
- The ledger view labels its own field "Ledger record: ownership unresolved", which is permanent by
  design.
- A separate "Liability resolution" badge shows whether G5 treats the deleted order as resolved by a
  recorded liability.
- The Ownership tab makes no ledger-list requests and has a card layout below the desktop breakpoint.

