# Delivery Management System
## Frontend Page Structure — Version 1

This document defines the recommended frontend page structure for Version 1 of the Delivery Management System.

It translates the approved business requirements into a practical page-by-page application structure for:

1. Management Portal
2. Driver Portal
3. Customer Portal
4. Public Tracking

---

# 1. Application Structure

The frontend should be separated into four distinct experiences.

## 1.1 Management Portal

Used by:

- Admin
- Employee / Dispatcher
- Finance / Accountant

The Management Portal should be desktop-first while remaining responsive.

## 1.2 Driver Portal

Used by drivers.

The Driver Portal should be mobile-first and optimized for fast delivery operations.

## 1.3 Customer Portal

Used by registered customers.

The Customer Portal should provide a simplified view of orders, tracking, wallet balances, transactions, and payouts.

## 1.4 Public Tracking

Used by receivers or anyone who has a valid tracking code.

No authentication is required.

Only safe tracking information should be displayed.

---

# 2. Management Portal Navigation

The Management Portal sidebar should group pages by purpose instead of displaying a long unstructured list.

```text
DELIVERY SYSTEM

Overview
├── Dashboard

Operations
├── Orders
│   ├── All Orders
│   └── Create Order
├── Customers
├── Drivers

Finance
├── Customer Wallets
├── Customer Payouts
├── Driver Settlements
└── Finance

Administration
├── Employees
├── Reports
├── Audit Logs
└── Settings
```

---

# 3. Management Dashboard

## Route

```text
/management/dashboard
```

## Purpose

The dashboard gives management a quick overview of current delivery operations and financial status.

The dashboard should mainly contain:

- Statistics
- Alerts
- Recent activity
- Shortcuts
- Links to filtered operational pages

## Header

```text
Dashboard                              [+ Create Order]

Monday, August 17
```

## Order Statistics

Recommended cards:

- Orders Today
- Awaiting Collection Assignment
- Collection In Progress
- Collection Attention / Failed
- Collected — Awaiting Company Receipt
- Ready for Delivery Assignment
- Ready for Pickup
- Assigned
- Out for Delivery
- Delivered Today
- Failed Today
- Returned
- Cancelled

**"Ready for Delivery Assignment"** is defined as: parcel received at the company AND no
current delivery driver AND the order is otherwise eligible for delivery assignment. Orders
whose parcel collection is still in progress must **not** be shown as delivery-unassigned.
The final card density is decided in the UI implementation sub-phase, but this operational
distinction must be visible somewhere on the dashboard.

Example:

```text
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ Orders Today │ │ Unassigned   │ │ Out Delivery │ │ Delivered    │
│     142      │ │     18       │ │      42      │ │      61      │
└──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘
```

Dashboard cards should be clickable.

Example:

Clicking:

```text
Out for Delivery: 42
```

should open:

```text
/management/orders?status=out-for-delivery
```

## Driver Statistics

Recommended cards:

- Active Drivers
- Drivers Currently Delivering
- Orders Assigned
- Deliveries Completed Today
- Drivers With Unsettled Cash
- Total Driver Cash Held

## Financial Statistics

Financial information should only be visible to users with the required permissions.

Recommended cards:

- Delivery Fee Revenue
- Company Order Revenue
- Total Collected
- Customer Wallet Liability
- Customer Payouts
- Driver Cash Outstanding

## Orders Requiring Attention

Recommended categories:

- Awaiting Collection Assignment
- Failed Parcel Collections
- Collected — Awaiting Company Receipt
- Orders Ready for Delivery Assignment
- Failed Deliveries
- Collection Differences (money — financial review)
- Returned Orders
- Orders Waiting Too Long
- Orders Requiring Review

Note: "Collection Differences" here means the existing financial collection-amount review
(money collected from the receiver), not parcel collection.

## Recent Activity

Example:

```text
#ORD-1052 delivered by Ali
#ORD-1059 assigned to Hassan
Customer ABC payout processed
Driver Ali settlement recorded
```

---

# 4. Orders Page

## Route

```text
/management/orders
```

## Purpose

The Orders page is the main operational page of the Management Portal.

Employees should be able to search, filter, inspect, select, assign, and manage orders from this page.

## Header

```text
Orders                                  [+ Create Order]
```

## Search

The search field should support:

- Order number
- Tracking code
- Customer name
- Receiver name
- Phone number

Example:

```text
[ Search order, customer, receiver, phone... ]
```

## Quick Status Tabs

Recommended:

```text
All | Awaiting Collection | Collecting | Ready for Delivery Assignment | Assigned | Out for Delivery | Delivered | Failed
```

## Filters

Recommended filters:

```text
[Status ▼]
[Intake Method ▼]
[Parcel Collection Status ▼]
[Collection Driver ▼]
[Delivery Driver ▼]
[Customer ▼]
[Area ▼]
[Order Type ▼]
[Payment Type ▼]
[Payment Method ▼]
[Assignment ▼]
[Date Range ▼]
[More Filters]
```

Filters must be combinable. The Collection Driver filter and the Delivery Driver filter are
distinct — do not overload one generic Driver filter.

## Orders Table

Recommended columns (use compact badges / secondary lines to avoid an over-wide table):

```text
☐
Order
Customer
Receiver
Receiver Phone
Area
Order Type
Intake Method
Parcel Collection Status
Order Amount
Delivery Fee
Amount to Collect
Collection Driver
Delivery Driver
Payment Type
Status
Created Date
Delivery Date
```

Example:

```text
☐ | Order  | Customer | Receiver | Area    | Type     | Collect | Driver | Status
---------------------------------------------------------------------------------
☐ | #10231 | Store A  | Ahmad    | Beirut  | Delivery | $105    | Ali    | Assigned
☐ | #10232 | Store B  | Rami     | Hamra   | Company  | $55     | —      | Ready
```

## Bulk Actions

When one or more orders are selected, display bulk actions.

Recommended actions:

```text
3 orders selected

[Assign Driver]
[Mark Ready]
```

Driver assignment should support assigning multiple selected orders to one **delivery**
driver. Bulk assignment is atomic and applies only to orders whose Parcel Collection Status
is `RECEIVED_AT_COMPANY`; if any selected order has not been received at the company the
whole batch is rejected.

---

# 5. Create Order Page

## Route

```text
/management/orders/new
```

## Purpose

Allows an employee to create either:

- Company Order
- Delivery Only Order

The form should be divided into clear sections instead of one large form.

---

## 5.1 Customer & Order Type

```text
Customer *
[ Search/select customer ]

Order Type *
( ) Company Order
( ) Delivery Only
```

---

## 5.2 Receiver Information

Fields:

- Receiver Name
- Primary Phone
- Alternative Phone
- Area / City
- Full Address
- Building / Floor
- Location / Map Link
- Delivery Instructions

Example:

```text
Receiver Name *
Phone *
Alternative Phone
Area *
Address *
Building / Floor
Location
Delivery Instructions
```

---

## 5.3 Package Information

Fields:

- Description
- Number of Packages
- Quantity
- Package Notes
- Weight, optional
- Size, optional

Example:

```text
Description
Number of Packages
Quantity
Package Notes
```

---

## 5.4 Payment Information

Fields:

- Order Amount
- Delivery Fee
- Payment Type
- Already Paid Amount
- Prepaid Payment Method
- Remaining Order Amount
- Amount to Collect
- Delivery-Time Payment Method

Example:

```text
Order Amount       $ ______
Delivery Fee       $ ______

Payment Type
[Cash on Delivery ▼]

Already Paid       $ ______
Prepaid Method     [Cash ▼]

Remaining Amount   $ 60
Amount to Collect  $ 65
```

Calculated values should be:

- Automatically calculated
- Read-only
- Visually distinct from editable fields

---

## 5.5 Parcel Intake

```text
How will the parcel reach the company? *
( ) Already at Company
( ) Collection by Driver Required
```

When **Collection by Driver Required** is selected, show collection fields, pre-filled from
the selected customer and stored as an order snapshot:

```text
Collection Contact Name *
Collection Phone *
Alternative Phone
Collection Area *
Collection Address *
Collection Notes

Collection Driver
[Leave Unassigned ▼]
```

The Collection Driver is optional. Choosing one here creates a **collection** assignment,
not a delivery assignment.

---

## 5.6 Delivery Assignment

```text
Delivery Driver
[Leave Unassigned ▼]

Notes
```

The Delivery Driver selector is only available when the parcel is **already at the company**.
For collection-required orders it is disabled until company receipt is confirmed on the
Order Detail page.

## Page Actions

The primary action label reflects what is actually assigned:

```text
Collection required, no collection driver:   [Create Order]
Collection required, collection driver set:   [Create & Assign Collection Driver]
Already at company, no delivery driver:        [Create Order]
Already at company, delivery driver set:       [Create & Assign]

[Cancel]                     [ primary action ]
```

One button must never ambiguously assign the wrong responsibility.

---

# 6. Order Detail Page

## Route

```text
/management/orders/:id
```

## Purpose

The Order Detail page should be the central source of truth for one order.

## Header

Example:

```text
← Orders

Order #10231                  [Out for Delivery]

Tracking: TRK-82JX91
Created Aug 17, 10:42

[Edit] [Assign/Reassign] [More ▼]
```

## Recommended Layout

Use a two-column layout on desktop.

### Main Column

Sections:

1. Order Information
2. Customer Information
3. Receiver Information
4. Package Information
5. Financial Information
6. Parcel Intake / Collection Information
7. Delivery Information

### Right Column

Sections:

- Current Status
- Assigned Driver
- Amount to Collect
- Order Actions
- Timeline

---

## 6.1 Order Information

Display:

- Order Number
- Tracking Code
- Order Type
- Status
- Description
- Number of Packages
- Quantity
- Created Date
- Created By

---

## 6.2 Customer Information

Display:

- Customer Name
- Customer Phone
- Customer ID
- Link to Customer Profile
- Link to Customer Wallet where authorized

---

## 6.3 Receiver Information

Display:

- Receiver Name
- Phone
- Alternative Phone
- Area
- Address
- Building / Floor
- Map / Location
- Delivery Instructions

---

## 6.4 Financial Information

Display:

- Order Amount
- Delivery Fee
- Amount Already Paid
- Remaining Amount
- Expected Amount to Collect
- Actual Amount Collected
- Payment Type
- Prepaid Payment Method
- Delivery Payment Method
- Company Amount
- Customer Wallet Amount

Delivered financial information must not be silently editable.

---

## 6.5 Parcel Intake / Collection Information

Display:

- Intake Method
- Parcel Collection Status
- Collection Contact snapshot (name, phone, alternative phone)
- Collection Address snapshot (area, address, notes)
- Current Collection Driver
- Collection Assignment History (permanent, never overwritten)
- Collection Attempts (permanent; each with outcome, reason, notes, timestamps)
- Collected From Sender timestamp
- Received At Company timestamp
- Received At Company — confirmed by

Actions here (permission- and state-dependent):

- Assign / Reassign Collection Driver
- Confirm Received At Company (Management only)
- Reschedule Collection after a failure

For `ALREADY_AT_COMPANY` orders this section shows the automatic receipt (timestamp = order
creation, confirmer = order creator) and omits collection-driver/attempt sub-sections.

This section is kept separate from Delivery Information below.

---

## 6.6 Delivery Information

Display:

- Assigned Delivery Driver
- Assignment Date
- Pickup Date
- Out-for-Delivery Date
- Delivery Date
- Failed Delivery Information
- Return Information
- Delivery Reassignment History

The **Assign Driver** action here is disabled until Parcel Collection Status is
`RECEIVED_AT_COMPANY`.

---

## 6.7 Order Actions

Possible actions depending on permissions and status:

- Edit Order
- Mark Ready
- Assign / Reassign Collection Driver
- Confirm Received At Company (Management only)
- Reschedule Collection
- Assign / Reassign Delivery Driver (only after Received At Company)
- Cancel Order (disabled while parcel collection is at Collected From Sender — a driver still
  holds the parcel; confirm Received At Company first. Backend enforces this on every path.)
- Reschedule Delivery
- View History
- Copy Tracking Code
- Copy Tracking Link
- Print Order / Label

---

## 6.8 Timeline

The timeline combines the parcel-collection workflow and the delivery workflow
chronologically, preserving each event's type.

Example:

```text
● 12:30  Delivered
│
● 11:40  Out for delivery
│
● 11:15  Picked up from company by Ali
│
● 10:55  Delivery driver assigned: Ali
│
● 10:30  Received at company (confirmed by Dispatcher Sara)
│
● 09:20  Collected from sender by Ali
│
● 08:50  Collection driver assigned: Ali
│
● 08:40  Order created by Employee A (collection required)
```

The timeline should include operational, collection, and financial events.

---

# 7. Customers Page

## Route

```text
/management/customers
```

## Header

```text
Customers                              [+ Add Customer]
```

## Search and Filters

```text
[Search name / phone]

[Status ▼]
[Area ▼]
```

## Table

Recommended columns:

```text
Customer
Phone
Area
Available Wallet
Pending Amount
Active Orders
Status
Created Date
```

---

# 8. Customer Detail Page

## Route

```text
/management/customers/:id
```

## Header

Example:

```text
ABC Store

+961 XX XXX XXX
Beirut

[Edit Customer]      [Create Order]
```

## Summary Cards

```text
Available Wallet
Pending Amount
Active Orders
Delivered Orders
```

Example:

```text
Available Wallet   Pending Amount   Active Orders   Delivered Orders
     $350              $150              4               128
```

## Tabs

Recommended tabs:

```text
Overview | Orders | Wallet | Payouts | Activity
```

---

## 8.1 Customer Overview

Display:

- Customer information
- Contact information
- Address
- Notes
- Account status
- Recent orders
- Wallet summary
- Recent payouts

## 8.2 Customer Orders

Display all orders belonging to the customer.

## 8.3 Customer Wallet

Display:

- Available Balance
- Pending Amount
- Recent Transactions

## 8.4 Customer Payouts

Display payout history.

## 8.5 Customer Activity

Display relevant customer-related operational activity.

---

# 9. Drivers Page

## Route

```text
/management/drivers
```

## Header

```text
Drivers                              [+ Add Driver]
```

## Table

Recommended columns:

```text
Driver
Phone
Active Deliveries
Out for Delivery
Completed Today
Active Collection Jobs
Cash Held
Status
```

Example:

```text
Ali Hassan | +961... | 12 | 6 | 18 | 3 | $1,245 | Active
```

---

# 10. Driver Detail Page

## Route

```text
/management/drivers/:id
```

## Header

```text
Ali Hassan                           Active
```

## Summary Cards

```text
Assigned Deliveries
Out for Delivery
Delivered Today
Active Collection Jobs
Cash Held
```

## Tabs

```text
Current Deliveries | Delivery History | Collection Jobs | Collection History | Cash | Settlements
```

Delivery metrics (Assigned Deliveries, Delivered Today, Delivery History, Delivery Success
Rate, Failed Deliveries) keep their existing delivery-only meaning. Parcel collection work
is shown in its own tabs/metrics and must not be folded into delivery numbers.

---

## 10.1 Current Deliveries

Display active delivery orders assigned to the driver.

## 10.2 Delivery History

Display completed, failed, returned, and cancelled **delivery** history.

## 10.3 Collection Jobs

Display the driver's current parcel-collection assignments (awaiting collection / collected,
awaiting company receipt).

## 10.4 Collection History

Display the driver's completed and failed parcel-collection attempts (permanent).

## 10.5 Cash

Display:

- Current Cash Held
- Recent Collections (money collected on delivery)
- Company Amount
- Customer-Related Amount
- Collection Differences (money — financial review)

Parcel collection never appears here.

## 10.6 Settlements

Display the driver's complete settlement history.

---

# 11. Customer Wallets Page

## Route

```text
/management/wallets
```

## Purpose

Provides finance users with a customer wallet overview.

## Table

Recommended columns:

```text
Customer
Available Balance
Pending Amount
Last Transaction
Last Payout
```

Example:

```text
ABC Store | $500 | $120 | Aug 17 | Aug 10
XYZ Shop  | $210 | $80  | Aug 16 | Aug 01
```

---

# 12. Customer Wallet Detail Page

## Route

```text
/management/wallets/:customerId
```

## Header

```text
ABC Store Wallet

Available Balance
$500

Pending
$120

[Process Payout]
```

## Wallet Transactions Table

Recommended columns:

```text
Date
Type
Related Order
Credit
Debit
Balance
Payment Method
Processed By
Notes
```

Example:

```text
Aug 17 | Order Credit | #10231 | $100 | —    | $500
Aug 16 | Payout       | —      | —    | $300 | $400
```

The wallet must always be based on traceable wallet transactions.

---

# 13. Customer Payouts Page

## Route

```text
/management/payouts
```

## Header

```text
Customer Payouts                      [+ New Payout]
```

## Table

Recommended columns:

```text
Payout ID
Customer
Amount
Payment Method
Processed By
Date
Status
```

---

# 14. New Customer Payout

This can be implemented as a modal or dedicated page.

Example:

```text
Customer
[ABC Store ▼]

Current Available Balance
$500

Payout Amount
$ ______

Payment Method
[Cash ▼]

Notes

Balance After
$200

[Cancel] [Confirm Payout]
```

Validation:

- Payout cannot normally exceed available balance.
- Payout must create a wallet debit transaction.
- Payout must remain permanently traceable.

---

# 15. Driver Settlements Page

## Route

```text
/management/driver-settlements
```

## Header

```text
Driver Settlements                  [+ New Settlement]
```

## Table

Recommended columns:

```text
Settlement ID
Driver
Balance Before
Amount Received
Balance After
Received By
Date
Method
```

---

# 16. New Driver Settlement

Example:

```text
Driver
[Ali Hassan ▼]

Current Cash Held
$1,245

Amount Received
$1,000

Remaining
$245

Payment Method
[Cash ▼]

Notes

[Cancel] [Record Settlement]
```

Important rule:

A driver settlement reduces the driver's cash balance.

It does not reduce customer wallet balances.

---

# 17. Finance Page

## Route

```text
/management/finance
```

## Purpose

The Finance page should provide a financial overview.

It should not duplicate wallet, payout, or settlement entry screens.

## Recommended Summary Cards

- Company Revenue
- Delivery Fee Revenue
- Company Order Revenue
- Customer Wallet Liability
- Total Customer Payouts
- Driver Cash Outstanding
- Total Cash Collected

## Date Filter

```text
Today | This Week | This Month | Custom
```

## Recent Financial Activity

Display recent:

- Wallet Credits
- Customer Payouts
- Driver Collections
- Driver Settlements
- Company Revenue Transactions
- Adjustments / Reversals

---

# 18. Employees Page

## Route

```text
/management/employees
```

## Purpose

Admin-only employee management.

## Table

Recommended columns:

```text
Name
Role
Email
Phone
Status
Last Login
Created Date
```

## Initial Roles

Recommended starting roles:

- Admin
- Dispatcher
- Finance

Permissions should still be configurable separately where required.

---

# 19. Employee Detail Page

## Route

```text
/management/employees/:id
```

Display:

- Employee information
- Role
- Permissions
- Status
- Last login
- Recent sensitive actions
- Account controls

---

# 20. Reports Page

## Route

```text
/management/reports
```

## Main Report Groups

```text
Orders
Drivers
Customers
Financial
```

## Order Reports

- Orders by Date
- Orders by Customer
- Orders by Driver
- Orders by Area
- Orders by Status
- Orders by Type
- Delivered vs Failed

## Driver Reports

- Orders Assigned
- Orders Delivered
- Failed Attempts
- Delivery Success Rate
- Money Collected
- Settlement History

## Customer Reports

- Orders Created
- Delivered Orders
- Wallet Credits
- Wallet Payouts
- Current Wallet Balance
- Pending Order Value

## Financial Reports

- Delivery Fee Revenue
- Company Order Revenue
- Customer Wallet Liabilities
- Driver Unsettled Cash
- Total Cash Collected
- Payout History
- Settlement History

All reports should support date filtering.

Advanced analytics and exports can be added later.

---

# 21. Audit Logs Page

## Route

```text
/management/audit-logs
```

## Purpose

Provides traceability for important system actions.

## Table

Recommended columns:

```text
Date
User
Action
Entity
Entity ID
Previous Value
New Value
Details
```

Example:

```text
17:42 | Employee A | Reassigned Driver | Order | #1021 | Ali | Hassan
```

Important audited events include:

- Order creation
- Order editing
- Driver assignment
- Driver reassignment
- Status changes
- Delivery failure
- Delivery completion
- Amount collection
- Wallet credits
- Customer payouts
- Driver settlements
- Financial adjustments

---

# 22. Settings Page

## Route

```text
/management/settings
```

## Recommended Tabs

```text
General
Payment Methods
Delivery Settings
Failed Delivery Reasons
Failed Collection Reasons
Areas
Users & Permissions
```

**Failed Collection Reasons** is a distinct tab from **Failed Delivery Reasons**; the two
datasets are never merged. It follows the same reference-data behavior: `settings.read` to
view, `settings.manage` to create/edit/deactivate/reactivate, no hard delete, configuration
changes audited. The DRIVER role is **not** granted `settings.read`; the Driver Portal
receives active collection reasons through a narrow Driver-safe endpoint.

## General

Possible settings:

- Company Name
- Company Contact Information
- Default Currency
- General Operational Settings

## Payment Methods

Manage available methods such as:

- Cash
- Card
- Bank Transfer
- Whish
- Other

## Delivery Settings

Possible settings:

- Default Delivery Fee
- Failed Attempt Fee Rules
- Redelivery Fee Rules

## Failed Delivery Reasons

Manage allowed delivery-failure reasons.

## Failed Collection Reasons

Manage allowed parcel-collection-failure reasons (separate catalog). Initial reasons:
Sender unavailable, Parcel not ready, Unable to contact sender, Incorrect collection
address, Sender requested reschedule, Collection cancelled by sender, Other (requires notes).

## Areas

Manage supported delivery areas.

## Users & Permissions

Manage role-based access and permissions.

---

# 23. Driver Portal

The Driver Portal should use a separate mobile-first interface. It is organized around
assigned **jobs**, of two types:

```text
COLLECTION   Sender -> Company
DELIVERY     Company -> Receiver
```

A driver may hold both a collection job and a delivery job for the same order at different
times.

## Main Navigation

```text
My Jobs
Out for Delivery
Completed
Failed / Returned
My Cash
```

---

# 24. Driver My Jobs Page

## Route

```text
/driver/jobs
```

`/driver/jobs` is the canonical Driver work-list route. There is **no** `/driver/orders`
compatibility alias in Phase 11.17. The exact job-detail route is finalized in Phase 12
from the final Collection / Delivery job DTO.

Display collection jobs and delivery jobs assigned to the logged-in driver.

Recommended grouping:

- To Collect
- Collected (awaiting company receipt)
- Assigned (delivery)
- Ready for Pickup
- Picked Up

Each job appears as a mobile-friendly card, clearly labeled COLLECTION or DELIVERY.

Delivery job example:

```text
#10231   DELIVERY            Assigned

Mohammad Ahmad
Beirut — Hamra

Phone: +961 XX XXX XXX
Address: Bliss Street...

Packages: 2

AMOUNT TO COLLECT
$105

[Call] [Location]

[Picked Up]
```

Collection job example:

```text
#10231   COLLECTION          To Collect

ABC Store (sender)
Beirut — Achrafieh

Phone: +961 XX XXX XXX
Pickup Address: Sassine Square...
Notes: Ask for the manager

Packages: 2

[Call] [Location]

[Collected From Sender]   [Failed Collection]
```

A collection card shows only what is needed to collect the parcel — no amount to collect,
no receiver data, no company-receipt action.

The amount to collect must be visually prominent.

---

# 25. Driver Out for Delivery Page

## Route

```text
/driver/out-for-delivery
```

Display only orders currently being delivered.

Example actions:

```text
[Mark Delivered]
[Failed Delivery]
```

---

# 26. Driver Job Detail

## Route

```text
/driver/jobs/:orderId?job=collection|delivery   (indicative — finalized in Phase 12)
```

The exact job-detail route and DTO are finalized in Phase 12. The driver sees only the
information required for the job type.

**Delivery job — display:**

- Order Number
- Receiver Name / Phone / Alternative Phone
- Area / Address / Location Link
- Delivery Instructions
- Package Count
- Order Amount where required
- Delivery Fee
- Amount to Collect
- Payment Type / Payment Method
- Current Status

Delivery actions (status-dependent): Picked Up, Start Delivery, Delivered, Failed Delivery.

**Collection job — display:**

- Order Number
- Sender / Collection Contact Name / Phone / Alternative Phone
- Collection Area / Collection Address / Location Link
- Collection Notes
- Package Count
- Parcel Collection Status

Collection actions (status-dependent): Collected From Sender, Failed Collection. The driver
never sees an amount to collect on a collection job and never confirms company receipt.

---

# 27. Driver Delivered Flow

When marking an order Delivered, show:

```text
Expected Amount
$105

Actual Amount Collected
$105

[Confirm Delivery]
```

If actual amount differs:

```text
Expected Amount
$105

Actual Amount Collected
$100

Difference
-$5

Reason *
[ __________________ ]

[Confirm With Difference]
```

The system must:

- Require a reason
- Record the difference
- Flag the order for management review

---

# 28. Failed Delivery Flow

When the driver selects Failed Delivery, display allowed reasons:

- Receiver did not answer
- Receiver unavailable
- Receiver refused the order
- Incorrect address
- Incomplete address
- Customer requested rescheduling
- Unable to contact receiver
- Other

If Other is selected, notes become required.

Example:

```text
Reason
[Receiver unavailable ▼]

Notes
[ __________________ ]

[Confirm Failed Delivery]
```

---

# 28A. Collected From Sender / Failed Collection Flow

On a collection job, the driver has two outcomes.

**Collected From Sender:**

```text
Confirm you have received the parcel(s) from the sender.

Packages: 2

[Confirm Collected From Sender]
```

This sets Parcel Collection Status to `COLLECTED_FROM_SENDER`. It does **not** confirm
company receipt — Management does that later.

**Failed Collection:** show the active Failed Collection Reasons (separate list from failed
delivery), from a narrow Driver-safe endpoint:

```text
Reason *
[Sender unavailable ▼]

Notes            (required for "Other" and any reason configured to require notes)
[ __________________ ]

[Confirm Failed Collection]
```

The failed attempt is permanent. Management can then reschedule / reassign for a retry.

---

# 29. Driver Completed Page

## Route

```text
/driver/completed
```

Display successful deliveries belonging to the driver.

Possible information:

- Order
- Receiver
- Delivery Date
- Amount Collected

---

# 30. Driver Failed / Returned Page

## Route

```text
/driver/failed
```

Display:

- Failed Deliveries
- Returned to Company
- Returned to Customer
- Rescheduled Orders

---

# 31. Driver Cash Page

## Route

```text
/driver/cash
```

Display:

- Current Cash Held
- Recent Collections
- Recent Settlements
- Settlement History

The driver does not need to see internal customer wallet accounting.

---

# 32. Customer Portal

The Customer Portal should remain much simpler than the Management Portal.

## Main Navigation

```text
Dashboard
My Orders
Wallet
Transactions
Payouts
Profile
```

---

# 33. Customer Dashboard

## Route

```text
/customer/dashboard
```

## Cards

Recommended:

```text
Available Wallet
Pending Amount
Active Orders
Delivered Orders
```

Example:

```text
Available Wallet   Pending       Active Orders   Delivered
     $350            $150              4             28
```

Optional secondary information:

- Failed / Rescheduled Orders
- Recent Wallet Transactions
- Recent Orders

---

# 34. Customer Orders Page

## Route

```text
/customer/orders
```

Customers can see only their own orders.

Recommended columns/cards:

```text
Order Number
Receiver
Area
Order Amount
Delivery Fee
Amount to Collect
Status
Created Date
Delivered Date
```

---

# 35. Customer Order Detail

## Route

```text
/customer/orders/:id
```

The customer should see simplified order information.

Display:

- Order Number
- Receiver
- Area
- Basic Address
- Amount
- Delivery Fee
- Amount to Collect
- Created Date
- Delivery Date
- Simplified Tracking

## Simplified Tracking

For a collection-required order:

```text
✓ Order Created
✓ Collection Scheduled
✓ Parcel Collected
● Received at Company
○ Preparing for Delivery
○ Out for Delivery
○ Delivered
```

For an order already at the company:

```text
✓ Order Received
✓ Ready for Delivery
● Out for Delivery
○ Delivered
```

If delivery fails: "Delivery Attempt Failed" / "Scheduled for Redelivery".
If a collection attempt fails, the customer sees a neutral "Collection Rescheduled" — no
internal failure detail, no collection-driver identity.

Internal employee, accounting, audit, driver cash, the receipt-confirming employee, and
sender/collection contact details must not be exposed.

---

# 36. Customer Wallet Page

## Route

```text
/customer/wallet
```

Display:

```text
Available Balance
$350

Pending Amount
$150
```

Also display a short explanation:

- Available Balance = withdrawable money from completed Delivery Only orders
- Pending Amount = potential money from active Delivery Only orders

---

# 37. Customer Transactions Page

## Route

```text
/customer/transactions
```

Display wallet transaction history.

Recommended columns:

```text
Date
Type
Order
Credit
Debit
Balance
```

Customers cannot edit transactions.

---

# 38. Customer Payout History

## Route

```text
/customer/payouts
```

Display:

- Payout ID
- Amount
- Payment Method
- Date
- Status

Version 1 does not require customers to submit payout requests themselves.

---

# 39. Customer Profile

## Route

```text
/customer/profile
```

Display basic customer information.

Depending on business rules, some profile information may be editable later.

---

# 40. Public Tracking Page

## Route

```text
/track
```

No authentication required.

## Tracking Input

```text
Track Your Order

Enter your tracking number

[ TRK-____________ ]

[Track Order]
```

## Tracking Result

Example:

```text
Tracking #TRK-82JX91

Out for Delivery

✓ Order Received
✓ Ready for Delivery
● Out for Delivery
○ Delivered
```

For a collection-required order the safe stages may include an earlier segment:

```text
✓ Order Created
✓ Parcel Collected
● Received at Company
○ Preparing for Delivery
○ Out for Delivery
○ Delivered
```

For an order already at the company, collection stages are omitted.

Possible safe information:

- Tracking Code
- Current Basic Stage
- Progress Timeline
- Delivered Status
- Delivery Date

Must not expose:

- Customer Wallet
- Customer Internal Information
- Company Revenue
- Internal Notes
- Employee Information (including the employee who confirmed company receipt)
- Driver Cash
- Financial Accounting
- Internal Audit Information
- Sender / collection contact name, phone, or address
- Collection driver identity or contact
- Internal collection failure detail

---

# 41. Recommended Route Structure

```text
/auth
└── /login

/management
├── /dashboard
├── /orders
│   ├── /new
│   └── /:id
├── /customers
│   └── /:id
├── /drivers
│   └── /:id
├── /wallets
│   └── /:customerId
├── /payouts
├── /driver-settlements
├── /finance
├── /reports
├── /employees
│   └── /:id
├── /audit-logs
└── /settings

/driver
├── /orders
│   └── /:id
├── /out-for-delivery
├── /completed
├── /failed
└── /cash

/customer
├── /dashboard
├── /orders
│   └── /:id
├── /wallet
├── /transactions
├── /payouts
└── /profile

/track
└── public order tracking
```

---

# 42. Page Responsibility Rules

Not every backend/business module requires its own top-level frontend page.

Some modules should naturally live inside existing pages.

## Delivery Assignment

Handled inside:

- Orders Page
- Order Detail Page
- Create Order Page

## Parcel Intake & Collection

Handled inside:

- Create Order Page (intake method + collection snapshot + optional collection driver)
- Orders Page (intake/collection columns and filters)
- Order Detail Page (Parcel Intake / Collection section, collection assignment/attempts,
  Confirm Received At Company)
- Driver Portal (collection jobs)
- Settings (Failed Collection Reasons)

No dedicated top-level Parcel Collection page.

## Delivery Workflow

Handled inside:

- Order Detail Page
- Driver Portal

## Driver Cash Management

Handled inside:

- Driver Detail Page
- Driver Cash Page
- Driver Settlements

## Wallet Transactions

Handled inside:

- Customer Wallet Detail
- Customer Portal Transactions

## Order Timeline

Handled inside:

- Order Detail Page

This avoids unnecessary navigation complexity while still supporting all required business modules.

---

# 43. Recommended Frontend Priority

The frontend should not be built page-by-page in sidebar order.

Recommended implementation priority:

1. Authentication Layout
2. Management Application Layout
3. Orders Page
4. Create Order Page
5. Order Detail Page
6. Customer Pages
7. Driver Management Pages
8. Driver Portal
9. Customer Wallet Pages
10. Customer Payouts
11. Driver Settlements
12. Management Dashboard
13. Customer Portal
14. Public Tracking
15. Finance Overview
16. Reports
17. Employees
18. Audit Logs
19. Settings

Orders should be implemented early because many other pages depend on order information and order workflows.

---

# 44. Shared Frontend Components

The frontend should reuse common components wherever possible.

Recommended components include:

- Application Sidebar
- Top Navigation Bar
- Page Header
- Search Input
- Filter Bar
- Data Table
- Status Badge
- Order Type Badge
- Payment Type Badge
- Customer Selector
- Driver Selector
- Date Range Filter
- Statistic Card
- Confirmation Modal
- Form Section
- Money Input
- Read-only Calculated Field
- Order Timeline
- Pagination
- Empty State
- Loading State
- Error State
- Permission Guard
- Mobile Order Card

---

# 45. Status Presentation

Order statuses should use consistent labels everywhere.

Internal statuses:

```text
Received
Ready for Pickup
Assigned
Picked Up
Out for Delivery
Delivered
Failed Delivery
Rescheduled
Returned to Company
Returned to Customer
Cancelled
```

Parcel Collection statuses (separate state, shown in the Parcel Intake / Collection area,
not mixed into the order status badge):

```text
Awaiting Assignment
Assigned
Collected From Sender
Failed
Rescheduled
Received at Company
```

Customer/public simplified stages:

```text
(collection-required)                (already at company)
Order Created                         Order Received
Collection Scheduled                  Ready for Delivery
Parcel Collected                      Out for Delivery
Received at Company                   Delivered
Preparing for Delivery
Out for Delivery
Delivered
```

The frontend should map internal order statuses and the parcel collection status to the
simplified customer/public stages. Keep the parcel collection status visually separate from
the order status badge.

---

# 46. Permission-Aware UI

The frontend must not rely only on hiding buttons.

Backend authorization remains required.

However, the UI should hide or disable actions the current user cannot perform.

Examples:

Finance-only actions:

- Process Customer Payout
- Record Driver Settlement
- Financial Adjustment

Admin-only actions:

- Manage Employees
- Manage Permissions
- Sensitive Settings
- Full Audit Access where required

Dispatcher actions:

- Create Order
- Edit Operational Information
- Assign / Reassign Collection Driver (`orders.assign`)
- Assign / Reassign Delivery Driver (`orders.assign`)
- Confirm Received At Company (`orders.change_status`)
- Reschedule Collection (`orders.change_status`)
- Change Operational Status

Driver actions:

- Collected From Sender (`driver.orders.update_own`)
- Failed Collection (`driver.orders.update_own`)
- Pickup / Start Delivery / Delivered / Failed Delivery (`driver.orders.update_own`)

Drivers must **not** be granted `settings.read`; active Failed Collection Reasons reach the
Driver Portal through a narrow Driver-safe endpoint.

---

# 47. Responsive Design Guidelines

## Management Portal

Priority:

- Desktop
- Tablet
- Usable on mobile

Tables may switch to cards or horizontal scrolling on smaller screens.

## Driver Portal

Priority:

- Mobile
- Fast one-handed interaction
- Large action buttons
- Clear receiver information
- Prominent amount to collect

## Customer Portal

Priority:

- Mobile and desktop
- Simple navigation
- Clear wallet and tracking information

## Public Tracking

Priority:

- Mobile-friendly
- Minimal interface
- No unnecessary navigation

---

# 48. Version 1 UI Scope

Version 1 should prioritize operational clarity over advanced visual features.

Important:

- Fast order creation
- Easy searching
- Strong filters
- Clear driver assignment
- Clear delivery workflow
- Strong financial visibility
- Traceable transactions
- Simple customer tracking
- Mobile-friendly driver operations

Features such as the following can remain for later:

- GPS live tracking
- Route optimization
- Advanced analytics
- Map-heavy dashboards
- Barcode scanning
- QR scanning
- Proof-of-delivery photos
- Receiver signatures
- OTP delivery confirmation
- Complex charting
- Multi-branch switching
- Multiple currencies

---

# 49. Final Frontend Structure Summary

The Version 1 frontend contains four primary experiences.

## Management

Core pages:

1. Dashboard
2. Orders
3. Create Order
4. Order Details
5. Customers
6. Customer Details
7. Drivers
8. Driver Details
9. Customer Wallets
10. Wallet Details
11. Customer Payouts
12. Driver Settlements
13. Finance
14. Reports
15. Employees
16. Audit Logs
17. Settings

## Driver

Core pages:

1. My Orders
2. Order Details
3. Out for Delivery
4. Completed
5. Failed / Returned
6. My Cash

## Customer

Core pages:

1. Dashboard
2. My Orders
3. Order Details
4. Wallet
5. Transactions
6. Payouts
7. Profile

## Public

Core page:

1. Track Order

---

# 50. Next Development Stage

After approving this page structure, the recommended next stage is to define:

1. Management layout and reusable design system
2. Detailed Orders page wireframe
3. Create Order form behavior
4. Order Detail page behavior
5. Status transition rules
6. Role and permission matrix
7. Frontend component hierarchy
8. API requirements per page
9. Database entities used by each page
10. Development roadmap

The Orders module should be designed first because it is the central operational workflow of the Delivery Management System.
