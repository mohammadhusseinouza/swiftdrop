# FR.12A.8 — Historical Incident Evidence Recovery and Finance Decision Preparation

Status: **investigation and documentation only.** No production connection was made. No database
(production, main development or isolated) was modified. No schema, API, UI, posting or activation
change was made, and nothing was committed.

The queries in §3 were validated only on the local lab copy `swiftdrop_g3lab` (a simulated
deletion), inside read-only transactions that were rolled back.

Builds on `docs/fr12a7-historical-financial-ownership-design.md`.

> **Time-critical:** if the company's database provider keeps backups or point-in-time recovery
> (PITR) for a limited window, every day of delay may let a pre-deletion backup expire (§4). The
> backup check is the first action of the next phase.

---

## 1. Evidence inventory

| # | Evidence | Status | Where | Notes |
|---|---|---|---|---|
| V1 | Order type DELIVERY_ONLY; expected 210.00; actual 110.00; difference −100.00 | **Verified** (operator-reported) | surviving `COLLECTION_DIFFERENCE_RECORDED` audit | exact ids not yet recorded in any document; E1 retrieves them |
| V2 | Original driver cash COLLECTION deleted; its id is in the audit | **Verified** | audit `driverCashTransactionId`; the +110.00 chain jump | E1 `cash_row_still_exists = false`; E5 locates the jump |
| V3 | 110.00 handed over in the 572.00 settlement of 2026-10-16; driver cash 0.00 | **Verified** | settlement + its cash row; balance chain | FR.12A.1 I4 |
| V4 | No resolution before deletion | **Verified** | no `COLLECTION_DIFFERENCE_RESOLVED`; no wallet/company rows; G4 passes | E1 filter; FR.12A.1 I6 / I8 |
| V5 | Deletion scope | **Partly known** | operator: "every related record identifiable by its **order number**" | audits are keyed by order **UUID**, which is why the difference audit survived. E3 lists every other surviving audit naming the order |
| R1 | The driver's recorded difference reason | **Recoverable** (E4, restricted) | audit `collectionDifferenceReason` | a statement by the driver, **not** accounting evidence (§6) |
| R2 | Delivery time, payment-method route / change | **Recoverable** (E1) | audit `created_at`, metadata | which fields exist depends on the deployed version at delivery (E2 lists them) |
| R3 | Other audits mentioning the order (for example parcel intake / receipt) | **Possibly recoverable** (E3) | `audit_logs` | parcel audits carry driver ids only; no amounts or customer |
| U1 | Customer identity | **Not in surviving system records** | — | no order-creation audit exists; the order row is gone |
| U2 | `orderAmount`, `deliveryFee`, prepaid amounts, payment type | **Not in surviving system records** | — | only their combined remaining total (210.00) is known |
| U3 | Order number / tracking code | **Not in surviving system records** | — | order numbers are random (`ORD-YYYYMMDD-XXXXXX`), so no sequence gap can identify them |
| U4 | Why the receiver paid 110.00; who should bear 100.00 | **Unknown** | — | Finance decision on evidence (§6) |
| U5 | Any settlement with the customer outside SwiftDrop | **Unknown** | — | Finance confirmation required |

**Prohibited:**
- inferring the customer, the fee or the split from typical values, other orders or memory;
- treating the reason text as proof;
- recreating the order.

---

## 2. Identifiers to record

No production identifier is recorded in the repository. FR.12A.1 reported counts and amounts only.

The operator must record, from E1 (§3), in the incident record (not in tickets or chat):
- `audit_id`, `recorded_at`, `deleted_order_reference` (order UUID), `original_cash_transaction_id`;
- E5's `ledger_row_id` and `chain_jump` (must be 110.00) for the anchor row;
- the settlement id / number of the 572.00 settlement.

These are internal ids, not personal data.

---

## 3. Safe audit-inspection SQL (for operator review — not executed against production)

**Run only with explicit authorization.**
- Use the direct / session connection.
- Use read-only mode, either:
  - `psql` with `PGOPTIONS='-c default_transaction_read_only=on'`; or
  - each query wrapped in the SQL editor as `begin read only; <query>; rollback;`.
- Every query is a single `SELECT`: no data-modifying statements, no functions with side effects.
- Replace the placeholder UUID in `params` with the value from E1.

Validated on `swiftdrop_g3lab`:
- E1 found the simulated incident (1 row; expected 35, actual 30, difference −5; cash row absent);
- E2 listed 6 metadata keys;
- E3 found 1 audit;
- E4 returned the reason (content not displayed);
- E5 located the 30.00 jump;
- E6 listed 3 same-day deliveries.

**Privacy:**
- E1–E3, E5 and E6 return ids, amounts, roles and catalog names only. E1 shows `reason_length`, not
  the text.
- **E4 returns free text the driver typed**, which may contain customer or receiver personal data.
  Run it only for the authorized Finance reviewer, read it on screen, and do not paste it into
  tickets, chat or this repository. Summarize only what matters (for example "receiver refused one
  item"), in the incident record.

```sql
-- E1 — discover the surviving collection-difference audit(s) of deleted orders
select l.id                                              as audit_id,
       l.created_at                                      as recorded_at,
       l.entity_type,
       l.entity_id                                       as deleted_order_reference,
       l.metadata ->> 'orderType'                        as order_type,
       l.metadata ->> 'expectedAmount'                   as expected_amount,
       l.metadata ->> 'actualAmount'                     as actual_amount,
       l.metadata ->> 'difference'                       as difference,
       l.metadata ->> 'driverCashTransactionId'          as original_cash_transaction_id,
       exists (select 1 from driver_cash_transactions x where x.id::text = l.metadata ->> 'driverCashTransactionId') as cash_row_still_exists,
       l.metadata ->> 'collectionRoute'                  as collection_route,
       l.metadata ->> 'financialReleaseMode'             as financial_release_mode,
       (l.metadata ->> 'collectionPaymentMethodChanged')::boolean as payment_method_changed,
       pm_prev.name                                      as payment_method_before,
       pm_new.name                                       as payment_method_after,
       r.code                                            as actor_role,
       length(coalesce(l.metadata ->> 'collectionDifferenceReason', '')) as reason_length,
       l.previous_values,
       l.new_values
from audit_logs l
left join users u            on u.id = l.actor_user_id
left join roles r            on r.id = u.role_id
left join payment_methods pm_prev on pm_prev.id::text = l.metadata ->> 'previousCollectionPaymentMethodId'
left join payment_methods pm_new  on pm_new.id::text  = l.metadata ->> 'newCollectionPaymentMethodId'
where l.action = 'COLLECTION_DIFFERENCE_RECORDED'
  and l.entity_type = 'ORDER'
  and not exists (select 1 from orders o where o.id::text = l.entity_id)
  and not exists (select 1 from audit_logs z
                  where z.entity_type = 'ORDER' and z.entity_id = l.entity_id
                    and z.action = 'COLLECTION_DIFFERENCE_RESOLVED')
order by l.created_at;

-- E2 — every structured metadata field present on that audit
with params as (select '00000000-0000-0000-0000-000000000000'::uuid as audit_id)
select k.key, jsonb_typeof(l.metadata::jsonb -> k.key) as json_type
from audit_logs l
cross join params p
cross join lateral jsonb_object_keys(l.metadata::jsonb) as k(key)
where l.id = p.audit_id
order by k.key;

-- E3 — every surviving audit that mentions the deleted order anywhere
with params as (select '00000000-0000-0000-0000-000000000000'::text as order_ref)
select l.id as audit_id, l.created_at, l.action, l.entity_type,
       (l.entity_id = p.order_ref)                                     as is_entity,
       (coalesce(l.metadata::text, '') like '%' || p.order_ref || '%')        as in_metadata,
       (coalesce(l.previous_values::text, '') like '%' || p.order_ref || '%') as in_previous_values,
       (coalesce(l.new_values::text, '') like '%' || p.order_ref || '%')      as in_new_values
from audit_logs l cross join params p
where l.entity_id = p.order_ref
   or coalesce(l.metadata::text, '')        like '%' || p.order_ref || '%'
   or coalesce(l.previous_values::text, '') like '%' || p.order_ref || '%'
   or coalesce(l.new_values::text, '')      like '%' || p.order_ref || '%'
order by l.created_at;

-- E4 — RESTRICTED: the driver's free-text difference reason (authorized Finance reviewer only)
with params as (select '00000000-0000-0000-0000-000000000000'::uuid as audit_id)
select l.id as audit_id, l.created_at, l.metadata ->> 'collectionDifferenceReason' as recorded_difference_reason
from audit_logs l cross join params p
where l.id = p.audit_id and l.action = 'COLLECTION_DIFFERENCE_RECORDED';

-- E5 — chain breaks on the cash account of the driver who recorded the audit
with params as (select '00000000-0000-0000-0000-000000000000'::uuid as audit_id),
acct as (
  select a.id as account_id
  from audit_logs l cross join params p
  join drivers d on d.user_id = l.actor_user_id
  join driver_cash_accounts a on a.driver_id = d.id
  where l.id = p.audit_id
),
seq as (
  select t.id, t.created_at, t.type, t.amount, t.balance_before, t.balance_after, t.settlement_id,
         lag(t.balance_after) over (order by t.created_at, t.id) as prev_after
  from driver_cash_transactions t join acct on acct.account_id = t.account_id
)
select s.id as ledger_row_id, s.created_at, s.type, s.amount::text, s.balance_before::text, s.balance_after::text,
       (s.balance_before - coalesce(s.prev_after, 0))::text as chain_jump, s.settlement_id is not null as is_settlement
from seq s
where s.balance_before <> coalesce(s.prev_after, 0)
order by s.created_at;

-- E6 — OPTIONAL corroboration: surviving deliveries by the same driver on the same UTC day
with params as (select '00000000-0000-0000-0000-000000000000'::uuid as audit_id),
day as (
  select (l.created_at at time zone 'UTC')::date as d, u.id as driver_user_id
  from audit_logs l cross join params p join users u on u.id = l.actor_user_id
  where l.id = p.audit_id
)
select o.order_number, o.order_type, o.payment_type, o.amount_to_collect::text, o.actual_amount_collected::text,
       o.order_amount::text, o.delivery_fee::text, o.delivered_at
from orders o
join drivers dr on dr.id = o.current_driver_id
join day on dr.user_id = day.driver_user_id
where (o.delivered_at at time zone 'UTC')::date = day.d
order by o.delivered_at;
```

**Interpretation:**
- **E1:** must return **exactly one** row with 210 / 110 / −100, DELIVERY_ONLY,
  `cash_row_still_exists = false`, `actor_role = DRIVER`. Zero or several rows means STOP and
  investigate before anything else.
- **E5:** must show exactly one jump of 110.00, on the row after the deleted collection.
- **E6:** only helps match a printed day summary or manifest (§5). It never establishes the deleted
  order's amounts by subtraction alone.
- **Time zones:** E6's "UTC day" assumes the production session time zone is UTC, which is still an
  open preflight item (`docs/timezone-investigation.md`).

---

## 4. Backup availability findings

| Item | Finding |
|---|---|
| Backups in this repository | **None.** No `.dump`, `.backup`, `.bak`, `.sql.gz`, `.tar`, `.csv` or exported data file exists outside the migration SQL |
| `docs/spring_cargo_database` | A `pg_dump` artifact dated 2026-09-04, **schema only** (0 `COPY` / `INSERT` statements). It predates the incident window (driver cash rows from 2026-09-18) and contains no data. **Not evidence** |
| Local / isolated PostgreSQL databases | All are copies of the local development database or test labs. Local dev holds 34 orders and 16 driver cash rows, against production's 518 cash rows. No document records a production data import. **They cannot contain the deleted order** |
| Saved preflight reports / number-mapping exports | None in the repository. `scripts/export-number-mapping.mjs` writes **outside** the repository, if it was ever run, and holds customer/driver number mappings, not orders |
| Production build logs (Vercel) | **Possible corroboration only.** Production builds log `financialSnapshot` counts and md5 fingerprints, including `orders` (count) and `orders_relationship_hash` = md5 over `id \| customer_id \| current_driver_id`. A log from **after the delivery and before the deletion** cannot reveal the customer, but can **verify** a candidate: rebuild the hash from surviving orders plus the candidate row and compare. The orders count across build logs can also bracket the deletion time. Retention, and whether such a deployment happened in that window, are **unverified** |
| Database provider backups (Supabase) | **Unverified.** Do not assume they exist. Plan, scheduled backups, retention and point-in-time recovery (PITR) were never recorded (operator preflight S1–S3 / B1–B3 unanswered). Plans without dashboard backups exist, and retention windows are short, so a pre-deletion backup may already have expired or may expire soon |
| SQL editor history / saved snippets / database logs at the provider | **Possible:** the deletion statements may still show the order number or UUID. They help locate documents only; they are not financial evidence. Retention is unverified |
| Accounting exports | V1 has no Excel/PDF export. Only printed or saved documents (§5) |

**Classification:**
- confirmed available backups: **none**;
- possible locations: provider backups / PITR, build logs, SQL editor history, printed documents;
- known unavailable: repository dumps and local databases.

**If an authentic backup is found:**
1. **Never restore in place** into the production project. Restoring replaces the live database and
   would destroy everything since the backup.
2. Use only a downloaded copy, or a restore into a **new, separate** project / an isolated local
   database (`createdb swiftdrop_fr12a8_backup` and `pg_restore`; never `--clean` against an
   existing database).
3. Record provenance:
   - source;
   - backup timestamp (must be after the delivery and before the deletion);
   - who downloaded it;
   - the file's SHA-256 on download;
   - chain of custody.
4. Verify integrity:
   - the file hash;
   - the restore completes without errors;
   - the target order exists with the audit's UUID, `amount_to_collect = 210.00`,
     `actual_amount_collected = 110.00`, `REVIEW_REQUIRED`;
   - its COLLECTION row has the audit's id;
   - surviving rows (the 572.00 settlement if after it, the other orders) match production.
5. Read only: the order row (`customer_id`, `order_amount`, `delivery_fee`, prepaid amounts,
   `payment_type`, `order_number`, `tracking_code`), its status history and attempts, and the
   COLLECTION row.

---

## 5. Customer identification sources

| Source | What it would show | Authentication |
|---|---|---|
| Pre-deletion backup | the order row: `customer_id`, number, amounts | provenance + integrity (§4). **Primary evidence** |
| A5 order label (`client/src/lib/orderLabelPrint.ts`) printed for the parcel | order number, tracking code, **customer name**, **order amount, delivery fee**, prepaid amounts, amount to collect | the original paper / PDF; the order number's date prefix matches the delivery period; the tracking barcode; amounts must total 210.00 |
| Customer orders statement (`customerOrdersInvoicePrint.ts`) printed for a customer covering the period | per order: number, **order price, delivery fee** | an original copy held by staff or the customer; it must list the order number and amounts consistent with 210.00 |
| Finalize Day summary (`dailyDeliverySummary.ts`) printed for the delivery day | the day's delivered orders and totals | an original copy; cross-check with E6. Corroboration only |
| Customer's own records / correspondence | what the customer sent and was told | written records with dates; the customer's statement alone is a claim, not proof |
| Driver / operations staff statements | context (receiver refused an item, …) | signed statement. Supporting only |
| Build-log hash check (§4) | confirms or refutes a candidate `customer_id` | requires a pre-deletion log; computed in an isolated environment |

**Identity rule:** a customer is established only by a primary source (backup), or by at least one
original document plus one independent corroboration, all consistent with the verified facts (V1–V3).
Finance decision F1 sets the exact standard.

---

## 6. Financial allocation evidence

| Fact Finance needs | Required evidence | Survives today? |
|---|---|---|
| Delivery fee | backup row, label, or statement | **no** |
| Goods value / order amount | same | **no** |
| Expected 210.00 breakdown (remaining order amount + remaining fee; prepaid amounts) | same | only the total |
| Actual 110.00 breakdown (what the receiver paid for) | receiver / driver account plus documents; the audit reason (E4) as a pointer | **no** (only a free-text pointer, after E4) |
| Shortfall cause and responsibility | reason (E4) + documents + Finance decision | **no** |
| Handled outside SwiftDrop? | receipts, correspondence, Finance records | unknown |

The free-text reason (E4) is a driver's statement entered at delivery. It can guide where to look
and corroborate other evidence, but it is **not** proof of amounts or responsibility.

**No posting amounts are recommended.** The evidence to determine any split does not currently
exist in the system.

---

## 7. Evidence gaps (summary)

1. Customer identity (U1).
2. Delivery fee, goods value and payment type (U2).
3. Shortfall cause and responsibility (U4).
4. External handling (U5).
5. Exact production ids not yet recorded (§2).
6. Backup availability unverified (§4).
7. Deletion time window unverified.

---

## 8. Recovery decision tree

```
Run E1–E5 (authorized, read-only) ─► record ids; E1 = 1 row, E5 = 110.00 jump?
   │ no → STOP: re-investigate the incident scope
   ▼ yes
Check the provider backups / PITR NOW (dashboard, read-only); locate build logs
   │
   ├── Path A: authentic pre-deletion backup found
   │     1. preserve the source; download / hash; record provenance
   │     2. restore ONLY into an isolated database (never in place)
   │     3. verify integrity (§4 step 4)
   │     4. read the order, customer, amounts, status history
   │     5. reassess: authentic RESTORATION of the deleted rows (FR.12A.2 option A) vs the
   │        FR.12A.7 ownership model. Restoration makes the normal resolution endpoint usable,
   │        and the ledger reconciliation must then be revoked
   │     6. separate approval before ANY production repair
   │
   └── Path B: no authentic backup
         1. collect labels, statements, day summaries, correspondence (§5)
         2. read E4 (restricted); obtain driver / ops statements
         3. assemble the evidence package (hashes, provenance)
         4. list the facts still missing
         5. Finance decisions F1–F10 (§9). If customer, fee or goods value stay unproven:
            NO allocation; the funds stay UNRESOLVED; G5 keeps blocking
         6. ownership implementation (FR.12A.9+) proceeds only if the evidence is sufficient
            or Finance approves an evidence-free policy (F7)
```

---

## 9. Finance decision package (to be completed by Finance — no decision is recorded here)

| # | Item | Content now | Decision possible now? |
|---|---|---|---|
| 1 | Confirmed transaction facts | V1–V4 (§1) | n/a |
| 2 | Evidence references | to be filled from E1/E5 (§2) and collected documents (hashes) | — |
| 3 | Customer identification evidence | none yet | **No** |
| 4 | Delivery fee and goods-value evidence | none yet | **No** |
| 5 | Shortfall cause and responsibility | reason text unread (E4); no documents | **No** |
| 6 | Possible allocation treatments | FR.12A.7 §6: C split (preferred with evidence); A / B edge cases; D unallocated (current); E external | only D can apply today |
| 7 | Outstanding uncertainties | §7 | — |
| 8 | Recommended next action | authorize the read-only evidence collection (§10) | **Yes** (authorization, not accounting) |
| 9 | Required Finance approvals | F1–F10 below | — |
| 10 | Remaining release blockers | G5 (historical ownership); G3 depends on the separately approved ledger reconciliation; activation authorization, time zone and other FR.11 blockers unchanged | — |

**Finance checklist:**
- **F1** Customer-identity evidence standard.
- **F2** Fee / goods-value evidence standard and the tie-break when sources disagree.
- **F3** Shortfall responsibility (customer / company / shared), with the evidence relied on.
- **F4** Allocation of the 110.00 (only once F1–F3 are met).
- **F5** Ledger types and reporting treatment (FR.12A.7 D6 / D7).
- **F6** Who executes the posting (FR.12A.7 D8).
- **F7** Policy if the customer cannot be identified (remain unallocated vs an approved
  unclaimed-funds policy).
- **F8** Whether an externally-settled outcome may release G5.
- **F9** Approval of the backup / PITR search and of any restore into an isolated environment.
- **F10** Confirmation that activation stays blocked while G5 blocks.

Each line needs a named Finance approver, the date and the evidence relied on. **No approval is
recorded on anyone's behalf in this document.**

---

## 10. Go / no-go for ownership implementation

| Item | Verdict |
|---|---|
| Posting implementation (FR.12A.12) or any allocation | **NO-GO.** No customer, fee or goods-value evidence; F1–F4 undecided |
| Ownership schema / workflow without posting (FR.12A.9–11) | **Hold.** Technically possible, but premature: if Path A succeeds, authentic restoration may make it unnecessary. Decide after §8 |
| Read-only evidence collection | **GO**, subject to explicit authorization (production read access, the Finance viewer for E4) |
| G5 | remains blocking (unchanged) |

## 11. Next recommended phase

**FR.12A.8b — Authorized evidence collection (operator + Finance; no code):**
1. Read-only, in production, with authorization:
   - run E1–E3 and E5, and record the ids in the incident record;
   - the Finance reviewer runs E4;
   - E6 only if a day summary needs matching.
2. **Immediately:** check the provider dashboard for scheduled backups / PITR and their retention.
   Record the plan, the earliest recovery point and whether it predates the deletion. Change nothing.
3. Locate production build logs between the delivery and the deletion (orders count;
   `orders_relationship_hash`).
4. Ask operations and the customer-facing staff for printed labels, statements, day summaries and
   correspondence. Hash and store the originals outside the repository.
5. Then a Finance decision session on F1–F10, and a review gate that chooses Path A (restoration
   assessment) or Path B (the FR.12A.7 model, FR.12A.9).

---

## 12. FR.12A.8b — Replacement-order evidence report (read-only, offline)

Status: **read-only investigation aid.** No API, page, schema, gate, release rule or reconciliation
approval was changed. The G5 exception rejected in the Phase A assessment is **not** implemented. The
report has not been run against production.

**Why it exists.** The owner reports that a *replacement order* was created for the deleted order
`0c937fee-8ebd-4679-8113-5bad8b713f01`, but no record links the two. E1–E6 (§3) cover the deleted
order itself. This report adds a structured search for **potential** replacement orders, and for the
movements, assignments, settlements and payouts around them.

**Code.**
- `server/src/modules/historical-reconciliation/incident-evidence-report.ts`: the queries (E1S, E3S,
  E5S, E6S, E7–E12) and the classification into confirmed facts, potential matches, missing evidence
  and unresolved assumptions.
- `server/scripts/fr12a8-incident-evidence-report.mjs`: the operator script. It forces the session
  read-only, verifies it, runs every query in one `READ ONLY` transaction and rolls it back.
- `server/tests/historical-reconciliation/incident-evidence-report.test.ts`.

**Run it (authorized operator only, direct / session connection):**

```
EVIDENCE_DATABASE_URL="<read-only direct URL, port 5432>" \
npx tsx scripts/fr12a8-incident-evidence-report.mjs \
  --order 0c937fee-8ebd-4679-8113-5bad8b713f01 [--days-before 7] [--days-after 30] [--out <file outside the repo>]
```

- Exit code 0 = report produced; 2 = STOP; 1 = failed.
- `--print-sql` prints the SQL in §12.4 with the inputs bound, for psql. It makes no connection.
- The `--out` JSON holds order / customer / driver / settlement / payout **numbers**. Store it with
  the incident record, not in tickets or chat.

### 12.1 What the report never does

- It never identifies a replacement. `replacementIdentified` is always `false`; identification is a
  Finance decision on documents (§5, F1).
- It never selects a candidate on dates, amounts or driver identity **alone**.
  - A candidate must show at least one *content* signal (§12.2) inside the window.
  - Matching the driver or the order type is shown only as an annotation.
  - Incident-driver orders without any content signal are **counted** (E12), never silently dropped.
- It never selects receiver, customer or user names, phones, addresses or free text. Free text only
  feeds boolean signals. The driver's difference reason (E4) stays restricted and is not read.
- It never writes.

### 12.2 Signals (each shown separately; none is proof)

| Signal | Meaning |
|---|---|
| expected total | `amount_to_collect` or `order_amount + delivery_fee` equals the recorded expected amount (210) |
| actual amount | `amount_to_collect` or `actual_amount_collected` equals the recorded actual amount (110) |
| difference | the same, against the recorded difference (100) |
| nothing to collect | `amount_to_collect = 0` or `ALREADY_PAID` (the cash was already in hand) |
| back-entered | delivered within 30 minutes of creation |
| mentions deleted reference | order text, status-history text or the order's audits contain the deleted UUID (or its first 8 characters) |
| replacement wording | order or status-history text matches replac / re-enter / re-create / duplicat / delet / resubmit (English only) |
| *annotation:* incident driver | delivery assignment / attempt, or parcel collection, by the driver who recorded the difference |
| *annotation:* same order type | DELIVERY_ONLY |

The window is 7 days before to 30 days after the recorded delivery by default. "Before" covers a
duplicate that existed first. Widen it with `--days-before` / `--days-after` if nothing plausible is
found.

### 12.3 Queries and interpretation

| Query | Content | Interpretation |
|---|---|---|
| E1S | E1 scoped to this reference | must be **exactly one** row, order absent, not resolved; otherwise STOP |
| E3S | audits naming the reference (action and flags only) | the deletion scope (V5) |
| E5S | chain jumps on the incident driver's account, with the settlement row | exactly one jump equal to the actual amount after the delivery (V2/V3) |
| E6S | the driver's surviving deliveries that UTC day (E6, using delivery attempts as well as the current driver) | corroboration for a printed day summary only |
| E7 | potential replacement orders and their signals | a **list for Finance review**, never an identification |
| E8 | ledger movements of the potential matches; for driver cash, the linked or next settlement | "next settlement" is **positional**: legacy settlements are amount-only |
| E9 | delivery / collection assignments, attempts and status history (no notes) | who handled each potential match, and when |
| E10 | payouts to the potential matches' customers since the window start | payouts debit the wallet, **not** an order; no payout can be tied to an order from the system |
| E11 | the incident driver's settlements since the window start | `amount_only_legacy_format = true` means which collections it covered was never recorded |
| E12 | coverage counts and the window bounds | how much was **not** listed |

**Reading a potential match.** Promote a match to Finance only together with documentary evidence
(§5):
- a label or statement with the same customer and amounts;
- the customer's or the driver's written account;
- the build-log hash check (§4).

Even then, the identification is a Finance decision F1, recorded outside this report.

### 12.4 Read-only SQL for the next production evidence-recovery step

Generated by `--print-sql` for the incident reference, default window. Run it as one script in
psql. It opens a `READ ONLY` transaction and ends with `ROLLBACK`.

```sql
BEGIN TRANSACTION READ ONLY;

-- E1S — Unresolved collection-difference audit(s) of the deleted order (must be exactly one)
SELECT
  l.id::text AS audit_id,
  to_char((l.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at_utc,
  l.metadata ->> 'orderType' AS order_type,
  l.metadata ->> 'expectedAmount' AS expected_amount,
  l.metadata ->> 'actualAmount' AS actual_amount,
  l.metadata ->> 'difference' AS difference,
  l.metadata ->> 'driverCashTransactionId' AS original_cash_transaction_id,
  EXISTS (SELECT 1 FROM driver_cash_transactions x
          WHERE x.id::text = l.metadata ->> 'driverCashTransactionId') AS cash_row_still_exists,
  EXISTS (SELECT 1 FROM orders o WHERE o.id::text = l.entity_id) AS order_still_exists,
  EXISTS (SELECT 1 FROM audit_logs z
          WHERE z.entity_type = 'ORDER' AND z.entity_id = l.entity_id
            AND z.action = 'COLLECTION_DIFFERENCE_RESOLVED') AS resolved,
  l.metadata ->> 'collectionRoute' AS collection_route,
  r.code AS actor_role,
  dr.id::text AS driver_id,
  dr.driver_number
FROM audit_logs l
LEFT JOIN users u ON u.id = l.actor_user_id
LEFT JOIN roles r ON r.id = u.role_id
LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
  AND l.entity_type = 'ORDER'
  AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
  AND 7::int >= 0
  AND 30::int >= 0
ORDER BY l.created_at, l.id;

-- E3S — Every surviving audit that names the deleted order (no payload content)
SELECT
  l.id::text AS audit_id,
  to_char((l.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_utc,
  l.action,
  l.entity_type,
  r.code AS actor_role,
  (l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text) AS is_entity,
  (coalesce(l.metadata::text, '')
    LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%') AS in_metadata,
  (concat_ws(' ', l.previous_values::text, l.new_values::text)
    LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%') AS in_values
FROM audit_logs l
LEFT JOIN users u ON u.id = l.actor_user_id
LEFT JOIN roles r ON r.id = u.role_id
WHERE 7::int >= 0
  AND 30::int >= 0
  AND (l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    OR concat_ws(' ', l.metadata::text, l.previous_values::text, l.new_values::text)
      LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%')
ORDER BY l.created_at, l.id;

-- E5S — Balance-chain jumps on the incident driver's cash account, with the settlement row they fall on
WITH 
inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
),
seq AS (
  SELECT
    t.*,
    lag(t.balance_after) OVER (ORDER BY t.created_at, t.id) AS prev_after
  FROM driver_cash_transactions t
  JOIN inc ON inc.account_id = t.account_id
)
SELECT
  s.id::text AS ledger_row_id,
  to_char((s.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_utc,
  s.type::text AS type,
  s.amount::text AS amount,
  s.balance_before::text AS balance_before,
  s.balance_after::text AS balance_after,
  (s.balance_before - coalesce(s.prev_after, 0))::text AS chain_jump,
  ((s.balance_before - coalesce(s.prev_after, 0)) = inc.actual_amount) AS jump_equals_actual_amount,
  (s.created_at >= inc.recorded_at) AS after_recorded_delivery,
  ds.settlement_number,
  ds.amount_received::text AS settlement_amount_received
FROM seq s
CROSS JOIN inc
LEFT JOIN driver_settlements ds ON ds.id = s.settlement_id
WHERE s.balance_before <> coalesce(s.prev_after, 0)
ORDER BY s.created_at, s.id;

-- E6S — Surviving deliveries by the incident driver on the same UTC day (corroboration only)
WITH 
inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
)
SELECT
  o.order_number,
  c.customer_number,
  o.order_type::text AS order_type,
  o.payment_type::text AS payment_type,
  o.order_amount::text AS order_amount,
  o.delivery_fee::text AS delivery_fee,
  o.amount_to_collect::text AS amount_to_collect,
  o.actual_amount_collected::text AS actual_amount_collected,
  to_char((o.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
  to_char((o.delivered_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS delivered_at_utc
FROM orders o
CROSS JOIN inc
JOIN customers c ON c.id = o.customer_id
WHERE o.delivered_at IS NOT NULL
  AND (o.delivered_at AT TIME ZONE 'UTC')::date = (inc.recorded_at AT TIME ZONE 'UTC')::date
  AND (o.current_driver_id = inc.driver_id
    OR EXISTS (SELECT 1 FROM delivery_attempts x
               WHERE x.order_id = o.id AND x.driver_id = inc.driver_id
                 AND x.outcome = 'DELIVERED'))
ORDER BY o.delivered_at, o.id;

-- E7 — POTENTIAL replacement orders in the window, with every signal shown separately (not identification)
WITH 

inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
),
win_orders AS (
  SELECT
    o.*,
    (EXISTS (SELECT 1 FROM order_assignments x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      OR EXISTS (SELECT 1 FROM delivery_attempts x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id))
      AS s_incident_driver_delivery,
    EXISTS (SELECT 1 FROM parcel_collection_assignments x
            WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      AS s_incident_driver_collection,
    (o.order_type::text = inc.order_type) AS s_same_order_type,
    (o.amount_to_collect = inc.expected_amount
      OR o.order_amount + o.delivery_fee = inc.expected_amount) AS s_expected_total,
    (o.amount_to_collect = inc.actual_amount
      OR o.actual_amount_collected = inc.actual_amount) AS s_actual_amount,
    (o.amount_to_collect = inc.difference_abs
      OR o.actual_amount_collected = inc.difference_abs) AS s_difference_amount,
    (o.amount_to_collect = 0 OR o.payment_type = 'ALREADY_PAID') AS s_nothing_to_collect,
    (o.delivered_at IS NOT NULL
      AND o.delivered_at - o.created_at <= interval '30 minutes') AS s_back_entered,
    (concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes)
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR coalesce((SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id), '')
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR EXISTS (
        SELECT 1 FROM audit_logs z
        WHERE z.entity_type = 'ORDER' AND z.entity_id = o.id::text
          AND concat_ws(' ', z.metadata::text, z.previous_values::text, z.new_values::text)
            LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%'))
      AS s_mentions_deleted_reference,
    (concat_ws(' ', concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes),
        (SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id))
      ~* '(replac|re-?enter|re-?creat|duplicat|delet|resubmit)') AS s_replacement_wording
  FROM orders o
  CROSS JOIN inc
  CROSS JOIN win
  WHERE o.created_at >= win.from_at
    AND o.created_at < win.to_at
    AND o.id::text <> '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
),
cand AS (
  SELECT * FROM win_orders
  WHERE s_expected_total OR s_actual_amount OR s_difference_amount
     OR s_nothing_to_collect OR s_back_entered
     OR s_mentions_deleted_reference OR s_replacement_wording
)
SELECT
  c.id::text AS order_id,
  c.order_number,
  cu.customer_number,
  c.order_type::text AS order_type,
  c.payment_type::text AS payment_type,
  c.status::text AS status,
  c.financial_status::text AS financial_status,
  c.financial_release_mode::text AS release_mode,
  c.order_amount::text AS order_amount,
  c.delivery_fee::text AS delivery_fee,
  c.prepaid_order_amount::text AS prepaid_order_amount,
  c.prepaid_delivery_fee::text AS prepaid_delivery_fee,
  c.amount_to_collect::text AS amount_to_collect,
  c.actual_amount_collected::text AS actual_amount_collected,
  to_char((c.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
  to_char((c.delivered_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS delivered_at_utc,
  c.s_expected_total,
  c.s_actual_amount,
  c.s_difference_amount,
  c.s_nothing_to_collect,
  c.s_back_entered,
  c.s_mentions_deleted_reference,
  c.s_replacement_wording,
  c.s_incident_driver_delivery,
  c.s_incident_driver_collection,
  c.s_same_order_type
FROM cand c
JOIN customers cu ON cu.id = c.customer_id
ORDER BY c.created_at, c.id;

-- E8 — Ledger movements of the potential matches (driver cash, wallet, company, direct, release)
WITH 

inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
),
win_orders AS (
  SELECT
    o.*,
    (EXISTS (SELECT 1 FROM order_assignments x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      OR EXISTS (SELECT 1 FROM delivery_attempts x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id))
      AS s_incident_driver_delivery,
    EXISTS (SELECT 1 FROM parcel_collection_assignments x
            WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      AS s_incident_driver_collection,
    (o.order_type::text = inc.order_type) AS s_same_order_type,
    (o.amount_to_collect = inc.expected_amount
      OR o.order_amount + o.delivery_fee = inc.expected_amount) AS s_expected_total,
    (o.amount_to_collect = inc.actual_amount
      OR o.actual_amount_collected = inc.actual_amount) AS s_actual_amount,
    (o.amount_to_collect = inc.difference_abs
      OR o.actual_amount_collected = inc.difference_abs) AS s_difference_amount,
    (o.amount_to_collect = 0 OR o.payment_type = 'ALREADY_PAID') AS s_nothing_to_collect,
    (o.delivered_at IS NOT NULL
      AND o.delivered_at - o.created_at <= interval '30 minutes') AS s_back_entered,
    (concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes)
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR coalesce((SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id), '')
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR EXISTS (
        SELECT 1 FROM audit_logs z
        WHERE z.entity_type = 'ORDER' AND z.entity_id = o.id::text
          AND concat_ws(' ', z.metadata::text, z.previous_values::text, z.new_values::text)
            LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%'))
      AS s_mentions_deleted_reference,
    (concat_ws(' ', concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes),
        (SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id))
      ~* '(replac|re-?enter|re-?creat|duplicat|delet|resubmit)') AS s_replacement_wording
  FROM orders o
  CROSS JOIN inc
  CROSS JOIN win
  WHERE o.created_at >= win.from_at
    AND o.created_at < win.to_at
    AND o.id::text <> '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
),
cand AS (
  SELECT * FROM win_orders
  WHERE s_expected_total OR s_actual_amount OR s_difference_amount
     OR s_nothing_to_collect OR s_back_entered
     OR s_mentions_deleted_reference OR s_replacement_wording
)
SELECT
  m.order_number,
  m.ledger,
  m.type,
  m.amount,
  m.party,
  m.settlement_ref,
  m.settlement_basis,
  to_char((m.at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_utc
FROM (
  SELECT
    c.order_number,
    'DRIVER_CASH' AS ledger,
    t.type::text AS type,
    t.amount::text AS amount,
    dr.driver_number AS party,
    coalesce(ds.settlement_number, nx.settlement_number) AS settlement_ref,
    CASE WHEN ds.id IS NOT NULL THEN 'linked'
         WHEN nx.settlement_number IS NOT NULL
           THEN 'next settlement on the account (positional only)'
    END AS settlement_basis,
    t.created_at AS at
  FROM cand c
  JOIN driver_cash_transactions t ON t.order_id = c.id
  JOIN drivers dr ON dr.id = t.driver_id
  LEFT JOIN driver_settlements ds ON ds.id = t.settlement_id
  LEFT JOIN LATERAL (
    SELECT s2.settlement_number
    FROM driver_cash_transactions n
    JOIN driver_settlements s2 ON s2.id = n.settlement_id
    WHERE n.account_id = t.account_id
      AND n.type = 'SETTLEMENT'
      AND (n.created_at, n.id) > (t.created_at, t.id)
    ORDER BY n.created_at, n.id
    LIMIT 1
  ) nx ON t.type = 'COLLECTION'
  UNION ALL
  SELECT c.order_number, 'CUSTOMER_WALLET', w.type::text, (w.credit - w.debit)::text,
         cu.customer_number, NULL, NULL, w.created_at
  FROM cand c
  JOIN wallet_transactions w ON w.order_id = c.id
  JOIN customers cu ON cu.id = w.customer_id
  UNION ALL
  SELECT c.order_number, 'COMPANY', f.type::text, f.amount::text,
         NULL, NULL, NULL, f.created_at
  FROM cand c
  JOIN company_financial_transactions f ON f.order_id = c.id
  UNION ALL
  SELECT c.order_number, 'DIRECT_COMPANY_COLLECTION', 'DIRECT', k.amount::text,
         NULL, NULL, NULL, k.created_at
  FROM cand c
  JOIN company_direct_collections k ON k.order_id = c.id
  UNION ALL
  SELECT c.order_number, 'FINANCIAL_RELEASE',
         r.release_status::text || '/' || r.review_status::text, r.collection_amount::text,
         NULL, NULL, NULL, r.created_at
  FROM cand c
  JOIN order_financial_releases r ON r.order_id = c.id
) m
ORDER BY m.order_number, m.at, m.ledger;

-- E9 — Assignment, delivery-attempt and status history of the potential matches (no notes)
WITH 

inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
),
win_orders AS (
  SELECT
    o.*,
    (EXISTS (SELECT 1 FROM order_assignments x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      OR EXISTS (SELECT 1 FROM delivery_attempts x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id))
      AS s_incident_driver_delivery,
    EXISTS (SELECT 1 FROM parcel_collection_assignments x
            WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      AS s_incident_driver_collection,
    (o.order_type::text = inc.order_type) AS s_same_order_type,
    (o.amount_to_collect = inc.expected_amount
      OR o.order_amount + o.delivery_fee = inc.expected_amount) AS s_expected_total,
    (o.amount_to_collect = inc.actual_amount
      OR o.actual_amount_collected = inc.actual_amount) AS s_actual_amount,
    (o.amount_to_collect = inc.difference_abs
      OR o.actual_amount_collected = inc.difference_abs) AS s_difference_amount,
    (o.amount_to_collect = 0 OR o.payment_type = 'ALREADY_PAID') AS s_nothing_to_collect,
    (o.delivered_at IS NOT NULL
      AND o.delivered_at - o.created_at <= interval '30 minutes') AS s_back_entered,
    (concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes)
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR coalesce((SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id), '')
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR EXISTS (
        SELECT 1 FROM audit_logs z
        WHERE z.entity_type = 'ORDER' AND z.entity_id = o.id::text
          AND concat_ws(' ', z.metadata::text, z.previous_values::text, z.new_values::text)
            LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%'))
      AS s_mentions_deleted_reference,
    (concat_ws(' ', concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes),
        (SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id))
      ~* '(replac|re-?enter|re-?creat|duplicat|delet|resubmit)') AS s_replacement_wording
  FROM orders o
  CROSS JOIN inc
  CROSS JOIN win
  WHERE o.created_at >= win.from_at
    AND o.created_at < win.to_at
    AND o.id::text <> '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
),
cand AS (
  SELECT * FROM win_orders
  WHERE s_expected_total OR s_actual_amount OR s_difference_amount
     OR s_nothing_to_collect OR s_back_entered
     OR s_mentions_deleted_reference OR s_replacement_wording
)
SELECT
  e.order_number,
  e.kind,
  e.driver_number,
  to_char((e.at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_utc,
  to_char((e.ended) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ended_utc,
  e.detail,
  e.is_incident_driver
FROM (
  SELECT c.order_number, 'DELIVERY_ASSIGNMENT' AS kind, dr.driver_number,
         x.assigned_at AS at, x.ended_at AS ended, x.end_reason AS detail,
         (x.driver_id = inc.driver_id) AS is_incident_driver
  FROM cand c
  CROSS JOIN inc
  JOIN order_assignments x ON x.order_id = c.id
  JOIN drivers dr ON dr.id = x.driver_id
  UNION ALL
  SELECT c.order_number, 'COLLECTION_ASSIGNMENT', dr.driver_number,
         x.assigned_at, x.ended_at, x.end_reason::text,
         (x.driver_id = inc.driver_id)
  FROM cand c
  CROSS JOIN inc
  JOIN parcel_collection_assignments x ON x.order_id = c.id
  JOIN drivers dr ON dr.id = x.driver_id
  UNION ALL
  SELECT c.order_number, 'DELIVERY_ATTEMPT', dr.driver_number,
         x.started_at, x.completed_at,
         x.outcome::text || ' expected ' || x.expected_collection::text
           || ' actual ' || coalesce(x.actual_collection::text, '-'),
         (x.driver_id = inc.driver_id)
  FROM cand c
  CROSS JOIN inc
  JOIN delivery_attempts x ON x.order_id = c.id
  JOIN drivers dr ON dr.id = x.driver_id
  UNION ALL
  SELECT c.order_number, 'STATUS', NULL,
         h.created_at, NULL,
         coalesce(h.from_status::text, '-') || ' -> ' || h.to_status::text,
         NULL
  FROM cand c
  JOIN order_status_history h ON h.order_id = c.id
) e
ORDER BY e.order_number, e.at, e.kind;

-- E10 — Payouts to the potential matches' customers since the window start (wallet-level, not order-linked)
WITH 

inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
),
win_orders AS (
  SELECT
    o.*,
    (EXISTS (SELECT 1 FROM order_assignments x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      OR EXISTS (SELECT 1 FROM delivery_attempts x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id))
      AS s_incident_driver_delivery,
    EXISTS (SELECT 1 FROM parcel_collection_assignments x
            WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      AS s_incident_driver_collection,
    (o.order_type::text = inc.order_type) AS s_same_order_type,
    (o.amount_to_collect = inc.expected_amount
      OR o.order_amount + o.delivery_fee = inc.expected_amount) AS s_expected_total,
    (o.amount_to_collect = inc.actual_amount
      OR o.actual_amount_collected = inc.actual_amount) AS s_actual_amount,
    (o.amount_to_collect = inc.difference_abs
      OR o.actual_amount_collected = inc.difference_abs) AS s_difference_amount,
    (o.amount_to_collect = 0 OR o.payment_type = 'ALREADY_PAID') AS s_nothing_to_collect,
    (o.delivered_at IS NOT NULL
      AND o.delivered_at - o.created_at <= interval '30 minutes') AS s_back_entered,
    (concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes)
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR coalesce((SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id), '')
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR EXISTS (
        SELECT 1 FROM audit_logs z
        WHERE z.entity_type = 'ORDER' AND z.entity_id = o.id::text
          AND concat_ws(' ', z.metadata::text, z.previous_values::text, z.new_values::text)
            LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%'))
      AS s_mentions_deleted_reference,
    (concat_ws(' ', concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes),
        (SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id))
      ~* '(replac|re-?enter|re-?creat|duplicat|delet|resubmit)') AS s_replacement_wording
  FROM orders o
  CROSS JOIN inc
  CROSS JOIN win
  WHERE o.created_at >= win.from_at
    AND o.created_at < win.to_at
    AND o.id::text <> '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
),
cand AS (
  SELECT * FROM win_orders
  WHERE s_expected_total OR s_actual_amount OR s_difference_amount
     OR s_nothing_to_collect OR s_back_entered
     OR s_mentions_deleted_reference OR s_replacement_wording
)
SELECT
  p.payout_number,
  cu.customer_number,
  p.amount::text AS amount,
  p.status::text AS status,
  to_char((p.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
  w.balance_before::text AS wallet_balance_before,
  w.balance_after::text AS wallet_balance_after
FROM customer_payouts p
CROSS JOIN win
JOIN customers cu ON cu.id = p.customer_id
LEFT JOIN wallet_transactions w ON w.payout_id = p.id AND w.type = 'PAYOUT'
WHERE p.customer_id IN (SELECT customer_id FROM cand)
  AND p.created_at >= win.from_at
ORDER BY p.created_at, p.id;

-- E11 — Incident driver's settlements from the window start
WITH 
inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
)
SELECT
  s.settlement_number,
  to_char((s.created_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at_utc,
  s.balance_before::text AS balance_before,
  s.amount_received::text AS amount_received,
  s.balance_after::text AS balance_after,
  s.allocated_total::text AS allocated_total,
  s.unattributed_amount::text AS unattributed_amount,
  (s.allocated_total IS NULL) AS amount_only_legacy_format
FROM driver_settlements s
CROSS JOIN inc
CROSS JOIN win
WHERE s.driver_id = inc.driver_id
  AND s.created_at >= win.from_at
ORDER BY s.created_at, s.id;

-- E12 — Coverage: window orders, potential matches, incident-driver orders without a content signal
WITH 

inc AS (
  SELECT
    l.id AS audit_id,
    l.created_at AS recorded_at,
    l.metadata ->> 'orderType' AS order_type,
    CASE WHEN (l.metadata ->> 'expectedAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'expectedAmount')::numeric END AS expected_amount,
    CASE WHEN (l.metadata ->> 'actualAmount') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'actualAmount')::numeric END AS actual_amount,
    abs(CASE WHEN (l.metadata ->> 'difference') ~ '^-?[0-9]+([.][0-9]+)?$'
           THEN (l.metadata ->> 'difference')::numeric END) AS difference_abs,
    dr.id AS driver_id,
    a.id AS account_id
  FROM audit_logs l
  LEFT JOIN drivers dr ON dr.user_id = l.actor_user_id
  LEFT JOIN driver_cash_accounts a ON a.driver_id = dr.id
  WHERE l.action = 'COLLECTION_DIFFERENCE_RECORDED'
    AND l.entity_type = 'ORDER'
    AND l.entity_id = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
    AND NOT EXISTS (SELECT 1 FROM orders o WHERE o.id::text = '0c937fee-8ebd-4679-8113-5bad8b713f01'::text)
  ORDER BY l.created_at, l.id
  LIMIT 1
),
win AS (
  SELECT
    recorded_at - make_interval(days => 7::int) AS from_at,
    recorded_at + make_interval(days => 30::int) AS to_at
  FROM inc
),
win_orders AS (
  SELECT
    o.*,
    (EXISTS (SELECT 1 FROM order_assignments x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      OR EXISTS (SELECT 1 FROM delivery_attempts x WHERE x.order_id = o.id AND x.driver_id = inc.driver_id))
      AS s_incident_driver_delivery,
    EXISTS (SELECT 1 FROM parcel_collection_assignments x
            WHERE x.order_id = o.id AND x.driver_id = inc.driver_id)
      AS s_incident_driver_collection,
    (o.order_type::text = inc.order_type) AS s_same_order_type,
    (o.amount_to_collect = inc.expected_amount
      OR o.order_amount + o.delivery_fee = inc.expected_amount) AS s_expected_total,
    (o.amount_to_collect = inc.actual_amount
      OR o.actual_amount_collected = inc.actual_amount) AS s_actual_amount,
    (o.amount_to_collect = inc.difference_abs
      OR o.actual_amount_collected = inc.difference_abs) AS s_difference_amount,
    (o.amount_to_collect = 0 OR o.payment_type = 'ALREADY_PAID') AS s_nothing_to_collect,
    (o.delivered_at IS NOT NULL
      AND o.delivered_at - o.created_at <= interval '30 minutes') AS s_back_entered,
    (concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes)
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR coalesce((SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id), '')
        ILIKE '%' || left('0c937fee-8ebd-4679-8113-5bad8b713f01'::text, 8) || '%'
      OR EXISTS (
        SELECT 1 FROM audit_logs z
        WHERE z.entity_type = 'ORDER' AND z.entity_id = o.id::text
          AND concat_ws(' ', z.metadata::text, z.previous_values::text, z.new_values::text)
            LIKE '%' || '0c937fee-8ebd-4679-8113-5bad8b713f01'::text || '%'))
      AS s_mentions_deleted_reference,
    (concat_ws(' ', concat_ws(' ',
        o.description, o.package_notes, o.receiver_instructions,
        o.collection_difference_reason, o.parcel_collection_notes),
        (SELECT string_agg(concat_ws(' ', h.reason, h.notes), ' ')
        FROM order_status_history h WHERE h.order_id = o.id))
      ~* '(replac|re-?enter|re-?creat|duplicat|delet|resubmit)') AS s_replacement_wording
  FROM orders o
  CROSS JOIN inc
  CROSS JOIN win
  WHERE o.created_at >= win.from_at
    AND o.created_at < win.to_at
    AND o.id::text <> '0c937fee-8ebd-4679-8113-5bad8b713f01'::text
),
cand AS (
  SELECT * FROM win_orders
  WHERE s_expected_total OR s_actual_amount OR s_difference_amount
     OR s_nothing_to_collect OR s_back_entered
     OR s_mentions_deleted_reference OR s_replacement_wording
)
SELECT
  (SELECT count(*) FROM win_orders)::int AS orders_in_window,
  (SELECT count(*) FROM cand)::int AS potential_matches,
  (SELECT count(*)
   FROM win_orders w
   WHERE (w.s_incident_driver_delivery OR w.s_incident_driver_collection)
     AND w.id NOT IN (SELECT id FROM cand))::int AS incident_driver_orders_without_content_signal,
  to_char((win.from_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS window_from_utc,
  to_char((win.to_at) AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS window_to_utc
FROM (SELECT 1) AS one
LEFT JOIN win ON true;

ROLLBACK;
```
