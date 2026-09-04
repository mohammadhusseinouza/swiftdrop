# Delivery Management System
## Complete Requirements Specification — Version 1

## 1. Project Overview

The Delivery Management System is a web-based system designed primarily for the internal management of a delivery company.

The system will manage the complete delivery lifecycle, including:

- Customers
- Employees
- Drivers
- Orders
- Parcel intake (parcel already at company, or driver collection from the sender)
- Parcel collection assignments
- Delivery assignments
- Order tracking
- Customer wallets
- Driver cash collection
- Driver settlements
- Customer payouts
- Company delivery revenue
- Reports
- Audit history

The system will provide three main authenticated interfaces:

1. **Management Portal**
2. **Driver Portal**
3. **Customer Portal**

A separate **Public Tracking Page** will also be available for receivers or other users who only need to track an order.

---

# 2. Main System Users

## 2.1 Admin

The Admin has full access to the system.

The Admin can:

- Manage employees
- Manage drivers
- Manage customers
- Create and edit orders
- Assign and reassign collection drivers
- Assign and reassign delivery drivers
- Confirm parcels received at the company
- Manage customer wallets
- Manage customer payouts
- Manage driver settlements
- View company financial information
- View reports
- View audit logs
- Manage system settings
- Manage user permissions

## 2.2 Employee / Dispatcher

Employees handle normal operational work.

They can:

- View customers
- Create customers
- Edit customer information
- Create orders
- Edit orders before completion
- Assign and reassign collection drivers
- Assign and reassign delivery drivers
- Confirm parcels received at the company
- Reschedule and retry failed parcel collections
- Change operational order statuses
- Search and filter orders
- View tracking information
- View customer order history
- View operational dashboard information

Financial permissions can be restricted depending on the employee's role.

## 2.3 Finance / Accountant

Finance users manage money-related operations.

They can:

- View customer wallets
- Process customer payouts
- View wallet transactions
- Process driver cash settlements
- View driver balances
- View company revenue
- View financial reports
- Create authorized financial adjustments when necessary

Financial transactions must remain traceable.

## 2.4 Driver

Drivers have limited access.

A driver can only access the jobs assigned to them. A driver may hold two kinds of job for
an order at different times: a **collection job** (bring the parcel from the sender to the
company) and a **delivery job** (deliver the parcel from the company to the receiver). The
same driver may hold both jobs for the same order; they remain separate assignments.

Drivers can:

- View their assigned collection jobs and delivery jobs
- View sender / collection contact and address for a collection job
- View receiver information, delivery address, phone, and instructions for a delivery job
- View amount that must be collected (delivery jobs only)
- Confirm a parcel was collected from the sender
- Mark a parcel collection attempt as failed (with a reason)
- Mark an order as picked up (from the company)
- Start delivery
- Mark an order as delivered
- Mark a delivery attempt as failed
- Enter the actual amount collected
- View their delivery and collection history
- View their current collected-cash balance

Drivers cannot confirm that a parcel was **received at the company** — only authorized
Management can confirm company receipt.

Drivers cannot access:

- Customer wallet balances
- Other drivers' orders
- Company revenue
- Internal accounting
- Employee management
- Other customers' information

## 2.5 Customer

A registered customer can use the customer portal.

A customer can:

- View their own orders
- View basic tracking stages
- View delivered orders
- View active orders
- View their wallet balance
- View pending delivery amounts
- View wallet transaction history
- View payout history

A customer cannot modify financial transactions.

A customer cannot view another customer's information.

---

# 3. Customer Model

A customer can perform both types of business with the company:

1. Buy an order directly from the company.
2. Give the company an order/package to deliver to another receiver.

Therefore, there is only **one Customer entity**.

Suggested customer information includes:

- Customer ID
- Name / business name
- Primary phone number
- Secondary phone number
- Email, optional
- Default address
- Area / city
- Notes
- Active / inactive status
- Wallet balance
- Date created
- Created by

A customer may have multiple orders and multiple wallet transactions.

---

# 4. Receiver Model

The receiver of an order does **not** need to be a registered customer.

Receiver information is stored directly on the order.

An order should contain:

- Receiver name
- Receiver phone
- Alternative phone, optional
- Area / city
- Full delivery address
- Building / floor information, optional
- Map/location link, optional
- Delivery instructions, optional

This allows a registered customer such as a shop to send orders to many different receivers without creating a customer account for every receiver.

---

# 5. Order Types

Each order must have one of two types.

## 5.1 Company Order

A Company Order means the product/order belongs to the delivery company.

Example:

- Order amount: $100
- Delivery fee: $5
- Total due: $105

After successful delivery:

- Order amount belongs to the company
- Delivery fee belongs to the company

Therefore:

**Company amount = Order Amount + Delivery Fee**

No customer wallet credit is created.

## 5.2 Delivery Only

Delivery Only means a customer gives the company something to deliver.

Example:

- Order value: $100
- Delivery fee: $5
- Total due: $105

After successful delivery:

- $100 belongs to the customer/sender
- $5 belongs to the delivery company

Therefore:

**Customer Wallet Credit = Collected Order Amount**

**Company Revenue = Delivery Fee**

The customer can later withdraw their wallet balance from the company.

---

# 5A. Parcel Intake and Parcel Collection

## 5A.1 Parcel Intake Method

Every order has a **Parcel Intake Method** that describes how the parcel reaches the
company. It is **independent of Order Type** — all four combinations are valid.

```text
Parcel Intake Method
- ALREADY_AT_COMPANY   the parcel is physically at the company when the order is created
- DRIVER_COLLECTION    a driver must first collect the parcel from the sender
```

An Order Type is never hard-wired to one intake method. A `COMPANY_ORDER` may require driver
collection; a `DELIVERY_ONLY` order may already be at the company.

## 5A.2 Parcel Collection is not money collection

"Parcel collection" (a driver bringing a parcel from a sender to the company) is a different
concept from the existing financial "collection" wording (money the driver collects from the
receiver on delivery). The two must never be mixed. Parcel collection technical naming is
always `Parcel`-prefixed (`ParcelIntakeMethod`, `ParcelCollectionStatus`, etc.).

## 5A.3 Parcel Collection state

`DRIVER_COLLECTION` orders move through a **Parcel Collection state** that is separate from
the order/delivery lifecycle:

```text
AWAITING_ASSIGNMENT    collection required, no current collection driver
ASSIGNED               a collection driver is assigned; parcel still with the sender
COLLECTED_FROM_SENDER  the driver has the parcel; the company does NOT have it yet
FAILED                 the last collection attempt failed; no current collection driver
RESCHEDULED            Management approved another attempt; no current collection driver
RECEIVED_AT_COMPANY    Management has confirmed the parcel is physically at the company
```

For `ALREADY_AT_COMPANY` orders the Parcel Collection state is `RECEIVED_AT_COMPANY`
immediately on creation (there is no separate "not required" state). The receipt timestamp
is the order creation time and the receipt confirmer is the order creator. No collection
assignment record is created.

**Current collection driver pointer.** The order carries a single "current collection
driver" value that always matches the one open collection assignment:

- set when a collection driver is assigned;
- **kept through `COLLECTED_FROM_SENDER`** — the driver still physically holds the parcel
  while transporting it to the company;
- cleared when a collection attempt fails, and when Management confirms receipt;
- empty while `AWAITING_ASSIGNMENT` or `RESCHEDULED`, and for `ALREADY_AT_COMPANY` orders.

This is a separate value from the current **delivery** driver and is never confused with it.

## 5A.4 Parcel Collection workflow (DRIVER_COLLECTION)

```text
Order created (intake = DRIVER_COLLECTION)
  -> Collection driver assigned now or later
  -> Driver confirms "Collected From Sender"
  -> Driver transports the parcel to the company
  -> Management confirms "Received At Company"
  -> Order is now eligible for delivery-driver assignment
  -> Existing delivery workflow
```

## 5A.5 Collection assignment and reassignment

- The collection driver is **optional at order creation** and may be assigned later.
- The collection driver may be **reassigned only before `COLLECTED_FROM_SENDER`**. Once the
  driver has confirmed possession from the sender, reassignment is forbidden — that driver
  keeps the job through company receipt.
- Reassignment ends the previous assignment record (reason: reassigned) and opens a new one;
  assignment history is permanent and is never overwritten.
- After a failed collection there is no current collection driver. Assigning a driver again
  — even the same person — always creates a new assignment record.
- Collection assignments are **separate records** from delivery assignments. The same
  physical driver may hold both, at different times, for the same order.
- Inactive drivers should not normally receive new collection assignments.

## 5A.6 Company receipt confirmation

- The **collection driver** confirms only that the parcel was collected from the sender.
- **Authorized Management** (Admin / Dispatcher under existing operational permissions)
  confirms that the parcel was received at the company.
- Company receipt records a timestamp and the confirming user.
- A driver can never perform the company-receipt step.

## 5A.7 Failed parcel collection

- A collection attempt can fail. A failed collection does **not** automatically cancel the
  order.
- A failed collection records a configured **Failed Collection Reason** and notes where the
  reason requires them.
- Collection may be rescheduled and retried; each retry is a new attempt.
- Failed collection attempts are permanent history and are never overwritten.
- **Failed Collection Reasons are a separate configurable catalog from Failed Delivery
  Reasons** (see §19A).

## 5A.8 Collection contact and address snapshot

For `DRIVER_COLLECTION`, the collection contact and address are pre-filled from the
customer's saved information and then **stored as an order snapshot** (collection contact
name, collection phone, alternative phone, collection area, collection address, collection
notes). Later edits to the customer profile must not rewrite an existing order's collection
snapshot. This matches the existing receiver-snapshot principle (§4).

## 5A.9 Delivery assignment gate

> A delivery driver may not be assigned to an order until its Parcel Collection state is
> `RECEIVED_AT_COMPANY`.

This is a hard business rule enforced server-side on every delivery-assignment path (assign,
reassign, bulk assign, create-and-assign, direct API request). For bulk delivery assignment
the batch is atomic: if any selected order has not reached `RECEIVED_AT_COMPANY`, the whole
batch is rejected rather than partially assigned.

## 5A.10 Financial neutrality

Parcel collection is **free of charge in V1** and is financially neutral:

```text
Parcel Collection action
Customer Wallet      change 0
Driver Cash          change 0
Company Finance      change 0
Customer Payout      none
Driver Settlement    none
Collection fee       none
```

The existing financial rules (§10) are unchanged and continue to refer only to money
collected from the receiver during delivery.

## 5A.11 Parcel Collection state transition matrix

### Already at company

```text
(create, intake = ALREADY_AT_COMPANY)  ->  RECEIVED_AT_COMPANY
```

Recorded automatically: `received_at_company_at` = creation time,
`received_at_company_by` = order creator. No collection driver, no attempts.

### Driver collection

```text
(create, DRIVER_COLLECTION, no driver)   ->  AWAITING_ASSIGNMENT
(create, DRIVER_COLLECTION, with driver) ->  ASSIGNED
AWAITING_ASSIGNMENT   -- assign collection driver -->  ASSIGNED
ASSIGNED              -- reassign collection driver -->  ASSIGNED
ASSIGNED              -- driver: Collected From Sender -->  COLLECTED_FROM_SENDER
ASSIGNED              -- driver: Collection Failed -->  FAILED
COLLECTED_FROM_SENDER -- management: Received At Company -->  RECEIVED_AT_COMPANY
FAILED                -- management: reschedule -->  RESCHEDULED
RESCHEDULED           -- assign collection driver -->  ASSIGNED
```

Reassignment is **not** allowed from `COLLECTED_FROM_SENDER` onward.

### What each transition does to the collection assignment and the current-driver pointer

| Transition | Collection assignment row(s) | Current collection driver | Resulting status |
|---|---|---|---|
| Create `ALREADY_AT_COMPANY` | none created | empty | `RECEIVED_AT_COMPANY` |
| Create `DRIVER_COLLECTION`, no driver | none created | empty | `AWAITING_ASSIGNMENT` |
| Create `DRIVER_COLLECTION`, with driver | open a new current row | set to that driver | `ASSIGNED` |
| Assign collection driver | open a new current row | set to that driver | `ASSIGNED` |
| Reassign (before Collected From Sender) | end current row (reason: reassigned); open a new current row | set to the new driver | `ASSIGNED` |
| Collected From Sender | **current row unchanged**; append a `COLLECTED` attempt; set collected-from-sender time | **unchanged — driver keeps custody** | `COLLECTED_FROM_SENDER` |
| Collection Failed | append a `FAILED` attempt; end current row (reason: failed) | cleared | `FAILED` |
| Reschedule after failure | no row change (none open) | empty | `RESCHEDULED` |
| Received At Company | end current row (reason: received at company); set receipt time + confirmer | cleared | `RECEIVED_AT_COMPANY` |

- Every failed attempt is a permanent `parcel_collection_attempts` row; a retry adds a new
  row and never overwrites.
- All rows in each transition change together in **one transaction** — the status, the
  assignment row, and the current-driver pointer can never disagree.
- The assignment end reason is one of a fixed set: **reassigned**, **failed**,
  **received at company**, **order cancelled** (§5A.12).
- `RECEIVED_AT_COMPANY` is the only state from which a delivery driver may be assigned. The
  historical collecting driver stays visible in the collection assignment/attempt history.
- Full lifecycle detail and the DB invariants are in
  `/docs/parcel-intake-collection-database-contract.md` §4.1 / §4.3 / §8.

## 5A.12 Order cancellation while parcel collection is active

Order cancellation is an order-level action under the existing order-cancellation rules. It
does not change `parcel_collection_status` and never fabricates a collection attempt — the
collection status and history are kept as historical state, and the order's terminal
**Cancelled** status is what communicates the cancellation.

| Collection state when cancelled | Cancellation | Effect on the collection assignment |
|---|---|---|
| `AWAITING_ASSIGNMENT` | allowed | none — there is no assignment; do not create one |
| `ASSIGNED` | allowed | in the **same transaction**: end the current assignment (end reason = order cancelled), clear the current collection driver, then apply the order cancellation |
| `COLLECTED_FROM_SENDER` | **rejected** | — the driver physically holds the parcel; Management must confirm **Received At Company** first, then the cancellation / return workflow may proceed |
| `FAILED` | allowed | none — no current assignment |
| `RESCHEDULED` | allowed | none — no current assignment |
| `RECEIVED_AT_COMPANY` | per the existing post-receipt order/delivery workflow | none — assignment already closed at receipt |

Hard rules:

- A cancelled order must **never** leave a parcel in unresolved driver custody. Cancellation
  from `COLLECTED_FROM_SENDER` is rejected server-side on every cancellation path (frontend
  disabling is UX only).
- A cancelled order must **never** retain a current collection assignment or a current
  collection driver. Cancellation from `ASSIGNED` closes the assignment atomically — no
  exception.
- V1 adds no "cancelled while driver holds the parcel" workflow and no returned-collection
  outcome.
- "Order cancelled" (assignment end reason) is not the same as the Failed Collection Reason
  *"Collection cancelled by sender"* (§19A) and must not be conflated with it.

### Actor policy

| Transition | Actor | Permission (existing catalog) |
|---|---|---|
| Assign / reassign collection driver | Admin / Dispatcher | `orders.assign` |
| Collected From Sender | the assigned collection driver | `driver.orders.update_own` |
| Collection Failed (reason + notes) | the assigned collection driver | `driver.orders.update_own` |
| Reschedule / reassign after failure | Admin / Dispatcher (Management) | `orders.assign` / `orders.change_status` |
| Received At Company | Admin / Dispatcher (Management) | `orders.change_status` |
| View parcel intake information (Management) | Admin / Dispatcher / Finance as configured | `orders.read` |
| Driver sees own collection/delivery jobs | the assigned driver | `driver.orders.read_own` |
| Manage Failed Collection Reasons | Admin (or role with the permission) | `settings.read` / `settings.manage` |

No role-name checks: authorization is by permission code. The DRIVER role must not receive
`settings.read`; the Driver Portal reads active Failed Collection Reasons from a narrow
Driver-safe endpoint. If the existing permission model turns out not to express a required
action, the change is proposed for approval — not worked around with a role check.

---

# 6. Order Information

Each order should contain the following information.

## 6.1 Identification

- Internal order ID
- Order number
- Unique tracking code
- Order type
- Created date/time
- Created by employee

Order numbers and tracking codes must be automatically generated.

## 6.2 Customer Information

- Customer / sender
- Customer ID

## 6.3 Receiver Information

- Receiver name
- Receiver phone
- Alternative phone, optional
- Area / city
- Delivery address
- Location/map link, optional
- Delivery instructions

## 6.4 Package Information

- Order description
- Number of packages
- Quantity, where applicable
- Package notes
- Weight, optional
- Package size, optional

Weight and size are optional for Version 1.

## 6.5 Parcel Intake Information

- Parcel Intake Method (`ALREADY_AT_COMPANY` or `DRIVER_COLLECTION`)
- Parcel Collection Status
- Current Collection Driver (nullable)
- Collection contact name (snapshot, `DRIVER_COLLECTION` only)
- Collection phone / alternative phone (snapshot)
- Collection area (snapshot)
- Collection address (snapshot)
- Collection notes (snapshot)
- Collected-from-sender timestamp (nullable)
- Received-at-company timestamp
- Received-at-company confirmed by (user)

The current delivery driver (§6.3 area / §17) is a separate concept from the current
collection driver and must not be confused with it.

---

# 7. Payment Information

Every order must contain financial information.

Core fields:

- Order amount
- Delivery fee
- Payment type
- Amount already paid
- Remaining order amount
- Amount to collect
- Actual amount collected
- Payment method

Calculated values should be generated automatically wherever possible.

---

# 8. Payment Types

The system supports three payment types.

## 8.1 Cash on Delivery

Nothing has been paid beforehand.

Example:

- Order amount: $100
- Delivery fee: $5

Amount driver collects:

**$105**

## 8.2 Already Paid

The order amount has already been paid.

Depending on the order, the delivery fee may still need to be collected.

Example:

- Order amount: $100
- Already paid: $100
- Delivery fee: $5

Amount to collect:

**$5**

If both order and delivery fee were previously paid:

**Amount to collect = $0**

## 8.3 Partially Paid

Part of the order has already been paid.

Example:

- Order amount: $100
- Already paid: $40
- Delivery fee: $5

Remaining order amount:

**$60**

Amount to collect:

**$65**

The system must calculate this automatically.

---

# 9. Payment Methods

Payment type and payment method are separate concepts.

Supported payment methods may include:

- Cash
- Card
- Bank transfer
- Whish
- Other

Additional methods can be added later through system settings.

The system should allow the pre-paid amount and the delivery-time payment to use different payment methods if necessary.

---

# 10. Financial Rules

## 10.1 Company Order

When successfully delivered:

**Company receives:**

- Collected order amount
- Delivery fee

No customer wallet credit is created.

## 10.2 Delivery Only

When successfully delivered:

**Customer wallet receives:**

- The unpaid order amount actually collected through the delivery

**Company receives:**

- Delivery fee

Example:

Order:

- Value: $100
- Already paid to sender: $40
- Delivery fee: $5
- Driver collects: $65

After delivery:

- Customer wallet credit: $60
- Company delivery revenue: $5
- Driver cash balance increase: $65

The $40 already paid directly to the sender must not be credited again.

---

# 11. Customer Wallet

Every customer has a wallet.

The wallet represents money that the delivery company currently owes that customer.

Wallet money mainly comes from successfully completed **Delivery Only** orders.

Example:

Customer has three delivered orders:

- +$100
- +$70
- +$80

Wallet balance:

**$250**

---

# 12. Wallet Transactions

The system should not rely only on a manually editable wallet balance.

Every wallet movement must create a transaction.

Wallet transaction types include:

- Order credit
- Customer payout / withdrawal
- Authorized adjustment
- Reversal/correction where required

Each wallet transaction should contain:

- Transaction ID
- Customer
- Transaction type
- Related order, if applicable
- Credit amount
- Debit amount
- Resulting balance
- Date/time
- Created or processed by
- Payment method, where applicable
- Notes

Wallet balances should be calculated from valid wallet transactions or maintained consistently using transaction-based logic.

---

# 13. Wallet Available and Pending Amount

The customer portal should distinguish between:

### Available Balance

Money from successfully delivered orders that is currently owed to the customer.

### Pending Amount

Potential money associated with active Delivery Only orders that have not yet been successfully delivered.

Example:

- Available wallet: $300
- Pending deliveries: $150

The $150 must **not** become withdrawable until successful delivery and collection.

---

# 14. Customer Payout / Withdrawal

When the company gives wallet money to a customer, an authorized employee creates a payout.

Payout information includes:

- Payout ID
- Customer
- Amount
- Payment method
- Date/time
- Processed by
- Notes
- Status

Example:

Customer wallet before payout:

**$500**

Payout:

**$300**

Customer wallet after payout:

**$200**

The payout creates a wallet debit transaction.

The customer can view this transaction from their portal.

---

# 15. Driver Assignment

There are **two independent assignments** on an order:

1. **Parcel Collection assignment** — the driver who brings the parcel from the sender to
   the company. Applies only to `DRIVER_COLLECTION` orders.
2. **Delivery assignment** — the driver who delivers the parcel from the company to the
   receiver. Applies to every order.

They are separate assignments with separate permanent histories. The same physical driver
may hold both for one order at different times.

## 15.1 Parcel Collection assignment

- Optional at order creation; may be assigned later.
- May be reassigned any time before successful collection; previous assignment records are
  preserved.
- Only active drivers should normally receive new collection assignments.

## 15.2 Delivery assignment

An order does not need a delivery driver immediately when created.

For `DRIVER_COLLECTION` orders, a delivery driver **cannot** be assigned until the Parcel
Collection state is `RECEIVED_AT_COMPANY` (§5A.9). For `ALREADY_AT_COMPANY` orders a
delivery driver may be assigned as soon as the existing order workflow allows.

An employee may:

### Create Order Only

The order remains awaiting collection assignment or ready for delivery assignment,
depending on the intake method.

### Create & Assign Collection Driver

For a `DRIVER_COLLECTION` order, a collection driver is selected immediately.

### Create & Assign (Delivery)

For an order already received at the company, a delivery driver is selected immediately.

Employees must be able to:

- Assign / change the collection driver
- Assign / change the delivery driver
- Bulk assign multiple **received-at-company** orders to one delivery driver

Only active drivers should normally receive new assignments.

---

# 16. Bulk Assignment

The management portal should support selecting multiple orders and assigning them to one driver.

Example:

- Order #1001
- Order #1002
- Order #1003

Assign selected orders to:

**Driver Ali**

This is particularly useful after filtering orders by area.

Bulk assignment means **delivery** assignment. It is atomic: every selected order must have
Parcel Collection state `RECEIVED_AT_COMPANY`. If any selected order has not been received
at the company, the whole batch is rejected rather than partially assigned.

---

# 17. Order Lifecycle

The detailed internal order lifecycle is:

1. **Received**
2. **Ready for Pickup**
3. **Assigned**
4. **Picked Up**
5. **Out for Delivery**
6. **Delivered**

Additional exception statuses include:

- Failed Delivery
- Rescheduled
- Returned to Company
- Returned to Customer / Sender
- Cancelled

Not every order must pass through every exception status.

## 17.1 Order status vs. physical parcel possession

The order/delivery status (`RECEIVED` … `DELIVERED`) and the **physical Parcel Intake
state** (§5A.3) are two separate things. Company possession of the parcel is determined by
the Parcel Intake state / receipt information, **not** by `OrderStatus = RECEIVED` alone.
A `DRIVER_COLLECTION` order can be in status `RECEIVED` while the parcel is still with the
sender.

---

# 18. Status Definitions

## Received

The order has been entered and recorded in the system. This status alone does **not** prove
that the company physically holds the parcel. For `DRIVER_COLLECTION` orders the parcel may
still be with the sender; company possession is confirmed separately through the Parcel
Collection workflow (`RECEIVED_AT_COMPANY`, §5A.6). For `ALREADY_AT_COMPANY` orders the
parcel is at the company from creation.

## Ready for Pickup

The parcel is at the company, prepared and ready for a delivery driver.

## Assigned

A delivery driver has been assigned. (Reaching this status requires the parcel to have been
received at the company — see §5A.9. Collection-driver assignment is tracked separately in
the Parcel Collection state, not in the order status.)

## Picked Up

The delivery driver confirms possession of the parcel, taken from the company.

## Out for Delivery

The driver is currently attempting to deliver it.

## Delivered

The receiver successfully received the order.

This status triggers the appropriate financial transactions.

## Failed Delivery

The driver attempted delivery but was unable to complete it.

## Rescheduled

Another delivery attempt will be made later.

## Returned to Company

The driver returned the package to the company location.

## Returned to Customer / Sender

The package was returned to the original sender/customer.

## Cancelled

The order was cancelled. Cancellation is rejected while parcel collection is at
`COLLECTED_FROM_SENDER` (a driver still holds the parcel) — see §5A.12. Cancelling from
`ASSIGNED` also closes the active parcel collection assignment in the same transaction.

---

# 19. Failed Delivery Reasons

When selecting Failed Delivery, the driver must provide a reason.

Possible reasons include:

- Receiver did not answer
- Receiver unavailable
- Receiver refused the order
- Incorrect address
- Incomplete address
- Customer requested rescheduling
- Unable to contact receiver
- Other

If Other is selected, a note should be required.

---

# 19A. Failed Collection Reasons

Failed **parcel collection** uses its own configurable reason catalog, separate from Failed
Delivery Reasons. The datasets must not be merged.

Initial reasons:

- Sender unavailable
- Parcel not ready
- Unable to contact sender
- Incorrect collection address
- Sender requested reschedule
- Collection cancelled by sender
- Other

If Other is selected, notes are required. Each reason has `requires_notes`, `is_active`, and
`sort_order`. Inactive reasons stay visible on historical attempts but are not offered for
new failures. There is no hard delete in normal settings management.

The reason *"Collection cancelled by sender"* records a sender-driven **collection failure**
on a `FAILED` attempt. It is not the same as cancelling the whole order (§5A.12), which is
an order-level action with its own assignment end reason.

---

# 20. Failed Delivery Financial Rule

A failed delivery does not automatically:

- Credit the customer wallet
- Record company order revenue
- Mark the order amount as collected

Financial completion occurs only when money has actually been collected according to the final delivery result.

The company may decide to charge for failed attempts or redeliveries.

Therefore, **redelivery/failed-attempt fees should be configurable** rather than hard-coded.

An authorized employee can add an additional delivery charge where company policy requires it.

---

# 21. Driver Portal

The Driver Portal should be optimized for mobile use and remain simple.

The portal is organized around assigned **jobs**, which are of two types:

```text
COLLECTION   Sender -> Company   (collect the parcel from the sender)
DELIVERY     Company -> Receiver (deliver the parcel to the receiver)
```

A driver may hold both a collection job and a delivery job for the same order at different
times.

The driver's main screen should show:

- Collection jobs (to collect / collected)
- Assigned (delivery)
- Out for Delivery
- Completed
- Failed / Returned

For a collection job the driver sees only what is needed to collect the parcel: sender /
collection contact, collection address, collection notes, and order identification.
Collection job actions are **Collected From Sender** and **Failed Collection** (with a
reason). The driver does not confirm company receipt.

For a delivery job the driver sees only information necessary for delivery.

---

# 22. Driver Order Information

The driver can see:

- Order number
- Receiver name
- Receiver phone
- Alternative phone, if available
- Area
- Address
- Map/location link
- Delivery instructions
- Package count
- Order amount where required
- Delivery fee
- Amount to collect
- Payment type
- Payment method
- Current status

The driver should see the **final amount they are expected to collect clearly and prominently**.

---

# 23. Driver Actions

Depending on the current status, the driver can perform actions such as:

- Picked Up
- Start Delivery
- Delivered
- Failed Delivery

When marking Delivered, the system should display:

- Expected amount
- Actual amount collected

The expected amount should be prefilled.

If the driver enters a different actual amount, the system should:

- Require a reason
- Record the difference
- Flag the order for management review

This prevents hidden financial differences.

---

# 24. Driver Cash Balance

Whenever a driver collects money from an order, that amount becomes part of the driver's cash balance until handed over to the company.

Example:

Company Order:

- Product: $40
- Fee: $5
- Collected: $45

Delivery Only:

- Product: $100
- Fee: $5
- Collected: $105

Driver collected:

**$150**

The system should show:

- Driver cash held: $150
- Amount belonging to company
- Amount associated with customer wallet obligations

The driver does not necessarily need to see the accounting breakdown, but management/finance should.

---

# 25. Driver Settlement

When a driver hands collected money to the company, Finance creates a Driver Settlement.

Settlement fields include:

- Settlement ID
- Driver
- Driver balance before settlement
- Amount handed over
- Remaining driver balance
- Date/time
- Received by employee
- Payment/cash method where applicable
- Notes

Example:

Driver balance:

**$1,245**

Driver hands company:

**$1,000**

Remaining driver balance:

**$245**

The settlement must be saved permanently in the driver's settlement history.

---

# 26. Important Difference Between Driver Settlement and Customer Wallet

When a driver hands money to the company, this reduces the driver's cash balance.

It does **not** remove money from a customer wallet.

Example:

Driver collected:

- $100 belonging to Customer A
- $5 delivery fee

Driver gives company $105.

Driver cash becomes:

**$0**

Customer A wallet remains:

**$100**

until the company later pays Customer A.

---

# 27. Management Orders Page

The Orders page should be the main operational screen.

Each order row should display important information such as:

- Order number
- Customer
- Receiver
- Receiver phone
- Area
- Order type
- Intake method
- Parcel collection status
- Order amount
- Delivery fee
- Amount to collect
- Collection driver
- Delivery driver
- Payment type
- Status
- Created date
- Delivery date, when applicable

---

# 28. Orders Search

Employees should be able to search using:

- Order number
- Tracking code
- Customer name
- Receiver name
- Phone number

---

# 29. Orders Filters

Filters should include:

- Status
- Intake method
- Parcel collection status
- Collection driver
- Delivery driver
- Customer
- Order type
- Area
- Payment type
- Payment method
- Date range
- Assigned / unassigned (delivery)
- Delivered / undelivered

Filters should be combinable. The collection-driver filter and the delivery-driver filter
are separate; do not overload a single generic "driver" filter.

---

# 30. Order Detail Page

The management Order Detail page should contain several sections.

## Order

- Order number
- Tracking code
- Order type
- Status
- Description
- Package quantity

## Customer

- Customer name
- Customer phone
- Customer wallet link

## Receiver

- Name
- Phone
- Address
- Area
- Location
- Instructions

## Financial

- Order amount
- Delivery fee
- Amount already paid
- Remaining amount
- Expected amount to collect
- Actual amount collected
- Payment type
- Payment method
- Company amount
- Customer wallet amount

## Parcel Intake / Collection

- Parcel Intake Method
- Parcel Collection Status
- Collection contact snapshot
- Collection address snapshot
- Current collection driver
- Collection assignment history
- Collection attempts (permanent)
- Collected-from-sender timestamp
- Received-at-company timestamp
- Received-at-company confirmed by

## Delivery

- Assigned delivery driver
- Assignment date
- Pickup date
- Out-for-delivery date
- Delivery date
- Failure information, if applicable

The Parcel Intake / Collection section and the Delivery section are kept separate. The order
timeline combines both workflows chronologically while preserving each event's type.

## History

Complete order timeline and audit information.

---

# 31. Order Actions for Employees

Depending on permissions and order state, employees may:

- Edit order
- Assign driver
- Reassign driver
- Mark ready
- Cancel order
- Reschedule order
- View history
- Copy tracking code
- Copy tracking link
- Print order/label
- Duplicate an order in a future version

Delivered financial information should not be silently editable.

---

# 32. Customer Portal

The Customer Portal should remain simpler than the management system.

Main sections:

- Dashboard
- My Orders
- Order Details / Tracking
- Wallet
- Wallet Transactions
- Payout History
- Profile

---

# 33. Customer Dashboard

The dashboard can display:

- Available wallet balance
- Pending amount
- Active orders
- Delivered orders
- Failed/rescheduled orders if relevant

Example:

**Available Wallet:** $350  
**Pending:** $150  
**Active Orders:** 4  
**Delivered Orders:** 28

---

# 34. Customer Orders

Customers can see only orders belonging to them.

Information may include:

- Order number
- Receiver
- Area
- Order amount
- Delivery fee
- Amount to collect
- Current status
- Created date
- Delivered date

Customers may open an order to view basic details and tracking.

---

# 35. Customer Tracking Stages

Customers do not need every internal status.

The customer-facing stages should be simplified.

For orders that require driver collection:

1. **Order Created**
2. **Collection Scheduled**
3. **Parcel Collected**
4. **Received at Company**
5. **Preparing for Delivery**
6. **Out for Delivery**
7. **Delivered**

For orders already at the company, the collection stages are omitted:

1. **Order Received**
2. **Ready for Delivery**
3. **Out for Delivery**
4. **Delivered**

Example:

✓ Order Received  
✓ Ready for Delivery  
● Out for Delivery  
○ Delivered

If an attempt fails, the customer can see a simple message such as:

**Delivery Attempt Failed**

or:

**Scheduled for Redelivery**

Internal employee details do not need to be exposed.

---

# 36. Public Tracking Page

A public tracking page must also exist for receivers who do not have customer accounts.

The user enters a unique tracking code.

The public page should display only safe information such as:

- Order tracking code
- Current basic stage
- Progress timeline
- Delivered status
- Possibly delivery date

Public tracking may expose safe simplified milestones only (e.g. Order Created, Parcel
Collected, Received at Company, Preparing for Delivery, Out for Delivery, Delivered).

The public page must not expose:

- Customer wallet
- Company revenue
- Internal notes
- Internal employee information (including the employee who confirmed company receipt)
- Driver cash information
- Full accounting details
- Sender / collection contact name, phone, or address
- Collection driver identity or contact
- Internal collection failure detail

Driver contact information should only be exposed later if the company explicitly decides to allow it.

---

# 37. Company Dashboard

The management dashboard should provide a quick operational overview.

## Order Statistics

- Orders received today
- Awaiting collection assignment
- Collection in progress
- Collection failed / attention required
- Collected — awaiting company receipt
- Ready for delivery assignment
- Ready for pickup
- Assigned (delivery)
- Out for delivery
- Delivered today
- Failed today
- Returned
- Cancelled

**"Ready for delivery assignment"** means: parcel received at the company AND no current
delivery driver AND the order is otherwise eligible for delivery assignment. An order with
no delivery driver whose parcel collection is still in progress is **not** a delivery
assignment problem and must not be counted as delivery-unassigned.

## Driver Statistics

- Active drivers
- Drivers currently delivering
- Deliveries assigned per driver
- Deliveries completed today
- Active collection jobs
- Collections completed today
- Cash currently held by drivers

Collection activity is reported separately and must not be merged into delivery metrics.

## Financial Statistics

- Delivery fees earned
- Company order revenue
- Total amount collected
- Customer wallet liabilities
- Customer payouts
- Driver unsettled cash

Dashboard cards should link to already-filtered pages where useful.

Example:

Clicking:

**Out for Delivery: 12**

opens the Orders page filtered to those 12 orders.

---

# 38. Reports

The system should eventually support reports such as:

## Orders Reports

- Orders by date
- Orders by customer
- Orders by driver
- Orders by area
- Orders by status
- Orders by type
- Delivered vs failed deliveries

## Driver Reports

Existing delivery metrics keep their current meaning and must not silently start including
parcel collection activity:

- Orders assigned (delivery)
- Orders delivered
- Failed delivery attempts
- Delivery success rate
- Money collected
- Settlement history

Parcel collection metrics are reported as separate dimensions where needed for V1:

- Collection assignments
- Collections completed
- Failed collection attempts

## Customer Reports

- Orders created
- Delivered orders
- Wallet credits
- Wallet payouts
- Current wallet balance
- Pending order value

## Financial Reports

- Delivery fee revenue
- Company-order revenue
- Customer wallet liabilities
- Driver unsettled cash
- Total cash collected
- Payout history
- Settlement history

Reports should allow filtering by date range.

Export to Excel/PDF can be added during implementation or a later version.

---

# 39. Audit Log and Order Timeline

Important actions must be recorded.

Examples:

- Order created
- Order edited
- Collection driver assigned
- Collection driver reassigned
- Company receipt confirmed (Received At Company)
- Failed Collection Reason configuration changed
- Delivery driver assigned
- Delivery driver reassigned
- Status changed
- Delivery failed
- Delivery completed
- Amount collected
- Wallet credited
- Customer payout created
- Driver settlement created
- Financial adjustment made

Operational parcel-collection events (Collected From Sender, Collection Failed, Collection
Rescheduled, collection attempts) belong to the parcel-collection operational history, which
is separate from the management audit log. The audit log records the sensitive management
actions above; it does not replace collection attempt/assignment history.

Each audit entry should include:

- Action
- User who performed it
- Date/time
- Related entity
- Previous value where relevant
- New value where relevant

Example:

09:15 — Order created by Employee A  
09:30 — Assigned to Driver Ali  
10:05 — Picked up by Ali  
10:10 — Out for delivery  
11:20 — Delivered  
11:20 — $105 collected  
11:20 — Customer wallet credited $100  
11:20 — Delivery fee revenue $5

---

# 40. Reassignment History

Driver reassignment must not overwrite historical information.

Example:

10:20 — Assigned to Ali by Employee A  
10:45 — Reassigned from Ali to Hassan by Employee B

The complete assignment history remains visible internally.

---

# 41. Data Validation Rules

The system should enforce rules including:

- Order amount cannot be negative.
- Delivery fee cannot be negative.
- Amount already paid cannot be negative.
- Amount already paid cannot exceed the appropriate payable amount.
- Tracking code must be unique.
- Order number must be unique.
- Driver must normally be active before new assignment.
- A delivery driver may not be assigned until the Parcel Collection state is `RECEIVED_AT_COMPANY`.
- A collection driver may only be assigned to a `DRIVER_COLLECTION` order that has not yet been received at the company.
- A parcel collection attempt failure requires a configured reason (and notes where the reason requires them).
- Parcel collection actions must not create any wallet, driver-cash, or company-finance transaction.
- An order cannot be cancelled while parcel collection is at `COLLECTED_FROM_SENDER` (§5A.12).
- A cancelled order must never retain a current parcel collection assignment or a current collection driver.
- Delivered order cannot be deleted through normal operations.
- Cancelled order cannot become delivered without a valid reopening process.
- Wallet cannot be credited twice for the same delivery.
- A driver collection cannot be posted twice for the same delivery event.
- Customer payout cannot exceed available wallet balance unless an administrator explicitly authorizes negative balances in a future version.
- Actual collected amount differences require an explanation.

For Version 1, customer wallets should **not normally be allowed to become negative**.

---

# 42. Financial Integrity

Financial records require stronger protection than normal order information.

After a financial transaction has been finalized:

- It should not normally be directly edited.
- Corrections should use reversal or adjustment transactions.
- The original transaction should remain in history.
- Every adjustment should identify who created it and why.

This applies to:

- Wallet credits
- Wallet withdrawals
- Driver settlements
- Company revenue transactions
- Collection corrections

---

# 43. Security Requirements

The system must use authenticated access for all internal and customer portals.

Core security requirements:

- Secure password storage
- Role-based permissions
- Session/token protection
- Customer data isolation
- Driver data isolation
- Server-side authorization
- Validation of all financial operations
- Protection against users manually changing IDs to access other records
- Audit logs for sensitive changes

A customer must never gain access to another customer's orders or wallet simply by modifying a URL or API request.

A driver must never gain access to another driver's orders through the same method.

---

# 44. Soft Delete / Record Retention

Important records should not normally be permanently deleted.

Instead, use statuses such as:

- Active / inactive customer
- Active / inactive driver
- Cancelled order

Financial records, delivered orders, wallet transactions, settlements, and payouts should remain historically available.

---

# 45. Order Creation Workflow

A typical employee workflow is:

1. Open Create Order.
2. Select an existing customer.
3. Select order type:
   - Company Order
   - Delivery Only
4. Enter receiver information.
5. Enter package information.
6. Enter order amount.
7. Enter delivery fee.
8. Select payment type.
9. Enter already-paid amount if required.
10. Select payment method.
11. System calculates remaining amount.
12. System calculates amount driver must collect.
13. Add delivery instructions.
14. Choose Parcel Intake Method:
    - Already at Company
    - Collection by Driver Required (pre-fills collection contact/address from the customer;
      optionally assign a collection driver now)
15. Optionally assign a delivery driver (only when the parcel is already at the company).
16. Save order — the action label reflects what is assigned
    (Create Order / Create & Assign Collection Driver / Create & Assign).

The system generates:

- Order number
- Tracking code
- Creation timestamp

---

# 46. Successful Delivery Workflow — Company Order

Example:

Order amount: $100  
Delivery fee: $5  
Amount to collect: $105

Flow:

1. Order created.
2. Driver assigned.
3. Driver picks up.
4. Driver starts delivery.
5. Driver delivers order.
6. Driver confirms $105 collected.
7. Order becomes Delivered.
8. Driver cash balance increases by $105.
9. Company financial records receive the applicable $105.
10. Order timeline records all actions.

No customer wallet credit occurs.

---

# 47. Successful Delivery Workflow — Delivery Only

Example:

Order amount: $100  
Delivery fee: $5  
Amount to collect: $105

Flow:

1. Employee creates the Delivery Only order and chooses the Parcel Intake Method.
2. The parcel reaches the company:
   - **Already at Company:** the sender brought it in; receipt is recorded on creation.
   - **Driver Collection:** a collection driver is assigned, confirms "Collected From
     Sender", brings the parcel in, and Management confirms "Received At Company".
3. Delivery driver assigned (only allowed once the parcel is received at the company).
4. Driver picks up package.
5. Driver starts delivery.
6. Receiver pays $105.
7. Driver marks Delivered.
8. Driver cash balance increases by $105.
9. Customer wallet increases by $100.
10. Company delivery revenue increases by $5.
11. Timeline records all operations.

Later:

12. Driver gives collected cash to company.
13. Driver settlement reduces driver cash balance.
14. Customer wallet remains $100.
15. Company pays customer.
16. Customer payout reduces wallet by $100.

---

# 48. Failed Delivery Workflow

Example:

1. Driver starts delivery.
2. Receiver does not answer.
3. Driver selects Failed Delivery.
4. Driver chooses reason.
5. No normal delivery wallet credit is created.
6. No normal completed-order revenue is posted unless a specific fee was actually charged according to company policy.
7. Employee may:
   - Reschedule
   - Reassign
   - Return package to company
   - Return package to sender
   - Cancel order

The complete history remains recorded.

---

# 49. Suggested Main Navigation

## Management Portal

- Dashboard
- Orders
- Customers
- Drivers
- Wallets
- Customer Payouts
- Driver Settlements
- Finance
- Reports
- Employees
- Audit Logs
- Settings

## Driver Portal

- My Jobs (collection jobs + delivery jobs)
- Out for Delivery
- Completed
- Failed / Returned
- My Cash / Settlements

## Customer Portal

- Dashboard
- My Orders
- Wallet
- Wallet Transactions
- Payouts
- Profile

---

# 50. Version 1 Priorities

The first version should focus on reliable business operations rather than advanced automation.

Priority features:

1. Authentication and roles
2. Customer management
3. Driver management
4. Order creation
5. Order types
6. Payment calculations
7. Parcel intake (already at company / driver collection) and company receipt
8. Parcel collection assignment, failure, reschedule
9. Driver assignment (collection and delivery)
10. Delivery statuses
11. Driver portal
12. Successful/failed delivery handling
13. Customer wallets
14. Wallet transactions
15. Customer payouts
16. Driver cash balances
17. Driver settlements
18. Customer portal
19. Public tracking
20. Dashboard
21. Search and filters
22. Audit history

---

# 51. Features That Can Be Added Later

These should not block the first version:

- Automatic delivery fee calculation by area
- Google Maps integration
- Driver route optimization
- GPS/live driver tracking
- SMS notifications
- WhatsApp notifications
- Email notifications
- Barcode/QR scanning
- Label printing
- Automatic invoice generation
- Customer order creation
- Customer payout requests
- Advanced analytics
- Excel/PDF exports
- Mobile application
- Proof-of-delivery photo
- Receiver signature
- OTP delivery confirmation
- Multi-branch support
- Multiple currencies

The architecture should avoid making these unnecessarily difficult to add later.

---

# 52. Core Business Rules Summary

The most important rules of the system are:

### Rule 1
A customer can use both Company Orders and Delivery Only orders.

### Rule 2
A receiver does not need to have a customer account.

### Rule 3
For Company Orders, collected order money belongs to the company.

### Rule 4
For Delivery Only orders, the collected order value belongs to the sender/customer and is credited to their wallet.

### Rule 5
Delivery fees belong to the delivery company.

### Rule 6
Wallet money becomes available only after successful delivery and actual applicable collection.

### Rule 7
A driver's cash balance represents money collected but not yet settled with the company.

### Rule 8
Driver settlement does not reduce customer wallet balances.

### Rule 9
Customer payouts reduce wallet balances.

### Rule 10
Financial transactions must remain traceable and should not be silently modified.

### Rule 11
The customer sees only their own orders, wallet, payouts, and simplified tracking.

### Rule 12
The driver sees only assigned delivery information necessary to perform the delivery.

### Rule 13
Management has the detailed operational and financial view.

### Rule 14
Public tracking exposes only safe basic delivery status information.

### Rule 15
Every order has a Parcel Intake Method (`ALREADY_AT_COMPANY` or `DRIVER_COLLECTION`) that is
independent of Order Type.

### Rule 16
Parcel collection and financial cash collection are separate domains. Parcel collection is
free and financially neutral in V1 (no wallet, driver-cash, or company-finance posting).

### Rule 17
Parcel collection and final delivery are separate assignments with separate permanent
histories; the same driver may perform both for one order.

### Rule 18
The collection driver confirms "Collected From Sender"; only authorized Management confirms
"Received At Company".

### Rule 19
A delivery driver may not be assigned until the parcel's collection state is
`RECEIVED_AT_COMPANY`.

### Rule 20
Failed collection and failed delivery are separate, with separate reason catalogs; a failed
collection does not cancel the order.

### Rule 21
Customer collection contact/address is snapshotted onto the order and is not rewritten by
later customer-profile edits.

---

# 53. Final System Structure

The complete system consists of these main business modules:

1. **Authentication & Authorization**
2. **Dashboard**
3. **Customer Management**
4. **Employee Management**
5. **Driver Management**
6. **Order Management**
7. **Parcel Intake & Collection**
8. **Delivery Assignment**
9. **Delivery Workflow**
10. **Driver Portal**
11. **Customer Portal**
12. **Public Tracking**
13. **Customer Wallet**
14. **Wallet Transactions**
15. **Customer Payouts**
16. **Driver Cash Management**
17. **Driver Settlements**
18. **Company Revenue / Finance**
19. **Reports**
20. **Audit Logs**
21. **System Settings**

This document should be treated as the **baseline functional requirements for Version 1** of the Delivery Management System.

The next development stage should convert these business requirements into:

- System architecture
- Database entities and relationships
- Database schema
- API/backend modules
- Roles and permissions matrix
- Frontend pages
- Order state machine
- Financial transaction logic
- Development phases and implementation roadmap
