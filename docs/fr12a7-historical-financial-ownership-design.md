# FR.12A.7 — Historical Financial Ownership Resolution: Design

Status: **DESIGN ONLY — not implemented, not approved.** No code, schema, migration, posting,
gate or data was changed.

Production facts are the operator-reported results of the FR.12A.1 investigation queries
(`docs/g3-driver-cash-discrepancy-investigation.md`); this phase did not access production.

Related documents:
- `docs/fr12a2-historical-ledger-reconciliation-design.md` (the ledger reconciliation)
- `docs/fr12a3-historical-reconciliation-foundation.md` to `docs/fr12a6-historical-reconciliation-ui.md`
- `docs/requirements.md` §10, §21, §42 / CLAUDE.md §12, §21, §62
- `docs/settlement-financial-release-contract.md` §11

---

## 1. Executive summary

A DELIVERY_ONLY order was delivered with an expected collection of 210.00 and an actual collection
of 110.00, a difference of −100.00. It was deleted directly in PostgreSQL before Finance resolved
that difference. The 110.00 was handed to the company in a surviving 572.00 settlement.

The company therefore holds 110.00 that is recorded as **neither** a customer liability **nor**
revenue. The FR.12A.3–6 ledger reconciliation explains the missing driver-cash row. It does not,
and must not, decide who owns the money. Gate G5 blocks activation until that is decided.

Technical conclusions:
1. **No rule decides the split.** For a normal order, the split of a shortfall is not computed:
   Finance supplies it explicitly (CLAUDE.md §21 / §62). The code only requires that it sums to the
   actual collection and contains no product revenue for DELIVERY_ONLY. The deleted order is
   therefore resolvable with **equivalent business rules** (an explicit, independently approved
   Finance decision) **without recreating the order**, but only if the inputs Finance needs exist.
2. **The surviving system records cannot supply those inputs.** The audit holds no customer, no
   delivery fee, no order amount, no payment type and no order number. A wallet credit is impossible
   without the customer, and a fee/goods split is impossible without the fee. Documentary evidence is
   **mandatory**; the system must never infer either.
3. **Ownership needs its own append-only record.** The proposed model is evidence → proposal →
   independent Finance approval → separately executed posting, with its own key namespace. It must
   **not** reuse the deleted order's `delivery:<orderId>:…` keys or write a
   `COLLECTION_DIFFERENCE_RESOLVED` audit: either would invalidate the approved ledger
   reconciliation (FR.12A.4 V5 `DIFFERENCE_RESOLUTION_FOUND`) and re-block G3.
4. **G5 releases only on a completed, still-valid, fully reconciled posting.** Approval alone, a
   ledger reconciliation, or a partial or reversed posting never releases it.

Accounting conclusions are **not** made here. Who bears the 100.00 shortfall, the split, the
customer's identity and the treatment of an unidentifiable customer are Finance decisions (§14).

---

## 2. Current implementation findings

### 2.1 Order money (normal orders)

From `orders/order-financial.service.ts`:

```
remainingOrderAmount = orderAmount − prepaidOrderAmount
remainingDeliveryFee = deliveryFee − prepaidDeliveryFee
amountToCollect      = remainingOrderAmount + remainingDeliveryFee

DELIVERY_ONLY ownership:
  customerWalletAmountDue = remainingOrderAmount   (customer money)
  companyDeliveryFeeDue   = remainingDeliveryFee   (company revenue)
  companyOrderAmountDue   = 0                      (never product revenue)
```

The delivery fee is entered per order; there is no automatic area pricing (V1 deferral). So the
fee of a deleted order is not derivable from any rule or table.

### 2.2 Delivery with a difference

Path: legacy / IMMEDIATE, driver-cash route (`driver-orders/driver-order.service.ts`).
- **Posted:** a driver cash `COLLECTION` of the **actual** amount (key
  `delivery:<orderId>:driver-collection`). The order becomes `DELIVERED`, `REVIEW_REQUIRED`,
  `needs_financial_review = true`.
- **Audited:** `COLLECTION_DIFFERENCE_RECORDED`, with metadata `orderType`, `expectedAmount`,
  `actualAmount`, `difference` (= actual − expected), the free-text `collectionDifferenceReason`,
  `driverCashTransactionId`, `collectionRoute`, `directCompanyCollectionId`, and payment-method
  change ids.
- **Not posted:** no wallet or company row. Physical custody is recorded; ownership is not.

### 2.3 Resolution

`POST /orders/:id/resolve-collection-difference` (`finance.adjust`, `order.service.ts`):
- **Input:** `customerWalletCredit`, `companyProductRevenue`, `companyDeliveryFeeRevenue`,
  `resolutionNotes`.
- **Validation:**
  - the order must be `DELIVERED` + `REVIEW_REQUIRED`;
  - the sum must equal `actual_amount_collected` exactly;
  - DELIVERY_ONLY ⇒ product revenue = 0; COMPANY_ORDER ⇒ wallet = 0.
  - There is **no** bound tying the wallet credit to `remainingOrderAmount` or the fee to
    `remainingDeliveryFee`. The split is a Finance judgment.
- **Posting (one transaction):**
  - a conditional claim on the order;
  - wallet `ORDER_CREDIT` (key `delivery:<id>:wallet-order-credit`);
  - `DELIVERY_FEE_REVENUE` (key `delivery:<id>:delivery-fee-revenue`);
  - a `COLLECTION_DIFFERENCE_RESOLVED` audit;
  - `FINALIZED`.

  Driver cash is never touched.
- **Settlement-based orders** record the split on the release and post on full settlement
  (contract §5.4). Not relevant here: the incident order is legacy.

### 2.4 Ledgers and checks a historical resolution would interact with

| Mechanism | Relevance |
|---|---|
| `wallet_transactions` (`ORDER_CREDIT`, `ADJUSTMENT`, `REVERSAL`, `PAYOUT`), `order_id` nullable FK | the deleted order cannot be referenced (FK); a row would have `order_id = NULL` |
| `company_financial_transactions` (`DELIVERY_FEE_REVENUE`, `COMPANY_ORDER_PRODUCT_REVENUE`, `ADJUSTMENT`, `REVERSAL`) | `companyRevenue` sums every row; category figures (`deliveryFeeRevenue`) count only their own type and its reversals. A generic `ADJUSTMENT` has **no** category attribution |
| H1 (reconciliation, HISTORICAL) | flags `ORDER_CREDIT` / revenue rows **without an order**, so a historical posting would be reported as an anomaly unless linked and excluded |
| R7 / R8 | per-order duplicate / bucket checks key on `order_id`; NULL rows are invisible to them, so duplicate protection must come from the new model |
| I8 (investigation) | flags ledger keys `delivery:<id>:…` naming a missing order |
| FR.12A.4 V5 | a `COLLECTION_DIFFERENCE_RESOLVED` audit or a wallet/company row keyed `delivery:<deletedOrder>:…` invalidates the approved **ledger** reconciliation (G3 re-blocks) |
| G5 (FR.12A.4) | deleted order with an unresolved difference audit, **plus** every reconciliation with `ownership_status = UNRESOLVED` (any status). `dchr_ownership_unresolved_chk` pins that column to `UNRESOLVED` |
| Generic corrections | wallet / driver-cash / company adjustments and reversals (`finance.adjust`); release-linked rows are refused (FR.6) |
| Locking / idempotency | advisory key → activation row (SHARE) → driver cash account → … → wallets (by customer); `Idempotency-Key` header derived per actor |
| Audit | same-transaction `audit_logs`; FR.12A.5 adds audit corroboration of approvals |

### 2.5 No suspense ledger

SwiftDrop has **no** company cash or suspense ledger: company money is modeled only as revenue
rows. The 110.00 the company physically holds is today *implicitly* in suspense (held, not
booked). FR.12A.4 G5 and the read APIs made that state explicit. Introducing a posted suspense
account would be a new accounting concept not present in `requirements.md`.

---

## 3. Confirmed incident evidence

| Fact | Value | Source |
|---|---|---|
| Order type | DELIVERY_ONLY | surviving `COLLECTION_DIFFERENCE_RECORDED` audit (`orderType`) |
| Expected collection | 210.00 | audit `expectedAmount` |
| Actual collection | 110.00 | audit `actualAmount`; matches the +110.00 ledger gap |
| Difference | −100.00 | audit `difference` (= actual − expected) |
| Collection route | driver cash | audit `driverCashTransactionId` (row deleted) |
| Collection handed over | yes — included in the 572.00 settlement of 2026-10-16 | settlement and its cash row survive; balance chain |
| Driver cash now | 0.00 (true) | `current_balance`; FR.12A.2 |
| Difference resolved before deletion | **no** | no `COLLECTION_DIFFERENCE_RESOLVED` audit; no wallet/company rows for the order; G4 passes; no orphan revenue |
| Wallets / company records | reconcile | G4, I9, I10 |
| Deleted order row and details | unavailable | — |

---

## 4. Evidence matrix and gaps

| Item | Class | Notes |
|---|---|---|
| Order type, expected, actual, difference, deleted order UUID, missing cash row id, driver, settlement | **Verified** | surviving audit + ledger + settlement |
| `collectionDifferenceReason` (the driver's free-text explanation) | **Recoverable — must be read** by an authorized person in production | may explain the shortfall (receiver refused an item, partial payment, …). May contain personal data, so it must not be copied into new records |
| Payment method of the collection | Partially recoverable | audit route and method-change ids |
| Customer (sender) identity | **Not in system records** | no order-creation audit exists (order workflow actions do not write `audit_logs`). Candidates: a pre-deletion backup / PITR, printed order labels or delivery summaries, the customer's invoice / statement printouts, the customer's own records, correspondence. **Requires documentary evidence** |
| Order number / tracking code | Not in system records | possibly from labels / summaries, or order-number sequence gaps (weak; never sufficient alone) |
| `orderAmount`, `deliveryFee`, prepaid amounts, payment type | **Not determinable from surviving system records** | `expectedAmount = remainingOrderAmount + remainingDeliveryFee = 210.00` is known; its split is **not**. Requires a backup extract or documents |
| Why the receiver paid 110.00 | Unknown without the reason text / documents | decides who should bear the 100.00 |
| Whether the customer was already compensated outside the system | Unknown | requires Finance confirmation |
| Who bears the 100.00 shortfall | **Finance decision** | no system rule exists (§21) |
| Final split of the 110.00 | **Finance decision**, evidence-backed | — |

**Prohibited assumptions:**
- the customer is owed 110.00;
- the company is owed 110.00;
- the fee equals any "usual" fee;
- the split is proportional;
- the shortfall is the driver's obligation (the settlement matches its cash row);
- any order data reconstructed from memory without documents;
- recreating the order.

The surviving audit is **not** sufficient to determine the delivery fee or the intended customer
amount. Unless a pre-deletion backup (option A of FR.12A.2) is found, resolution requires
documentary evidence plus an explicit, independently approved Finance decision.

---

## 5. Normal DELIVERY_ONLY handling (counterfactual)

The same order, not deleted, expected 210.00, actual 110.00, legacy mode:

1. **Delivery:** driver cash `COLLECTION` +110.00; order `REVIEW_REQUIRED`;
   `COLLECTION_DIFFERENCE_RECORDED` audit. No wallet credit, no revenue. The customer's money
   shows as *Under Review*, not as pending or available.
2. **Settlement:** driver cash −110.00 (inside the 572.00 settlement). Customer wallet unchanged
   (§26 invariant).
3. **Resolution:** a Finance user decides `customerWalletCredit + companyDeliveryFeeRevenue = 110.00`
   (product revenue 0), with notes:
   - posted: one `ORDER_CREDIT` and one `DELIVERY_FEE_REVENUE` with the order's keys;
   - order `FINALIZED`; `COLLECTION_DIFFERENCE_RESOLVED` audit.

Illustration only (the real split is unknown): if the order had been `orderAmount 200`,
`deliveryFee 10`, CASH_ON_DELIVERY, an exact delivery would have credited 200 and recognized 10.
With 110 collected, Finance might decide wallet 100 + fee 10 (customer bears the shortfall), or
wallet 110 + fee 0 (fee waived), or another evidence-based split. The **system never picks**.

**Can the incident follow equivalent rules without recreating the order?** Yes, technically:
- the same decision (an explicit split summing to the actual amount, DELIVERY_ONLY bucket rules);
- the same ledger primitives;
- an independent approval;
- an order-less, explicitly linked posting.

Only if the customer and the fee/goods split are established by evidence.

---

## 6. Accounting treatments compared

| | A. Customer wallet credit (all 110.00) | B. Company revenue (all 110.00) | C. Split (wallet X + fee Y = 110.00) | D. Remain unallocated (explicit suspense, no posting) | E. Externally settled (no in-system posting) |
|---|---|---|---|---|---|
| Justification | the receiver's 110.00 was entirely goods value and the company waives its fee | the company is entitled to the whole amount | mirrors normal resolution: goods value to the customer, fee to the company, shortfall borne as Finance decides | evidence insufficient; nothing may be guessed | the customer was already compensated outside the system |
| Preconditions | customer identified; evidence that the fee is waived / not collectable | evidence that fee ≥ 110.00, or a separate Finance policy for "other income". **Goods value of a DELIVERY_ONLY order is never company product revenue** (§12, R8) | customer identified; fee and goods value evidenced; documented shortfall decision | none | documentary proof of the external settlement |
| Evidence | backup extract / invoice / correspondence | invoice proving the fee, or an approved policy | as A, plus the fee | the investigation record | receipts / signed acknowledgment |
| Customer balance | +110.00 available (withdrawable) | 0 | +X | 0 | 0 |
| Company revenue | 0 | +110.00 (fee category only if it really is fee) | +Y delivery-fee revenue | 0 | 0 |
| Driver cash | unchanged | unchanged | unchanged | unchanged | unchanged |
| Audit | resolution, evidence, approval, posting | same | same | incident remains open | resolution with evidence of external settlement |
| Reversal | wallet REVERSAL (blocked if paid out → Finance procedure) | company REVERSAL | both | n/a | revoke the decision |
| Duplicate risk | one posting per resolution / deleted order (unique keys) | same | same | none | none (but G5 risk: a non-posting release) |
| Reports | ORDER_CREDIT without order (H1 unless linked); appears in the posting period | revenue in the posting period; delivery-date basis cannot attribute it | both | disclosure line "historical unallocated cash 110.00" | disclosure |
| G5 | released once posted and valid | same | same | **stays blocking** | release only if Finance explicitly approves this outcome type (D9) |
| Assessment | plausible only with evidence | **weakest**: lacks a basis unless fee = 110 | **preferred when evidence exists** | **mandatory interim state**; possibly the long-term state if the customer cannot be identified | exceptional; needs a policy decision |

- **F. Driver obligation:** rejected. The driver handed over exactly what was collected (the
  settlement matches its cash row), so no obligation exists.
- **G. Restore the order:** only from an **authentic** backup (FR.12A.2 option A). That is never
  reconstruction: it would make the normal resolution endpoint usable and remove the need for this
  model.

**Recommendation (technical):** support C (with A and B as its edge cases X = 110 / Y = 110) through
one evidence-bound allocation model. D is the default state, and E only if Finance authorizes it.
Do not choose an allocation from the fact that 110.00 was collected.

---

## 7. Recommended architecture

A new aggregate, separate from the ledger reconciliation, keyed by the **deleted order reference**
and linked to the incident (and to the ledger reconciliation as evidence when one exists):

```
financial_ledger_incidents ─┬─< driver_cash_historical_reconciliations   (ledger: G3 / R1)
                            └─< historical_ownership_resolutions          (ownership: G5)
                                   ├─< historical_ownership_evidence      (append-only documents)
                                   ├─< historical_ownership_acknowledgments (operator / Finance)
                                   ├─< historical_ownership_decisions     (append-only lifecycle)
                                   └─< historical_ownership_postings      (one per ledger row posted)
```

Principles:
1. **Evidence first.** A proposal must cite at least one evidence document (hash-bound), the
   surviving `COLLECTION_DIFFERENCE_RECORDED` audit, and an identified customer whenever any wallet
   amount is proposed.
2. **Server-derived invariants.** The collected amount, order type and deleted order come from the
   audit, exactly as in FR.12A.5. The allocation must sum exactly to the collected amount;
   DELIVERY_ONLY ⇒ no product revenue.
3. **Decision ≠ posting.** `APPROVED` records the accounting decision. Posting is a separate,
   idempotent operation that creates the ledger rows **and** the posting records in one transaction.
   An approved-but-unposted resolution keeps G5 blocking.
4. **Own namespace.** Keys are `historical-ownership:<resolutionId>:wallet-credit` and
   `…:delivery-fee-revenue`. No `delivery:<deletedOrder>:…` key and no
   `COLLECTION_DIFFERENCE_RESOLVED` audit, so the ledger reconciliation stays valid (V5) and I8 stays
   clean.
5. **Explicit linkage.** Each ledger row is referenced by exactly one posting record (unique FK).
   H1 excludes rows linked to a **valid completed** ownership posting and reports them in a separate
   informational check instead.
6. **Append-only, digest-bound.** This reuses the FR.12A.3 pattern:
   - an immutable proposal with a CHECK-computed digest;
   - decisions pinned by an `ON UPDATE RESTRICT` composite FK;
   - independence enforced by CHECK;
   - supersession for re-proposal;
   - audit corroboration.

---

## 8. Proposed data model (not applied)

### Enums
- `HistoricalOwnershipOutcome = ALLOCATION | EXTERNALLY_SETTLED` (the second only if D9 is approved)
- `HistoricalOwnershipDecisionType = APPROVED | REJECTED | WITHDRAWN | REVOKED`
- `HistoricalOwnershipEvidenceKind = BACKUP_EXTRACT | ORDER_DOCUMENT | CUSTOMER_STATEMENT | CORRESPONDENCE | FINANCE_MEMO | OTHER`
- `HistoricalOwnershipPostingKind = WALLET_CREDIT | DELIVERY_FEE_REVENUE`

### `historical_ownership_resolutions` (immutable proposal)

| Column | Rule |
|---|---|
| `id`, `incident_id` FK, `ledger_reconciliation_id` FK nullable | — |
| `deleted_order_reference` uuid | from the audit; CHECK no `orders` row (service + validity) |
| `source_audit_log_id` FK RESTRICT | the `COLLECTION_DIFFERENCE_RECORDED` audit |
| `order_type`, `expected_amount`, `collected_amount`, `collection_difference` | snapshot from the audit; CHECK `difference = collected − expected` |
| `outcome` | enum |
| `customer_id` FK nullable | CHECK `customer_wallet_amount > 0 ⇒ customer_id NOT NULL` |
| `customer_wallet_amount`, `delivery_fee_revenue_amount` | NUMERIC(14,2) ≥ 0. ALLOCATION: CHECK sum = `collected_amount`. EXTERNALLY_SETTLED: both 0 |
| `shortfall_bearer` | enum `CUSTOMER / COMPANY / SHARED / NOT_APPLICABLE`, Finance's stated rationale (no arithmetic) |
| `rationale` | ≥ 50 characters; no personal data |
| `evidence_digest` | CHECK-computed over the fields above and the sorted evidence hashes |
| `proposed_by_id`, `idempotency_key` unique, `supersedes_*` (FR.12A.3 chain), `created_at` | — |

Uniqueness: one chain root per `deleted_order_reference` (partial unique), so at most one live
resolution per deleted order.

### `historical_ownership_evidence` (append-only, attached before the decision)
- `resolution_id`, `kind`, `description` (no personal data), `document_sha256` (CHAR(64)),
  `external_reference` (document-store path, not the document);
- `submitted_by_id`, `created_at`;
- documents are stored **outside** the database; only the hash and the reference.

### `historical_ownership_acknowledgments` (append-only)
`resolution_id`, `kind` (`OPERATOR_INCIDENT` — the person who performed or witnessed the deletion,
or the ops lead; `FINANCE_EVIDENCE_REVIEW`), `acknowledged_by_id`, `statement`, `created_at`.

### `historical_ownership_decisions` (append-only)
The FR.12A.3 decisions table:
- `APPROVED` / `REJECTED` by FINANCE ≠ proposer (CHECK);
- `WITHDRAWN` by ADMIN;
- `REVOKED` of the approval only, by ADMIN ≠ proposer **and ≠ approver**. Enforce this in the
  database this time, with an approver copy column and a CHECK;
- digest binding;
- the same-transaction audit is required for validity.

### `historical_ownership_postings` (one row per ledger row)
- `resolution_id`, `approval_decision_id` (FK to the APPROVED decision of the same resolution);
- `kind`, `amount`;
- `wallet_transaction_id` FK UNIQUE nullable / `company_transaction_id` FK UNIQUE nullable (exactly
  one, CHECK by kind);
- `idempotency_key` unique `historical-ownership:<resolutionId>:<kind>`;
- `posted_by_id`, `created_at`.

A posting **batch** is complete when the rows exist for every non-zero allocated kind. That is
checked, not stored. Reversal: `historical_ownership_posting_reversals` (posting FK unique, reversal
ledger row FK unique, reason, actor), using the existing `reversal:<ledger>:<id>` primitives.

Prisma and SQL are kept in sync, and the migration is additive only (FR.12A.3 conventions).

---

## 9. Approval and posting lifecycle

```
DRAFT evidence ─► PROPOSED ─► APPROVED ─► POSTED ─► (REVOKED + REVERSED)
                     │            │
                     ├─► REJECTED  └─► REVOKED (before posting: no ledger effect)
                     └─► WITHDRAWN
```

| Step | Who | Effect |
|---|---|---|
| Attach evidence | ADMIN or FINANCE | evidence rows (hash-bound) |
| Propose | ADMIN | immutable resolution. **No ledger effect.** G5 still blocks |
| Acknowledge | operator / Finance | acknowledgment rows |
| Approve | FINANCE ≠ proposer; confirms the digest (stale ⇒ re-review, FR.12A.6 rules) | accounting decision only. **G5 still blocks** |
| Post | FINANCE (D8: the approver, or a second Finance user), separate request | one transaction: lock the customer wallet → wallet credit (no `order_id`) + fee revenue (no `order_id`) + posting rows + audit. Idempotent replay |
| Revoke | ADMIN ≠ proposer, ≠ approver | before posting: the decision ends. After posting: requires reversal postings in the same transaction (wallet REVERSAL refused if the funds were paid out → Finance procedure; never a negative wallet) |
| Dispute / correction | — | revoke (+ reverse), then re-propose (supersession). History is preserved |

Concurrency follows the global lock order:
- advisory key → activation row (SHARE) → customer wallet (by customer_id) → inserts;
- posting holds the resolution chain lock (advisory on `deleted_order_reference`);
- partial unique indexes back up every "at most one" rule.

Transactions are bounded, and responses are built after commit.

---

## 10. G5 release criteria

The historical ownership blocker for a deleted order `O` is **released** only when exactly one
resolution `H` exists with all of the following:

1. **H1** H is the head of its chain. Its derived status is `APPROVED` (not rejected, withdrawn,
   revoked or invalid-history), with an approval audit matching the decision id, approver and digest.
2. **H2** The evidence is valid now: the source audit exists and matches; `O` is still absent; the
   collected amount equals the audit's actual amount; the digest matches; ≥ 1 evidence document; the
   required acknowledgments are present; the incident is linked.
3. **H3** `outcome = ALLOCATION`: postings exist for **every** non-zero allocated kind, and their
   amounts sum to `collected_amount`. Each linked ledger row:
   - exists, with the right type, amount and customer;
   - carries the namespaced key;
   - has `order_id IS NULL`;
   - has **no** reversal.
4. **H4** No other ledger row carries a `historical-ownership:<H>:…` key without a posting record,
   and no `delivery:<O>:…` row exists (no duplicate recognition).
5. **H5** The affected customer's wallet passes G4 / R13 (cached = ledger net).
6. **H6** `outcome = EXTERNALLY_SETTLED` (only if D9 is approved): H1–H2 plus a `FINANCE_MEMO` and
   an external-receipt evidence document. No postings.

G5 **keeps blocking** for:
- missing evidence or acknowledgments;
- PROPOSED / REJECTED / WITHDRAWN / REVOKED / INVALID_HISTORY;
- approved-but-unposted;
- missing, partial or reversed postings;
- amount mismatches;
- invalid evidence;
- unreconciled wallet or revenue.

An approved **ledger** reconciliation never releases G5.

Implementation: G5's `DELETED_ORDER` query becomes "unresolved unless `released(O)`", computed by one
shared SQL definition (the FR.12A.4 pattern). The reconciliation table's `ownership_status` stays an
immutable historical fact (`UNRESOLVED` at reconciliation time). The **effective** ownership shown
by the APIs and UI is derived from `released(O)`, so `dchr_ownership_unresolved_chk` needs no change.

---

## 11. Audit, authorization, idempotency

- **Roles** (by role, never permission, as in FR.12A.5):
  - propose and withdraw: ADMIN;
  - approve, reject and post: FINANCE (no Admin fallback; approver ≠ proposer);
  - revoke: an independent ADMIN.
- **Write flag:** `HISTORICAL_OWNERSHIP_RESOLUTION_ENABLED`, unset by default, separate from the
  ledger reconciliation flag.
- **Audit actions** (same transaction):
  - `HISTORICAL_OWNERSHIP_EVIDENCE_ATTACHED` / `_PROPOSED` / `_ACKNOWLEDGED` / `_APPROVED` /
    `_REJECTED` / `_WITHDRAWN` / `_REVOKED`;
  - `_POSTED` (the ledger row ids);
  - `_REVERSED`.
- **Audit content:** ids, amounts and digests only; never the document content or customer
  personal data.
- **Idempotency:**
  - an `Idempotency-Key` header per action (actor-scoped);
  - posting keys are deterministic per resolution and kind;
  - the posting replays on a duplicate key;
  - unique FKs from the posting rows to the ledger rows.
- **Residual threat:** direct production database write access (FR.12A.5 §4); restrict it.

---

## 12. Testing requirements

1. **Proposal:**
   - the allocation must sum exactly to the audit's actual amount;
   - product revenue > 0 for DELIVERY_ONLY → refused;
   - a wallet amount without a customer → refused;
   - no evidence document → refused;
   - an existing order → refused.
2. Server-derived amounts: client-supplied collected / expected values are rejected.
3. Independence: the approver ≠ proposer (database + service); the revoker ≠ proposer and ≠ approver
   (database + service); Admin cannot approve.
4. A stale digest at approval → refused, and re-review required.
5. Approval without posting: G5 still blocks; no ledger rows exist.
6. Posting:
   - exactly one wallet and one fee row;
   - `order_id` NULL;
   - namespaced keys;
   - the wallet balance increases by X, fee revenue by Y;
   - driver cash unchanged;
   - customer pending amounts unchanged.
7. Posting idempotency: a replay creates no duplicates; concurrent posts → exactly one.
8. Partial posting is impossible (a forced failure mid-transaction rolls back every row).
9. **G5 releases only when H1–H5 hold.** Each violation re-blocks it: a revoked decision, a
   reversed row, a deleted row, a changed amount, a wallet mismatch, a restored order, a missing
   audit.
10. **The ledger reconciliation stays valid after posting** (no V5 `DIFFERENCE_RESOLUTION_FOUND`),
    and G3 / R1 are unchanged.
11. **H1** no longer reports linked, valid postings; an informational check lists them; I8 stays
    clean.
12. Reports:
    - the released basis shows the posting in its posting period;
    - delivery-date reports exclude it, with a disclosure line;
    - `companyRevenue` and `deliveryFeeRevenue` change by exactly Y;
    - customer available changes by exactly X.
13. Revoke after posting: reversal rows, and the wallet reversal refused if paid out (nothing changes).
14. No customer personal data in the new tables or audits; evidence holds hashes only.
15. Full backend + frontend regression; isolated-database rehearsal of the production sequence.

---

## 13. Production remediation and rollback

**Order of operations**, each step separately authorized:

1. Obtain the evidence: read the audit's difference reason in production (authorized, read-only),
   look for a pre-deletion backup / PITR, and collect documents.
   - **If an authentic backup exists**, stop and re-evaluate FR.12A.2 option A: restoring the order
     makes the normal resolution endpoint usable, and the ledger reconciliation must then be
     revoked (its V4/V6 checks will fail anyway).
2. Finance decides D1–D9 in writing (§14).
3. Deploy the additive migration and code with the flag off, after the FR and FR.12A migrations
   (runbook §8.3 sequence).
4. Rehearse on a restored copy of a current production backup: propose → acknowledge → approve →
   post → verify H1–H5, the financial snapshots, G3 unchanged and G5 released.
5. Maintenance window:
   - set the flag;
   - record the evidence, proposal, acknowledgments and approval;
   - post;
   - verify;
   - remove the flag;
   - archive the incident record.

**Rollback:**
- before posting: revoke (no ledger effect);
- after posting: revoke + reversal postings. If the customer was already paid out, the wallet
  reversal is refused, and recovery follows Finance's procedure outside the system (never a
  negative wallet);
- the schema is never rolled back;
- the order is never recreated.

---

## 14. Outstanding Finance decisions (required before implementation)

| # | Decision |
|---|---|
| D1 | Identify the customer: which documents are acceptable; how many independent sources |
| D2 | The evidence standard for the fee / goods split (backup extract, invoice, label, correspondence); what is sufficient when sources disagree |
| D3 | **Who bears the 100.00 shortfall** (customer, company, or shared) and why, using the driver's recorded difference reason |
| D4 | The split policy when the fee is evidenced but the shortfall cause is not |
| D5 | **If the customer cannot be identified:** does it stay unallocated indefinitely (G5 keeps blocking activation), or is there an approved unclaimed-funds policy (time limit, legal review, ledger type)? |
| D6 | Ledger types: wallet `ORDER_CREDIT` (with `order_id` NULL) vs `ADJUSTMENT`; fee `DELIVERY_FEE_REVENUE` vs `ADJUSTMENT`. This affects customer statements and category reports |
| D7 | Reporting: posting period (released basis) and the disclosure wording for delivery-date reports |
| D8 | Who executes the posting: the approver, or a second Finance user (four-eyes on execution) |
| D9 | Whether an `EXTERNALLY_SETTLED` outcome may release G5, and its evidence standard |
| D10 | Confirm activation stays blocked until G5 releases (recommended: yes, no override) |

---

## 15. Proposed implementation sub-phases

Each sub-phase is its own session with a review gate. They replace the earlier FR.12A plan numbering
for the remaining work:

| Sub-phase | Scope |
|---|---|
| FR.12A.8 | Finance decisions D1–D10 recorded; evidence gathered (no code) |
| FR.12A.9 | Additive schema: resolutions, evidence, acknowledgments, decisions (with database revoker independence), postings, reversals; Prisma + migration; isolated databases |
| FR.12A.10 | Validity SQL (H1–H5) shared by G5 / the read APIs; the G5 change; H1 exclusion + informational check; tests |
| FR.12A.11 | Workflow endpoints (evidence, propose, acknowledge, approve, reject, withdraw, revoke) behind the flag; audit; idempotency; concurrency tests |
| FR.12A.12 | The posting operation + reversal; report disclosures; tests |
| FR.12A.13 | Management UI (evidence review, the approval acknowledgment, posting confirmation) |
| FR.12A.14 | Full regression, a rehearsal on a restored production backup, runbook update |
| FR.12A.15 | Production remediation window (separately authorized) |
