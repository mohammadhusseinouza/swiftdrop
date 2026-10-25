# Settlement-Based Financial Release — Technical Contract (v1)

Status: **FR.1 approved. FR.2 (database foundation) implemented** — §3 below describes the
schema exactly as built in `server/prisma/schema.prisma` and migration
`server/prisma/migrations/20261016000000_settlement_financial_release_foundation/migration.sql`.
No service, API or UI behavior exists yet (FR.3–FR.11). Implementation proceeds sub-phase by
sub-phase (`implementation_plan.md` §63) with a human review gate after each one.

Business rules: `requirements.md` §55. Mandatory implementation rules: `CLAUDE.md` §74 /
§75. Related existing feature: Direct Payment Settlement (`payment_methods.bypass_driver_cash`,
`requirements.md` §9.1, `CLAUDE.md` §75).

This contract distinguishes:

- **[EXISTING]** — behavior verified in the repository at FR.1 (commit `8b47fd9`).
- **[NEW]** — approved design, not yet implemented.

---

## 1. Purpose

For orders whose delivery-time collection enters **Driver Cash**, the customer wallet credit
and company revenue are no longer posted at delivery. They are **released** only when the
company has actually received that collection from the driver through settlement(s)
explicitly allocated to it, and after any collection-difference review is resolved.

Everything else keeps its existing behavior:

- Legacy orders (delivered before activation, or while activation is disabled) — immediate.
- Direct (bypass) payments — immediate (the company already holds the money).
- Zero-cash deliveries — immediate (there is nothing to settle).

---

## 2. Verified current behavior [EXISTING]

| Area | Behavior |
|---|---|
| Delivery | `deliverDriverOrder` (`driver-orders/driver-order.service.ts`), one transaction: order claim → attempt → status history → routing (Driver Cash COLLECTION / `company_direct_collections` / none) → wallet + company postings for exact deliveries; REVIEW_REQUIRED (no ownership postings) for differences → audit. |
| Difference resolution | `resolveCollectionDifference` (`orders/order.service.ts`) — Finance supplies an explicit split summing to `actual_amount_collected`; posts wallet/company rows; never touches Driver Cash. |
| Settlement | `createSettlement` (`settlements/settlement.service.ts`) — account-level only: advisory lock → `debitDriverSettlement` → `driver_settlements` row → link `settlement_id` → audit. No order/collection linkage. |
| Pending | `wallet.service.ts` — Σ `remaining_order_amount` of DELIVERY_ONLY orders in `ORDER_ACTIVE_STATUSES`. DELIVERED is excluded. |
| Corrections | Driver cash / wallet / company ADJUSTMENT and once-only REVERSAL endpoints (`finance.adjust`). |
| Activation-style settings | `system_settings` generic API updates existing keys only (`settings.manage`). |

### 2.1 Idempotency keys that MUST be preserved verbatim

```text
delivery:<orderId>:driver-collection          driver_cash_transactions.idempotency_key
delivery:<orderId>:direct-company-collection  company_direct_collections.idempotency_key
delivery:<orderId>:wallet-order-credit        wallet_transactions.idempotency_key
delivery:<orderId>:delivery-fee-revenue       company_financial_transactions.idempotency_key
delivery:<orderId>:company-product-revenue    company_financial_transactions.idempotency_key
reversal:driver-cash:<originalTxId>
reversal:wallet:<originalTxId>
reversal:company:<originalTxId>
<scope>:<actorUserId>:<hash(Idempotency-Key)>  request-derived (settlement, payout)
```

A release posts with the **same** `delivery:<orderId>:…` keys exact delivery uses today. All
three columns are `UNIQUE`, so a release attempted for an order that already received a
legacy/immediate posting fails with P2002 and rolls back — the database-level guarantee that
no historical financial event is ever replayed or credited twice.

### 2.2 Verified lock behavior of the existing primitives [EXISTING]

No existing primitive issues an explicit `SELECT … FOR UPDATE`. Every row lock is implicit:

| Statement | Lock taken |
|---|---|
| Prisma `update` / `updateMany` of a non-key column (`current_balance`, `available_balance`, `orders.status`, …) | `FOR NO KEY UPDATE` on that row |
| `INSERT` into a table with FKs (ledger rows, settlements, payouts, attempts, history) | `FOR KEY SHARE` on each referenced parent row (orders, customers, drivers, accounts, wallets, payment methods, users) |
| Settlement / payout request-key serialization | `pg_advisory_xact_lock(hashtext(derivedKey))`, taken first |
| `applyDriverCashTransaction` / `applyWalletTransaction` existence pre-check | plain read, no lock |

Existing acquisition orders:

```text
deliver:      orders(NKU) → driver_cash_accounts(NKU) → customer_wallets(NKU) → inserts
resolve:      orders(NKU) → customer_wallets(NKU) → inserts
settlement:   advisory → driver_cash_accounts(NKU) → inserts → driver_cash_transactions(NKU, link)
payout:       advisory → inserts (KEY SHARE customers) → customer_wallets(NKU) → inserts
corrections:  single ledger account (NKU) → inserts
```

Consequence for the new design: `FOR KEY SHARE` (FK checks) does **not** conflict with
`FOR NO KEY UPDATE`, but **does** conflict with `FOR UPDATE`. All new explicit row locks on
accounts, wallets, orders and releases therefore use **`FOR NO KEY UPDATE`**, matching what
the primitives already take, so explicit locking never deadlocks against concurrent FK
checks. The only intentional exceptions are the activation gate (§10) and the flag read
(§5.1), which use `FOR SHARE` / `FOR UPDATE` on the single `system_settings` row.

Lock behavior must additionally be proven empirically with concurrent integration tests on
real PostgreSQL (§13, groups C and L) before FR.4 is approved.

---

## 3. Schema [IMPLEMENTED in FR.2] — additive only

No existing column, constraint, row or index is changed or removed. The migration uses the
active convention, **Prisma Migrate** (`server/migrations/` is superseded per its README): one
`-- IDEMPOTENT` file, `server/prisma/migrations/20261016000000_settlement_financial_release_foundation/migration.sql`,
applied in production only by `scripts/build.mjs` (`prisma migrate deploy`). Every object is
guarded (`IF NOT EXISTS` / catalog lookups), so re-execution is a no-op. A database that is not
baselined for Prisma Migrate (e.g. the local dev DB) receives the same file via
`prisma db execute --file`. Constraint and index names equal the names Prisma derives, so
`prisma migrate diff` reports no FR.2 drift; CHECK constraints and partial indexes exist only in
the SQL (documented with `///` comments on each model).

### 3.1 Enums

```prisma
enum FinancialReleaseMode {
  IMMEDIATE        // decided while activation was ON; route was not Driver Cash (bypass or zero cash)
  ON_SETTLEMENT    // decided while activation was ON; route was Driver Cash
}

enum FinancialReleaseStatus {
  PENDING          // collection recorded; ownership postings not yet made
  RELEASED         // wallet/company postings made
  VOIDED           // collection reversed before any allocation; nothing ever posted
  RELEASE_REVERSED // postings reversed by an explicit release-reversal correction; terminal
}

enum FinancialReleaseReviewStatus { NOT_REQUIRED  AWAITING_REVIEW  RESOLVED }

enum DriverSettlementCorrectionType {
  SETTLEMENT_REVERSAL   // the settlement did not happen / was recorded in error
  SETTLEMENT_SHORTFALL  // the driver genuinely handed over less than recorded
}

enum OrderFinancialReleaseCorrectionType {
  COLLECTION_VOID       // the recorded Driver Cash collection is reversed
  RELEASE_REVERSAL      // released postings are reversed (mis-attribution)
}

// Existing enum — three values ADDED (ALTER TYPE … ADD VALUE IF NOT EXISTS):
enum OrderFinancialStatus {
  PENDING
  FINALIZED
  REVIEW_REQUIRED
  NOT_APPLICABLE
  AWAITING_SETTLEMENT   // [NEW] delivered; collection awaiting full settlement and/or release
  COLLECTION_VOIDED     // [NEW] Driver Cash collection reversed; nothing posted
  RELEASE_REVERSED      // [NEW] released postings reversed by correction
}
```

`ADD VALUE` statements are committed before any statement uses the new values (PostgreSQL
restriction). `NOT_APPLICABLE` and `REVIEW_REQUIRED` keep their existing meanings and are
never used to represent voids or release reversals.

### 3.2 `orders` — one nullable column

```prisma
financial_release_mode FinancialReleaseMode?   // NULL = legacy immediate processing
@@index([financial_release_mode, financial_status])
```

SQL CHECK `orders_financial_release_mode_delivered_chk`:
`financial_release_mode IS NULL OR delivered_at IS NOT NULL`.

The column is written **only** by `/deliver`, inside its transaction, and never changed
afterwards. It is never derived from dates or from the current activation setting.

### 3.3 `driver_settlements` — three nullable columns + one unique

```prisma
allocated_total     Decimal? @db.Decimal(14, 2)
unattributed_amount Decimal? @db.Decimal(14, 2)
unattributed_reason String?
allocations driver_settlement_allocations[]
corrections driver_settlement_corrections[]
@@unique([id, driver_id])          // composite-FK target
```

SQL CHECKs (as implemented):

- `driver_settlements_allocation_metadata_presence_chk`:
  `(allocated_total IS NULL) = (unattributed_amount IS NULL)` — both NULL ⇔ legacy-format
  settlement — and `unattributed_reason` may only be set on an allocation-format settlement.
- `driver_settlements_allocation_metadata_values_chk`: when set, `allocated_total >= 0`,
  `unattributed_amount >= 0`, `amount_received = allocated_total + unattributed_amount`.
- `driver_settlements_unattributed_reason_chk`: `unattributed_amount > 0` ⇒
  `unattributed_reason IS NOT NULL AND length(btrim(unattributed_reason)) >= 10`.
- Unique index `driver_settlements_id_driver_id_key` on `(id, driver_id)` (composite-FK target).

### 3.4 `order_financial_releases` (new)

One row per ON_SETTLEMENT order. `customer_id`, `order_type`, `delivered_at` and `driver_id` are
deliberate immutable snapshots (pending aggregation by customer, the order-type CHECKs,
delivery-date reporting, composite-FK target).

```prisma
model order_financial_releases {
  id                             String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  order_id                       String   @unique @db.Uuid
  customer_id                    String   @db.Uuid
  driver_id                      String   @db.Uuid
  collection_transaction_id      String   @unique @db.Uuid   // the COLLECTION driver_cash_transactions row
  order_type                     OrderType                  // snapshot
  delivered_at                   DateTime @db.Timestamptz(3) // snapshot (delivery-date reporting)
  collection_amount              Decimal  @db.Decimal(14, 2) // = actual_amount_collected
  allocated_amount               Decimal  @default(0) @db.Decimal(14, 2) // Σ ACTIVE allocations
  review_status                  FinancialReleaseReviewStatus
  release_status                 FinancialReleaseStatus @default(PENDING)
  planned_customer_wallet_amount Decimal? @db.Decimal(14, 2)
  planned_company_product_amount Decimal? @db.Decimal(14, 2)
  planned_company_fee_amount     Decimal? @db.Decimal(14, 2)
  wallet_transaction_id          String?  @unique @db.Uuid
  company_product_transaction_id String?  @unique @db.Uuid
  company_fee_transaction_id     String?  @unique @db.Uuid
  released_at                    DateTime? @db.Timestamptz(3)
  released_by_id                 String?  @db.Uuid
  released_by_settlement_id      String?  @db.Uuid   // NULL when the release was triggered by resolution
  created_at                     DateTime @default(now()) @db.Timestamptz(3)
  updated_at                     DateTime @default(now()) @db.Timestamptz(3)
  // FKs (all ON DELETE RESTRICT, ON UPDATE NO ACTION): orders, customers, drivers,
  // driver_cash_transactions, wallet_transactions, company_financial_transactions (x2),
  // users (released_by), driver_settlements (released_by_settlement — a plain FK: Prisma cannot
  // model an optional composite relation whose other column is required).
  allocations driver_settlement_allocations[]
  correction  order_financial_release_corrections?

  @@unique([id, driver_id])        // composite-FK target
  @@index([driver_id, release_status, delivered_at], map: "ofr_driver_id_release_status_delivered_at_idx")
  @@index([customer_id, release_status])
  @@index([release_status, review_status])
  @@index([delivered_at])
  @@index([released_at])
  @@index([released_by_settlement_id])
}
```

SQL-only constraints (as implemented):

- `ofr_collection_amount_positive_chk`: `collection_amount > 0`.
- `ofr_allocated_amount_range_chk`: `allocated_amount >= 0 AND allocated_amount <= collection_amount`.
- `ofr_planned_presence_chk`: each planned amount is NULL ⇔ `review_status = 'AWAITING_REVIEW'`.
- `ofr_planned_values_chk`: when set, each `>= 0` and their sum `= collection_amount`.
- `ofr_order_type_buckets_chk`: DELIVERY_ONLY ⇒ no product amount and no product posting;
  COMPANY_ORDER ⇒ no wallet amount and no wallet posting.
- `ofr_release_state_chk` (§4.1): PENDING and VOIDED carry no release metadata and no posting
  ids; VOIDED is unallocated; RELEASED is fully allocated; RELEASED and RELEASE_REVERSED have
  `released_at` / `released_by_id` and review not `AWAITING_REVIEW`.
- `ofr_posted_transactions_chk`: RELEASED / RELEASE_REVERSED rows reference a posting exactly for
  each non-zero planned amount.
- Partial index `ofr_outstanding_idx ON (driver_id, delivered_at, id) WHERE release_status = 'PENDING' AND allocated_amount < collection_amount`.

### 3.5 `driver_settlement_allocations` (new)

The order and its COLLECTION row are reached through `release_id`; they are **not** duplicated
on the allocation (FR.2 removed `order_id`, `collection_transaction_id` and `reversed_at` from
the original draft as redundant).

```prisma
model driver_settlement_allocations {
  id                        String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  settlement_id             String   @db.Uuid
  release_id                String   @db.Uuid
  driver_id                 String   @db.Uuid   // exists solely for the two composite FKs
  amount                    Decimal  @db.Decimal(14, 2)
  created_by_id             String   @db.Uuid
  created_at                DateTime @default(now()) @db.Timestamptz(3)
  reversed_by_correction_id String?  @db.Uuid   // ACTIVE <=> NULL; set once by a SETTLEMENT_REVERSAL correction
  // Composite FKs — the database itself rejects cross-driver allocation:
  //   (settlement_id, driver_id) -> driver_settlements(id, driver_id)
  //   (release_id,    driver_id) -> order_financial_releases(id, driver_id)
  @@unique([settlement_id, release_id])
  @@index([release_id])
  @@index([driver_id, created_at])
  @@index([reversed_by_correction_id])
}
```

SQL CHECK: `dsa_amount_positive_chk` (`amount > 0`). Allocation rows are append-only except the
one-way ACTIVE → REVERSED marker (`reversed_by_correction_id`); the reversal time and actor are
on the referenced correction row.

### 3.6 `driver_settlement_corrections` (new)

```prisma
model driver_settlement_corrections {
  id                  String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  settlement_id       String   @db.Uuid
  driver_id           String   @db.Uuid
  correction_type     DriverSettlementCorrectionType
  amount              Decimal  @db.Decimal(14, 2)
  reason              String
  cash_transaction_id String   @unique @db.Uuid   // the corrective driver_cash_transactions row
  created_by_id       String   @db.Uuid
  idempotency_key     String   @unique @db.VarChar(200)
  created_at          DateTime @default(now()) @db.Timestamptz(3)
  // composite FK (settlement_id, driver_id) -> driver_settlements(id, driver_id)
  @@index([settlement_id])
  @@index([driver_id, created_at])
}
```

SQL constraints: `dsc_amount_positive_chk` (`amount > 0`); `dsc_reason_not_blank_chk`
(`length(btrim(reason)) > 0`); `dsc_idempotency_key_not_blank_chk`; partial unique
`dsc_one_reversal_per_settlement_uq` on `(settlement_id) WHERE correction_type = 'SETTLEMENT_REVERSAL'`
(at most one reversal per settlement, legacy or new).

**Reason-length compatibility:** the database requires only a non-blank reason because the
existing generic reversal endpoint (`reason` ≥ 1 character) also writes a SETTLEMENT_REVERSAL
correction row when it reverses a legacy-format settlement, and that endpoint's behavior is
preserved. The ≥ 10-character rule for the NEW settlement-correction endpoints (FR.6) is
enforced by their request schemas.

Corrective cash rows reuse the existing types: SETTLEMENT_REVERSAL → driver cash `REVERSAL`
(credit, `reversal_of_id` = the settlement's SETTLEMENT row, key
`reversal:driver-cash:<settlementTxId>` — the existing key); SETTLEMENT_SHORTFALL → driver
cash `ADJUSTMENT` (credit, key `settlement-shortfall:<correctionId>`).
Correction `idempotency_key`: `settlement-reversal:<settlementId>` (deterministic, once only)
or the request-derived key for SETTLEMENT_SHORTFALL (`Idempotency-Key` header required).
Release corrections use `release-void:<releaseId>` / `release-reversal:<releaseId>`.

### 3.7 `order_financial_release_corrections` (new)

The order is reached through `release_id` (FR.2 removed the redundant `order_id` from the draft).

```prisma
model order_financial_release_corrections {
  id                                      String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  release_id                              String   @unique @db.Uuid   // at most one terminal correction per release
  correction_type                         OrderFinancialReleaseCorrectionType
  reason                                  String
  driver_cash_reversal_transaction_id     String?  @unique @db.Uuid
  wallet_reversal_transaction_id          String?  @unique @db.Uuid
  company_product_reversal_transaction_id String?  @unique @db.Uuid
  company_fee_reversal_transaction_id     String?  @unique @db.Uuid
  created_by_id                           String   @db.Uuid
  idempotency_key                         String   @unique @db.VarChar(200)
  created_at                              DateTime @default(now()) @db.Timestamptz(3)
  @@index([correction_type, created_at])
  // Long constraint/index names use explicit `ofrc_*` maps (PostgreSQL's 63-character limit).
}
```

SQL CHECKs: `ofrc_reason_meaningful_chk` (`length(btrim(reason)) >= 10` — only the new
endpoints write this table); `ofrc_idempotency_key_not_blank_chk`; `ofrc_type_shape_chk` —
`COLLECTION_VOID` ⇒ driver cash reversal set and no wallet/company reversal;
`RELEASE_REVERSAL` ⇒ no driver cash reversal and at least one wallet/company reversal.
Corrective rows reuse the existing reversal keys (`reversal:driver-cash|wallet|company:<id>`).

### 3.8 Activation setting (seeded row — the only data the migration writes)

```sql
INSERT INTO system_settings (key, value, description)
VALUES ('financial_release.settlement_mode_enabled', 'false'::jsonb,
        'Settlement-based financial release. Admin-only; changed only through the dedicated activation endpoint (FR.11).')
ON CONFLICT (key) DO NOTHING;
```

---

## 4. State machines [NEW]

### 4.1 Release status

| From | To | Trigger | Guard |
|---|---|---|---|
| — | PENDING | ON_SETTLEMENT delivery | collection > 0 via Driver Cash |
| PENDING | RELEASED | settlement allocation **or** difference resolution (`releaseOrder`) | `allocated = collection` AND review ∈ {NOT_REQUIRED, RESOLVED} |
| PENDING | VOIDED | COLLECTION_VOID correction | `allocated = 0` (no ACTIVE allocations) |
| RELEASED | RELEASE_REVERSED | RELEASE_REVERSAL correction | wallet balance ≥ posted wallet credit; no payout dependency (§8.4) |

VOIDED and RELEASE_REVERSED are terminal. **No automatic re-release** (decision A3); any
later re-posting is a separate, explicit, reasoned ADJUSTMENT.

### 4.2 Review status

`NOT_REQUIRED` (exact) is fixed. `AWAITING_REVIEW` → `RESOLVED` only via
`resolve-collection-difference`.

### 4.3 Collection settlement state (derived, never stored)

`UNSETTLED` (allocated = 0) → `PARTIALLY_SETTLED` (0 < allocated < collection) →
`FULLY_SETTLED` (allocated = collection). Increases only via settlement allocation; decreases
only via SETTLEMENT_REVERSAL of an allocating settlement.

### 4.4 Allocation status

`ACTIVE` (`reversed_by_correction_id IS NULL`) → `REVERSED` (only by SETTLEMENT_REVERSAL; blocked while the release is RELEASED).

### 4.5 Order `financial_status` for ON_SETTLEMENT orders (operational status stays DELIVERED)

| Release state | `orders.financial_status` | `needs_financial_review` |
|---|---|---|
| PENDING, AWAITING_REVIEW | REVIEW_REQUIRED | true |
| PENDING, NOT_REQUIRED / RESOLVED | AWAITING_SETTLEMENT | false |
| RELEASED | FINALIZED | false |
| VOIDED | COLLECTION_VOIDED | false |
| RELEASE_REVERSED | RELEASE_REVERSED | false |

Legacy (NULL) and IMMEDIATE orders keep the existing PENDING / FINALIZED / REVIEW_REQUIRED
behavior unchanged.

---

## 5. Transaction algorithms [NEW]

### 5.1 Delivery (`deliverDriverOrder`)

Pre-transaction validation unchanged. Inside the transaction:

1. `SELECT value FROM system_settings WHERE key = 'financial_release.settlement_mode_enabled' FOR SHARE`
   (serializes against activation/deactivation; a missing row reads as disabled).
2. Load the final collection payment method's `bypass_driver_cash` (moved before the claim).
3. `route` = NONE (actual = 0) | DIRECT_COMPANY (bypass) | DRIVER_CASH.
4. `mode` = flag off → NULL; flag on & DRIVER_CASH → ON_SETTLEMENT; flag on otherwise → IMMEDIATE.
5. Claim (existing WHERE clause), additionally writing `financial_release_mode = mode` and
   `financial_status` = REVIEW_REQUIRED (difference) | AWAITING_SETTLEMENT (ON_SETTLEMENT exact)
   | FINALIZED (otherwise).
6. Attempt + status history — unchanged.
7. Mode NULL / IMMEDIATE: the **existing** routing + posting code, unchanged.
8. Mode ON_SETTLEMENT:
   - `creditDriverCollection` (key `delivery:<orderId>:driver-collection`).
   - Insert the release: `collection_amount = actual`, `delivered_at = now`,
     `collection_transaction_id`, and
     - exact: `review_status = NOT_REQUIRED`; planned = DELIVERY_ONLY
       `(remaining_order_amount, 0, remaining_delivery_fee)`, COMPANY_ORDER
       `(0, remaining_order_amount, remaining_delivery_fee)` (sums to `amount_to_collect = actual`);
     - difference: `review_status = AWAITING_REVIEW`, planned NULL.
   - **No wallet / company posting.**
   - Audit `DELIVERY_FINANCE_AWAITING_SETTLEMENT` (exact) or `COLLECTION_DIFFERENCE_RECORDED`
     (difference), metadata incl. `financialReleaseMode`, `releaseId`, routing, payment-method change.

### 5.2 Settlement (`POST /driver-settlements`)

Request body:

```text
{ driverId, amountReceived, paymentMethodId, notes?,
  allocations?: [{ releaseId, amount }],
  unattributedAmount?, unattributedReason? }
```

Two request formats:

- **Allocation format** (`allocations` present, may be empty): server checks
  `amountReceived = Σ allocations.amount + unattributedAmount` exactly;
  `unattributedAmount > 0` requires `unattributedReason` (trimmed, ≥ 10 chars).
- **Legacy format** (`allocations` omitted): accepted **only** when the activation setting is
  OFF **and** the driver has no PENDING release; stored with NULL
  `allocated_total` / `unattributed_amount` exactly as today. Otherwise 400
  `ALLOCATION_CONTRACT_REQUIRED`. A legacy-format request therefore can never consume money
  reserved for settlement-mode collections.

Pre-transaction: Zod (unique `releaseId`s, positive 2-dp amounts, `allocations.length ≤
MAX_ALLOCATIONS_PER_SETTLEMENT` — initial target **20**, production value set by FR.4/FR.11
measurement), driver + payment-method validation, request-derived key, replay fast path.

Transaction (lock order per §6):

1. `pg_advisory_xact_lock(hashtext(derivedKey))`; re-check replay.
2. Read the activation flag `FOR SHARE` (legacy-format eligibility).
3. `SELECT … FROM driver_cash_accounts WHERE driver_id = $1 FOR NO KEY UPDATE`.
4. `SELECT … FROM order_financial_releases WHERE id = ANY($ids) ORDER BY id FOR NO KEY UPDATE`;
   each must exist, belong to `driverId`, be PENDING, and `amount ≤ collection − allocated`
   (else 400 `ALLOCATION_INVALID` naming the release).
5. `attributedOutstanding = Σ (collection − allocated)` over the driver's PENDING releases;
   `U = current_balance − attributedOutstanding`. `U < 0` → 500 integrity failure (logged).
   `unattributedAmount > U` → 400 `UNATTRIBUTED_EXCEEDS_BALANCE`. Legacy format: requires
   `attributedOutstanding = 0` (enforced above).
6. `debitDriverSettlement(amountReceived)` — existing primitive (balance ≥ amount guard).
7. Create `driver_settlements` (+ `allocated_total`, `unattributed_amount`, `unattributed_reason`);
   link `settlement_id` on the cash row (existing).
8. Per allocation: insert row; `UPDATE order_financial_releases SET allocated_amount = allocated_amount + $a
   WHERE id = $id AND allocated_amount = $old AND release_status = 'PENDING'` — exactly 1 row or 409.
9. Releases now fully allocated with review ≠ AWAITING_REVIEW: `releaseOrder(tx, r, { settlementId })`,
   processed in `(customer_id, id)` order.
10. Audit `DRIVER_SETTLEMENT_COMPLETED` (metadata: allocations, unattributed amount + reason,
    released release ids). `unattributed_reason` is also captured in the audit row.

Replay comparison (same key): driver, amount, payment method, notes, format, and the
normalized allocation set (sorted by `releaseId`, `Decimal.equals`), `unattributedAmount`,
`unattributedReason`. Same key + different request → 409; never re-executes.

### 5.3 `releaseOrder(tx, release, trigger)` — the only release path

1. `UPDATE order_financial_releases SET release_status='RELEASED', released_at, released_by_id,
   released_by_settlement_id WHERE id = $id AND release_status='PENDING'
   AND allocated_amount = collection_amount AND review_status <> 'AWAITING_REVIEW'` — 1 row or 409.
2. Post with the existing primitives and keys, payment method = the order's original
   `collection_payment_method_id` (decision A8):
   - DELIVERY_ONLY: `creditWalletForOrder` (`delivery:<orderId>:wallet-order-credit`) if > 0;
     `recordDeliveryFeeRevenue` (`delivery:<orderId>:delivery-fee-revenue`) if > 0.
   - COMPANY_ORDER: `recordCompanyOrderProductRevenue` (`delivery:<orderId>:company-product-revenue`)
     if > 0; fee as above. **Never** the wallet.
3. Store the posted transaction ids on the release.
4. `UPDATE orders SET financial_status='FINALIZED' WHERE id AND status='DELIVERED'
   AND financial_release_mode='ON_SETTLEMENT' AND financial_status='AWAITING_SETTLEMENT'` — 1 row or 409.
5. Audit `FINANCIAL_RELEASE_COMPLETED` (ORDER entity; trigger, planned/posted amounts, tx ids, settlement id).

A P2002 on any posting key is logged as an integrity failure and rolls back the entire
enclosing transaction.

**FR.11A batch form (implemented).** `releaseOrder()` is a wrapper over `releaseOrders(tx, ids)`,
still the single release path. A settlement releases all of its fully settled, review-cleared
collections in one call: releases read once (locks already held), orders read and locked
`FOR NO KEY UPDATE` in id order (lock step 5), COLLECTION / reversal checks in one query each,
wallet credits one by one in `(customer_id, id)` order through the existing primitive, company
revenue rows in one insert (`createCompanyFinancialTransactions`, same keys, same P2002
rollback), one multi-row compare-and-set for the releases, one `updateMany` (count-checked) for
the orders and one insert for the audit rows. Settlement allocation rows and the
`allocated_amount` compare-and-set are likewise one statement each. Semantics, keys, checks and
lock order are unchanged; measurements in `docs/fr11a-release-readiness.md` §1.

### 5.4 Difference resolution

Validation unchanged (`loadEligibleReviewOrder`, split sums to actual, order-type buckets).
Branch on the persisted mode:

- NULL / IMMEDIATE (legacy, direct payment, zero cash): existing code unchanged (decision 10).
- ON_SETTLEMENT: lock the release by `order_id` `FOR NO KEY UPDATE` (must be PENDING +
  AWAITING_REVIEW) → claim the order `REVIEW_REQUIRED → AWAITING_SETTLEMENT`,
  `needs_financial_review = false` → write planned amounts, `review_status = RESOLVED` → if
  `allocated = collection`, `releaseOrder(…, { trigger: 'RESOLUTION' })` → audit
  `COLLECTION_DIFFERENCE_RESOLVED` with `deferredRelease: true|false`.

**Implemented in FR.5:** the interim FR.3 guard (409 for ON_SETTLEMENT orders) is removed.
`order.service` `resolveCollectionDifference` keeps the shared pre-transaction validation and
branches on the persisted mode; the ON_SETTLEMENT branch is
`financial-release.service` `resolveReleaseDifference()`. Inside one transaction it locks the
release by `order_id` (`FOR NO KEY UPDATE`), requires `PENDING` + `AWAITING_REVIEW` (409
otherwise), verifies order ↔ release ↔ COLLECTION ↔ driver consistency (500 on mismatch, 409
if the COLLECTION was reversed), re-validates the split with `plannedAmountProblems` (400),
claims the order, writes planned amounts + `RESOLVED` in one update, and calls `releaseOrder`
(trigger `RESOLUTION`, `released_by_settlement_id = NULL`) only when the collection is fully
allocated. The `COLLECTION_DIFFERENCE_RESOLVED` audit adds `financialReleaseMode`, `releaseId`,
`deferredRelease`, `collectionAmount`, `allocatedAmount`; a release adds its own
`FINANCIAL_RELEASE_COMPLETED` row.

### 5.5 Persisted mode governs processing

Settlement, resolution, release and corrections read only the order's persisted
`financial_release_mode` and release state — **never** the activation setting. Existing
ON_SETTLEMENT orders therefore remain fully processable after activation is disabled.

---

## 6. Concurrency control [NEW]

Global acquisition order (every path takes a prefix/subsequence, never out of order):

```text
1. advisory lock on the request key
2. system_settings activation row          (FOR SHARE; FOR UPDATE only in activation)
3. driver_cash_accounts                     (FOR NO KEY UPDATE)
4. order_financial_releases, by id          (FOR NO KEY UPDATE)
5. orders, by id                            (NKU via conditional updateMany)
6. customer_wallets, by customer_id         (NKU via increment / conditional decrement)
7. inserts (FK KEY SHARE on parents)
```

| Path | Locks |
|---|---|
| Settlement | 1 → 2 → 3 → 4 → 5 → 6 → 7 |
| Resolution (ON_SETTLEMENT) | 4 → 5 → 6 → 7 |
| COLLECTION_VOID / SETTLEMENT_REVERSAL / SETTLEMENT_SHORTFALL / cash ADJUSTMENT / cash REVERSAL | 3 → 4 → (5) → 7 |
| RELEASE_REVERSAL | 4 → 5 → 6 → 7 |
| Payout (unchanged) | 1 → 6 → 7 |
| Delivery | 2 → 5 (OUT_FOR_DELIVERY order) → 3 → 6 (IMMEDIATE only) → 7 |
| Activation | 2 (FOR UPDATE) → 3 (all accounts, FOR SHARE) |

Delivery takes `orders` before `driver_cash_accounts` (existing order). It cannot cycle with
settlement: delivery only locks an OUT_FOR_DELIVERY order that has no release, settlement only
locks DELIVERED orders with releases, and delivery never takes a release lock.

Rules:

- Any write to `allocated_amount`, any VOID, and any Driver Cash debit holds the driver's
  account lock (3). This makes `attributedOutstanding` stable inside a settlement: new
  releases are created only after delivery's account increment (which waits for the
  settlement to commit), and a resolution-triggered release only affects releases that already
  contribute 0 outstanding.
- Multiple wallets in one transaction are locked in `customer_id` order.
- Duplicate protection layers: request Idempotency-Key + advisory lock (existing);
  `UNIQUE(settlement_id, release_id)`; compare-and-set on `allocated_amount` / `release_status`
  / `orders.financial_status`; unique deterministic posting keys; unique `order_id`,
  `collection_transaction_id`, posted/reversal transaction ids and correction `release_id`;
  CHECK constraints.
- Isolation: READ COMMITTED + explicit locks. Explicit locks are `$queryRaw` inside the Prisma
  interactive transaction.

---

## 7. Unattributed driver cash, adjustments, legacy balances, zero collections [NEW]

```text
U(driver) = current_balance − Σ (collection_amount − allocated_amount) over PENDING releases
Invariant: U ≥ 0
```

U covers all cash not reserved for an open settlement-mode collection: legacy collections,
cash adjustments, credits from SETTLEMENT_REVERSAL / SETTLEMENT_SHORTFALL corrections, and
allocations reversed on terminal releases.

- Settlement unattributed line ≤ U, reason required, never releases anything.
- Cash ADJUSTMENT **credit**: increases U only. Must represent a genuine driver obligation
  (decision A4) — reason required; never creates a release, wallet credit or revenue.
- Cash ADJUSTMENT **debit**, REVERSAL of a credit ADJUSTMENT, and REVERSAL of a COLLECTION that
  has no release: allowed only if amount ≤ U (400 `ADJUSTMENT_EXCEEDS_UNATTRIBUTED`).
- Legacy balances: must be zero at activation (§10). If a legacy credit later reappears
  (e.g. reversal of a legacy settlement), it is unattributed and settled via the unattributed
  line.
- Zero collection (actual = 0): route NONE → mode IMMEDIATE → existing immediate behavior.
- Payment method: only the **final** method at delivery decides route and mode; both are
  persisted. Delivered orders are not editable; toggling `bypass_driver_cash` later never
  changes a delivered order.

---

## 8. Corrections and reversals [NEW]

| Original | Action | Policy |
|---|---|---|
| Settlement-mode COLLECTION, release PENDING, allocated = 0 | `POST /finance/order-releases/:id/void-collection` | Driver cash REVERSAL (debit, existing key), release → VOIDED, order → COLLECTION_VOIDED, correction row, audit. |
| Settlement-mode COLLECTION with allocations, or RELEASED | any | 409 `COLLECTION_HAS_ALLOCATIONS` — reverse the allocating settlement(s) first (if permitted). |
| Settlement-mode COLLECTION via the generic `/driver-cash-transactions/:id/reverse` | — | 409 `USE_RELEASE_CORRECTION`. |
| Legacy / IMMEDIATE COLLECTION | existing reverse endpoint | Unchanged, plus the `amount ≤ U` guard. Order financial status unchanged (existing behavior). |
| Settlement (legacy or new) | `POST /driver-settlements/:id/reverse` | Blocked (409 `SETTLEMENT_HAS_RELEASED_FUNDS`) if any ACTIVE allocation's release is RELEASED. Otherwise: driver cash REVERSAL credit (existing key), allocations → REVERSED, releases' `allocated_amount` decremented (compare-and-set), SETTLEMENT_REVERSAL correction row, audit. |
| Settlement via the generic `/driver-cash-transactions/:id/reverse` | — | Legacy-format settlement: still accepted (backward compatibility) and internally records the same SETTLEMENT_REVERSAL correction row with the supplied reason. Allocation-format settlement: 409 `USE_SETTLEMENT_CORRECTION`. |
| Settlement where the driver handed over less than recorded | `POST /driver-settlements/:id/shortfall` | Driver cash ADJUSTMENT credit (genuine driver obligation only), SETTLEMENT_SHORTFALL correction row; Σ shortfalls ≤ `amount_received`; not after a SETTLEMENT_REVERSAL. Releases and customer credits stand — the receiver paid; the company still owes the customer. |
| RELEASED release (mis-attribution) | `POST /finance/order-releases/:id/reverse-release` | Wallet REVERSAL of the ORDER_CREDIT (existing primitive; debit fails if insufficient balance) + company REVERSAL rows, release → RELEASE_REVERSED, order → RELEASE_REVERSED, correction row, audit. If the wallet cannot be debited because funds were paid out → 409 `RELEASED_FUNDS_PAID_OUT`, nothing changes (decision A4). |
| Release-linked wallet / company rows via generic reverse endpoints | — | 409 `USE_RELEASE_CORRECTION`. Legacy/IMMEDIATE rows unchanged. |
| Payouts | — | Unchanged; spend available balance only. |

All correction endpoints: `finance.adjust`, mandatory reason (≥ 10 chars), required
`Idempotency-Key`, one transaction, audit with actor, original records and corrective
transaction ids. Original rows are never edited or deleted.

### 8.1 Implemented in FR.6 (verified semantics)

| Endpoint | Service | Lock order | Audit action |
|---|---|---|---|
| `POST /finance/order-releases/:releaseId/void-collection` | `financial-release-correction.service` `voidReleaseCollection` | account 3 → release 4 → order 5 → inserts | `FINANCIAL_RELEASE_COLLECTION_VOIDED` (ORDER) |
| `POST /finance/order-releases/:releaseId/reverse-release` | `reverseRelease` | release 4 → order 5 → wallet 6 (explicit `FOR NO KEY UPDATE`) → inserts | `FINANCIAL_RELEASE_REVERSED` (ORDER) |
| `POST /driver-settlements/:id/reverse` | `settlement-correction.service` `reverseSettlement` | account 3 → releases by id 4 → inserts | `DRIVER_SETTLEMENT_REVERSED` |
| `POST /driver-settlements/:id/shortfall` | `recordSettlementShortfall` | advisory key 1 → account 3 → inserts | `DRIVER_SETTLEMENT_SHORTFALL_RECORDED` |

Decisions taken where §8 was silent (all conservative — each blocks rather than permits):

- **Retry semantics.** Void, release reversal and settlement reversal use deterministic keys
  (`release-void:<id>`, `release-reversal:<id>`, `settlement-reversal:<id>`); the
  `Idempotency-Key` header is required but not stored. A retry with the same reason returns the
  recorded correction (201); a different reason → 409. The shortfall uses the request-derived key
  (`request:settlement-shortfall:<hash>`): same key + same body replays, different body → 409.
- **Settlement reversal is also blocked when an allocated release is `RELEASE_REVERSED`**
  (409 `SETTLEMENT_HAS_RELEASED_FUNDS`), not only `RELEASED`. The schema would allow
  decrementing a reversed release's `allocated_amount`, but those allocations did trigger a
  release.
- **Settlement reversal and shortfall are mutually exclusive** (409 `SETTLEMENT_HAS_SHORTFALL` /
  `SETTLEMENT_ALREADY_REVERSED`): reversing after a shortfall would credit the driver twice for
  the same missing cash.
- **The shortfall's ADJUSTMENT credit is not generically reversible** (409
  `USE_SETTLEMENT_CORRECTION`); a mistaken shortfall is corrected with a reasoned debit
  adjustment (≤ U).
- **A legacy-format settlement reversed through the generic endpoint** writes the
  SETTLEMENT_REVERSAL correction row with the supplied reason (≥ 1 char, the existing endpoint
  rule) and keeps its existing response shape.
- **Void of a difference awaiting review** is allowed (allocated = 0); the order goes to
  `COLLECTION_VOIDED` with `needs_financial_review = false`; `review_status` is left as it was.
- **Release reversal** checks every referenced posting (type, order, customer, amount) and that
  none was reversed before; the release keeps its original posting ids. Wallet insufficiency is
  checked under the explicit wallet lock → 409 `RELEASED_FUNDS_PAID_OUT`, nothing written.
- **U guard (§7)** applies to: debit ADJUSTMENT, and generic REVERSAL whose direction is a debit
  (reversal of a credit ADJUSTMENT or of a non-release COLLECTION) — 400
  `ADJUSTMENT_EXCEEDS_UNATTRIBUTED`. A void's debit is not U-capped (it removes cash that the
  release itself reserved).
- Generic guards return 409 `CONFLICT` with `details.reason` = `USE_RELEASE_CORRECTION` /
  `USE_SETTLEMENT_CORRECTION`, evaluated inside the transaction (driver-cash guards under the
  account lock).

Not representable with the approved schema (not implemented): a driver handing over **more**
than recorded (an over-recorded settlement in the driver's favour) — no correction type exists
for it.

---

## 9. Pending customer wallet calculation [NEW]

```text
pendingDelivery(c)   = Σ remaining_order_amount          [existing rule: DELIVERY_ONLY, active statuses]
pendingSettlement(c) = Σ planned_customer_wallet_amount
                       WHERE customer_id = c AND order_type = 'DELIVERY_ONLY'
                         AND release_status = 'PENDING' AND review_status IN ('NOT_REQUIRED','RESOLVED')
underReview(c)       = COUNT(*) WHERE customer_id = c AND release_status = 'PENDING'
                         AND review_status = 'AWAITING_REVIEW'
                       (+ Σ collection_amount for Management only)
pendingAmount        = pendingDelivery + pendingSettlement    (field name unchanged)
available            = customer_wallets.available_balance     (unchanged)
```

No double counting: DELIVERED is not an active status (leaves `pendingDelivery` at delivery);
releases exist only for DELIVERED orders; PENDING → RELEASED moves the amount from
`pendingSettlement` to `available` in one transaction; VOIDED / RELEASE_REVERSED are excluded.
Unresolved differences are never in the customer's monetary pending total (decision A1).

API additions (backward compatible): `pendingDeliveryAmount`, `pendingSettlementAmount`,
`underReviewOrderCount` (+ `underReviewCollectionAmount` on Management DTOs only). Batched
list endpoints add one `groupBy` on releases — no N+1.

---

### 9.1 Implemented in FR.7 (read APIs)

All reads are strictly read-only. Multi-figure reads run in `readSnapshot()` (one REPEATABLE
READ, `READ ONLY` transaction) so a balance and its breakdown come from the same instant. The
"release still holds driver cash" predicate (`PENDING_RELEASE_HOLDS_CASH`: `PENDING` and its
COLLECTION not reversed) is shared by the settlement lock path and every read.

| Endpoint | Permission | Notes |
|---|---|---|
| `GET /finance/driver-cash/:driverId/outstanding-collections?page&limit` (limit ≤ 100, default 50) | `finance.read` | `data` = `{ driverId, cashBalance, attributedOutstanding, unattributedBalance, outstandingCollectionCount, items[] }`, `meta` = pagination. Items: PENDING releases with `allocated < collection`, oldest first (`delivered_at, id`, partial index `ofr_outstanding_idx`). FR.9 (additive): `plannedCustomerWalletAmount`, `plannedCompanyProductAmount`, `plannedCompanyFeeAmount` — the approved split a release posts, all null while the difference awaits review (feeds the settlement preview without a per-order fetch). |
| `GET /driver-settlements/:id` | `settlements.read` | Summary + `format`, allocations (ACTIVE/REVERSED, current collection state, `releasedByThisSettlement`), `releasedOrders`, fully/partially settled counts, corrections. |
| `GET /driver-settlements` (existing) | `settlements.read` | Additive `reversed`, `shortfallTotal` (batched: 2 queries per page). |
| `GET /orders/:id/financial-release` | `finance.read` | `{ orderId, financialReleaseMode, financialStatus, release }`; `release` null for NULL / IMMEDIATE orders. |
| `GET /orders/:id` (existing) | `orders.read` | Additive scalar `financialReleaseMode` only. |
| Management wallet DTOs (`/wallets`, `/wallets/:id`, `/wallets/customer-summaries`, `/wallets/totals`) | `wallets.read` | Additive `pendingDeliveryAmount`, `pendingSettlementAmount`, `underReviewOrderCount`, `underReviewCollectionAmount`. |
| `/customer/me/wallet`, `/customer/me/dashboard` | own customer | Additive `pendingDeliveryAmount`, `pendingSettlementAmount`, `underReviewOrderCount` (no cash amount). |

Decisions:

- The full release detail is a sub-resource (`/orders/:id/financial-release`, like
  `/orders/:id/parcel-collection`), not inlined in `OrderDetail`: Dispatcher holds `orders.read`
  but not `finance.read`, and `OrderDetail` is also returned by every order mutation.
- `underReview` counts **DELIVERY_ONLY** releases only (a COMPANY_ORDER difference never affects
  a customer wallet).
- `pendingAmount` = delivery + settlement on every surface, including the existing customer
  report's pending figure (same shared function; identical while activation is off).
- `outstandingAmount` of a terminal release is 0; `collectionReversed` flags a pre-FR.6 generic
  reversal of the collection (read-only, never repaired).

## 10. Activation, deactivation and rollback [NEW]

Endpoints (`requireRole("ADMIN")`, decision A7): `GET /api/v1/admin/financial-release`
(state), `GET /api/v1/admin/financial-release/readiness` (dry-run gate report),
`POST /api/v1/admin/financial-release/activate`, `POST /api/v1/admin/financial-release/deactivate`.
The generic `PATCH /api/v1/system-settings/:key` rejects this key — **implemented in FR.3**
(400 `VALIDATION_ERROR`, `details.reason = "SETTING_MANAGED_ELSEWHERE"`, checked before any DB
access) because `/deliver` honours the flag from FR.3 onward and `settings.manage` can be held by
non-Admin roles.

**Hard activation gate** (decision A6) — evaluated inside the activation transaction after
`SELECT … FROM system_settings WHERE key = … FOR UPDATE` and
`SELECT … FROM driver_cash_accounts FOR SHARE` (all rows, active and inactive drivers):

| Gate | Check |
|---|---|
| G0 Cutover authorization | Server env `FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED=true`. Unset by default — activation is impossible until production cutover is explicitly authorized. |
| G1 Schema readiness | All §3 enums, columns, tables, constraints and the seeded key exist (catalog query). |
| G2 Zero legacy driver cash | Every driver's unattributed balance `U = 0` (§7). At first activation no release exists, so this is exactly `current_balance = 0` for every account; on a later re-activation, cash reserved by existing PENDING releases is permitted, but no legacy/unattributed cash is. |
| G3 Driver cash ledger integrity | For every account: cached balance = ledger net, and latest `balance_after` = cached balance. |
| G4 Wallet ledger integrity | For every wallet: `available_balance` = Σ(credit − debit). |
| G5 Legacy obligations | No legacy (mode NULL) DELIVERED order with `financial_status = 'REVIEW_REQUIRED'`; no `driver_settlements` row whose `driver_cash_transactions` link is missing. |
| G6 Reconciliation | Reconciliation (§11) returns zero violations. |
| G7 Deployment readiness | Server build reports the FR.11 contract version and the client build serving the settlement-allocation UI (FR.9) is deployed (version endpoint check). |

Any failure → 409 `ACTIVATION_GATE_FAILED` with the failing gates; nothing is modified. The
gate **never** modifies balances or records. Success writes the setting and an audit row
(`FINANCIAL_RELEASE_ACTIVATED`, gate report in metadata).

**Implemented in FR.11A** (`financial-release-activation.service.ts`; details and gate
queries in `docs/fr11a-release-readiness.md` §3): G0 is checked first without database access;
G1 checks 48 catalog objects; G6 runs R1–R13 inside the activation transaction (H* findings are
reported in the readiness report and the activation audit, never hidden, but do not block);
**G7 mechanism** — the server declares `FINANCIAL_RELEASE_CONTRACT_VERSION = "FR.11"` and fetches
`${CLIENT_URL}/version.json` (3 s timeout, before the transaction); the deployed client must
declare `"financialReleaseContract": "FR.11"` (`client/public/version.json`). Activation and the
readiness dry run use a bounded 30 s transaction timeout. Both POSTs take no body; activating an
enabled feature or deactivating a disabled one is a no-op (`changed: false`, no audit).

Deactivation: Admin, always allowed, audited (`FINANCIAL_RELEASE_DEACTIVATED`). Affects
future deliveries only; existing ON_SETTLEMENT orders keep their mode and are processed by
settlement / resolution / corrections as normal (§5.5).

Rollback constraints:

- Setting rollback (deactivate): always safe.
- Code rollback to a pre-FR build: safe **only** before the first ON_SETTLEMENT delivery, or
  after every release is terminal (RELEASED / VOIDED / RELEASE_REVERSED). Older code does not
  know the new enum values and would never release pending collections.
- Schema rollback: never. The additive objects remain.

---

## 11. Reconciliation equations and invariants [NEW]

Exposed read-only as `GET /api/v1/finance/reconciliation/financial-release` (`finance.read`),
returning violations only.

| # | Invariant |
|---|---|
| R1 | `driver_cash_accounts.current_balance` = net of that driver's cash ledger (existing), plus the account's approved, currently valid historical reconciliation (FR.12A.4; `docs/fr12a4-historical-reconciliation-validation.md`). For each account: raw discrepancy `D = stored − ledger net`, approved amount `A`, residual `R = D − A`. R1 fails when `R ≠ 0`, or when the account carries an invalid historical approval (`X > 0`; that approval is also its own finding). Without historical reconciliation records, `A = 0`: the original rule applies, with identical findings. |
| R2 | `current_balance = Σ outstanding(PENDING releases) + U`, `U ≥ 0`. |
| R3 | Per release: `allocated_amount = Σ amount of its ACTIVE allocations` (`reversed_by_correction_id IS NULL`); `0 ≤ allocated ≤ collection`. |
| R4 | Per allocation-format settlement: `allocated_total = Σ its allocations` (ACTIVE or REVERSED) and `amount_received = allocated_total + unattributed_amount`. |
| R5 | Per release in RELEASED or RELEASE_REVERSED: each non-zero planned amount has exactly one original posting row of the matching type and order with equal amount; Σ planned = `collection_amount`. |
| R6 | Original ownership postings for an ON_SETTLEMENT order (ORDER_CREDIT, DELIVERY_FEE_REVENUE, COMPANY_ORDER_PRODUCT_REVENUE): **none** while PENDING or VOIDED; exactly those referenced by the release while RELEASED; while RELEASE_REVERSED, each referenced original has exactly one REVERSAL referenced by the release correction, and the order's net ownership postings are zero. |
| R7 | At most one ORDER_CREDIT, one DELIVERY_FEE_REVENUE and one COMPANY_ORDER_PRODUCT_REVENUE original row per order (unique keys). |
| R8 | No wallet posting for any COMPANY_ORDER release; no product revenue for any DELIVERY_ONLY release. |
| R9 | An order with NULL mode has no release, allocation or release correction. |
| R10 | `release.collection_amount` = its COLLECTION row amount = `orders.actual_amount_collected`. |
| R11 | ON_SETTLEMENT order `financial_status` matches the §4.5 mapping exactly, and `status = 'DELIVERED'`. |
| R12 | VOIDED release ⇔ a COLLECTION_VOID correction whose driver cash REVERSAL reverses the release's COLLECTION row; RELEASE_REVERSED ⇔ a RELEASE_REVERSAL correction. |
| R13 | Wallet cached = ledger net (existing); payouts never touch Driver Cash; settlements never debit a wallet. |

---

## 12. Reporting semantics [NEW]

**Released basis** (default, decision A10) — existing flow functions over each ledger row's
own `created_at`. For ON_SETTLEMENT orders that is the release time. Reversal rows count in
their own period (existing net-signed logic: company amounts are signed; wallet / driver cash
REVERSAL magnitudes are subtracted only when they reverse a row of the category). Labels:
"Released revenue", "Released customer credits".

**Delivery-date basis** (`basis=delivered`), by `orders.delivered_at`:

```text
earned(category, range) =
    Σ original posting rows of the category, joined to orders delivered in range
  + Σ REVERSAL rows whose reversal_of_id is such an original row
        (attributed to the ORIGINAL order's delivery date, regardless of the reversal's own date)
  + Σ planned_<category>_amount of PENDING releases with delivered_at in range
        AND review_status <> 'AWAITING_REVIEW'
underReviewCash(range) = Σ collection_amount of PENDING releases awaiting review, delivered in range
```

No double counting: an order contributes planned amounts only while PENDING; the release
transaction creates the posting rows and leaves PENDING atomically. RELEASE_REVERSED orders net
to zero (original + reversal); VOIDED orders contribute nothing; generic ADJUSTMENT rows
without an order are excluded from category totals (existing rule). Legacy / IMMEDIATE orders
contribute posted rows only.

Snapshot cards: customer liability pending settlement (Σ `pendingSettlement`), company revenue
pending settlement, cash under review, attributed vs unattributed driver cash.

---

### 12.1 Implemented in FR.8

Code: `financial-release-reporting.service.ts` (figures) and
`financial-release-reconciliation.service.ts` (checks). All reads are read-only; related figures
are read in one `readSnapshot()`.

| Surface | Addition (additive — no existing field changes meaning) |
|---|---|
| `GET /finance/summary?basis=released\|delivered` (`finance.read`) | `basis: "RELEASED"` label; `settlementRelease.current` (now: customer funds / delivery fees / product revenue awaiting settlement, awaiting count, driver cash held = attributed + unattributed, under review — all modes and settlement-mode only); `settlementRelease.activity` (in range: releases completed + released amounts by `released_at`, release reversals and collection voids by correction date); `deliveryDate` (only for `basis=delivered`). |
| `GET /reports/finance?basis=…` (`reports.read`) | Same summary additions; `deliveryDateRows` (by `delivered_at` period) for day/week/month with `basis=delivered`; existing `rows` unchanged. |
| `GET /reports/drivers` | `attributedCashHeld`, `unattributedCashHeld`, `outstandingCollectionCount` (current). |
| `GET /reports/customers` | `pendingDeliveryAmount`, `pendingSettlementAmount`, `underReviewOrderCount` (`pendingOrderValue` = their total). |
| `GET /reports/orders` | `summary.financialRelease` — delivered orders by mode and financial status. |
| `GET /dashboard` (`finance` section, `finance.read`) | `revenueBasis: "RELEASED"`, `settlementRelease` (current snapshot + `releasesCompletedToday`). Activity: `DELIVERY_FINANCE_AWAITING_SETTLEMENT`, `FINANCIAL_RELEASE_COMPLETED` (operational, amount-free); `DRIVER_SETTLEMENT_SHORTFALL_RECORDED` (`settlements.read`); `FINANCIAL_RELEASE_COLLECTION_VOIDED`, `FINANCIAL_RELEASE_REVERSED` (`finance.read`). |
| `GET /finance/reconciliation/financial-release` (`finance.read`) | R1–R13 (INVARIANT), H1–H3 (HISTORICAL), I1–I3 (INFORMATIONAL). Per check: status, exact `affectedCount`, FR-violation vs historical-anomaly counts, ≤ 50 sample findings (`entityType`, `entityId`, `expected`, `actual`, `detail`, `classification`), `truncated`. FR.12A.4 additions: H3 = balance-chain discontinuities that no valid approved historical reconciliation explains (`UNEXPLAINED_GAP` / `AMBIGUOUS_ORDER`); I3 = per-account raw discrepancy, approved amount and residual, always shown; additive `driverCashHistoricalReconciliation` summary from the same snapshot. |

Delivery-date figures per category = posted (originals of orders delivered in range + their
reversals, whatever the reversal date) + pending (approved planned amounts of PENDING releases
still holding cash). Unresolved differences contribute only `underReviewCollectionAmount`.
Category postings without an order cannot be attributed to a delivery and are reported as
`orderlessCategoryPostings` (by their own posting date) beside — never inside — the
delivery-date figures; they stay in the released totals. Identity verified by tests:
`posted + orderless = released category total` (all time).

Reconciliation classification is rule-based: a finding touching a release / settlement-mode
order / allocation-format settlement is a `FINANCIAL_RELEASE_VIOLATION`; one touching only
legacy records is a `HISTORICAL_ANOMALY`. Any INVARIANT finding sets `blocksActivation`
(FR.11 gates G3 / G4 / G6), whatever its classification. HISTORICAL checks (H1: category
postings without an order; H2: revenue postings with a non-positive amount) are reported for
separate review and do not block. On a copy of the local dev DB: R1–R13 PASS; H1 = H2 = the
40 pre-FR.2 order-less −$5 `DELIVERY_FEE_REVENUE` rows (−$200), untouched.

## 13. Test matrix [NEW]

| Group | Coverage |
|---|---|
| A — Off = unchanged | Full existing suite passes byte-for-byte with the setting off; new deliveries get mode NULL; legacy-format settlements unchanged. |
| B — Mode decision | flag × route (cash / bypass / none) × exact/difference × order type → mode, financial status, postings. |
| C — Settlement | full, partial, split across settlements, release on completion only, unattributed line + reason, over-allocation, cross-driver (app + composite FK), VOIDED/RELEASED target, duplicate release id, `MAX_ALLOCATIONS_PER_SETTLEMENT`, legacy format rejected when reserved money exists, replay same/different allocations. |
| D — Difference | settle → resolve and resolve → settle (exactly one release each); bypass/zero-cash differences immediate. |
| E — Pending | pending delivery / settlement / under review for Management and customer at every stage; customer DTO leaks no internal fields. |
| F — Corrections | void (allowed / blocked), settlement reversal (allowed / blocked by released funds), shortfall limits, release reversal (allowed / paid-out 409), generic endpoints blocked for release-linked rows, `amount ≤ U` guards. |
| G — Historical protection | legacy REVIEW_REQUIRED resolved after activation posts immediately; forced release of a legacy order fails P2002 with full rollback; legacy settlements/payouts/finance rows unchanged (row-count + checksum snapshot). |
| H — Activation | each gate failing individually; success; Admin-only; env authorization; deactivate mid-flight keeps existing releases processable. |
| I — Reporting | released vs delivered bases with reversals in later periods; no double counting across release; dashboard / finance summary / reports. |
| J — Reconciliation | R1–R13 return zero violations after every scenario. |
| K — RBAC | DRIVER / CUSTOMER 403 on all new Management endpoints; corrections need `finance.adjust`; settlements need `settlements.create`. |
| L — Concurrency + performance | concurrent settlements on one release; settlement vs resolution; settlement vs delivery (same driver); settlement vs payout (same customer); activation vs delivery; deadlock-free under load; latency at 20 / 50 / 100 allocations to set the production limit. |
| M — E2E | Delivery Only and Company Order: deliver → settle → release → payout. |

---

## 14. Open issues (not blocking FR.1)

0. **Session time zone (found in FR.8)** — the local PostgreSQL session time zone is
   `America/Los_Angeles`, and the Prisma pg adapter sends JS `Date` parameters without an
   offset, so timestamps written through Prisma are stored shifted by the zone offset. Prisma
   reads, filters and ranges are shifted identically (internally consistent), but SQL that
   derives UTC calendar labels (`date_trunc(… AT TIME ZONE 'UTC')`, existing finance-report
   period rows and the new delivery-date rows alike) can label late-day activity with the next
   date locally. Not changed in FR.8; production readiness must confirm the database / pooler
   session time zone is UTC (or the adapter's timestamp handling) before activation.
   The stabilization checkpoint confirmed this in an isolated database and also found that
   app timestamps in the US spring-forward hour (02:00–02:59 UTC) read back +1h under the LA
   session. Evidence and the proposed plan: `docs/timezone-investigation.md`.


1. **Production allocation limit / transaction timeout** — start at 20; final value from
   measurement. FR.4 measurement (isolated PostgreSQL 18 behind a round-trip-counting proxy
   with injected latency; each allocation fully releases a DELIVERY_ONLY order): a settlement
   costs ≈ 25 + 15 database round trips per allocation (1 → 40, 5 → 100, 10 → 175, 20 → 325),
   and its duration ≈ round trips × RTT. With Prisma's default 5 000 ms interactive-transaction
   timeout: 20 allocations = 0.12 s (no added latency), 0.85 s (2 ms RTT), 1.9 s (5 ms),
   3.5 s (10 ms), **P2028 timeout at 20 ms RTT**; 10 allocations = 3.6 s at 20 ms RTT. The
   production Vercel ↔ Supabase RTT is unmeasured (earlier P2028 incidents on much smaller
   transactions suggest it can be high). Decision required before FR.11: measure production
   RTT, then choose among a lower limit, an explicit settlement transaction timeout, and
   round-trip reduction (batched validation / allocation writes).
   **FR.11A:** round trips reduced (§5.3 batch form): 20 allocations = 88 in-transaction round
   trips (was 317), 2.04 s per request at 20 ms RTT (was a P2028 timeout). Limit stays **20**,
   conditional on a measured production p95 RTT ≤ 20 ms; otherwise ⌊(2000 / RTT − 28) / 3⌋.
   Transaction timeout unchanged. See `docs/fr11a-release-readiness.md` §1.
   **FR.11B:** read-only, Admin-only `GET /api/v1/admin/financial-release/latency-probe` measures
   the production RTT inside the deployed server; P2028 timeouts return 503 `TRANSACTION_TIMEOUT`
   (retry the same request — never a new key). Procedure and limit table:
   `docs/fr11b-release-readiness.md` §3.
2. **G7 mechanism** — **resolved in FR.11A**: `/version.json` handshake (§10).
3. **Paid-out mis-attribution** — when a RELEASE_REVERSAL is blocked because funds were paid out,
   V1 has no customer-receivable model; recovery is an off-system process recorded through an
   explicit, reasoned wallet ADJUSTMENT only once the customer actually returns funds.
4. **Shortfall after release** — a SETTLEMENT_SHORTFALL re-establishes a driver obligation
   while customer credits stand; whether a company-loss expense category is needed when the
   driver obligation is later written off is undecided (no write-off workflow exists in V1).
   **FR.11A:** the shortfall controls were found insufficient for a debt-creating operation
   (single actor, no evidence, no separation from the settlement receiver, no write-off). New
   shortfalls are refused (403 `SHORTFALL_POLICY_NOT_APPROVED`) unless
   `SETTLEMENT_SHORTFALL_POLICY_APPROVED=true`; recorded shortfalls and their replays are
   unaffected. Policy decisions P1–P8: `docs/fr11a-release-readiness.md` §4.
