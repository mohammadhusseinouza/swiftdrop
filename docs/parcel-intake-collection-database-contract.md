# Parcel Intake & Collection — Database Contract

**Status:** Designed in Phase 11.17.1 (design-only). **APPLIED in Phase 11.17.2** — enums,
`orders` columns, `parcel_collection_assignments`, `parcel_collection_attempts`,
`failed_collection_reasons` (+ 7-row canonical seed), all indexes/constraints, and the
existing-order backfill are live in the dev database and mirrored in
`server/prisma/schema.prisma`. **Phase 11.17.3** built the Parcel Collection backend on top
of this schema (`src/modules/parcel-collection/` + reference-data `failed-collection-reason.*`)
with no further schema change.
**Migration artifacts** (`server/migrations/`, applied by `apply.mjs`; the project does not
use `prisma migrate` — see `server/migrations/README.md`):
- `2026-09-01__1117__parcel_intake_collection.sql` — bootstrap.
- `2026-09-01__1173__parcel_collection_attempt_started_at_nullable.sql` — 11.17.3: attempt
  `started_at` nullable, no default.
- `2026-09-01__1174__drop_orders_parcel_intake_defaults.sql` — 11.17.4: dropped the
  temporary `orders.parcel_intake_method` / `parcel_collection_status` DB defaults (Create
  Order is now parcel-aware and writes both explicitly; columns stay NOT NULL).
**Feature source of truth:**
`/docs/delivery_management_system_parcel_intake_collection_feature_change_spec_v1.md`.
**`/docs/swiftdrop_database`** is a stale point-in-time `pg_dump` (predates `auth_sessions`)
and was **not** refreshed by Phase 11.17.2 — refreshing it is a separate team decision.

Conventions follow the existing project: PostgreSQL `snake_case` table/column names,
`uuid` PKs (`gen_random_uuid()`), `timestamp(3) with time zone` timestamps, `NUMERIC(14,2)`
money (not used here — Parcel Collection is financially neutral), Prisma `camelCase` model
field mapping via `@map` where the generated client already does so.

---

## 1. Naming rule (must-follow)

The word `collection` is already used across the codebase for **money** collection
(`amount_to_collect`, `actual_amount_collected`, `collection_payment_method_id`,
`collection_difference_reason`, `DriverCashTransactionType.COLLECTION`,
`company_financial_transactions`, wallet `ORDER_CREDIT`, etc.). Those names are **unchanged**
and keep their financial meaning.

Every new object in this feature is explicitly **parcel**-scoped:

| Concept | Enum / table / column |
|---|---|
| Intake method | `parcel_intake_method` / enum `ParcelIntakeMethod` |
| Collection state | `parcel_collection_status` / enum `ParcelCollectionStatus` |
| Current collection driver pointer | `orders.current_parcel_collection_driver_id` |
| Collection assignment history | `parcel_collection_assignments` |
| Collection attempt history | `parcel_collection_attempts` |
| Failed collection reasons | `failed_collection_reasons` |
| Attempt outcome | enum `ParcelCollectionAttemptOutcome` |

Never introduce bare `collection_status`, `collection_attempt`, `collection_transaction`.

---

## 2. Enums

### 2.1 `ParcelIntakeMethod`

```sql
CREATE TYPE public."ParcelIntakeMethod" AS ENUM (
    'ALREADY_AT_COMPANY',
    'DRIVER_COLLECTION'
);
```

| Value | Meaning |
|---|---|
| `ALREADY_AT_COMPANY` | The parcel is physically at the company when the order is created. Receipt is recorded automatically. |
| `DRIVER_COLLECTION` | A driver must collect the parcel from the sender and bring it to the company before delivery assignment. |

Independent of `OrderType`. All four `(OrderType × ParcelIntakeMethod)` combinations are
valid. Immutable after creation in V1 (no "change intake method" workflow).

### 2.2 `ParcelCollectionStatus`

```sql
CREATE TYPE public."ParcelCollectionStatus" AS ENUM (
    'AWAITING_ASSIGNMENT',
    'ASSIGNED',
    'COLLECTED_FROM_SENDER',
    'FAILED',
    'RESCHEDULED',
    'RECEIVED_AT_COMPANY'
);
```

| Value | Meaning | Applies to |
|---|---|---|
| `AWAITING_ASSIGNMENT` | Collection required; no current collection driver. | `DRIVER_COLLECTION` |
| `ASSIGNED` | A collection driver is currently assigned; parcel still with sender. | `DRIVER_COLLECTION` |
| `COLLECTED_FROM_SENDER` | The collection driver has confirmed physical possession from the sender. **The company does not have the parcel yet.** | `DRIVER_COLLECTION` |
| `FAILED` | The most recent collection attempt failed; awaiting a management decision (reschedule / reassign). | `DRIVER_COLLECTION` |
| `RESCHEDULED` | A failed collection has been scheduled for retry (transient; normally moves back to `ASSIGNED`). | `DRIVER_COLLECTION` |
| `RECEIVED_AT_COMPANY` | Management has confirmed the parcel is physically at the company. **Delivery-assignment gate.** | both |

**No `NOT_REQUIRED` value.** For `ALREADY_AT_COMPANY` the status is `RECEIVED_AT_COMPANY`
from creation. This gives one universal delivery-assignment invariant:

```text
delivery driver may be assigned  ⟺  orders.parcel_collection_status = 'RECEIVED_AT_COMPANY'
```

> **APPROVED (§12.1):** no `NOT_REQUIRED` status. `ALREADY_AT_COMPANY` goes directly to
> `RECEIVED_AT_COMPANY`. Rationale: a `NOT_REQUIRED` value would force every
> delivery-assignment check to test two values and would split dashboards/reports on a
> distinction with no operational value.

### 2.3 `ParcelCollectionAttemptOutcome`

```sql
CREATE TYPE public."ParcelCollectionAttemptOutcome" AS ENUM (
    'COLLECTED',
    'FAILED'
);
```

Mirrors the shape of `DeliveryAttemptOutcome` but is a **separate** type (there is no
`RETURNED` concept for collection). `COLLECTED` = the driver took possession from the
sender on that attempt; `FAILED` = the attempt failed and carries a
`failed_collection_reason_id` + optional notes.

---

## 3. `orders` — new columns (all nullable on add; see §8 migration)

```sql
ALTER TABLE public.orders
  ADD COLUMN parcel_intake_method              public."ParcelIntakeMethod",
  ADD COLUMN parcel_collection_status          public."ParcelCollectionStatus",
  ADD COLUMN current_parcel_collection_driver_id uuid,

  ADD COLUMN parcel_collection_contact_name    character varying(200),
  ADD COLUMN parcel_collection_phone           character varying(30),
  ADD COLUMN parcel_collection_alt_phone       character varying(30),
  ADD COLUMN parcel_collection_area_id         uuid,
  ADD COLUMN parcel_collection_area            character varying(150),
  ADD COLUMN parcel_collection_address         character varying(500),
  ADD COLUMN parcel_collection_notes           text,

  ADD COLUMN parcel_collected_from_sender_at   timestamp(3) with time zone,
  ADD COLUMN received_at_company_at            timestamp(3) with time zone,
  ADD COLUMN received_at_company_by_id         uuid;
```

| Column | Notes |
|---|---|
| `parcel_intake_method` | After backfill + Phase 11.17.2: `NOT NULL`. No DB default in the final state — the service always sets it explicitly at creation. |
| `parcel_collection_status` | After backfill: `NOT NULL`. `ALREADY_AT_COMPANY` → `RECEIVED_AT_COMPANY`; `DRIVER_COLLECTION` → `AWAITING_ASSIGNMENT` (or `ASSIGNED` if a collection driver is chosen at creation). |
| `current_parcel_collection_driver_id` | Denormalized pointer to the **current** collection driver, analogous to `current_driver_id` for delivery. Set on assignment; **retained through `COLLECTED_FROM_SENDER`** (driver keeps custody in transit); cleared to `NULL` on collection failure and on `RECEIVED_AT_COMPANY`, and `NULL` while `AWAITING_ASSIGNMENT` / `RESCHEDULED` / for `ALREADY_AT_COMPANY`. Always mirrors the single open row in `parcel_collection_assignments` (§4.1). FK → `drivers(id)` `ON DELETE SET NULL`. |
| `parcel_collection_contact_name` … `parcel_collection_notes` | **Order snapshot** of the sender/collection contact + address, pre-filled from the customer at creation, never rewritten by later customer edits. Only populated for `DRIVER_COLLECTION`. |
| `parcel_collection_area_id` | Optional FK → `areas(id)` `ON DELETE SET NULL`, for active reference-data lookup/filtering. |
| `parcel_collection_area` | Textual **snapshot** of the area name. Historical readable location must not depend on the current `areas` row (same principle as `orders.receiver_area` vs `orders.receiver_area_id`). |
| `parcel_collected_from_sender_at` | Set when the driver confirms `COLLECTED_FROM_SENDER`. `NULL` otherwise (and for `ALREADY_AT_COMPANY`). |
| `received_at_company_at` | For `ALREADY_AT_COMPANY` = `orders.created_at`. For `DRIVER_COLLECTION` = the moment management confirms receipt. |
| `received_at_company_by_id` | FK → `users(id)` `ON DELETE RESTRICT` (actor FK, consistent with `orders.created_by_id`). For `ALREADY_AT_COMPANY` = `orders.created_by_id`. |

**Invariant — do not reinterpret existing columns:**
`orders.current_driver_id` remains the current **final delivery** driver only. It is never
set to whichever driver currently has custody. `order_assignments` remains delivery-only.
`delivery_attempts` remains delivery-only. The financial columns
`collection_payment_method_id` and `collection_difference_reason` are **not** reused — they
are about money.

---

## 4. `parcel_collection_assignments`

Separate from `order_assignments`. Follows the same shape/patterns.

```sql
CREATE TYPE public."ParcelCollectionAssignmentEndReason" AS ENUM (
    'REASSIGNED',
    'FAILED',
    'RECEIVED_AT_COMPANY',
    'ORDER_CANCELLED'
);

CREATE TABLE public.parcel_collection_assignments (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id       uuid NOT NULL,
    driver_id      uuid NOT NULL,
    assigned_by_id uuid NOT NULL,
    assigned_at    timestamp(3) with time zone DEFAULT now() NOT NULL,
    ended_at       timestamp(3) with time zone,
    end_reason     public."ParcelCollectionAssignmentEndReason",
    is_current     boolean DEFAULT true NOT NULL,
    CONSTRAINT parcel_collection_assignments_pkey PRIMARY KEY (id)
);
```

`end_reason` is a constrained enum (§8). It is `NULL` while `is_current = true` and set to
exactly one of the four values when the row is ended.

Rules:

- Exactly **one** current assignment per order at any time (`is_current = true`),
  enforced by the partial unique index below.
- `is_current = true` ⟺ `ended_at IS NULL` ⟺ `end_reason IS NULL` (see the CHECK in §8.2).
- Reassignment **ends** the previous record (`ended_at = now`, `end_reason = 'REASSIGNED'`,
  `is_current = false`) and inserts a new current record. Previous records are permanent and
  never updated again.
- A failed collection ends the current record (`end_reason = 'FAILED'`) and clears
  `orders.current_parcel_collection_driver_id`.
- Successful company receipt ends the current record (`end_reason = 'RECEIVED_AT_COMPANY'`)
  and clears `orders.current_parcel_collection_driver_id`.
- **Order cancellation while the collection is `AWAITING_ASSIGNMENT`, `ASSIGNED`, `FAILED`,
  or `RESCHEDULED`** may proceed under existing order-cancellation rules. When it happens
  from `ASSIGNED`, the same transaction ends the current record
  (`end_reason = 'ORDER_CANCELLED'`) and clears the pointer (§4.3).
- **Order cancellation from `COLLECTED_FROM_SENDER` is rejected** — the driver still has
  custody; receipt must be confirmed first (§4.3, §8.3).
- `COLLECTED_FROM_SENDER` does **not** end the current record — the driver still has
  physical custody while transporting the parcel to the company.
- The same `driver_id` may later appear in `order_assignments` (delivery) for the same
  order — that is allowed and expected.
- Inactive drivers should not normally receive new collection assignments (service-level
  check, consistent with delivery assignment).

### 4.1 Current-assignment / `current_parcel_collection_driver_id` lifecycle

Every step below is a single transaction that changes the assignment row(s), the
`orders.current_parcel_collection_driver_id` pointer, and `orders.parcel_collection_status`
together — they can never drift apart.

| Event | `parcel_collection_assignments` | `orders.current_parcel_collection_driver_id` | `orders.parcel_collection_status` |
|---|---|---|---|
| **Create, `ALREADY_AT_COMPANY`** | no row created | `NULL` | `RECEIVED_AT_COMPANY` |
| **Create, `DRIVER_COLLECTION`, no driver** | no row created | `NULL` | `AWAITING_ASSIGNMENT` |
| **Create, `DRIVER_COLLECTION`, with driver** | insert row: `is_current = true`, `ended_at = NULL`, `end_reason = NULL` | `= driverId` | `ASSIGNED` |
| **Assign collection driver** (from `AWAITING_ASSIGNMENT` or `RESCHEDULED`) | insert new current row | `= driverId` | `ASSIGNED` |
| **Reassign** (only before `COLLECTED_FROM_SENDER`) | end current row (`ended_at = now`, `end_reason = 'REASSIGNED'`, `is_current = false`); insert new current row | `= newDriverId` | `ASSIGNED` |
| **Collected From Sender** (assigned driver) | append `parcel_collection_attempts` row, outcome `COLLECTED`; **current assignment row unchanged** | **unchanged** (driver keeps custody) | `COLLECTED_FROM_SENDER` |
| **Collection Failed** (assigned driver) | append `parcel_collection_attempts` row, outcome `FAILED`; end current row (`ended_at = now`, `end_reason = 'FAILED'`, `is_current = false`) | `NULL` | `FAILED` |
| **Reschedule after failure** (Management) | no row change (there is no current row) | `NULL` | `RESCHEDULED` |
| **Received At Company** (Management) | end current row (`ended_at = now`, `end_reason = 'RECEIVED_AT_COMPANY'`, `is_current = false`) | `NULL` | `RECEIVED_AT_COMPANY` |

Consequences:

- After `FAILED` and after `RECEIVED_AT_COMPANY` there is **no** current collection
  assignment and `current_parcel_collection_driver_id IS NULL`.
- Between `COLLECTED_FROM_SENDER` and `RECEIVED_AT_COMPANY` the current assignment stays open
  and `current_parcel_collection_driver_id` still points at the collecting driver. Collection
  **reassignment is forbidden** in this window.
- `RESCHEDULED` never carries a driver. Selecting a driver again — even the same physical
  person — always creates a brand-new assignment-history row.
- The historical collecting driver is always recoverable from `parcel_collection_assignments`
  and `parcel_collection_attempts`; no history is ever deleted.

### 4.2 `RESCHEDULED` semantics (V1)

V1 does **not** introduce collection calendar/date scheduling (no scheduled-for date field,
no reminders) unless already required elsewhere. `RESCHEDULED` simply means *Management has
approved another collection attempt after a failure*. It is a short-lived state with no
current driver; the next driver assignment moves it to `ASSIGNED`.

### 4.3 Order cancellation while Parcel Collection is active

Order cancellation is an **order-level** action governed by the existing order-cancellation
authorization and workflow. It is **not** a Parcel Collection status transition — the
`parcel_collection_status` value and all collection history are preserved as historical
state, and the order's terminal `CANCELLED` status is what communicates the cancellation.
No `parcel_collection_attempts` row is ever fabricated because an order was cancelled.

| `parcel_collection_status` at cancel time | Cancellation allowed? | Effect on `parcel_collection_assignments` | `current_parcel_collection_driver_id` |
|---|---|---|---|
| `AWAITING_ASSIGNMENT` | yes (existing rules) | none — there is no current row; do **not** create one | already `NULL` |
| `ASSIGNED` | yes (existing rules) | **same transaction:** end the current row — `ended_at = now`, `end_reason = 'ORDER_CANCELLED'`, `is_current = false` | set to `NULL` in the same transaction |
| `COLLECTED_FROM_SENDER` | **NO — rejected** | unchanged | unchanged |
| `FAILED` | yes (existing rules) | none — no current row | already `NULL` |
| `RESCHEDULED` | yes (existing rules) | none — no current row | already `NULL` |
| `RECEIVED_AT_COMPANY` | per existing post-receipt order/delivery workflow | none — no current row (already closed at receipt) | already `NULL` |

`COLLECTED_FROM_SENDER` — required sequence instead of cancellation:

```text
COLLECTED_FROM_SENDER
  -> Management confirms RECEIVED_AT_COMPANY   (collection assignment closes normally)
  -> company has controlled custody
  -> then the applicable cancellation / return workflow may proceed
```

V1 adds **no** "cancelled while driver holds parcel" workflow and **no** `RETURNED`
collection attempt outcome. `end_reason = 'ORDER_CANCELLED'` is distinct from the business
Failed Collection Reason *"Collection cancelled by sender"* (§6) — the former is an
assignment-lifecycle end reason for an order-level cancellation, the latter is a
sender-driven collection failure recorded on a `FAILED` attempt.

FKs:

| Column | References | On delete |
|---|---|---|
| `order_id` | `orders(id)` | `RESTRICT` |
| `driver_id` | `drivers(id)` | `RESTRICT` |
| `assigned_by_id` | `users(id)` | `RESTRICT` |

Indexes:

```sql
CREATE INDEX parcel_collection_assignments_order_id_is_current_idx
    ON public.parcel_collection_assignments (order_id, is_current);
CREATE INDEX parcel_collection_assignments_driver_id_is_current_idx
    ON public.parcel_collection_assignments (driver_id, is_current);
CREATE INDEX parcel_collection_assignments_assigned_at_idx
    ON public.parcel_collection_assignments (assigned_at);
```

Single-current-assignment guarantee (partial unique index — DB-level invariant, created in
Phase 11.17.2, not now):

```sql
CREATE UNIQUE INDEX parcel_collection_assignments_one_current_per_order_uidx
    ON public.parcel_collection_assignments (order_id)
    WHERE is_current;
```

(This matches the intent of `order_assignments`; if the project decides the existing
delivery table should get the same guard, that is a separate, out-of-scope change.)

---

## 5. `parcel_collection_attempts`

Separate from `delivery_attempts`. Failed attempts are permanent; a retry inserts a new row.

```sql
CREATE TABLE public.parcel_collection_attempts (
    id                        uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id                  uuid NOT NULL,
    driver_id                 uuid NOT NULL,
    attempt_number            integer NOT NULL,
    outcome                   public."ParcelCollectionAttemptOutcome" NOT NULL,
    failed_collection_reason_id uuid,
    notes                     text,
    started_at                timestamp(3) with time zone,   -- nullable, NO default (see rules)
    completed_at              timestamp(3) with time zone,
    created_at                timestamp(3) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parcel_collection_attempts_pkey PRIMARY KEY (id),
    CONSTRAINT parcel_collection_attempts_order_id_attempt_number_key
        UNIQUE (order_id, attempt_number)
);
```

Rules:

- `attempt_number` is per order, 1-based, monotonic. `(order_id, attempt_number)` unique
  (mirrors `delivery_attempts`).
- `outcome = 'FAILED'` requires `failed_collection_reason_id`; `notes` required when the
  chosen reason has `requires_notes = true` (server-validated, like failed delivery).
- `outcome = 'COLLECTED'` sets `completed_at` and drives
  `orders.parcel_collected_from_sender_at`. It does **not** end the current
  `parcel_collection_assignments` row (§4.1) — the driver retains custody in transit.
- **`started_at` is nullable with NO default.** V1 has no "start parcel collection"
  action, so both `COLLECTED` and `FAILED` attempts are inserted with `started_at = NULL`
  and `completed_at = <action time>` — the completion time is never copied into
  `started_at`. (Phase 11.17.2 originally shipped this column as `NOT NULL DEFAULT now()`,
  mirroring `delivery_attempts`; the Phase 11.17.3 correction
  `server/migrations/2026-09-01__1173__parcel_collection_attempt_started_at_nullable.sql`
  dropped the default and the NOT NULL. A future explicit "start collection" action may
  populate it.) The `(driver_id, started_at)` index still exists for future use.
- Rows are append-only. A reschedule/retry never overwrites a prior attempt.
- There is at most one `COLLECTED` attempt per order; every failed retry is a new `FAILED`
  row with the next `attempt_number`.

FKs:

| Column | References | On delete |
|---|---|---|
| `order_id` | `orders(id)` | `RESTRICT` |
| `driver_id` | `drivers(id)` | `RESTRICT` |
| `failed_collection_reason_id` | `failed_collection_reasons(id)` | `SET NULL` |

Indexes:

```sql
CREATE INDEX parcel_collection_attempts_driver_id_started_at_idx
    ON public.parcel_collection_attempts (driver_id, started_at);
CREATE INDEX parcel_collection_attempts_outcome_completed_at_idx
    ON public.parcel_collection_attempts (outcome, completed_at);
```

(The `(order_id, attempt_number)` unique constraint already serves order-scoped lookups.)

---

## 6. `failed_collection_reasons`

Follows the safe `failed_delivery_reasons` pattern exactly. Separate dataset — never merged.

```sql
CREATE TABLE public.failed_collection_reasons (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    name           character varying(150) NOT NULL,
    requires_notes boolean DEFAULT false NOT NULL,
    is_active      boolean DEFAULT true NOT NULL,
    sort_order     integer DEFAULT 0 NOT NULL,
    created_at     timestamp(3) with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp(3) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT failed_collection_reasons_pkey PRIMARY KEY (id),
    CONSTRAINT failed_collection_reasons_name_key UNIQUE (name)
);

CREATE INDEX failed_collection_reasons_is_active_sort_order_idx
    ON public.failed_collection_reasons (is_active, sort_order);
```

Behavior: `settings.read` to view, `settings.manage` to create/edit/deactivate/reactivate,
no hard delete, config changes audited. Inactive reasons stay readable on historical
attempts but are not offered for new failures.

**Canonical catalog — seeded by the Phase 11.17.2 migration** (idempotent
`INSERT ... ON CONFLICT (name) DO NOTHING`, mirroring how the existing
`failed_delivery_reasons` rows live directly in the DB):

| name | requires_notes | sort_order |
|---|---|---|
| Sender unavailable | false | 10 |
| Parcel not ready | false | 20 |
| Unable to contact sender | false | 30 |
| Incorrect collection address | false | 40 |
| Sender requested reschedule | false | 50 |
| Collection cancelled by sender | true | 60 |
| Other | true | 70 |

---

## 7. Foreign keys / delete behavior — summary

Historical assignment/attempt records must survive normal driver / customer / order
deactivation. There is no hard-delete business workflow for those entities. Chosen behavior
(consistent with existing project FK policy):

| From | To | On delete | Rationale |
|---|---|---|---|
| `orders.current_parcel_collection_driver_id` | `drivers` | `SET NULL` | matches `orders.current_driver_id`; denormalized pointer only |
| `orders.parcel_collection_area_id` | `areas` | `SET NULL` | matches `orders.receiver_area_id`; textual `parcel_collection_area` snapshot survives |
| `orders.received_at_company_by_id` | `users` | `RESTRICT` | actor FK, matches `orders.created_by_id` |
| `parcel_collection_assignments.order_id` | `orders` | `RESTRICT` | matches `order_assignments` |
| `parcel_collection_assignments.driver_id` | `drivers` | `RESTRICT` | matches `order_assignments` |
| `parcel_collection_assignments.assigned_by_id` | `users` | `RESTRICT` | actor FK, matches `order_assignments.assigned_by_id` |
| `parcel_collection_attempts.order_id` | `orders` | `RESTRICT` | matches `delivery_attempts` |
| `parcel_collection_attempts.driver_id` | `drivers` | `RESTRICT` | matches `delivery_attempts` |
| `parcel_collection_attempts.failed_collection_reason_id` | `failed_collection_reasons` | `SET NULL` | matches `delivery_attempts.failed_reason_id`; historical `notes` + attempt row survive |

No `CASCADE` deletes anywhere in this feature.

---

## 8. Index / constraint contract (for Phase 11.17.2)

New `orders` indexes to support operational reads:

```sql
CREATE INDEX orders_parcel_collection_status_idx
    ON public.orders (parcel_collection_status);
CREATE INDEX orders_parcel_intake_method_idx
    ON public.orders (parcel_intake_method);
CREATE INDEX orders_current_parcel_collection_driver_id_idx
    ON public.orders (current_parcel_collection_driver_id);
```

Combined with the table indexes in §4–§6, this covers:

| Query | Backed by |
|---|---|
| Orders by parcel collection status (dashboard buckets) | `orders_parcel_collection_status_idx` |
| Orders by intake method | `orders_parcel_intake_method_idx` |
| Orders by current collection driver | `orders_current_parcel_collection_driver_id_idx` |
| Collection assignments for an order / current | `..._order_id_is_current_idx` |
| Collection assignments for a driver / current | `..._driver_id_is_current_idx` |
| Collection attempts for an order (ordered) | `(order_id, attempt_number)` unique |
| Collection attempts by driver / time | `..._driver_id_started_at_idx` |
| Failed collection reasons active + ordered | `..._is_active_sort_order_idx` |

Unique constraints:

- `parcel_collection_attempts (order_id, attempt_number)` — enforced.
- `parcel_collection_assignments` one-current-per-order — partial unique index
  (`WHERE is_current`). **APPROVED.**

  ```sql
  CREATE UNIQUE INDEX parcel_collection_assignments_one_current_per_order_uidx
      ON public.parcel_collection_assignments (order_id)
      WHERE is_current;
  ```

- `failed_collection_reasons (name)` — enforced.

### 8.1 Assignment end-reason contract

`parcel_collection_assignments.end_reason` is the enum
`ParcelCollectionAssignmentEndReason` (§4). V1 values:

| Value | Set when |
|---|---|
| `REASSIGNED` | The collection driver is changed before `COLLECTED_FROM_SENDER`. |
| `FAILED` | The assigned driver records a failed collection. |
| `RECEIVED_AT_COMPANY` | Management confirms the parcel is at the company. |
| `ORDER_CANCELLED` | The order is cancelled from `parcel_collection_status = ASSIGNED` (before successful collection). Same transaction as the order cancellation (§4.3). |

`end_reason IS NULL` exactly while the row is current. `ORDER_CANCELLED` is **not** the same
as the business Failed Collection Reason *"Collection cancelled by sender"* (§6): the former
ends an assignment because the order itself was cancelled; the latter is a sender-driven
collection failure recorded on a `FAILED` attempt. Order cancellation never fabricates a
`parcel_collection_attempts` row.

### 8.2 Assignment consistency invariants (future CHECK / service guarantees)

Intended invariants for the Phase 11.17.2 schema and the Phase 11.17.3 service:

- At most one `is_current = true` row per `order_id` (partial unique index above).
- Current row ⟹ `ended_at IS NULL` and `end_reason IS NULL`.
- Historical row ⟹ `ended_at IS NOT NULL` and `end_reason IS NOT NULL`.
- `orders.current_parcel_collection_driver_id` equals the `driver_id` of the single current
  row when one exists, and is `NULL` when none exists.
- No current row exists once `orders.parcel_collection_status` is `FAILED` or
  `RECEIVED_AT_COMPANY`.
- A current row **does** exist while status is `ASSIGNED` or `COLLECTED_FROM_SENDER`
  (custody is with the driver in both) **and the order is not cancelled**.
- No current row exists while status is `AWAITING_ASSIGNMENT` or `RESCHEDULED`.
- **A cancelled order (`orders.status = 'CANCELLED'`) never has a current collection
  assignment (`is_current = true`) and never has
  `current_parcel_collection_driver_id IS NOT NULL`.** Cancellation from `ASSIGNED` closes
  the assignment atomically with `end_reason = 'ORDER_CANCELLED'`; no exception.
- Cancellation is impossible from `COLLECTED_FROM_SENDER` (rejected server-side, §8.3), so a
  cancelled order can never strand a parcel in unresolved driver custody.

Row-level CHECK to add in Phase 11.17.2 (PostgreSQL-compatible; it does not reference other
rows, so it is safe as a table CHECK):

```sql
ALTER TABLE public.parcel_collection_assignments
    ADD CONSTRAINT parcel_collection_assignments_current_state_chk
    CHECK ( (is_current AND ended_at IS NULL  AND end_reason IS NULL)
         OR (NOT is_current AND ended_at IS NOT NULL AND end_reason IS NOT NULL) );
```

Cross-row / cross-table invariants (single current row per order; pointer matches current
row; no current row after `FAILED` / `RECEIVED_AT_COMPANY` / order cancellation) are enforced
by the partial unique index plus the transactional service logic in §4.1 / §4.3 — not by a
CHECK.

### 8.3 Order-cancellation guard (hard backend invariant — Phase 11.17.4)

Every order-cancellation API path (`POST /api/v1/orders/:id/cancel`, any bulk cancel, any
future direct path) **must reject** cancellation when
`orders.parcel_collection_status = 'COLLECTED_FROM_SENDER'`, because driver custody of the
parcel has not been resolved. The management flow is: confirm `RECEIVED_AT_COMPANY` first,
then cancel/return. Frontend button disabling is UX only; this backend check is
authoritative.

When cancellation is allowed from `ASSIGNED`, the cancel handler must, in the **same
transaction** as the order status change: end the current
`parcel_collection_assignments` row with `end_reason = 'ORDER_CANCELLED'` and set
`orders.current_parcel_collection_driver_id = NULL`.

No migration is created now. This section is the checklist for Phase 11.17.2.

---

## 9. Existing-order migration / backfill

All pre-feature orders were created under the assumption that the parcel was already at the
company before delivery assignment.

### Safe sequence (Phase 11.17.2)

1. Create enums; add the new `orders` columns as **nullable**; create the three new tables
   (empty). No constraints that would fail on existing data yet.
2. Backfill existing orders:

   ```sql
   UPDATE public.orders SET
       parcel_intake_method            = 'ALREADY_AT_COMPANY',
       parcel_collection_status        = 'RECEIVED_AT_COMPANY',
       received_at_company_at          = created_at,
       received_at_company_by_id       = created_by_id,
       current_parcel_collection_driver_id = NULL
   WHERE parcel_intake_method IS NULL;
   ```

   Collection snapshot columns (`parcel_collection_contact_name`, `_phone`, `_alt_phone`,
   `_area_id`, `_area`, `_address`, `_notes`) and `parcel_collected_from_sender_at` stay
   `NULL`. Do **not** fabricate sender collection locations for historical orders.

3. Verify: every order has non-null `parcel_intake_method`, `parcel_collection_status`,
   `received_at_company_at`, `received_at_company_by_id`; zero rows in
   `parcel_collection_assignments` / `parcel_collection_attempts`; no existing order appears
   in any collection queue (all are `RECEIVED_AT_COMPANY`).
4. Apply `NOT NULL` on `parcel_intake_method` and `parcel_collection_status`. *(As shipped:
   Phase 11.17.2 added them NOT NULL **with** a temporary DB default so the not-yet-parcel-aware
   Create Order kept working; Phase 11.17.4 made Create Order explicit and migration `__1174__`
   dropped both defaults. Final state = NOT NULL, no default, written only by the service.)*
5. Add indexes and the partial unique index from §8.

### Must not change

- `orders.current_driver_id`, `order_assignments`, `delivery_attempts`,
  `order_status_history`, and every financial ledger keep their exact current meaning.
- No existing delivery assignment is converted into a collection assignment.
- `OrderStatus` enum is unchanged; `RECEIVED` keeps its value. Its documented meaning is
  clarified (order recorded in system; company possession is read from
  `parcel_collection_status` / receipt fields) — see `requirements.md` §17.1 / §18.

---

## 10. Prisma direction (Phase 11.17.2)

- Add `enum ParcelIntakeMethod`, `enum ParcelCollectionStatus`,
  `enum ParcelCollectionAttemptOutcome`, `enum ParcelCollectionAssignmentEndReason`.
- Add the new fields to `model orders` with `@map` to the snake_case columns, plus relations
  `parcel_collection_assignments[]`, `parcel_collection_attempts[]`, a `drivers?` relation
  for `current_parcel_collection_driver_id` (distinct relation name from the existing
  delivery `drivers` relation), an `areas?` relation for `parcel_collection_area_id`
  (distinct relation name from `receiver_area_id`), and a `users?` relation for
  `received_at_company_by_id`.
- Add `model parcel_collection_assignments`, `model parcel_collection_attempts`,
  `model failed_collection_reasons` mirroring the SQL above.
- Add back-relations on `drivers`, `users`, `areas`, `orders`, `failed_collection_reasons`.
- Regenerate the client. Keep `schema.prisma` and `/docs/swiftdrop_database` in sync when
  the schema is re-dumped.

---

## 11. Financial non-regression (contract)

Parcel Intake / Collection creates **zero** rows in `wallet_transactions`,
`driver_cash_transactions`, `company_financial_transactions`, `customer_payouts`,
`driver_settlements`. No `DriverCashTransactionType.COLLECTION`, no wallet `ORDER_CREDIT`,
no company revenue, no fee, no commission. The existing financial formulas and the
`collection_payment_method_id` / `collection_difference_reason` / `actual_amount_collected`
columns are untouched and continue to mean money collected from the receiver on delivery.

Regression phrase to keep true: **`parcel collection != cash collection`.**

---

## 12. Approved architecture decisions

These were open in Phase 11.17.1 and are now **APPROVED** (no implementation this session):

1. No `NOT_REQUIRED` Parcel Collection status.
2. `ALREADY_AT_COMPANY` orders are created directly at `parcel_collection_status =
   RECEIVED_AT_COMPANY` (receipt time = `created_at`, confirmer = `created_by_id`, no
   assignment row).
3. Failed Collection Reasons use a **separate Settings tab** (not a shared "Failure
   Reasons" area).
4. A DB-level **partial unique index** enforces one current Parcel Collection assignment per
   order (`WHERE is_current`). No retro-fit to `order_assignments`.
5. `ParcelCollectionAttemptOutcome = { COLLECTED, FAILED }` for V1.
6. **No `RETURNED`** Parcel Collection attempt outcome in V1.
7. `ParcelCollectionAssignmentEndReason = { REASSIGNED, FAILED, RECEIVED_AT_COMPANY,
   ORDER_CANCELLED }`.
8. `COLLECTED_FROM_SENDER` **retains** the current collection assignment and
   `current_parcel_collection_driver_id`; collection reassignment is forbidden from that
   point on.
9. `RESCHEDULED` carries **no** driver and **no** scheduled date in V1; it only records
   Management approval of another attempt.
10. **Order cancellation while collection is active** (§4.3): allowed from
    `AWAITING_ASSIGNMENT` / `ASSIGNED` / `FAILED` / `RESCHEDULED` under existing
    order-cancellation rules; from `ASSIGNED` it atomically closes the assignment with
    `end_reason = 'ORDER_CANCELLED'` and clears the pointer. **Rejected from
    `COLLECTED_FROM_SENDER`** — receipt must be confirmed first. No "cancelled while driver
    holds parcel" workflow, no `RETURNED` attempt outcome, no fabricated attempt row in V1.

### Route decision

- `/driver/jobs` is the future **canonical** Driver work-list route.
- **No `/driver/orders` compatibility alias** is required in Phase 11.17.
- The exact Driver job-detail route is finalized in Phase 12 from the final
  Collection / Delivery job DTO.
