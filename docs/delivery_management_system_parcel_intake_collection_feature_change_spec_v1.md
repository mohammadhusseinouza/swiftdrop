# Delivery Management System
## Parcel Intake & Driver Collection — Feature Change Specification v1

**Status:** Business behavior approved; documentation update required before implementation  
**Purpose:** Formalize the new parcel intake / pre-delivery driver collection capability and define its impact on the approved V1 system before any code changes.

---

# 1. Feature Summary

A delivery order must now distinguish between:

1. A parcel that is already physically at the company when the order is created.
2. A parcel that must first be collected from the customer/sender by a driver and returned to the company before final delivery assignment.

This new process is a **Parcel Intake / Parcel Collection workflow** that occurs before the existing Delivery workflow.

The system must treat Parcel Collection and Delivery as two separate responsibilities, even when the same physical driver performs both jobs.

---

# 2. Locked Business Decisions

The following decisions are approved and must be treated as requirements.

1. **Collection Driver and Delivery Driver may be the same driver.**
   - They are still recorded as separate assignments and separate responsibilities.

2. **Company receipt is confirmed by Management.**
   - A Collection Driver can confirm that the parcel was collected from the sender.
   - Only an authorized Management user, currently Admin/Dispatcher according to operational permission rules, confirms that the parcel was received at the company.

3. **Collection Driver assignment is optional during order creation.**
   - Management may assign a Collection Driver while creating the order.
   - The order may also be created with Collection required but without a Collection Driver, to be assigned later.

4. **Parcel Collection is free of charge in V1.**
   - No collection fee is charged.
   - Parcel Collection creates no Customer Wallet, Driver Cash, Company Finance, payout, settlement, or other financial posting.

5. **Already-at-company orders are automatically considered received by the company.**
   - The order creator is recorded as the user who confirmed receipt.
   - The receipt timestamp is the order creation timestamp.

6. **Failed Parcel Collection is supported.**
   - Collection failure does not automatically cancel the entire order.
   - The collection can be rescheduled and retried.

7. **Collection address/contact starts from the Customer's saved information and becomes an order snapshot.**
   - Later Customer profile edits must not rewrite historical collection details for an existing order.

8. **Collection Driver can be reassigned before successful collection.**
   - Reassignment must preserve permanent assignment history.

9. **Parcel Intake Method is independent of Order Type.**
   - Both `COMPANY_ORDER` and `DELIVERY_ONLY` may use either intake method.

---

# 3. Terminology

The project already uses the word **collection** extensively for money collection, for example:

- amount to collect
- actual amount collected
- collection payment method
- collection difference
- Driver Cash `COLLECTION`

Therefore, backend/database code must avoid ambiguous generic names.

Preferred technical terminology:

- `ParcelIntake`
- `ParcelCollection`
- `ParcelCollectionAssignment`
- `ParcelCollectionAttempt`
- `ParcelCollectionStatus`

Avoid ambiguous names such as:

- `collectionStatus`
- `collectionAttempt`
- `collectionTransaction`

unless they are clearly namespaced under the Parcel Collection domain.

UI wording may use:

- Collection Driver
- Collected From Sender
- Received At Company

Existing financial collection terminology remains unchanged.

---

# 4. Order Type vs Intake Method

These are independent dimensions.

## Order Type

- `COMPANY_ORDER`
- `DELIVERY_ONLY`

## Parcel Intake Method

- `ALREADY_AT_COMPANY`
- `DRIVER_COLLECTION`

All four combinations are valid.

| Order Type | Intake Method | Valid |
|---|---|---|
| COMPANY_ORDER | ALREADY_AT_COMPANY | Yes |
| COMPANY_ORDER | DRIVER_COLLECTION | Yes |
| DELIVERY_ONLY | ALREADY_AT_COMPANY | Yes |
| DELIVERY_ONLY | DRIVER_COLLECTION | Yes |

No Order Type may be hard-wired to one Intake Method.

---

# 5. Core Workflow

## 5.1 Already At Company

```text
Create Order
  -> Intake Method = ALREADY_AT_COMPANY
  -> Received At Company recorded automatically
  -> Received By = order creator
  -> Ready for Delivery Assignment
  -> Existing Delivery workflow
```

There is no fake Parcel Collection assignment for this path.

## 5.2 Driver Collection Required

```text
Create Order
  -> Intake Method = DRIVER_COLLECTION
  -> Collection Driver assigned now OR later
  -> Collection Driver collects parcel from sender
  -> COLLECTED_FROM_SENDER
  -> Driver transports parcel to company
  -> Management confirms RECEIVED_AT_COMPANY
  -> Ready for Delivery Assignment
  -> Delivery Driver assigned
  -> Existing Delivery workflow
```

---

# 6. Critical Backend Invariant

A Delivery Driver must never be assigned until the parcel has been confirmed as physically received at the company.

Conceptually:

```text
Delivery Assignment allowed only when:
Parcel Intake Status = RECEIVED_AT_COMPANY
```

This rule must be enforced server-side for every delivery-assignment path, including:

- normal assign
- reassign where applicable
- create-and-assign
- bulk assignment
- direct API calls

Frontend disabling is not sufficient.

---

# 7. Parcel Intake State Model

Parcel Intake must be a separate state machine from the existing Delivery status machine.

Recommended V1 Parcel Collection statuses:

```text
NOT_REQUIRED
AWAITING_ASSIGNMENT
ASSIGNED
COLLECTED_FROM_SENDER
FAILED
RESCHEDULED
RECEIVED_AT_COMPANY
```

Notes:

- `NOT_REQUIRED` applies when Intake Method = `ALREADY_AT_COMPANY` only if the implementation chooses to represent this explicitly. It is also acceptable for such orders to be directly represented as `RECEIVED_AT_COMPANY`, provided the contract is consistent.
- `COLLECTED_FROM_SENDER` does **not** mean the company has received the parcel.
- `RECEIVED_AT_COMPANY` is the gate for Delivery Assignment.

The existing Delivery status lifecycle remains conceptually separate.

---

# 8. Existing `RECEIVED` Delivery Status

The previous V1 requirement defined `RECEIVED` as meaning the order was entered and the package was received by the company.

That definition is no longer universally correct because a Collection-required order may exist before the company possesses the parcel.

After this feature:

- physical company receipt must be determined from the Parcel Intake workflow;
- the existing Delivery/Order status must no longer be the sole source of truth for company possession.

The exact migration/reinterpretation of `RECEIVED` must be documented during the database/order-engine contract update without collapsing Parcel Intake and Delivery into one oversized status enum.

---

# 9. Parcel Collection Assignment Model

Existing Delivery assignment behavior remains dedicated to final Delivery.

Existing concepts such as:

- current Delivery Driver on Order
- Delivery assignment history

must not be repurposed for Parcel Collection.

A separate Parcel Collection assignment model is required.

Conceptual fields/history:

```text
ParcelCollectionAssignment
- id
- orderId
- driverId
- assignedByUserId
- assignedAt
- endedAt
- endReason
- isCurrent / equivalent current-assignment rule
```

Required behavior:

- assign Collection Driver
- assign during creation or later
- reassign before successful collection
- preserve all previous assignments
- inactive Drivers should not normally receive new assignments
- the same Driver may later also receive the Delivery assignment

---

# 10. Parcel Collection Attempt Model

Parcel Collection failures must not be written into existing `delivery_attempts`.

A separate attempt history is required.

Conceptually:

```text
ParcelCollectionAttempt
- id
- orderId
- driverId
- attemptNumber
- outcome
- failedCollectionReasonId, nullable
- notes, nullable
- completedAt
```

The exact schema may differ, but the following requirements are mandatory:

- failed attempts are permanent history;
- retries do not overwrite previous attempts;
- failure/reschedule remains separate from failed Delivery attempts.

---

# 11. Failed Collection Reasons

Failed Parcel Collection requires its own configurable reason catalog.

Do not reuse Failed Delivery Reasons.

Recommended initial reasons:

- Sender unavailable
- Parcel not ready
- Unable to contact sender
- Incorrect collection address
- Sender requested reschedule
- Collection cancelled by sender
- Other

Recommended model follows the existing Failed Delivery Reason pattern:

```text
FailedCollectionReason
- id
- name
- requiresNotes
- isActive
- sortOrder
- createdAt
- updatedAt
```

Rules:

- `Other` should require notes if configured that way.
- inactive reasons remain visible in historical attempts.
- inactive reasons are not available for new collection failures.
- no hard delete in normal Settings management.

---

# 12. Collection Contact and Address Snapshot

For `DRIVER_COLLECTION`, Parcel Collection details start from the selected Customer's saved information.

Recommended snapshot concepts:

- Collection Contact Name
- Collection Phone
- Alternative Phone if needed
- Collection Area
- Collection Address
- Collection Notes

The UI should prefill these values from the Customer.

Once the Order is created, the Parcel Collection snapshot belongs to the Order and is not automatically rewritten when the Customer profile changes.

This matches the existing receiver-snapshot principle.

---

# 13. Company Receipt Confirmation

For Collection-required Orders:

1. Collection Driver confirms `COLLECTED_FROM_SENDER`.
2. Management later confirms `RECEIVED_AT_COMPANY`.

Required receipt information:

- received-at-company timestamp
- confirming Management user

The Collection Driver must not be able to perform the Management receipt-confirmation step through the Driver workflow.

For `ALREADY_AT_COMPANY`:

- received-at-company timestamp = creation timestamp
- confirming user = order creator

---

# 14. Financial Rules

Parcel Collection is operational only in V1.

It creates no financial posting.

Required no-side-effect rule:

```text
Parcel Collection action
Customer Wallet       no change
Driver Cash           no change
Company Finance       no change
Customer Payout       no change
Driver Settlement     no change
```

Do not introduce a `collectionFee` business rule in V1.

Existing financial collection rules remain unchanged and refer to money collected from the receiver during Delivery.

Explicit regression requirement:

```text
parcel collection != cash collection
```

---

# 15. Create Order Changes

Create Order must gain a **Parcel Intake** section.

Recommended structure:

```text
Customer & Order Type
Receiver Information
Package Information
Payment Information
Parcel Intake
Delivery Assignment
```

## Parcel Intake fields

```text
How will the parcel reach the company?
- Already at Company
- Collection by Driver Required
```

When `DRIVER_COLLECTION` is selected:

- Collection Contact
- Collection Phone
- Collection Area
- Collection Address
- Collection Notes
- Collection Driver, optional

## Assignment actions

For Collection-required orders, the existing concept of “Create & Assign” must not ambiguously assign a Delivery Driver.

Use explicit semantics such as:

- Create Order
- Create & Assign Collection Driver

Delivery Driver assignment is unavailable until company receipt is confirmed.

For Already-at-company orders, immediate Delivery assignment may remain available if allowed by the existing Order workflow.

---

# 16. Orders List Changes

Orders must distinguish Parcel Intake state from Delivery state.

Potential list information:

- Order
- Customer
- Receiver
- Intake Method / Intake Status
- Collection Driver
- Delivery Driver
- Delivery Status
- Amount to Collect
- Created Date

Recommended filters:

- Intake Method
- Parcel Collection Status
- Collection Driver
- existing Delivery Driver
- existing Delivery Status

Do not make the table unnecessarily wide; exact visual layout can use compact badges/secondary lines.

---

# 17. Bulk Assignment Changes

Existing bulk assignment continues to mean **Delivery assignment** unless a separate Parcel Collection bulk action is deliberately added later.

Delivery bulk assignment must reject orders that have not reached `RECEIVED_AT_COMPANY`.

Preserve existing atomic semantics.

Example:

```text
Order A: received at company
Order B: received at company
Order C: collection in progress

Bulk assign A+B+C for Delivery
-> reject the batch according to existing atomic bulk behavior
```

Do not silently partially assign eligible rows unless the approved bulk contract is intentionally changed.

---

# 18. Order Detail Changes

Order Detail becomes the primary chain-of-custody view.

Add a dedicated Parcel Intake / Collection section containing:

- Intake Method
- Parcel Collection Status
- Collection Contact
- Collection Address
- Current Collection Driver
- Collection Assignment History
- Collection Attempts
- Collected From Sender timestamp
- Received At Company timestamp
- Received At Company By

Existing Delivery section remains separate and contains:

- Delivery Driver
- Delivery assignment history
- pickup from company
- out-for-delivery
- Delivery attempts
- final Delivery result

The unified timeline may combine events chronologically while preserving their type.

Example:

```text
Order Created
Collection Driver Assigned
Collection Driver Reassigned
Collection Failed
Collection Rescheduled
Collected From Sender
Received At Company
Delivery Driver Assigned
Picked Up From Company
Out For Delivery
Delivered
```

---

# 19. Dashboard Changes

The previous meaning of “Unassigned” is no longer sufficient.

An order may have no Delivery Driver because Parcel Collection is still in progress.

Recommended operational concepts:

- Awaiting Collection Assignment
- Collection In Progress
- Collection Failed / Attention Required
- Collected — Awaiting Company Receipt
- Ready For Delivery Assignment

Delivery-unassigned logic must only include an order when:

```text
Parcel received at company
AND
no current Delivery Driver
AND
the Delivery workflow permits assignment
```

Do not count Collection-in-progress orders as Delivery assignment failures.

---

# 20. Driver Management Changes

Existing Delivery metrics must keep their current meaning.

Do not silently merge Parcel Collection activity into:

- Deliveries Completed Today
- Delivery Success Rate
- Failed Deliveries
- Delivery History

Parcel Collection work should be represented separately where needed, for example:

- Active Collection Jobs
- Collections Completed
- Failed Collection Attempts

Driver Detail may eventually separate:

- Current Collection Jobs
- Collection History
- Current Delivery Orders
- Delivery History

Exact UI scope is part of the later Management integration sub-phase.

---

# 21. Driver Portal Changes

The Driver Portal should be built around **assigned jobs**, not only final Delivery orders.

A Driver may receive:

## Collection Job

```text
COLLECTION
Sender / Customer -> Company
```

Required information should be limited to what is necessary to perform collection:

- sender/customer contact
- collection address
- collection notes
- package/order identification

Primary actions include:

- Collected From Sender
- Collection Failed
- Collection Reschedule flow where authorized by the contract

## Delivery Job

```text
DELIVERY
Company -> Receiver
```

Existing Delivery information/actions remain:

- receiver information
- amount to collect
- pickup from company
- out for delivery
- delivered / failed

A Driver may perform both jobs for the same Order at different times.

---

# 22. Customer Portal Tracking

Customer-facing tracking should expose simplified Parcel Collection stages.

For Collection-required orders:

```text
Order Created
Collection Scheduled
Parcel Collected
Received at Company
Preparing for Delivery
Out for Delivery
Delivered
```

For Already-at-company orders, Collection-specific stages may be omitted:

```text
Order Created
Received at Company
Preparing for Delivery
Out for Delivery
Delivered
```

Do not expose internal Management details such as the employee who confirmed company receipt.

---

# 23. Public Tracking

Public Tracking may expose only safe simplified stages.

Potential safe stages:

- Order Created
- Parcel Collected
- Received at Company
- Preparing for Delivery
- Out for Delivery
- Delivered

Do not expose:

- collection address
- sender phone
- Collection Driver contact
- internal failure notes
- Management actor identity
- internal audit metadata

---

# 24. Reports

Existing Delivery metrics must remain semantically stable.

Do not redefine current Driver Report fields such as:

- ordersAssigned
- ordersDelivered
- failedAttempts
- deliveryAttempts
- successRate

so that they suddenly include Parcel Collection.

Parcel Collection metrics should be separate where added, for example:

- Collection Assignments
- Collections Completed
- Failed Collection Attempts
- Collection Success Rate

Any added report fields must clearly distinguish Collection from Delivery.

---

# 25. Audit vs Operational History

Parcel Collection needs both operational history and selected Management audit events.

## Operational Parcel Collection history

Examples:

- Collected From Sender
- Collection Failed
- Collection Rescheduled
- Collection Attempt Created/Completed

These belong to the Parcel Collection domain history.

## Management Audit

Examples:

- Collection Driver Assigned
- Collection Driver Reassigned
- Company Receipt Confirmed
- Failed Collection Reason configuration changed

Do not duplicate every operational event into Audit Logs unnecessarily.

---

# 26. Permissions

No new permission code is automatically required merely because Parcel Collection exists.

Preferred reuse where semantically correct:

- `orders.read`
- `orders.create`
- `orders.update`
- `orders.assign`
- `orders.change_status`
- `settings.read`
- `settings.manage`

Driver own-work permissions may be reused during Phase 12 if they safely represent both Collection and Delivery own jobs.

If an existing permission cannot safely authorize a new operation, add a permission deliberately during implementation rather than introducing role-name checks.

Portal-family access remains role-code based.

---

# 27. Settings Changes

Settings requires a new Failed Collection Reasons management surface.

Preferred approaches:

1. Add a dedicated **Failed Collection Reasons** tab, or
2. Add a **Failure Reasons** section with distinct Delivery and Collection sub-sections.

Recommended V1 approach: explicit separate Failed Collection Reasons management for clarity.

It should follow the existing Settings reference-data behavior:

- settings.read to view
- settings.manage to create/edit/deactivate/reactivate
- no hard delete
- audit configuration changes

Do not grant DRIVER `settings.read` merely so the Driver Portal can load Collection reasons.

Phase 12 must use a narrowly safe Driver-facing endpoint for active Collection failure reasons if needed.

---

# 28. Existing Order Migration

All orders created before this feature were created under the previous assumption that the company already possessed the parcel before Delivery assignment.

Existing orders must therefore migrate as:

```text
Intake Method = ALREADY_AT_COMPANY
Parcel Intake Status = RECEIVED_AT_COMPANY
Received At Company At = Order Created At
Received At Company By = Order Created By
```

Existing records remain Delivery records:

- current Delivery Driver
- Delivery assignment history
- Delivery attempts
- financial transactions

No old Delivery assignment may be reinterpreted as Parcel Collection work.

The migration must preserve historical behavior and must not cause old Orders to appear in Collection queues.

---

# 29. Database Design Direction

The exact SQL/Prisma design must be finalized before implementation, but the approved direction requires support for:

## Orders / Intake fields

Conceptually:

- intake method
- current Parcel Collection status
- current Parcel Collection Driver reference or equivalent efficient lookup
- collection contact/address snapshot fields
- collected-from-sender timestamp where appropriate
- received-at-company timestamp
- received-at-company Management user

## New tables

- Parcel Collection Assignments
- Parcel Collection Attempts
- Failed Collection Reasons

Potential additional history structures may be used if needed, but do not duplicate the existing Delivery history model unnecessarily.

## Existing tables remain Delivery-specific

- `order_assignments`
- `delivery_attempts`

The exact approved SQL must keep Prisma synchronized with the manually authoritative PostgreSQL schema.

---

# 30. API / Backend Contract Direction

Exact routes must be designed from the existing module conventions, but the backend will need capabilities for:

- create Order with Intake Method
- optional Collection Driver assignment at creation
- assign Collection Driver
- reassign Collection Driver
- Driver mark Collected From Sender
- Driver report Collection failure
- Collection reschedule/retry flow
- Management confirm Received At Company
- read Collection assignment/history/attempts on Order Detail
- active Failed Collection Reasons for appropriate Management/Driver scopes
- Delivery assignment gate based on company receipt

Do not expose Management Settings broadly to Driver role.

---

# 31. Test Requirements

At minimum the new feature must include regression coverage for:

## Already-at-company

- create Order
- receipt auto-recorded
- creator recorded as receipt confirmer
- Delivery assignment allowed according to Delivery status rules

## Collection required

- create unassigned Collection Order
- assign Collection Driver later
- assign Collection Driver during creation
- reassign Collection Driver preserving history
- mark Collected From Sender
- Delivery assignment still rejected before Management receipt
- Management confirms company receipt
- Delivery assignment becomes allowed

## Same Driver both responsibilities

- Driver A collects
- Driver A later receives final Delivery assignment
- histories remain separate

## Collection failure

- failed reason required where configured
- failed attempt persists
- reschedule creates further history
- previous attempt remains unchanged

## Finance

- Parcel Collection produces zero Wallet posting
- zero Driver Cash posting
- zero Company Finance posting
- existing Delivery financial behavior unchanged

## Bulk Delivery assignment

- ineligible Collection-in-progress order causes rejection according to atomic bulk contract

## Migration

- all existing Orders appear as Already At Company / Received At Company
- old Delivery history remains unchanged

## Authorization / privacy

- Driver sees only assigned Collection/Delivery work
- Collection Driver gets only Collection-required data
- public/customer tracking exposes only simplified safe stages

---

# 32. Explicit Non-Goals for This Feature

Not part of this change unless separately approved:

- collection fee
- Collection Driver commission
- GPS tracking
- route optimization
- proof-of-collection photos
- sender signatures
- OTP collection confirmation
- barcode/QR scanning
- automatic route planning
- multiple company depots/branches
- transfer between branches
- advanced Collection analytics

---

# 33. Required Documentation Updates Before Coding

The authoritative project documents must be updated before implementation.

## `requirements.md`

Update at least:

- Project Overview
- Admin / Dispatcher / Driver responsibilities
- Order Information
- Driver Assignment
- Order Lifecycle / Status Definitions
- Failed reason sections
- Driver Portal
- Customer/Public Tracking
- System modules / final business rules

Add dedicated sections for:

- Parcel Intake Methods
- Parcel Collection workflow
- Collection assignment/reassignment
- Collection failure/reschedule
- company receipt confirmation
- free-of-charge rule
- Delivery assignment gate

## `page-structure.md`

Update at least:

- Dashboard
- Orders List
- Create Order
- Order Detail
- Drivers / Driver Detail
- Settings
- Driver Portal
- Customer Portal tracking
- Public Tracking
- status presentation

## `database.sql`

Design and approve:

- Intake method/status fields
- Collection snapshot fields
- Parcel Collection assignment history
- Parcel Collection attempt history
- Failed Collection Reasons
- receipt-confirmation fields
- indexes/constraints
- migration/backfill for existing Orders

## `implementation-plan.md`

Insert a controlled change phase before Driver Portal work.

Recommended:

```text
Phase 11.17 — Parcel Intake & Collection Integration

11.17.1 Requirements + Database Contract Update
11.17.2 Database / Prisma + Migration
11.17.3 Parcel Collection Backend
11.17.4 Order Engine Integration
11.17.5 Management UI Integration
11.17.6 Dashboard + Reports + Audit + Tracking Contracts
11.17.7 Full Regression + Visual Acceptance
```

Only after 11.17 is approved should Phase 12 Driver Portal begin.

## `CLAUDE.md`

Add mandatory implementation rules:

- Parcel Collection and financial cash Collection are separate concepts.
- Delivery assignment requires company receipt.
- Collection and Delivery assignments are separate histories.
- same Driver may perform both jobs.
- Parcel Collection is financially neutral in V1.
- Failed Collection and Failed Delivery histories/reasons are separate.
- do not expose Management Settings to Driver merely for Collection reasons.

---

# 34. Approval Gate

Before coding begins, approve all of the following:

- Feature Change Specification
- revised requirements
- revised page structure
- revised database design
- revised implementation plan
- any new/changed permissions, if later found necessary
- migration strategy for existing Orders

Then implementation may begin with:

**Phase 11.17.1 — Requirements + Database Contract Update**

No Phase 12 Driver Portal work should begin before this feature is integrated and approved.

---

# 35. Locked Feature Summary

The approved feature can be summarized as:

> Every Order has a Parcel Intake Method independent of Order Type. A parcel may already be at the company or require free Driver Collection from the sender. Collection Driver work is separate from final Delivery work, may be assigned during creation or later, may be reassigned, may fail/reschedule, and may be performed by the same Driver who later performs Delivery. The Collection Driver confirms possession from the sender, while Management confirms receipt at the company. Final Delivery assignment is forbidden until company receipt is confirmed. Parcel Collection creates no financial posting in V1 and must remain technically distinct from financial cash collection.
