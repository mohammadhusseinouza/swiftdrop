# Production G3 driver-cash discrepancy — investigation

Status: **investigation only.** Nothing in production was read or changed by this work; the
queries in §6 are for the authorized operator. No correction is authorized by this document.

## 1. Observed (operator report)

| Fact | Value |
|---|---|
| Affected driver cash accounts | 1 |
| Stored `current_balance` | 0.00 |
| Remaining ledger net Σ(`balance_after − balance_before`) | −110.00 |
| G3 difference (stored − net) | +110.00 |
| Remaining driver cash transactions | 118 (2026-09-18 … 2026-10-17) |
| Operator statement | an earlier $110 order with a collection difference was deleted directly in PostgreSQL, together with every related record identifiable by its order number |

## 2. What the model allows a manual deletion to remove

Foreign keys on `orders(id)` (Prisma schema / approved SQL):

| Table → `orders` | Delete rule | Consequence |
|---|---|---|
| `driver_cash_transactions.order_id` | RESTRICT | the order could only be deleted after its COLLECTION row (and any REVERSAL / ADJUSTMENT row carrying the same `order_id`) was deleted |
| `wallet_transactions.order_id` | RESTRICT | likewise for an ORDER_CREDIT (only exists if the difference had been **resolved** for a DELIVERY_ONLY order) |
| `company_financial_transactions.order_id` | RESTRICT | likewise for DELIVERY_FEE / COMPANY_ORDER_PRODUCT revenue (only if resolved) |
| `company_direct_collections.order_id` | RESTRICT | only if the payment method bypassed driver cash (then driver cash would not be involved) |
| `delivery_attempts`, `order_assignments`, `order_status_history`, … | FK to the order | deleted with it |
| `driver_cash_transactions.reversal_of_id` | RESTRICT | a reversal of the deleted collection would have had to be deleted first |

What **cannot** be found by order number and therefore **survives**:

| Survives | Why | Evidential value |
|---|---|---|
| the SETTLEMENT cash rows and `driver_settlements` rows | `order_id` is NULL; they reference the settlement | their `balance_before` still **includes** the deleted collection |
| every later cash row | their `balance_before/after` were written when the collection existed | the running balance chain shows a **jump** where the row was removed |
| `driver_cash_accounts.current_balance` | deletion of ledger rows never updates the cached balance | stays at the true figure |
| `audit_logs` | `entity_id` is a VARCHAR **without** FK, keyed by the order **UUID**, not the order number | `COLLECTION_DIFFERENCE_RECORDED` (legacy path) stores `expectedAmount`, `actualAmount`, `difference` and `driverCashTransactionId`; `COLLECTION_DIFFERENCE_RESOLVED` stores the wallet / revenue split and their transaction ids; `DRIVER_SETTLEMENT_COMPLETED` stores `balanceBefore` and `cashTransactionId`. These survive unless the operator also deleted audit rows by UUID |

A legacy (pre-FR) collection difference posts **only** the driver cash COLLECTION of the **actual**
amount at delivery (no wallet / company rows, `financial_status = REVIEW_REQUIRED`); wallet and
revenue rows are created only by `resolve-collection-difference`, which never touches driver cash.

## 3. Why a deleted +110 collection gives exactly stored 0 / net −110 / G3 +110

The ledger chain telescopes: with every row present,
Σ(after − before) = last.balance_after − first.balance_before = `current_balance` (first.before = 0).
Deleting rows removes their movements from the sum but leaves every other row's recorded
balances unchanged, so

```
remaining net = current_balance − Σ(movements of deleted rows)
G3 difference = current_balance − remaining net = Σ(movements of deleted rows)
```

G3 = +110 therefore proves that **the deleted driver-cash rows netted +110**, i.e. cash the
driver received and that was **later handed over in a settlement that still exists** (the
settlement's debit, which includes the 110, remains; hence stored 0 is still the true position).

It does **not** by itself prove that one +110 COLLECTION was deleted: +120 collection and a −10
adjustment, or two deleted orders, give the same G3. And for a collection-difference order the
driver-cash COLLECTION equals the **actual** amount, which differs from the order value by
definition — "a $110 order" is only consistent if `actualAmount = 110`. §6 resolves this.

**Lab reproduction** (isolated copy `swiftdrop_g3lab`, never dev or production): deleting a
legacy REVIEW_REQUIRED DELIVERY_ONLY order (expected 35, actual 30, later settled) plus all
FK-dependent rows, but not audit rows, produced: stored 150.00 / net 120.00 / G3 +30.00; exactly
one chain break with jump +30.00 at the deleted row's position; the reconstruction offset carried
at +30.00 through every later settlement; and the surviving `COLLECTION_DIFFERENCE_RECORDED`
audit showing `actualAmount 30` with `driverCashTransactionId` pointing at a non-existent row.
An untouched copy returns no findings (no false positives).

## 4. Evidence required before attributing the gap (production, read-only — §6)

| # | Expected if the deleted order fully explains it | If not |
|---|---|---|
| E1 (I1) | one account, G3 +110.00, `last_balance_after = 0.00` | additional accounts or a non-zero latest balance → another cause |
| E2 (I2/I3) | **exactly one** chain break, jump **+110.00**, dated at the order's delivery; offset 0 before and +110 after | several breaks / other amounts → more than one deletion or another cause; `timestamp_ties > 0` → check ordering before concluding |
| E3 (I4) | every settlement matches its cash row; settlements after the break carry +110 | a mismatching settlement → settlement data also damaged |
| E4 (I5) | no row whose movement ≠ amount | a malformed row → separate defect |
| E5 (I6/I7) | a deleted order with `COLLECTION_DIFFERENCE_RECORDED`, `actualAmount = 110`, `cash_tx_still_exists = false` | no rows → audit also deleted: rely on E2 + backup; `actualAmount ≠ 110` → the gap includes other deleted rows |
| E6 (I6) | if the difference had been **resolved**: a `COLLECTION_DIFFERENCE_RESOLVED` row and `wallet/fee/product_tx_still_exists = false` → company revenue (and possibly a customer wallet) history is also missing | |
| E7 (I9) | `g4_mismatched_wallets = 0`, no wallet chain breaks — or, if a resolved DELIVERY_ONLY credit was deleted, exactly one wallet with a break equal to the credit | |
| E8 (I8) | 0 everywhere | non-zero → ledger rows that still name the deleted order (partial deletion) |
| E9 (backup) | a backup / PITR point from **before** the deletion contains the order and rows whose movement sum is +110 | none in retention → authentic restore impossible |

The deletion date and the backup retention window decide whether option A (§5) remains
possible; Supabase scheduled backups and PITR have limited retention, so E9 is time-critical.

## 5. Correction options

| | A. Restore authentic records from a verified backup | B. Approved historical reconciliation entry | C. Existing correction workflows |
|---|---|---|---|
| What | restore a pre-deletion backup into a **non-production** project; extract exactly the deleted rows (order, its cash row(s), attempts, assignments, status history, and any wallet / company / audit rows); verify they sum to +110 at the break; re-insert them **unchanged** (same ids, timestamps, idempotency keys) in one transaction under a separately authorized maintenance procedure, with an audit record of the restoration | a new, explicitly approved ledger entry type that records "history missing: +110, cause, evidence, approver" without claiming a collection | driver-cash ADJUSTMENT (`POST /finance/driver-cash/:driverId/adjust`), REVERSAL, settlement reversal, shortfall |
| G3 after | passes naturally (chain and sum restored) | passes only if G3 is defined to count the entry | see below |
| Accounting truth | exact: the delivery, the cash received and its settlement are all real again; the order reappears in history and reports | the gap is documented, not explained in ledger terms; reports by type must treat it separately | **incorrect** |
| Consequences | the restored order returns with its last real state (e.g. REVIEW_REQUIRED → it re-enters the G5 backlog and must be resolved through the normal workflow); a resolved order's wallet/revenue rows return too; idempotency keys come back, preventing double posting | schema + business-rule change (enum value, G3/G4/report treatment, permissions) → its own approved sub-phase; the deleted order and any revenue/wallet history stay lost | ADJUSTMENT CREDIT +110 sets `current_balance` 0 → 110 and creates a **false driver obligation** (the driver already handed this cash over; G2 then demands it again). A REVERSAL needs the deleted original. Reversing the surviving settlement would also invent an obligation. Shortfall is disabled and semantically wrong |
| Risk | direct INSERTs into production ledgers (restoring, not fabricating) — needs dual control, a rehearsal on the restored copy, and a rollback plan (the transaction aborts on any FK / unique conflict) | low data risk, but permanently weaker history | financial misstatement |
| Verdict | **recommended**, if E9 holds and E2/E5 match | fallback only if no authentic copy exists | **rejected** |

Never: edit `current_balance`, edit or delete other ledger rows, or create a collection,
settlement, obligation or revenue row that did not happen.

## 6. Read-only investigation SQL (production; Supabase SQL Editor or psql)

Run each block on its own (a single `SELECT`; no DML/DDL). Results are counts, amounts, dates,
UUIDs and masked idempotency key kinds only — no names, phones, addresses or free-text reasons.
Validated read-only on the lab copy (finds the simulated deletion) and on an untouched copy (no
findings).

```sql
-- I1 affected accounts (the G3 predicate) and their ledger envelope
with net as (
  select account_id, sum(balance_after - balance_before) net, count(*) n, min(created_at) first_at, max(created_at) last_at
  from driver_cash_transactions group by account_id
), g3 as (
  select a.id account_id, a.driver_id, a.current_balance, coalesce(n.net, 0) net, n.n, n.first_at, n.last_at
  from driver_cash_accounts a left join net n on n.account_id = a.id
  where a.current_balance <> coalesce(n.net, 0)
     or (n.last_at is not null and not exists (select 1 from driver_cash_transactions x
           where x.account_id = a.id and x.created_at = n.last_at and x.balance_after = a.current_balance))
)
select g3.driver_id, g3.current_balance::text stored, g3.net::text ledger_net, (g3.current_balance - g3.net)::text g3_difference,
       g3.n transactions, g3.first_at, g3.last_at,
       (select balance_before::text from driver_cash_transactions t where t.account_id = g3.account_id order by created_at, id limit 1) first_balance_before,
       (select balance_after::text  from driver_cash_transactions t where t.account_id = g3.account_id order by created_at desc, id desc limit 1) last_balance_after,
       (select count(*) from (select created_at from driver_cash_transactions t where t.account_id = g3.account_id group by created_at having count(*) > 1) d)::int timestamp_ties
from g3;

-- I2 chain breaks + reconstruction offset (only rows where something changes)
with g3 as (
  select a.id account_id, a.current_balance from driver_cash_accounts a
  left join (select account_id, sum(balance_after - balance_before) net from driver_cash_transactions group by account_id) n on n.account_id = a.id
  where a.current_balance <> coalesce(n.net, 0)
), seq as (
  select t.*, row_number() over w seq_no,
         lag(t.balance_after) over w prev_after,
         t.balance_after - sum(t.balance_after - t.balance_before) over (w rows between unbounded preceding and current row) offset_after
  from driver_cash_transactions t join g3 on g3.account_id = t.account_id
  window w as (partition by t.account_id order by t.created_at, t.id)
)
select seq_no, created_at, type, amount::text, balance_before::text, coalesce(prev_after, 0)::text expected_before,
       (balance_before - coalesce(prev_after, 0))::text chain_jump, offset_after::text reconstruction_offset,
       order_id is not null has_order_ref, settlement_id is not null has_settlement_ref, reversal_of_id is not null is_reversal,
       regexp_replace(coalesce(idempotency_key, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}', '<id>', 'g') key_kind
from seq
where balance_before <> coalesce(prev_after, 0)
   or seq_no = 1
   or seq_no = (select max(seq_no) from seq s2 where s2.account_id = seq.account_id)
order by account_id, seq_no;

-- I3 context: two rows either side of every chain break
with g3 as (
  select a.id account_id from driver_cash_accounts a
  left join (select account_id, sum(balance_after - balance_before) net from driver_cash_transactions group by account_id) n on n.account_id = a.id
  where a.current_balance <> coalesce(n.net, 0)
), seq as (
  select t.*, row_number() over w seq_no, lag(t.balance_after) over w prev_after
  from driver_cash_transactions t join g3 on g3.account_id = t.account_id
  window w as (partition by t.account_id order by t.created_at, t.id)
), breaks as (select account_id, seq_no from seq where balance_before <> coalesce(prev_after, 0))
select s.seq_no, s.created_at, s.type, s.amount::text, s.balance_before::text, s.balance_after::text,
       (s.balance_before - coalesce(s.prev_after, 0))::text chain_jump,
       s.order_id is not null has_order_ref, s.settlement_id is not null has_settlement_ref,
       regexp_replace(coalesce(s.idempotency_key, ''), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32,}', '<id>', 'g') key_kind
from seq s join breaks b on b.account_id = s.account_id and s.seq_no between b.seq_no - 2 and b.seq_no + 2
order by s.seq_no;

-- I4 settlements of the affected driver vs their cash rows and the gap
with g3 as (
  select a.id account_id, a.driver_id from driver_cash_accounts a
  left join (select account_id, sum(balance_after - balance_before) net from driver_cash_transactions group by account_id) n on n.account_id = a.id
  where a.current_balance <> coalesce(n.net, 0)
), seq as (
  select t.id, t.settlement_id, t.created_at,
         t.balance_after - sum(t.balance_after - t.balance_before) over (partition by t.account_id order by t.created_at, t.id rows between unbounded preceding and current row) offset_after
  from driver_cash_transactions t join g3 on g3.account_id = t.account_id
)
select d.created_at, d.balance_before::text settlement_before, d.amount_received::text received, d.balance_after::text settlement_after,
       t.balance_before::text cash_row_before, t.amount::text cash_row_amount, t.balance_after::text cash_row_after,
       (d.balance_before = t.balance_before and d.amount_received = t.amount and d.balance_after = t.balance_after) settlement_matches_cash_row,
       s.offset_after::text gap_carried_at_this_point
from driver_settlements d
join g3 on g3.driver_id = d.driver_id
left join driver_cash_transactions t on t.settlement_id = d.id
left join seq s on s.id = t.id
order by d.created_at;

-- I5 row integrity (every row's movement must equal its amount with the type's sign)
select type, count(*)::int rows_checked,
       count(*) filter (where abs(balance_after - balance_before) <> amount)::int movement_ne_amount,
       count(*) filter (where type = 'COLLECTION' and balance_after < balance_before)::int collection_debits,
       count(*) filter (where type = 'SETTLEMENT' and balance_after > balance_before)::int settlement_credits,
       count(*) filter (where type = 'SETTLEMENT' and settlement_id is null)::int settlement_without_ref
from driver_cash_transactions group by type order by type;

-- I6 surviving audit evidence for orders that no longer exist (amounts and ids only)
select l.created_at, l.action, l.metadata ->> 'orderType' order_type,
       l.metadata ->> 'expectedAmount' expected_amount, l.metadata ->> 'actualAmount' actual_amount, l.metadata ->> 'difference' difference,
       l.metadata ->> 'customerWalletCredit' wallet_credit, l.metadata ->> 'companyProductRevenue' product_revenue, l.metadata ->> 'companyDeliveryFeeRevenue' fee_revenue,
       case when l.metadata ? 'driverCashTransactionId' then exists (select 1 from driver_cash_transactions x where x.id::text = l.metadata ->> 'driverCashTransactionId') end cash_tx_still_exists,
       case when l.metadata ? 'walletTransactionId' and l.metadata ->> 'walletTransactionId' is not null then exists (select 1 from wallet_transactions x where x.id::text = l.metadata ->> 'walletTransactionId') end wallet_tx_still_exists,
       case when l.metadata ? 'companyFeeTransactionId' and l.metadata ->> 'companyFeeTransactionId' is not null then exists (select 1 from company_financial_transactions x where x.id::text = l.metadata ->> 'companyFeeTransactionId') end fee_tx_still_exists,
       case when l.metadata ? 'companyProductTransactionId' and l.metadata ->> 'companyProductTransactionId' is not null then exists (select 1 from company_financial_transactions x where x.id::text = l.metadata ->> 'companyProductTransactionId') end product_tx_still_exists,
       dense_rank() over (order by l.entity_id) deleted_order_no
from audit_logs l
where l.entity_type = 'ORDER'
  and not exists (select 1 from orders o where o.id::text = l.entity_id)
  and (l.action like '%DELIVER%' or l.action like '%COLLECTION_DIFFERENCE%' or l.action like '%FINANCE%')
order by deleted_order_no, l.created_at;

-- I7 any audit pointing at a driver cash row that no longer exists (all entity types)
select l.action, l.entity_type, l.created_at, k.key metadata_field
from audit_logs l
cross join lateral (values ('driverCashTransactionId'), ('cashTransactionId')) k(key)
where l.metadata ? k.key and l.metadata ->> k.key is not null
  and not exists (select 1 from driver_cash_transactions x where x.id::text = l.metadata ->> k.key)
order by l.created_at;

-- I8 ledger rows whose idempotency key names an order that no longer exists
select 'driver_cash' ledger, count(*)::int rows from driver_cash_transactions where idempotency_key ~ '^delivery:[0-9a-f-]{36}:' and not exists (select 1 from orders o where o.id::text = substring(idempotency_key from 10 for 36))
union all
select 'wallet', count(*)::int from wallet_transactions where idempotency_key ~ '^delivery:[0-9a-f-]{36}:' and not exists (select 1 from orders o where o.id::text = substring(idempotency_key from 10 for 36))
union all
select 'company', count(*)::int from company_financial_transactions where idempotency_key ~ '^delivery:[0-9a-f-]{36}:' and not exists (select 1 from orders o where o.id::text = substring(idempotency_key from 10 for 36))
union all
select 'direct_collection', count(*)::int from company_direct_collections where idempotency_key ~ '^delivery:[0-9a-f-]{36}:' and not exists (select 1 from orders o where o.id::text = substring(idempotency_key from 10 for 36));

-- I9 wallet ledgers: G4 and chain breaks (counts only)
with seq as (
  select t.wallet_id, t.balance_before, lag(t.balance_after) over (partition by t.wallet_id order by t.created_at, t.id) prev_after
  from wallet_transactions t
)
select (select count(*) from customer_wallets w left join (select wallet_id, sum(credit - debit) net from wallet_transactions group by wallet_id) n on n.wallet_id = w.id
        where w.available_balance <> coalesce(n.net, 0))::int g4_mismatched_wallets,
       count(*) filter (where balance_before <> coalesce(prev_after, 0))::int wallet_chain_breaks,
       count(distinct wallet_id) filter (where balance_before <> coalesce(prev_after, 0))::int wallets_with_breaks,
       coalesce(sum(balance_before - coalesce(prev_after, 0)) filter (where balance_before <> coalesce(prev_after, 0)), 0)::text total_wallet_jump
from seq;

-- I10 company revenue around the gap (order-less rows, counts and sums only)
select type, count(*)::int rows, sum(amount)::text total,
       count(*) filter (where order_id is null)::int without_order,
       count(*) filter (where amount <= 0)::int non_positive
from company_financial_transactions group by type order by type;
```

On a **restored non-production copy** (option A), the same queries return no G3 finding, and
the order named by I6 (its UUID, not shown in the output) is present with its cash row(s).

## 7. Approvals required before any production change

1. APPROVER: choice of option (A recommended) and written authorization naming the environment,
   window and exact record set.
2. OPS: confirmation that a pre-deletion backup / PITR point exists (E9); restore into a
   non-production project only; rehearsal of the restoration there with §6 before and after.
3. FIN: sign-off that the restored records match the business facts (delivery, actual amount,
   settlement), and on any resolution still owed for the order.
4. Process: the manual deletion itself is an unaudited change to financial history — record it as
   an incident, and restrict direct production write access.

## 8. Impact on FR.12B / FR.12C

- **FR.12B (migration):** the FR migration is additive and does not read or change driver cash;
  `build.mjs`'s snapshot comparison is unaffected. But runbook §8.3 lists "ledgers G3/G4 are OK"
  as a deployment go/no-go, so under the runbook as written this is **NO-GO** until the
  discrepancy is corrected or the APPROVER records an explicit, documented exception for the
  migration step only.
- **FR.12C (activation):** G3 is a hard activation gate evaluated under locks; there is no
  exception path. **Blocked** until G3 passes for real (option A, or an approved option B).
