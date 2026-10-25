# Settlement Allocation Performance — Optimization Proposal (for review)

Status: **Options A + B IMPLEMENTED in FR.11A** (pending approval) — measurements, the limit
decision and contention results: `fr11a-release-readiness.md` §1. Original proposal below.

Original status: **PROPOSAL ONLY — nothing in this document is implemented.** Prepared during FR.5 as
required by the FR.5 brief §7. Blocks production activation (FR.11) until a decision is made.
Related: `settlement-financial-release-contract.md` §5.2 / §5.3 / §6 / §14 item 1.

## 1. Evidence (FR.4 measurement, unchanged by FR.5)

Isolated PostgreSQL 18 behind a round-trip-counting proxy with injected latency; each allocation
fully releases a DELIVERY_ONLY order.

| Allocations | DB round trips | 0 ms added | 2 ms | 5 ms | 10 ms | 20 ms RTT |
|---|---|---|---|---|---|---|
| 1 | 40 | | | | | |
| 10 | 175 | | | | | 3.6 s |
| 20 | 325 | 0.12 s | 0.85 s | 1.9 s | 3.5 s | **P2028 timeout (5 s)** |

Model: ≈ 25 fixed + 15 per fully-releasing allocation; duration ≈ round trips × RTT. The
production Vercel ↔ Supabase RTT is **unmeasured**.

## 2. Where the per-allocation round trips come from (code reading)

Per allocation in `createSettlement` (`settlement.service.ts`) + `releaseOrder`
(`financial-release.service.ts`):

| Step | Round trips |
|---|---|
| `driver_settlement_allocations.create` | 1 |
| `allocated_amount` compare-and-set `updateMany` | 1 |
| `releaseOrder`: re-lock release (`$queryRaw`) + `findUnique` | 2 |
| `releaseOrder`: settlement driver check, order read, COLLECTION read, reversal check | 4 |
| `creditWalletForOrder` (wallet read, conditional update, ledger insert) | ≈ 3 |
| `recordDeliveryFeeRevenue` (+ product revenue for COMPANY_ORDER) | 1 (2) |
| release `updateMany` → RELEASED, order `updateMany` → FINALIZED | 2 |
| `FINANCIAL_RELEASE_COMPLETED` audit insert | 1 |
| **Total** | **≈ 15** (matches the measurement) |

Partial (non-releasing) allocations cost only 2.

## 3. Options

### A. Batch the allocation writes (low risk)

- One `createMany` for all allocation rows (N → 1).
- One `UPDATE order_financial_releases r SET allocated_amount = r.allocated_amount + v.amount
  FROM (VALUES …) v(id, amount, old) WHERE r.id = v.id AND r.allocated_amount = v.old
  AND r.release_status = 'PENDING' RETURNING r.id` — require `RETURNING` count = N, else 409
  (N → 1). The compare-and-set semantics are unchanged.
- Lock/read the releases in one `SELECT * … ORDER BY id FOR NO KEY UPDATE` instead of lock +
  `findMany` (−1 fixed).

Saving: ≈ 2N − 2. Locking: the rows are already locked in id order before these statements
run, so a multi-row UPDATE introduces no new lock-order risk.

### B. Batch release path `releaseOrders(tx, releaseIds, trigger)` (medium risk)

Keep **one** release code path: `releaseOrder()` becomes a thin wrapper around a batch
function, so the contract's "single release path" rule holds.

- Skip the re-lock when the caller already holds the locks (settlement does; resolution passes
  one id and keeps the lock call).
- Validate the settlement driver once; read all orders, COLLECTION rows and reversal markers
  with three `IN (…)` queries (5N → 3).
- Postings stay on the existing primitives and keys, one per order, in `(customer_id, id)`
  order — wallet ledger rows need a running `balance_before/after` per wallet, and changing the
  primitive is out of scope. Company revenue rows could use `createMany` with the same keys
  (needs a new primitive variant; P2002 semantics must be kept).
- One `UPDATE … FROM (VALUES …)` for RELEASED + posting ids (each row's ids differ), one
  `updateMany` for orders with count check, one `createMany` for audits.

Estimated per releasing allocation: ≈ 4–5 (wallet ≈ 3 + fee 1) instead of 15; fixed cost
+≈ 8. 20 allocations ≈ 25 + 8 + 20 × 4.5 ≈ **125 round trips** (≈ 2.5 s at 20 ms RTT) — an
estimate to be re-measured with the same proxy before approval.

### C. Explicit settlement transaction timeout (no code-path change)

`prisma.$transaction(fn, { timeout })` for settlement only. Consequence: locks are held for
the whole duration — the driver's cash account (blocks that driver's deliveries at their cash
increment and any other settlement / cash correction for the driver), the allocated release
rows, and every credited customer's wallet row (blocks payouts and other credits for those
customers). A longer timeout hides latency rather than removing it.

### D. Lower `MAX_ALLOCATIONS_PER_SETTLEMENT`

Each settlement stays short; Finance needs more settlements for a busy driver. The legacy
unattributed line is unaffected.

### E. Measure first

Measure production RTT (Vercel function region ↔ Supabase pooler) with the existing proxy
methodology or a timing endpoint on a non-production project before choosing.

## 4. Recommendation

1. **E** first (measurement is cheap and decides everything else).
2. **A** in a dedicated, reviewed sub-phase — it is mechanical and keeps all guarantees.
3. **B** only if A + the measured RTT still exceed a safe margin (target: worst case
   ≤ 40 % of the transaction timeout), with the full FR.4 + FR.5 suites and a
   re-measurement as the gate.
4. Choose the production limit (D) from the post-optimization measurement; use C only as a
   bounded, documented supplement, never as the primary fix.

None of these options changes business behavior, idempotency keys or the lock order in
contract §6.
