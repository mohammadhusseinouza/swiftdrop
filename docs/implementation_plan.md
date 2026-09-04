# Delivery Management System — Full Implementation Plan

**Project:** Internal Delivery Management Platform  
**Version:** 1.1  
**Date:** 20 August 2026  
**Status:** Planning complete — phase + sub-phase execution plan

---

## 1. Purpose

This document is the single implementation blueprint for the Delivery Management System. It consolidates the approved business requirements, page structure, database design, backend architecture, frontend architecture, API plan, Redux Toolkit strategy, financial rules, testing plan, and deployment sequence.

The system will support four user experiences:

1. **Management Portal** — Admin, Dispatcher, and Finance users.
2. **Driver Portal** — Drivers see and process only their assigned delivery work.
3. **Customer Portal** — Customers see their own orders, tracking, wallet, transactions, and payouts.
4. **Public Tracking** — Unauthenticated order tracking using a tracking code.

The implementation goal is to preserve financial accuracy, traceability, role isolation, and operational simplicity.

---

# 2. Technology Stack

## 2.1 Frontend

- React
- TypeScript
- Vite
- Tailwind CSS
- React Router
- Redux Toolkit
- RTK Query
- React Hook Form
- Zod

## 2.2 Backend

- Node.js
- Express.js
- TypeScript
- Prisma ORM
- PostgreSQL
- Zod
- bcrypt
- JWT / secure session-based authentication

## 2.3 Infrastructure / Engineering

- Git
- Docker later in the project
- Environment-based configuration
- CI/CD during production phase
- PostgreSQL backups
- HTTPS in production

---

# 3. Core Architectural Principles

## 3.1 Backend owns business logic

The frontend must never be the source of truth for:

- payment calculations
- amount-to-collect calculations
- wallet credits
- driver cash
- settlements
- payouts
- company revenue
- order status transitions
- authorization

React may display calculated previews, but the Node backend recalculates and validates all financial and workflow values before writing to PostgreSQL.

## 3.2 Financial ledgers are separated

Three different kinds of money must never be mixed:

1. **Customer Wallet** — money the company owes the customer.
2. **Driver Cash** — money physically collected by a driver but not yet handed to the company.
3. **Company Finance** — money belonging to the company, such as delivery fees and Company Order revenue.

A driver settlement changes driver cash only.  
A customer payout changes customer wallet only.

## 3.3 Finalized financial records are append-only

Final financial history must not be silently edited.

Corrections should use:

- adjustment records
- reversal records
- audit logs

## 3.4 Server-side authorization is mandatory

Frontend permission checks exist only to improve the interface.

Every protected backend request must independently verify:

- authentication
- role
- permission
- ownership / record scope

## 3.5 Use database transactions for critical operations

The following operations must be atomic:

- Mark Delivered
- Customer Payout
- Driver Settlement
- Financial correction / reversal

If any step fails, the entire operation must roll back.

---

# 4. Main Business Roles

## 4.1 Admin

Full access to:

- employees
- customers
- drivers
- orders
- assignment / reassignment
- wallets
- payouts
- settlements
- finance
- reports
- audit
- settings
- permissions

## 4.2 Dispatcher / Employee

Operational access to:

- customers
- drivers
- order creation and editing
- order assignment
- order reassignment
- operational statuses
- order search and filtering
- tracking and order history
- dashboard

Finance permissions may be restricted.

## 4.3 Finance

Access to:

- wallets
- wallet transactions
- payouts
- driver cash
- settlements
- revenue
- financial reports
- authorized adjustments

## 4.4 Driver

May access only their own assigned work and their own cash information.

Can:

- view assigned orders
- view receiver details needed for delivery
- mark pickup
- start delivery
- mark delivered
- mark failed
- enter actual amount collected
- view delivery history
- view current driver cash balance

Cannot access:

- customer wallet balances
- other drivers' orders
- company finance
- employee management
- unrelated customer records

## 4.5 Customer

May access only their own account data:

- own orders
- simplified tracking
- wallet balance
- pending amount
- wallet transaction history
- payout history
- profile

---

# 5. Order Model and Business Rules

## 5.1 Order Types

### COMPANY_ORDER

The product belongs to the company.

Example:

- Order amount: 100
- Delivery fee: 5
- Total collection: 105

Result after delivery:

- Driver cash +105
- Company revenue +105 total allocation
- Customer wallet +0

### DELIVERY_ONLY

The package/order belongs to the customer/sender.

Example:

- Order amount: 100
- Delivery fee: 5
- Total collection: 105

Result after delivery:

- Driver cash +105
- Customer wallet +100
- Company delivery-fee revenue +5

---

# 6. Payment Model

## 6.1 Payment Types

- CASH_ON_DELIVERY
- ALREADY_PAID
- PARTIALLY_PAID

Payment type is not the same as payment method.

## 6.2 Payment Methods

Initial configurable methods:

- Cash
- Card
- Bank Transfer
- Whish
- Other

## 6.3 Recommended payment fields

Instead of a single ambiguous `alreadyPaid` field, store:

- `orderAmount`
- `deliveryFee`
- `prepaidOrderAmount`
- `prepaidDeliveryFee`
- `remainingOrderAmount`
- `remainingDeliveryFee`
- `amountToCollect`
- `actualAmountCollected`

Server formulas:

```text
remainingOrderAmount = orderAmount - prepaidOrderAmount
remainingDeliveryFee = deliveryFee - prepaidDeliveryFee
amountToCollect = remainingOrderAmount + remainingDeliveryFee
```

This makes cases such as “order already paid but delivery fee still due” unambiguous.

---

# 7. Order Lifecycle

Internal statuses:

1. RECEIVED
2. READY_FOR_PICKUP
3. ASSIGNED
4. PICKED_UP
5. OUT_FOR_DELIVERY
6. DELIVERED

Exception statuses:

- FAILED_DELIVERY
- RESCHEDULED
- RETURNED_TO_COMPANY
- RETURNED_TO_CUSTOMER
- CANCELLED

The backend must implement a controlled state machine rather than allowing arbitrary status values through a generic update endpoint.

Typical path:

```text
RECEIVED
  -> READY_FOR_PICKUP
  -> ASSIGNED
  -> PICKED_UP
  -> OUT_FOR_DELIVERY
  -> DELIVERED
```

Failure path:

```text
OUT_FOR_DELIVERY
  -> FAILED_DELIVERY
  -> RESCHEDULED / RETURNED_TO_COMPANY / RETURNED_TO_CUSTOMER / CANCELLED
```

Every transition creates status history and appropriate audit information.

---

# 8. Failed Delivery Rules

Configurable reasons:

- Receiver did not answer
- Receiver unavailable
- Receiver refused
- Incorrect address
- Incomplete address
- Customer requested rescheduling
- Unable to contact receiver
- Other

If `Other` is selected, notes should be required.

A failed delivery must not automatically:

- credit customer wallet
- record normal company revenue
- mark expected cash as collected

Redelivery or failed-attempt fees should be configurable later rather than hard-coded.

---

# 9. Collection Difference Rule

If actual collection differs from expected collection:

Example:

```text
Expected: 105
Actual:    95
```

The driver must provide a reason.

The order should record:

- actual amount collected
- collection difference reason
- `needsFinancialReview = true`

The real amount collected may safely increase driver cash, but if the split between customer money and company revenue is ambiguous, automatic financial allocation should be deferred until Admin/Finance resolves the difference.

This prevents the system from guessing which party should absorb the shortage.

---

# 10. Database Plan

Database: **PostgreSQL**

Money values must use `NUMERIC/DECIMAL`, never floating-point types.

Core V1 tables:

1. users
2. roles
3. permissions
4. role_permissions
5. employees
6. customers
7. drivers
8. orders
9. order_assignments
10. order_status_history
11. delivery_attempts
12. customer_wallets
13. wallet_transactions
14. customer_payouts
15. driver_cash_accounts
16. driver_cash_transactions
17. driver_settlements
18. company_financial_transactions
19. areas
20. payment_methods
21. failed_delivery_reasons
22. system_settings
23. audit_logs

### Phase 11.17 additions (Parcel Intake & Collection)

Designed in `/docs/parcel-intake-collection-database-contract.md`; applied in Phase 11.17.2:

24. parcel_collection_assignments
25. parcel_collection_attempts
26. failed_collection_reasons

Plus new enums `ParcelIntakeMethod` / `ParcelCollectionStatus` and new nullable `orders`
columns (`parcel_intake_method`, `parcel_collection_status`,
`current_parcel_collection_driver_id`, collection contact/address snapshot fields,
`parcel_collected_from_sender_at`, `received_at_company_at`, `received_at_company_by_id`).
`orders.current_driver_id` continues to mean the final Delivery driver only. Existing
financial `collection_*` columns are unchanged and remain about money collection.

---

# 11. Main Database Relationships

```text
User
 ├─ Employee
 ├─ Driver
 └─ Customer

Role
 └─ RolePermissions
      └─ Permission

Customer
 ├─ Orders
 ├─ CustomerWallet
 └─ CustomerPayouts

CustomerWallet
 └─ WalletTransactions

Order
 ├─ Customer
 ├─ Current Driver
 ├─ Assignment History
 ├─ Status History
 ├─ Delivery Attempts
 ├─ Wallet Transactions
 ├─ Driver Cash Transactions
 └─ Company Financial Transactions

Driver
 ├─ Assignments
 ├─ Delivery Attempts
 ├─ DriverCashAccount
 └─ DriverSettlements

DriverCashAccount
 └─ DriverCashTransactions
```

Receiver data is stored directly on the order as snapshot data rather than as a reusable Receiver entity in V1.

---

# 12. Database Integrity Rules

Important constraints and rules:

- UUID primary keys
- unique order number
- unique tracking code
- unique driver number
- unique customer number
- unique wallet per customer
- unique driver cash account per driver
- foreign keys for all relationships
- indexes on frequently filtered fields
- timestamps on important records
- finalized ledger entries are not overwritten

Recommended idempotency protection:

- prevent duplicate wallet credit for the same delivered order
- prevent duplicate driver collection transactions
- prevent duplicate company revenue posting for the same order/category

---

# 13. Backend Project Structure

```text
server/
│
├─ prisma/
│  └─ schema.prisma
│
├─ src/
│  ├─ app.ts
│  ├─ server.ts
│  │
│  ├─ config/
│  │  ├─ env.ts
│  │  └─ constants.ts
│  │
│  ├─ db/
│  │  └─ prisma.ts
│  │
│  ├─ middleware/
│  │  ├─ authenticate.ts
│  │  ├─ authorize.ts
│  │  ├─ validate.ts
│  │  ├─ errorHandler.ts
│  │  └─ notFound.ts
│  │
│  ├─ modules/
│  │  ├─ auth/
│  │  ├─ users/
│  │  ├─ customers/
│  │  ├─ drivers/
│  │  ├─ orders/
│  │  ├─ delivery/
│  │  ├─ wallets/
│  │  ├─ payouts/
│  │  ├─ settlements/
│  │  ├─ finance/
│  │  ├─ dashboard/
│  │  ├─ reports/
│  │  ├─ audit/
│  │  ├─ settings/
│  │  └─ tracking/
│  │
│  ├─ shared/
│  │  ├─ errors/
│  │  ├─ types/
│  │  ├─ utils/
│  │  └─ constants/
│  │
│  └─ routes/
│     └─ index.ts
│
├─ .env
├─ package.json
└─ tsconfig.json
```

Typical module structure:

```text
orders/
├─ order.routes.ts
├─ order.controller.ts
├─ order.service.ts
├─ order.schema.ts
├─ order.types.ts
└─ order.utils.ts
```

---

# 14. API Conventions

Base URL:

```text
/api/v1
```

Recommended response shape:

```json
{
  "success": true,
  "data": {},
  "message": "Optional message"
}
```

Recommended error shape:

```json
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid request",
    "details": []
  }
}
```

Use standard HTTP status codes and central error handling.

---

# 15. Authentication and Authorization Plan

## 15.1 Endpoints

```text
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/refresh
GET  /api/v1/auth/me
```

## 15.2 Middleware flow

```text
Request
 -> authenticate
 -> authorize(permission)
 -> validate request
 -> controller
 -> service
 -> database
```

## 15.3 Permission examples

```text
orders.read
orders.create
orders.update
orders.assign
orders.change_status
orders.cancel

customers.read
customers.create
customers.update

drivers.read
drivers.manage

wallets.read
wallets.adjust

payouts.read
payouts.create

settlements.read
settlements.create

finance.read
finance.adjust

reports.read
employees.manage
audit.read
settings.manage
```

## 15.4 Ownership-safe portal endpoints

Customer endpoints should use the authenticated identity:

```text
GET /api/v1/customer/me/dashboard
GET /api/v1/customer/me/orders
GET /api/v1/customer/me/wallet
GET /api/v1/customer/me/transactions
GET /api/v1/customer/me/payouts
GET /api/v1/customer/me/profile
```

Driver endpoints should also be scoped by the authenticated driver:

```text
GET /api/v1/driver/me/orders
GET /api/v1/driver/me/cash
```

Do not trust customer or driver IDs supplied by the frontend for self-service routes.

---

# 16. Customer APIs

```text
GET    /api/v1/customers
POST   /api/v1/customers
GET    /api/v1/customers/:id
PATCH  /api/v1/customers/:id
GET    /api/v1/customers/:id/orders
```

Support:

- pagination
- search
- active/inactive filter
- area filter
- order summary
- wallet summary

---

# 17. Driver Management APIs

```text
GET    /api/v1/drivers
POST   /api/v1/drivers
GET    /api/v1/drivers/:id
PATCH  /api/v1/drivers/:id
```

Driver details should expose management-safe operational summaries:

- active assignments
- out-for-delivery count
- completed today
- cash held
- settlement history

---

# 18. Settings APIs

```text
GET /api/v1/settings/areas
GET /api/v1/settings/payment-methods
GET /api/v1/settings/failed-delivery-reasons
```

Admin management endpoints can later support create/update/deactivate operations for these references.

---

# 19. Order APIs

## 19.1 Main CRUD / Query

```text
GET   /api/v1/orders
POST  /api/v1/orders
GET   /api/v1/orders/:id
PATCH /api/v1/orders/:id
```

## 19.2 Operational actions

```text
POST /api/v1/orders/:id/ready
POST /api/v1/orders/:id/assign            # delivery driver; requires RECEIVED_AT_COMPANY
POST /api/v1/orders/:id/reassign          # delivery driver; requires RECEIVED_AT_COMPANY
POST /api/v1/orders/bulk-assign           # delivery; atomic; rejects any non-RECEIVED_AT_COMPANY
POST /api/v1/orders/:id/reschedule
POST /api/v1/orders/:id/cancel            # rejected if parcel_collection_status = COLLECTED_FROM_SENDER;
                                         # from ASSIGNED also closes the collection assignment (end_reason ORDER_CANCELLED)
```

Parcel-collection actions (exact routes designed in Phase 11.17.3, shape indicative):

```text
POST /api/v1/orders/:id/parcel-collection/assign      # assign collection driver
POST /api/v1/orders/:id/parcel-collection/reassign    # reassign before successful collection
POST /api/v1/orders/:id/parcel-collection/reschedule  # after a failed attempt
POST /api/v1/orders/:id/parcel-collection/receive     # Management: confirm RECEIVED_AT_COMPANY
POST /api/v1/driver/jobs/:id/collected                # Driver: COLLECTED_FROM_SENDER
POST /api/v1/driver/jobs/:id/collection-failed        # Driver: reason + notes
```

The delivery-assignment predicate on every path (assign, reassign, bulk-assign,
create-and-assign, direct API) must include
`orders.parcel_collection_status = 'RECEIVED_AT_COMPANY'` in addition to existing
order-status / driver-eligibility rules. Bulk delivery assignment stays atomic — one
ineligible order rejects the whole batch.

## 19.3 Search and filters

Orders should support combinations of:

- order number
- tracking code
- customer
- receiver
- intake method
- parcel collection status
- collection driver
- delivery driver
- phone
- status
- driver
- type
- area
- payment type
- payment method
- date range
- assigned / unassigned
- delivered / undelivered

Example:

```text
GET /api/v1/orders?status=OUT_FOR_DELIVERY&driverId=...&type=DELIVERY_ONLY&page=1
```

---

# 20. Driver Delivery APIs

```text
GET  /api/v1/driver/me/orders
GET  /api/v1/driver/me/orders/:id

POST /api/v1/driver/orders/:id/pickup
POST /api/v1/driver/orders/:id/start-delivery
POST /api/v1/driver/orders/:id/deliver
POST /api/v1/driver/orders/:id/fail

GET  /api/v1/driver/me/cash
```

Each action must verify:

- driver owns current assignment
- order is in a valid state
- transition is permitted
- required data is present

---

# 21. Mark Delivered Transaction

This is the most important server workflow.

Pseudo-flow:

```text
BEGIN TRANSACTION

1. Load and validate order
2. Verify authenticated driver / authorized management actor
3. Verify valid current status
4. Validate expected and actual collection
5. Record collection difference if needed
6. Update order to DELIVERED
7. Create status history
8. Complete delivery attempt
9. Add actual cash to driver cash account
10. Insert driver cash transaction

11. If COMPANY_ORDER and financial split is valid:
      - create company order revenue
      - create delivery fee revenue if tracked separately

12. If DELIVERY_ONLY and financial split is valid:
      - credit customer wallet with unpaid order portion collected
      - create wallet transaction
      - create company delivery-fee revenue

13. Create audit records

COMMIT
```

If an error occurs:

```text
ROLLBACK
```

---

# 22. Customer Wallet APIs

```text
GET /api/v1/wallets
GET /api/v1/wallets/:customerId
GET /api/v1/wallets/:customerId/transactions
```

Wallet transaction types:

- ORDER_CREDIT
- PAYOUT
- ADJUSTMENT
- REVERSAL

The wallet balance may be cached for fast access, but every balance change must have a ledger transaction.

Pending wallet amount should normally be derived from qualifying active Delivery Only orders and must not be withdrawable.

---

# 23. Customer Payout APIs

```text
GET  /api/v1/payouts
POST /api/v1/payouts
```

Payout transaction:

```text
BEGIN
1. Verify customer
2. Verify requested amount > 0
3. Verify available wallet balance
4. Create payout
5. Create wallet debit transaction
6. Update wallet balance
7. Create audit log
COMMIT
```

Default rule:

- payout cannot exceed available wallet balance
- wallet should not become negative in V1

---

# 24. Driver Cash APIs

Management may view driver cash balances and transaction history.

Driver cash transaction types:

- COLLECTION
- SETTLEMENT
- ADJUSTMENT
- REVERSAL

Driver cash represents physical/company-held collection responsibility, not customer ownership accounting.

---

# 25. Driver Settlement APIs

```text
GET  /api/v1/driver-settlements
POST /api/v1/driver-settlements
```

Settlement transaction:

```text
BEGIN
1. Load driver cash balance
2. Validate settlement amount
3. Create settlement
4. Reduce driver cash balance
5. Create driver cash transaction
6. Create audit log
COMMIT
```

Important:

```text
Driver settlement -> changes driver cash
Driver settlement -> does NOT change customer wallet
```

---

# 26. Company Finance APIs

```text
GET /api/v1/finance/summary
GET /api/v1/finance/transactions
```

Company financial transaction types may include:

- DELIVERY_FEE_REVENUE
- COMPANY_ORDER_REVENUE
- ADJUSTMENT
- REVERSAL

Finance reports should distinguish:

- delivery fee revenue
- company order revenue
- total collected
- customer wallet liabilities
- payouts
- unsettled driver cash

---

# 27. Dashboard API

```text
GET /api/v1/dashboard
```

Dashboard metrics:

## Orders

- today
- awaiting collection assignment
- collection in progress
- collection failed / attention
- collected — awaiting company receipt
- ready for delivery assignment  (received at company AND no delivery driver AND otherwise
  eligible — NOT every driver-less order)
- ready
- assigned (delivery)
- out for delivery
- delivered today
- failed today
- returned
- cancelled

## Drivers

- active drivers
- currently delivering
- active delivery assignments
- active collection jobs
- deliveries completed today
- collections completed today
- cash held

## Finance

- delivery fees
- company order revenue
- total collected
- customer wallet liabilities
- payouts
- driver unsettled cash

## Attention list

- orders awaiting collection assignment
- failed parcel collections
- collected — awaiting company receipt
- orders ready for delivery assignment (received at company, no delivery driver)
- failed deliveries
- collection differences (money — financial review)
- returned orders
- orders waiting too long
- financial review required

---

# 28. Reports and Audit APIs

Reports:

```text
GET /api/v1/reports/orders
GET /api/v1/reports/drivers
GET /api/v1/reports/customers
GET /api/v1/reports/financial
```

Audit:

```text
GET /api/v1/audit-logs
```

Audit events include:

- order created
- order edited
- driver assigned
- driver reassigned
- status changed
- delivery failed
- order delivered
- amount collected
- wallet credit
- payout
- driver settlement
- financial adjustment
- settings / permission changes where appropriate

---

# 29. Public Tracking API

```text
GET /api/v1/tracking/:trackingCode
```

Only return safe data:

- tracking code
- simplified customer-facing status
- basic timeline
- delivery progress

Never expose:

- customer wallet
- driver finance
- internal notes
- management-only fields
- audit metadata

---

# 30. Customer/Public Status Mapping

Internal states should be simplified for customers and public tracking.

Recommended mapping:

```text
RECEIVED
 -> Order Received

READY_FOR_PICKUP
ASSIGNED
PICKED_UP
 -> Ready for Delivery

OUT_FOR_DELIVERY
 -> Out for Delivery

DELIVERED
 -> Delivered
```

Exception messaging should be carefully simplified and avoid unnecessary internal operational details.

---

# 31. Frontend Project Structure

```text
client/src/
│
├─ app/
│  ├─ store.ts
│  └─ hooks.ts
│
├─ services/
│  ├─ api.ts
│  ├─ authApi.ts
│  ├─ ordersApi.ts
│  ├─ customersApi.ts
│  ├─ driversApi.ts
│  ├─ walletsApi.ts
│  ├─ payoutsApi.ts
│  ├─ settlementsApi.ts
│  ├─ financeApi.ts
│  ├─ reportsApi.ts
│  └─ settingsApi.ts
│
├─ features/
│  ├─ auth/
│  │  └─ authSlice.ts
│  ├─ orders/
│  │  └─ ordersUiSlice.ts
│  └─ ui/
│     └─ uiSlice.ts
│
├─ components/
├─ layouts/
├─ pages/
│  ├─ management/
│  ├─ driver/
│  ├─ customer/
│  └─ public/
├─ routes/
├─ types/
└─ utils/
```

---

# 32. Redux Toolkit Strategy

## 32.1 RTK Query manages server state

Use RTK Query for:

- auth/me requests
- orders
- customers
- drivers
- wallets
- payouts
- settlements
- dashboard
- finance
- reports
- settings

Benefits:

- API caching
- automatic loading state
- error state
- refetching
- cache invalidation after mutations

Example behavior:

```text
Driver marks order delivered
 -> backend transaction completes
 -> RTK Query invalidates Order / DriverCash / Wallet / Dashboard tags
 -> affected screens refetch automatically
```

## 32.2 Normal Redux slices manage client state

Use slices for:

- current authenticated user summary
- role / permissions if needed globally
- sidebar state
- modal state
- selected table rows
- order list UI filters if persistent across navigation
- other true global UI preferences

Do not copy every API result into a slice.

---

# 33. Frontend Shared Components

Reusable components:

- App Sidebar
- Top Navbar
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

# 34. Management Portal Routes

```text
/auth/login

/management/dashboard
/management/orders
/management/orders/new
/management/orders/:id
/management/customers
/management/customers/:id
/management/drivers
/management/drivers/:id
/management/wallets
/management/wallets/:customerId
/management/payouts
/management/driver-settlements
/management/finance
/management/reports
/management/employees
/management/employees/:id
/management/audit-logs
/management/settings
```

---

# 35. Management Portal Implementation Order

1. Login
2. Management layout
3. Orders list
4. Create Order
5. Order Detail
6. Customer pages
7. Driver pages
8. Wallet pages
9. Payouts
10. Driver settlements
11. Dashboard
12. Finance
13. Reports
14. Employees
15. Audit Logs
16. Settings

Orders are implemented early because they are the central workflow of the entire platform.

---

# 36. Orders Page

Capabilities:

- search by order number
- tracking code
- customer
- receiver
- phone
- combinable filters
- pagination
- sorting
- bulk driver assignment
- mark selected orders ready when allowed

Suggested table columns:

- order
- customer
- receiver / phone
- area
- type
- order amount
- delivery fee
- amount to collect
- driver
- payment type
- status
- created date
- delivery date

---

# 37. Create Order Page

Sections:

1. Customer
2. Receiver
3. Package
4. Order Type
5. Payment
6. Parcel Intake (method + conditional collection snapshot + optional collection driver)
7. Delivery Assignment (delivery-driver selector; only enabled when the parcel is already
   at the company)
8. Review / calculated totals

Create actions (label reflects what is assigned, never ambiguous):

- Create Order
- Create & Assign Collection Driver (collection-required order with a collection driver)
- Create & Assign (already-at-company order with a delivery driver)

Calculated financial values shown in the UI must be recalculated by the backend before persistence.

---

# 38. Order Detail Page

This page is the central source of truth.

Sections:

- Order Summary
- Customer
- Receiver
- Package
- Financial
- Parcel Intake / Collection (intake method, parcel collection status, collection snapshot,
  current collection driver, collection assignment history, collection attempts,
  collected-from-sender / received-at-company timestamps + confirmer)
- Delivery
- Timeline (collection + delivery events, chronological)
- Collection Assignment History
- Delivery Assignment History
- Collection Attempts
- Delivery Attempts

The delivery **Assign Driver** action is disabled until parcel collection status is
`RECEIVED_AT_COMPANY`.

Actions based on permission and status:

- Edit
- Mark Ready
- Assign
- Reassign
- Cancel
- Reschedule
- Copy Tracking Code
- Copy Tracking Link
- View History

Finalized financial details must not be silently edited.

---

# 39. Customer Management Pages

## Customer List

Suggested columns:

- customer
- phone
- area
- available wallet
- pending amount
- active orders
- status
- created date

## Customer Detail

Summary cards:

- available wallet
- pending
- active orders
- delivered orders

Tabs:

- Overview
- Orders
- Wallet
- Payouts
- Activity

---

# 40. Driver Management Pages

## Driver List

Suggested columns:

- driver
- phone
- active orders
- out for delivery
- completed today
- cash held
- status

## Driver Detail

Summary cards:

- assigned
- out for delivery
- delivered today
- cash held

Tabs:

- Current Orders
- Delivery History
- Cash
- Settlements

---

# 41. Wallet Pages

## Wallet List

Columns:

- customer
- available balance
- pending
- last transaction
- last payout

## Wallet Detail

Show:

- available balance
- pending amount
- process payout action
- transaction ledger
- related orders

---

# 42. Payout Pages

Functions:

- payout list
- payout detail if needed
- new payout
- filtering
- payment method
- processed by
- notes

---

# 43. Driver Settlement Pages

Functions:

- settlement list
- create settlement
- driver cash before
- amount received
- driver cash after
- method
- receiver employee
- notes

---

# 44. Finance Page

Summary cards:

- delivery fee revenue
- company order revenue
- total collected
- customer wallet liabilities
- payouts
- unsettled driver cash

Additional sections:

- recent financial activity
- date-range filtering
- transaction history

---

# 45. Employee / Permission Pages

Admin-only.

Initial roles:

- Admin
- Dispatcher
- Finance

Functions:

- employee list
- employee detail
- activate / deactivate
- role assignment
- permissions configuration

---

# 46. Reports Page

Report groups:

- Orders
- Drivers
- Customers
- Financial

Support date filters and later export functionality.

---

# 47. Audit Logs Page

Display:

- time
- actor
- action
- entity type
- entity ID
- previous values when relevant
- new values when relevant

Filters:

- actor
- action
- entity
- date range

---

# 48. Settings Page

Tabs:

- General
- Payment Methods
- Delivery Settings
- Failed Delivery Reasons
- Areas
- Users & Permissions

Settings that affect financial logic must be permission-controlled and audited.

---

# 49. Driver Portal

Job-oriented (COLLECTION and DELIVERY jobs — see Phase 11.17 and `page_structure.md` §23–28A).
Mobile-first routes:

```text
/driver/jobs          (canonical Driver work-list route; NO /driver/orders alias)
/driver/jobs/:orderId (indicative — job-detail route finalized in Phase 12)
/driver/out-for-delivery
/driver/completed
/driver/failed
/driver/cash
```

Delivery job cards prominently show: receiver, phone, area/address, amount to collect,
Call, Location, workflow action button.

Collection job cards prominently show: sender / collection contact, phone, collection
address, collection notes, Call, Location, and the actions **Collected From Sender** /
**Failed Collection**. No amount to collect, no receiver data, no company-receipt action.

Delivery workflow buttons: Mark Picked Up, Start Delivery, Mark Delivered, Mark Failed.
The Deliver action must show expected collection, actual collection input, and a difference
reason when values differ.

Collection workflow: Collected From Sender (sets `COLLECTED_FROM_SENDER`, no company receipt),
Failed Collection (reason from a narrow Driver-safe active list + notes where required).

---

# 50. Customer Portal

Routes:

```text
/customer/dashboard
/customer/orders
/customer/orders/:id
/customer/wallet
/customer/transactions
/customer/payouts
/customer/profile
```

Dashboard cards:

- available wallet
- pending amount
- active orders
- delivered orders

Order detail shows simplified tracking rather than internal operational data.

---

# 51. Public Tracking

Route:

```text
/track
```

User enters tracking code.

Show only:

- simplified current status
- safe timeline
- basic order progress

No authentication required.

---

# 52. Testing Strategy

Testing should happen continuously, not only at the end.

## 52.1 Unit Tests

Test business logic such as:

- amount-to-collect calculations
- order status transition rules
- wallet credit calculations
- company revenue calculations
- driver cash calculations
- collection difference logic
- permission decisions

## 52.2 Integration Tests

Critical full API flows.

### Delivery Only exact collection

```text
Create order
 -> Assign driver
 -> Pick up
 -> Start delivery
 -> Deliver 105

Verify:
Order = Delivered
Driver cash += 105
Customer wallet += 100
Company revenue += 5
```

### Company Order

Verify:

- no customer wallet credit
- company receives the appropriate order revenue and fee
- driver cash reflects actual collection

### Customer payout

```text
Wallet 500
Payout 80
 -> wallet becomes 420
 -> payout record exists
 -> driver cash unchanged
```

### Driver settlement

```text
Driver cash 1000
Settlement 700
 -> driver cash becomes 300
 -> customer wallet unchanged
```

### Collection difference

Verify:

- actual cash is recorded
- review flag is set
- unresolved financial split is not guessed

## 52.3 Authorization Tests

Verify:

- customer cannot read another customer
- driver cannot read another driver's assignments
- dispatcher cannot access restricted finance actions
- finance cannot perform unauthorized admin operations
- public tracking exposes only safe fields

## 52.4 End-to-End Tests

Automate critical user journeys through the browser after frontend/backend integration.

---

# 53. Production Security Checklist

Before release:

- secure password hashing
- protected authentication tokens / cookies
- server-side authorization
- HTTPS
- CORS configuration
- rate limiting
- input validation
- centralized error handling
- secure environment variables
- no secrets in repository
- audit sensitive actions
- safe logging
- IDOR protection
- database backup plan
- recovery procedure

---

# 54. Deployment Plan

Production preparation order:

1. Finalize environment variables
2. Production PostgreSQL database
3. Database migration / deployment process
4. Build backend
5. Build frontend
6. HTTPS / reverse proxy
7. CORS and cookie/domain configuration
8. Logging and monitoring
9. Backup automation
10. CI/CD
11. Smoke tests
12. Production launch

Docker may be introduced before deployment for repeatable environments.

---

# 55. Official Phase + Sub-Phase Implementation Plan

## 55.1 Execution Model

Implementation will now follow this rule:

```text
Phase
  -> Sub-phase
      -> One focused Claude Code session
          -> Tests / checks
              -> Review gate
                  -> Next sub-phase
```

A **phase** is a project milestone.  
A **sub-phase** is the normal Claude Code implementation unit.

Default rule:

- one Claude Code session targets one sub-phase
- Claude Code stops at the sub-phase boundary
- every sub-phase ends with tests/checks and a change summary
- the next sub-phase starts only after review
- later features must not be implemented early unless they are a direct technical dependency

For every sub-phase, Claude Code must report:

```text
Sub-phase completed:
Files created:
Files modified:
Routes/APIs added:
Database changes:
Tests/checks run:
Known issues:
Explicitly not implemented:
Recommended next sub-phase:
```

---

# Phase 0 — Requirements and Business Rules — COMPLETE

## 0.1 Roles and permissions — COMPLETE
Approved roles:

- Admin
- Dispatcher
- Finance
- Driver
- Customer

## 0.2 Customer and receiver model — COMPLETE
Approved:

- one Customer entity supports both Company Order and Delivery Only
- receiver data is stored as an order snapshot
- customer and receiver may be different people

## 0.3 Order/payment model — COMPLETE
Approved:

- COMPANY_ORDER
- DELIVERY_ONLY
- CASH_ON_DELIVERY
- ALREADY_PAID
- PARTIALLY_PAID
- separate order-value and delivery-fee prepayment

## 0.4 Financial rules — COMPLETE
Approved:

- customer wallet
- customer payouts
- driver cash
- driver settlements
- company financial ledger
- financial review for collection differences
- append-only/reversal-based financial history

## 0.5 Workflow and V1 scope — COMPLETE
Approved:

- lifecycle/statuses
- failed-delivery behavior
- audit requirements
- V1 scope
- deferred features

---

# Phase 1 — UI / Page Architecture — COMPLETE

## 1.1 Management Portal — COMPLETE
## 1.2 Driver Portal — COMPLETE
## 1.3 Customer Portal — COMPLETE
## 1.4 Public Tracking — COMPLETE
## 1.5 Routes/shared component responsibilities — COMPLETE

The page-structure document remains authoritative for navigation and page responsibility.

---

# Phase 2 — Database Design — COMPLETE

## 2.1 PostgreSQL relational model — COMPLETE
## 2.2 Financial ledgers — COMPLETE
## 2.3 Order/assignment/status/delivery history — COMPLETE
## 2.4 Audit model — COMPLETE
## 2.5 Manual PostgreSQL SQL scripts — COMPLETE
## 2.6 Prisma model direction — COMPLETE

The manually imported PostgreSQL database is authoritative. Prisma must stay synchronized with it.

---

# Phase 3 — Backend Foundation

Goal: create the Node/Express/TypeScript backend and connect it safely to PostgreSQL.

## 3.1 Backend Project Bootstrap

**Objective:** create the server application shell.

**Scope:**

- create `server/`
- initialize Node project
- configure TypeScript
- install/configure Express
- create `src/app.ts`
- create `src/server.ts`
- create base folders
- add `.env.example`
- add build/dev/typecheck scripts
- configure `.gitignore`

**Checks:**

- dependencies install
- TypeScript compiles
- Express server starts
- production build succeeds

**Definition of done:** the backend boots cleanly.

**Do not implement yet:** Prisma connection, auth, customers, drivers, orders, finance.

---

## 3.2 PostgreSQL + Prisma Connection

**Objective:** connect to the manually created PostgreSQL database.

**Scope:**

- configure Prisma
- align schema with real PostgreSQL schema
- generate Prisma Client
- create reusable DB client
- validate `DATABASE_URL`
- confirm DB connectivity
- graceful disconnect/shutdown behavior

**Rules:**

- do not reset/drop/recreate the database
- do not run destructive migrations automatically
- money remains Decimal/NUMERIC
- schema changes require explicit approval

**Checks:**

- Prisma Client generation succeeds
- backend connects to PostgreSQL
- harmless DB query succeeds
- typecheck passes

**Definition of done:** backend has a stable Prisma/PostgreSQL connection.

**Do not implement yet:** business CRUD/auth.

---

## 3.3 API Foundation + Global Middleware

**Objective:** create reusable HTTP infrastructure.

**Scope:**

- `/api/v1` router
- `GET /api/v1/health`
- JSON parsing
- central error classes
- error handler
- 404 handler
- validation middleware foundation
- base response conventions
- basic request logging if selected

**Checks:**

- health route succeeds
- unknown route returns controlled 404
- validation failures return controlled errors
- production errors do not expose stack/Prisma/SQL details

**Definition of done:** stable API shell + DB connectivity + health route.

**Phase 3 review gate:** build/typecheck passes and no destructive DB behavior exists.

---

# Phase 4 — Authentication and Authorization

Goal: establish secure identity and server-side authorization before business APIs.

## 4.1 Auth Domain Foundation + First Admin

**Objective:** prepare user, role, permission, and password infrastructure.

**Scope:**

- password hash/verify helpers
- safe user DTO
- role/permission loading
- explicit first-Admin bootstrap/seed command
- duplicate-account protections

**Rules:**

- never return/log password hashes or plaintext passwords
- Admin bootstrap must not run repeatedly on normal startup

**Checks:** hash verification, safe DTO, duplicate protection.

**Definition of done:** project can create and load an initial Admin safely.

---

## 4.2 Login

**Objective:** authenticate active users.

**API:**

```text
POST /api/v1/auth/login
```

**Scope:**

- input validation
- user lookup
- password verification
- active-status check
- secure token/session issuance
- role/permission response

**Checks:**

- valid login
- invalid password
- unknown account
- inactive user
- sensitive fields absent

**Definition of done:** valid users can authenticate.

---

## 4.3 Refresh / Logout / Current User

**APIs:**

```text
GET  /api/v1/auth/me
POST /api/v1/auth/refresh
POST /api/v1/auth/logout
```

**Scope:**

- token/session validation
- current user hydration
- refresh/rotation/revocation as applicable
- logout invalidation

**Checks:** `/me`, expired auth, refresh, logout.

**Definition of done:** complete auth lifecycle works.

---

## 4.4 RBAC + Ownership Protection

**Objective:** enforce permissions and record scope.

**Scope:**

- `authenticate`
- `authorize(permission)`
- current actor typing
- Customer self-scope
- Driver self-scope
- ownership helpers

**Rules:**

- frontend guards are UX only
- backend prevents IDOR
- Customer/Driver self-service uses authenticated identity

**Checks:**

- unauthorized -> 401
- forbidden -> 403
- driver cannot access another driver's data
- customer cannot access another customer's data

**Definition of done:** protected routes can enforce permission + ownership.

---

## 4.5 Authentication / RBAC Tests

Test:

- password hashing
- login
- inactive users
- `/auth/me`
- refresh/logout
- missing permission
- customer isolation
- driver isolation

**Phase 4 review gate:** auth storage, secrets, RBAC and IDOR protections reviewed.

---

# Phase 5 — Core Management Data

Goal: implement master/reference data required by Orders.

## 5.1 Customers Backend

**APIs:**

```text
GET    /api/v1/customers
POST   /api/v1/customers
GET    /api/v1/customers/:id
PATCH  /api/v1/customers/:id
GET    /api/v1/customers/:id/orders
```

**Scope:**

- create/read/update/deactivate
- search
- pagination
- active/area filters
- audit mutations
- initialize wallet if required by the approved service design

**Rules:**

- one Customer supports both order types
- linked login is optional
- no hard delete of historical customer relationships

**Checks:** CRUD, search, permissions, duplicate identifiers.

**Definition of done:** Management can manage customers needed by orders.

---

## 5.2 Drivers Backend

**APIs:**

```text
GET    /api/v1/drivers
POST   /api/v1/drivers
GET    /api/v1/drivers/:id
PATCH  /api/v1/drivers/:id
```

**Scope:**

- create/read/update/deactivate
- driver account linkage
- cash-account initialization if required
- management operational summary

**Rules:**

- inactive drivers cannot normally receive new assignments
- driver cash is not a raw editable profile value

**Checks:** CRUD, auth, duplicate IDs, activation state.

---

## 5.3 Reference / Settings Data

**APIs minimum:**

```text
GET /api/v1/settings/areas
GET /api/v1/settings/payment-methods
GET /api/v1/settings/failed-delivery-reasons
```

Add Admin create/update/deactivate endpoints only where V1 Settings requires them.

**Rules:**

- prefer deactivate over delete
- payment type != payment method
- failed reason `Other` notes rule is server validated

**Definition of done:** order/customer/driver forms can retrieve required reference data.

---

## 5.4 Phase 5 Integration Tests

Test:

- customer lifecycle
- driver lifecycle
- inactive restrictions
- reference data
- permissions
- search/pagination

**Phase 5 review gate:** master data is stable enough for Orders.

---

# Phase 6 — Order Engine

Goal: implement management-side order creation/query/editing/assignment/workflow.

## 6.1 Order Financial Calculations + Validation

**Objective:** centralize server-authoritative calculations.

Formula:

```text
remainingOrderAmount =
  orderAmount - prepaidOrderAmount

remainingDeliveryFee =
  deliveryFee - prepaidDeliveryFee

amountToCollect =
  remainingOrderAmount + remainingDeliveryFee
```

**Validate:**

- all amounts >= 0
- prepaid order <= order amount
- prepaid fee <= delivery fee
- payment type is consistent
- Decimal-safe arithmetic

**Tests:**

- full COD
- fully prepaid
- partial prepaid
- order prepaid / fee unpaid
- invalid overpayment
- zero values

**Definition of done:** tested calculation service exists.

**Do not implement yet:** CRUD/assignment/delivery finance.

---

## 6.2 Create Order + Order Detail

**APIs:**

```text
POST /api/v1/orders
GET  /api/v1/orders/:id
```

**Scope:**

- both order types
- customer
- receiver snapshot
- package info
- payment inputs
- backend calculations
- generated order number
- generated tracking code
- initial status/history
- audit

**Rules:**

- receiver remains snapshot data
- client totals are not authoritative
- identifiers are unique

**Checks:** both order types, invalid customer/payment, receiver validation, permissions.

**Definition of done:** Management can create and retrieve a valid order.

---

## 6.3 Order List / Search / Filters / Pagination

**API:**

```text
GET /api/v1/orders
```

Support:

- order number
- tracking code
- customer
- receiver
- phone
- status
- driver
- order type
- area
- payment type
- payment method
- date
- assigned/unassigned
- delivered/undelivered
- pagination
- approved sorting

**Rules:** server-side filtering/pagination; validated query params.

**Definition of done:** operational Orders table has a scalable backend source.

---

## 6.4 Order Editing

**API:**

```text
PATCH /api/v1/orders/:id
```

**Scope:**

- status-aware editable fields
- server recalculation when payment inputs change
- audit history

**Rules:**

- generic PATCH cannot change workflow status
- generic PATCH cannot assign/reassign driver
- finalized delivered finance is not silently editable

**Checks:** valid edit, forbidden status edit, delivered edit blocked, recalculation.

---

## 6.5 Assignment / Reassignment / Bulk Assignment

**APIs:**

```text
POST /api/v1/orders/:id/assign
POST /api/v1/orders/:id/reassign
POST /api/v1/orders/bulk-assign
```

**Scope:**

- current driver
- assignment history
- timestamps
- actor
- audit
- status consistency

**Rules:**

- inactive driver rejected
- reassign preserves previous assignment
- bulk behavior is explicitly atomic or explicitly partial, not accidental
- these routes assign the DELIVERY driver. From Phase 11.17 onward they also require
  `parcel_collection_status = RECEIVED_AT_COMPANY` (Phase 11.17.4 wires this in). Parcel
  Collection assignment is a separate module (Phase 11.17.3).

**Checks:** assign, reassign, inactive driver, history, bulk behavior, auth.

---

## 6.6 Ready / Reschedule / Cancel / History

**APIs:**

```text
POST /api/v1/orders/:id/ready
POST /api/v1/orders/:id/reschedule
POST /api/v1/orders/:id/cancel
```

Plus history/timeline retrieval needed by Order Detail.

**Rules:**

- validate every transition
- cancellation retains order
- reschedule retains previous history
- create status history + audit
- from Phase 11.17.4: `cancel` is rejected when
  `parcel_collection_status = COLLECTED_FROM_SENDER`; `cancel` from `ASSIGNED` also closes
  the current parcel collection assignment (`end_reason = ORDER_CANCELLED`) and clears the
  collection-driver pointer in the same transaction (contract §4.3 / §8.3)

**Definition of done:** management pre-delivery/exception actions work safely.

---

## 6.7 Order Engine Integration Tests

Flow:

```text
create customer
-> create order
-> retrieve detail
-> search/list
-> edit
-> ready
-> assign
-> reassign
-> history
```

Include invalid transitions and permissions.

**Phase 6 review gate:** calculations, assignment history, state rules, audit, query performance reviewed.

---

# Phase 7 — Driver Delivery Workflow

Goal: secure driver-scoped operational workflow.

## 7.1 Driver-Scoped Order Access

**APIs:**

```text
GET /api/v1/driver/me/orders
GET /api/v1/driver/me/orders/:id
```

**Rules:**

- driver identity comes from auth
- no arbitrary driver ID
- only delivery-needed data
- no customer wallet/company finance exposure

**Checks:** own order works; other driver blocked.

---

## 7.2 Pickup

**API:**

```text
POST /api/v1/driver/orders/:id/pickup
```

Update:

- status
- timestamp
- history
- audit
- delivery attempt when appropriate

**Checks:** valid, wrong driver, invalid status, repeat request.

---

## 7.3 Start Delivery

**API:**

```text
POST /api/v1/driver/orders/:id/start-delivery
```

Update:

- OUT_FOR_DELIVERY
- timestamp
- history
- attempt
- audit

**Checks:** valid + invalid transition/ownership cases.

---

## 7.4 Failed Delivery

**API:**

```text
POST /api/v1/driver/orders/:id/fail
```

Capture:

- configured reason
- required notes
- attempt outcome
- FAILED_DELIVERY
- history/audit

**Rules:** no wallet credit, normal revenue, or fake expected cash collection.

---

## 7.5 Successful Delivery Operational Logic

**API:**

```text
POST /api/v1/driver/orders/:id/deliver
```

Capture:

- expected amount
- actual amount
- difference reason
- delivered timestamp
- delivery result
- status/history/audit

**Rules:**

- exact vs difference handling
- difference requires reason
- difference marks financial review
- final implementation must call the Phase 8 financial transaction atomically
- do not create fake wallet/revenue writes before Phase 8

---

## 7.6 Driver Workflow Tests

Test:

```text
ASSIGNED
-> PICKED_UP
-> OUT_FOR_DELIVERY
-> DELIVERED
```

and:

```text
OUT_FOR_DELIVERY
-> FAILED_DELIVERY
```

Include wrong driver, duplicate action, invalid transition.

**Phase 7 review gate:** ownership, state machine, attempt history, collection input behavior reviewed.

---

# Phase 8 — Financial Engine

Goal: implement all financial ledgers and atomic money flows. This phase is intentionally highly segmented.

## 8.1 Driver Cash Ledger Foundation

Implement:

- driver cash account reads
- driver cash transaction service
- COLLECTION
- SETTLEMENT
- ADJUSTMENT
- REVERSAL
- balance-before/balance-after
- driver own cash API

```text
GET /api/v1/driver/me/cash
```

**Rules:** driver cash != customer wallet != company revenue.

**Tests:** credit/debit helpers, ledger consistency, authorization.

---

## 8.2 Customer Wallet Ledger Foundation

**APIs:**

```text
GET /api/v1/wallets
GET /api/v1/wallets/:customerId
GET /api/v1/wallets/:customerId/transactions
```

Implement:

- ORDER_CREDIT
- PAYOUT
- ADJUSTMENT
- REVERSAL
- available balance
- pending calculation
- balance history

**Rules:** pending is not withdrawable; every balance change has a transaction.

---

## 8.3 Delivery Only Exact Successful Finance

One DB transaction must:

1. validate order/driver/status
2. record DELIVERED operational result
3. add actual collection to driver cash
4. create driver COLLECTION
5. credit qualifying unpaid order portion to customer wallet
6. create wallet ORDER_CREDIT
7. create company DELIVERY_FEE_REVENUE
8. create audit/history
9. commit

**Tests:**

- full COD
- partial prepayment
- order prepaid / fee due
- all prepaid
- duplicate delivery request
- rollback on failure

---

## 8.4 Company Order Exact Successful Finance

On delivery:

- driver cash += actual collected
- company order revenue += qualifying order amount
- company delivery-fee revenue += qualifying fee
- customer wallet += 0

**Tests:** COD, partial prepayment, fully paid, no wallet credit, rollback/duplicate protection.

---

## 8.5 Customer Payouts

**APIs:**

```text
GET  /api/v1/payouts
POST /api/v1/payouts
```

Atomic steps:

1. permission
2. customer
3. amount > 0
4. available balance
5. payout row
6. wallet PAYOUT debit
7. balance update
8. audit
9. commit

**Rules:** no negative wallet; driver cash unchanged.

---

## 8.6 Driver Settlements

**APIs:**

```text
GET  /api/v1/driver-settlements
POST /api/v1/driver-settlements
```

Atomic steps:

1. permission
2. load driver cash
3. validate amount
4. settlement row
5. driver SETTLEMENT transaction
6. reduce driver cash
7. audit
8. commit

**Rule:** customer wallet remains unchanged.

---

## 8.7 Collection Difference Review

Implement:

- `needsFinancialReview`
- review state/status
- actual collected
- reason
- authorized resolution endpoint/service
- audit of resolution

**Mandatory rule for ambiguous Delivery Only difference:**

- driver cash records actual physical cash
- do not guess customer/company split
- wallet/revenue allocation waits for authorized resolution

---

## 8.8 Adjustments + Reversals

Implement authorized correction patterns for:

- wallet transactions
- driver cash transactions
- company finance
- payout/settlement correction where approved

**Rules:**

- preserve original rows
- create correction/reversal rows
- reference original where possible
- audit every correction

---

## 8.9 Idempotency + Concurrency Protection

Protect:

- delivery finance
- wallet order credit
- driver collection
- company revenue
- payouts
- settlements
- reversals

Use suitable combinations of:

- unique constraints
- transaction checks
- locking/isolation
- idempotency keys when useful

Test repeated/concurrent requests.

---

## 8.10 Financial Integration Tests

Required flows:

### Delivery Only
driver cash correct + customer wallet correct + company fee correct.

### Company Order
driver cash correct + company revenue correct + customer wallet unchanged.

### Payout
wallet decreases + driver cash unchanged.

### Settlement
driver cash decreases + wallet unchanged.

### Difference
actual cash recorded + review required + split not guessed.

**Phase 8 mandatory deep review:** ownership, transactions, duplicate protection, reversals, audit, reconciliation.

---

# Phase 9 — Dashboard / Finance / Reports / Audit APIs

## 9.1 Management Dashboard API

```text
GET /api/v1/dashboard
```

Return approved:

- order metrics
- driver metrics
- finance metrics
- attention queue
- recent activity

Validate against known DB scenarios.

---

## 9.2 Finance Summary + Transactions

```text
GET /api/v1/finance/summary
GET /api/v1/finance/transactions
```

Support date filtering and distinguish:

- delivery fee revenue
- company order revenue
- total collected
- customer liabilities
- payouts
- unsettled driver cash

---

## 9.3 Reports APIs

Implement server-side reports for:

- orders
- drivers
- customers
- finance

Support approved date/group/filter parameters.

---

## 9.4 Audit Search API

```text
GET /api/v1/audit-logs
```

Support actor/action/entity/date filtering.

Only authorized roles may access audit data.

**Phase 9 review gate:** dashboard/report totals reconcile with source ledgers.

---

# Phase 10 — Frontend Foundation

Goal: establish React architecture before full pages.

## 10.1 React + TypeScript + Vite + Tailwind Bootstrap

Create:

- React app
- TypeScript
- Vite
- Tailwind
- base styles
- env setup
- dev/build scripts

**Checks:** dev works; production build works.

---

## 10.2 Router + Layout Architecture

Create route groups/layout shells for:

- auth
- management
- driver
- customer
- public

Follow the page-structure document.

---

## 10.3 Redux Toolkit Store

Create:

- `configureStore`
- typed hooks
- auth/global UI slices
- client-only table/filter state where justified

**Rule:** do not mirror API collections into normal slices.

---

## 10.4 RTK Query Foundation

Create:

- base API
- base URL config
- auth integration
- error handling
- tag types
- invalidation conventions
- API modules

**Definition of done:** frontend can call backend through shared RTK Query layer.

---

## 10.5 Frontend Auth + Permission Guards

Implement:

- login bootstrap
- `/auth/me`
- authenticated routes
- permission-aware routes/actions
- logout
- unauthorized handling

Backend remains authoritative.

---

## 10.6 Shared UI + Design System

Rebuild reusable components from the Claude Design visual reference:

- Sidebar
- Navbar
- Page Header
- Search
- Filters
- Data Table
- badges
- cards
- modal
- form section
- money input
- calculated field
- timeline
- pagination
- loading/empty/error states
- Permission Guard
- Mobile Order Card

**Rule:** rebuild in React/Tailwind; do not use bundled HTML as application architecture.

**Phase 10 review gate:** routing, Redux/RTK Query separation, guards, responsiveness, design consistency.

---

# Phase 11 — Management Portal

Each subsection should normally be one Claude Code session.

## 11.1 Login Page
Connect design to real auth API.

## 11.2 Management Shell
Sidebar, navbar, responsive layout, permission-aware navigation.

## 11.3 Orders List
Table, search, filters, pagination, sorting, badges, bulk selection.

## 11.4 Create Order
Customer/receiver/package/payment fields, previews, create request.

**Rule:** frontend calculation is preview only.

## 11.5 Order Detail
Order/customer/receiver/package/financial/delivery/timeline sections and allowed actions.

## 11.6 Customer Management
List, create/edit, detail, Overview/Orders/Wallet/Payouts/Activity tabs.

## 11.7 Driver Management
List, create/edit, detail, Current Orders/History/Cash/Settlements.

## 11.8 Wallet Management
Wallet list/detail, available, pending, ledger, payout entry.

## 11.9 Payouts
List + payout form/modal + confirmations + refresh.

## 11.10 Driver Settlements
List + settlement workflow + current cash + history.

## 11.11 Management Dashboard
Cards, attention queue, activity, links to filtered pages.

## 11.12 Finance Page
Revenue/liabilities/payouts/unsettled cash/date range/activity.

## 11.13 Reports
Report categories + filters + backend-driven results.

## 11.14 Employees + Permissions
Admin-only employee/account/role/permission management.

## 11.15 Audit Logs
Search/filter/detail view.

## 11.16 Settings
General, Payment Methods, Delivery Settings, Failed Reasons, Areas, Users & Permissions.

**Phase 11 review gate:** responsive management UX + permission + finance page reconciliation.

---

# Phase 11.17 — Parcel Intake & Collection Integration

Goal: integrate the approved **Parcel Intake & Driver Collection before final Delivery**
feature across requirements, database, backend, management UI, and the operational/tracking
contracts, before the Driver Portal is built.

Primary source of truth:
`/docs/delivery_management_system_parcel_intake_collection_feature_change_spec_v1.md`.
Database design: `/docs/parcel-intake-collection-database-contract.md`.

Locked rules (do not reopen): Parcel Intake Method is independent of Order Type; Parcel
Collection is financially neutral in V1 and is a different domain from financial cash
collection; Collection and Delivery assignments are separate permanent histories; the same
Driver may perform both jobs; the Collection Driver confirms `COLLECTED_FROM_SENDER` and
Management confirms `RECEIVED_AT_COMPANY`; a Delivery Driver may not be assigned until
`parcel_collection_status = RECEIVED_AT_COMPANY`.

## 11.17.1 Requirements + Database Contract Update

**Objective:** update the authoritative documentation and design the database contract.
Documentation/design only — no production code, no `schema.prisma` change, no migration,
no live-database change, no seed change.

**Scope:**

- update `requirements.md`, `page_structure.md`, `implementation_plan.md`, `CLAUDE.md`
- correct the meaning of `OrderStatus.RECEIVED`
- create `docs/parcel-intake-collection-database-contract.md` (enums, Order fields,
  collection snapshot, `parcel_collection_assignments`, `parcel_collection_attempts`,
  `failed_collection_reasons`, receipt fields, indexes, constraints, FK/delete behavior,
  backfill + migration sequence)
- the **current collection assignment / `current_parcel_collection_driver_id` lifecycle**:
  transactional create/assign/reassign/fail/reschedule/collected/received transitions;
  `end_reason` enum (`REASSIGNED | FAILED | RECEIVED_AT_COMPANY | ORDER_CANCELLED`);
  `COLLECTED_FROM_SENDER` keeps the assignment open (driver keeps custody); no reassignment
  after `COLLECTED_FROM_SENDER`; `is_current = (ended_at IS NULL)` CHECK; one-current-per-order
  partial unique index (contract §4.1 / §8)
- **order-cancellation edge case** (contract §4.3 / §8.3): cancel rejected from
  `COLLECTED_FROM_SENDER`; cancel from `ASSIGNED` closes the assignment
  (`end_reason = ORDER_CANCELLED`) + clears the pointer in the same transaction; a cancelled
  order never retains a current assignment or pointer
- permission-catalog review (no seed change)
- cross-document consistency audit

**Definition of done:** all authoritative documents are internally consistent with the
feature and the database contract is complete and reviewed.

## 11.17.2 Database / Prisma + Migration

**Objective:** apply the approved database contract.

**Scope:** add enums (`ParcelIntakeMethod`, `ParcelCollectionStatus`,
`ParcelCollectionAttemptOutcome`, `ParcelCollectionAssignmentEndReason`), nullable Order
columns, three new tables, indexes, constraints (incl. the
`parcel_collection_assignments_current_state_chk` CHECK `is_current = (ended_at IS NULL)`
and the one-current-per-order partial unique index); keep `schema.prisma` synchronized with
the manually authoritative PostgreSQL schema; safe migration sequence — add nullable
columns/enums/tables → backfill existing Orders (`ALREADY_AT_COMPANY` /
`RECEIVED_AT_COMPANY`, receipt time = `created_at`, confirmer = `created_by_id`) → verify →
apply NOT NULL / defaults → add indexes and the current-assignment uniqueness constraint.

**Rules:** no destructive migration; no reinterpretation of existing delivery assignments;
existing ledgers/history unchanged.

## 11.17.3 Parcel Collection Backend

**Objective:** the Parcel Collection module and reference data.

**Scope:** `failed_collection_reasons` reference CRUD (settings.read / settings.manage,
deactivate-not-delete, audited); assign / reassign Collection Driver; Driver
`COLLECTED_FROM_SENDER`; Driver report Collection failure (reason + required notes);
reschedule / retry; Management confirm `RECEIVED_AT_COMPANY`; read Collection
assignment/attempt history for Order Detail; a narrow Driver-safe active-reasons endpoint.

**Rules:** Parcel Collection actions create zero financial postings; Driver cannot confirm
company receipt; `Parcel`-prefixed naming. Each assign/reassign/collected/failed/reschedule/
receive action is a single transaction that updates `parcel_collection_status`, the
`parcel_collection_assignments` current row, and `orders.current_parcel_collection_driver_id`
together (contract §4.1). Reassignment is rejected once status is `COLLECTED_FROM_SENDER`.

**As built (Phase 11.17.3):** `src/modules/parcel-collection/` + reference-data
`failed-collection-reason.*`. Routes:
`GET /orders/:id/parcel-collection` (orders.read),
`POST /orders/:id/parcel-collection/{assign,reassign}` (orders.assign),
`POST /orders/:id/parcel-collection/{reschedule,receive-at-company}` (orders.change_status),
`POST /driver/orders/:id/parcel-collection/{collected,failed}` (DRIVER portal + driver.orders.update_own),
`GET /driver/failed-collection-reasons` (DRIVER portal + driver.orders.read_own),
`GET|POST|PATCH /settings/failed-collection-reasons` (settings.read / settings.manage).
All three `/driver/*` parcel-collection routes carry the new
`requirePortal("driver")` middleware (src/middleware/require-portal.ts) — role-code
based, so an ADMIN (who holds `driver.*` in the full catalog) still gets 403 before any
driver-profile lookup. Pre-existing Phase 7/8 `/driver/*` routes are NOT retrofitted here
(they rely on `getDriverProfileForUser` throwing 403) — flagged as a small safe follow-up.
`parcel_collection_attempts.started_at` is nullable with no default (V1 has no "start
collection" action); both COLLECTED and FAILED attempts insert `started_at = NULL`.
No new permission codes. `assignParcelCollectionDriverTx(tx, …)` is the transaction-aware
core reserved for 11.17.4's create-and-assign path. Audit: Management actions
(`PARCEL_COLLECTION_DRIVER_ASSIGNED` / `…_REASSIGNED` / `PARCEL_COLLECTION_RESCHEDULED` /
`PARCEL_RECEIPT_CONFIRMED`) + Failed-Collection-Reason config
(`FAILED_COLLECTION_REASON_*`) write audit rows; Driver `collected` / `failed` outcomes are
operational-only (`parcel_collection_attempts`), matching the Driver `/fail` convention.
Deferred to 11.17.4: Create-Order changes, delivery-assignment gate, cancel guard, temp
DB-default removal, `seedTestOrder` receipt-field population.

## 11.17.4 Order Engine Integration

**Objective:** wire Parcel Intake into order creation and delivery assignment.

**Scope:** `POST /orders` accepts `parcelIntakeMethod` and optional collection snapshot +
optional Collection Driver; the delivery-assignment predicate (assign / reassign /
bulk-assign / create-and-assign / direct API) now requires
`parcel_collection_status = RECEIVED_AT_COMPANY`; bulk delivery assignment stays atomic and
rejects the whole batch on any ineligible order.

**Clean up the Phase 11.17.2 staging shims (required):**
- `POST /orders` must set `parcel_intake_method` explicitly from the request (default in the
  Zod schema, not the DB); for `ALREADY_AT_COMPANY` it sets `parcel_collection_status =
  RECEIVED_AT_COMPANY` **and** `received_at_company_at` / `received_at_company_by_id`
  (creator) in the same create; for `DRIVER_COLLECTION` it sets `AWAITING_ASSIGNMENT` (or
  `ASSIGNED` + opens a `parcel_collection_assignments` row if a collection driver is chosen).
- Then drop the temporary DB defaults on `orders.parcel_intake_method` /
  `orders.parcel_collection_status` (new `server/migrations/` SQL) and remove the matching
  `@default(...)` markers in `schema.prisma`.
- Add `parcel_collection_assignments` / `parcel_collection_attempts` deletes to
  `tests/helpers/fixtures.ts` `cleanupTestOrder` once real rows start being created.

**Order cancellation guard (hard invariant — contract §4.3 / §8.3):** every
order-cancellation path must **reject** cancellation when
`parcel_collection_status = COLLECTED_FROM_SENDER` (driver custody unresolved). When
cancellation is allowed from `ASSIGNED`, the cancel handler ends the current
`parcel_collection_assignments` row with `end_reason = ORDER_CANCELLED` and sets
`current_parcel_collection_driver_id = NULL` **in the same transaction** as the order status
change. A cancelled order must never retain a current collection assignment or a non-null
collection-driver pointer. No fabricated attempt row.

**As built (Phase 11.17.4):**
- `POST /orders` (`order-create.schema.ts` + `order.service.ts`): `parcelIntakeMethod`
  (omitted ⇒ `ALREADY_AT_COMPANY` **at the service layer**, never the DB), optional
  `parcelCollectionDriverId`, optional `deliveryDriverId` ("Create & Assign", ALREADY only),
  and `parcelCollection{ContactName,Phone,AltPhone,AreaId,Address,Notes}` snapshot overrides
  (DRIVER_COLLECTION only, else 400). The snapshot is derived from the Customer (override
  wins) and required fields (contact, phone, address, area) are validated → 400. Everything
  is one `$transaction`; `assignParcelCollectionDriverTx` / a local `assignDeliveryDriverTx`
  are reused; a driver failure rolls the whole create back. Assigning any driver at create
  additionally requires `orders.assign` (controller check).
- Delivery gate: `isParcelReadyForDelivery(status)` +
  `parcel_collection_status = RECEIVED_AT_COMPANY` inside the conditional claim of
  `assignOrder` / `reassignOrder` (fail-closed 500 on legacy corruption) / `bulkAssignOrders`
  (atomic — whole batch 409). `PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE`.
- Cancellation: `cancelOrder` rejects 409 from `COLLECTED_FROM_SENDER`; from `ASSIGNED` it
  closes the collection assignment (`end_reason='ORDER_CANCELLED'`) + clears the pointer in
  the same transaction; `parcel_collection_status` stays `ASSIGNED` (no `CANCELLED` value);
  no attempt fabricated; `parcel_collection_status` is in the order-claim WHERE for
  cancel-vs-collect/fail race safety.
- Migration `__1174__` dropped the two temporary `orders` DB defaults; `@default(...)`
  removed from `schema.prisma`; columns stay NOT NULL.
- `OrderDetail` DTO gains `parcelIntakeMethod` + `parcelCollectionStatus` (scalars only —
  full domain still via `GET /orders/:id/parcel-collection`).
- `loadEligibleDriverForAssignment` extracted to `modules/drivers/driver-eligibility.ts`
  (breaks the order.service ↔ parcel-collection.service import cycle).
- `tests/helpers/fixtures.ts`: `seedTestOrder` / `seedCustomerRecord` now set the parcel
  fields explicitly (no DB default); one pre-existing over-strict Phase 6 concurrency test
  (`orders-workflow` #57) was corrected to accept the valid ready→assign `[200,200]`
  interleaving.
- Deferred to later sub-phases: Management/Driver frontend (11.17.5), Dashboard/Reports/
  Tracking (11.17.6), and retro-fitting `requirePortal` onto the pre-existing Phase 7/8
  `/driver/*` routes.

## 11.17.5 Management UI Integration

**Objective:** surface Parcel Intake in the Management Portal.

**Scope:** Create Order Parcel Intake section + conditional collection fields + explicit
action labels; Orders List intake/collection columns and filters; Order Detail Parcel
Intake / Collection section (snapshot, current Collection Driver, assignment history,
attempts, `COLLECTED_FROM_SENDER` / `RECEIVED_AT_COMPANY` timestamps, confirmer) with a
combined chronological timeline; Driver Detail separate Collection metrics/history;
Settings Failed Collection Reasons surface.

**As built (Phase 11.17.5):**
- Frontend domain types + central presentation maps: `client/src/services/domain.types.ts`
  (parcel enums, `ParcelCollectionDetail` + sub-DTOs, `parcelIntakeMethod` /
  `parcelCollectionStatus` on `OrderSummary` and `OrderDetail`, `FailedCollectionReasonSummary`);
  `client/src/components/orders/parcelCollection.ts` (labels/tones — §61/§62) +
  `ParcelCollectionBadge.tsx`.
- RTK Query: new single-API module `client/src/services/parcelCollectionApi.ts`
  (`getParcelCollection` / `assign` / `reassign` / `reschedule` / `receiveAtCompany`);
  new tag `ParcelCollection`; `settingsApi.ts` gains the four Failed Collection Reason
  endpoints (`Settings/FAILED_COLLECTION_REASONS` + `LIST`). Parcel mutations invalidate
  `ParcelCollection` + `Order` (id & LIST) + `Driver LIST` — financially neutral, so NO
  Wallet / DriverCash / Finance / Dashboard / Report invalidation.
- Create Order: dedicated **Parcel Intake** section — required "How will the parcel reach
  the company?" (`ALWAYS` sends `parcelIntakeMethod`, default `ALREADY_AT_COMPANY`);
  DRIVER_COLLECTION reveals the collection snapshot (prefilled from the customer, editable
  per order, re-prefilled on customer change) + optional Collection Driver
  (`orders.assign`-gated); the delivery-driver selector is hidden for DRIVER_COLLECTION with
  an explanation. The create is **one atomic request** (collection driver / delivery driver
  in the body — the two-step assign after create is removed); button label is
  "Create order" / "Create & assign collection" / "Create & assign delivery".
- Order Detail: new **Parcel Intake & Collection** section
  (`ParcelCollectionSection.tsx`) — intake + status badges, ALREADY_AT_COMPANY concise note,
  DRIVER_COLLECTION snapshot + current Collection Driver + Assign / Reassign
  (no reason field) / Confirm Received at Company / Reschedule (no date), assignment history
  (humanized end reasons incl. `ORDER_CANCELLED`), attempt history (`startedAt` null →
  omitted, never "Invalid Date"). Delivery "Assign driver" is shown disabled with an
  explanation until `RECEIVED_AT_COMPANY`; Cancel is shown disabled while
  `COLLECTED_FROM_SENDER`. `getOrderDetailActions` gained `assignBlockedByParcel` /
  `cancelBlockedByCustody`.
- Orders List: narrow **backend DTO extension** — `OrderSummary` now carries
  `parcelIntakeMethod` + `parcelCollectionStatus` (scalar passthrough of existing NOT NULL
  columns, no join, no business logic; `orderSummarySelect` + `toOrderSummary` +
  `order.types.ts` + the DTO-shape test updated). New "Parcel intake" column + mobile-card
  badge. **DEFERRED CONTRACT (11.17.6):** collection-driver column, parcel-intake list
  FILTERS, and "Unassigned" quick-tab semantics — the list query supports none of these and
  no N+1 was introduced.
- Settings: new **Failed Collection Reasons** tab (`FailedCollectionReasonsTab.tsx`) — a
  separate catalog, `settings.read` view / `settings.manage` create-edit-deactivate-reactivate
  (no delete), Requires Notes shown.
- **DEFERRED CONTRACT (11.17.6):** Driver Detail Collection history — no backend Driver
  collection-history endpoint exists; not fabricated from Orders. Driver Detail is
  untouched, so existing Delivery metrics keep their exact meaning.
- **Deferred to 11.17.6:** a single unified server timeline including Collection events —
  Order Detail shows a dedicated Collection assignment/attempt history section instead
  (per §41).
- No permission-catalog change (35). No schema/migration. Frontend has no test framework
  configured (no vitest / test script) — verification is `tsc -b --noEmit` + `vite build`;
  backend `typecheck` + `build` + `test` = **1599 / 1599** (DTO-shape test updated).

## 11.17.6 Dashboard + Reports + Audit + Tracking Contracts

**Objective:** correct cross-cutting read models.

**Scope:** Dashboard — new operational concepts (Awaiting Collection Assignment, Collection
In Progress, Collection Attention/Failed, Collected — Awaiting Company Receipt, Ready for
Delivery Assignment) and a corrected "Ready for Delivery Assignment" definition (received at
company AND no current Delivery Driver AND otherwise eligible); Reports — existing Delivery
metrics keep their meaning, separate Collection metrics added only as required for V1;
Audit vs operational-history separation; Customer/Public tracking — simplified Parcel Intake
milestones, no Collection-Driver private data, no sender private address, no receipt-confirming
employee.

## 11.17.7 Full Regression + Visual Acceptance

**Objective:** confirm no regression and feature completeness.

**Scope:** full backend regression (baseline is currently 1531/1531 and must not drop),
new feature tests per the Feature Specification §31, financial non-regression
(`parcel collection != cash collection`), migration/backfill verification, authorization /
privacy tests, responsive/visual acceptance of the new Management surfaces.

**Phase 11.17 review gate:** feature integrated end-to-end; financial invariants unchanged;
existing delivery history and ledgers preserved; documentation consistent. Phase 12 stays
blocked until this gate passes and is approved.

---

# Phase 12 — Driver Portal

Phase 12 must be built as a **job-oriented** portal because of Phase 11.17: a Driver may
hold a `COLLECTION` job (Sender → Company) and/or a `DELIVERY` job (Company → Receiver) for
the same Order at different times. Own-job authorization applies to both. The Driver
confirms `Collected From Sender` and reports `Collection Failed`, but never confirms company
receipt. Failed Collection is separate from Failed Delivery.

## 12.1 Driver Layout + Assigned Jobs
Mobile-first navigation/cards for both job types; call/location; collect amount on delivery
jobs; collection contact/address on collection jobs.

## 12.2 Driver Order Detail + Pickup/Start (Delivery) / Collection actions
Receiver/address/instructions + pickup/start actions for delivery jobs; sender
contact/address + `Collected From Sender` / `Collection Failed` for collection jobs.

## 12.3 Delivered + Failed + Collection Outcome Actions
Actual collection, expected amount, difference reason, failed delivery reason/notes;
failed collection reason/notes (narrow Driver-safe reason list).

## 12.4 Completed + Failed History
Driver-scoped history, Delivery and Collection kept semantically separate.

## 12.5 Driver Cash Page
Current cash + allowed ledger/settlement history. Parcel Collection never appears here.

## 12.6 Mobile Responsiveness Review
Touch targets, common screen sizes, workflow clarity.

**Phase 12 review gate:** no cross-driver access; actions match both the Delivery state
machine and the Parcel Collection state machine.

---

# Phase 13 — Customer Portal

## 13.1 Customer Shell + Dashboard
Wallet, pending, active orders, delivered summary.

## 13.2 Customer Orders
Own active/history list.

## 13.3 Customer Order Detail + Tracking
Safe order information + simplified status/timeline.

## 13.4 Wallet
Available/pending + explanation.

## 13.5 Transactions + Payout History
Read-only ledger/payout history.

## 13.6 Profile
Approved customer profile fields.

**Phase 13 review gate:** strict ownership and customer-safe terminology.

---

# Phase 14 — Public Tracking

## 14.1 Public Tracking Backend API

```text
GET /api/v1/tracking/:trackingCode
```

Return only safe public DTO.

Do not expose:

- wallet
- private customer data
- driver finance
- internal notes
- audit
- management-only history

Add abuse protection/rate limiting where appropriate.

## 14.2 Public Tracking UI
Tracking input, loading, not found, simplified status/timeline, responsive layout.

## 14.3 Public Privacy Tests
Verify private fields are absent and invalid tracking is safe.

**Phase 14 review gate:** explicit information-leakage review.

---

# Phase 15 — Integration / Testing / Regression

Earlier phases already include tests. This phase validates the complete system.

## 15.1 Backend Unit Test Completion
Close gaps in calculations, state machine, financial allocation, mapping, validation.

## 15.2 Backend Integration Test Completion
Cross-module API/database workflows.

## 15.3 Financial Regression Suite
Delivery Only, Company Order, prepayment, payouts, settlements, differences, reversals, duplicates, concurrency.

## 15.4 Authorization / Security Regression
Role matrix, customer IDOR, driver IDOR, public privacy, inactive users, auth edge cases.

## 15.5 Frontend Integration Tests
Auth bootstrap, guards, RTK Query invalidation, forms, tables, loading/error behavior.

## 15.6 End-to-End Critical Flows

### Flow A — Delivery Only

```text
customer
-> order
-> assign
-> pickup
-> out for delivery
-> deliver
-> driver cash
-> customer wallet
-> company fee
-> customer portal update
```

### Flow B — Company Order

```text
create
-> assign
-> deliver
-> driver cash
-> company revenue
-> wallet unchanged
```

### Flow C — Payout
wallet decreases, payout recorded, driver cash unchanged.

### Flow D — Settlement
driver cash decreases, wallet unchanged.

### Flow E — Failed / Rescheduled
history correct, no incorrect success finance.

## 15.7 Responsive / Browser Review
Management, Driver, Customer, Public.

## 15.8 Release Candidate Regression
Backend/frontend build, typecheck, tests, E2E, permission and financial reconciliation.

**Phase 15 review gate:** no production release until critical finance/security/workflow tests pass.

---

# Phase 16 — Production Hardening + Deployment

## 16.1 Production Environment
Production env vars, secrets, DB, URLs, builds.

## 16.2 Security Hardening
HTTPS, auth settings, CORS, rate limits, headers, request limits, error exposure, secret/log review.

## 16.3 Docker / Reproducible Build
Docker only if selected by deployment approach.

## 16.4 CI/CD
Install, typecheck, tests, builds, deploy. No automatic destructive DB migration.

## 16.5 Database Backup + Recovery
Backup schedule, retention, restore procedure, pre-deploy backup.

## 16.6 Logging + Monitoring
Structured logs, errors, uptime/health monitoring. Financial audit stays in DB ledgers/audit logs.

## 16.7 Production Deploy + Smoke Test
Health, login, permissions, order, driver workflow, controlled finance flow, customer portal, public tracking, monitoring/backups.

**Phase 16 definition of done:** V1 is deployed and production checks pass.

---

# 56. Claude Code Session Rules

## 56.1 Default unit

Use:

```text
Implement Phase 6.1 only.
```

Avoid giving a large phase such as:

```text
Implement Phase 6.
```

in one session.

## 56.2 Before coding

Claude Code must:

1. read `CLAUDE.md`
2. read relevant `/docs`
3. inspect existing code
4. identify direct dependencies
5. report a genuine blocking conflict if one exists

Do not re-plan the whole project each session.

## 56.3 After coding

Claude Code must report:

- files created
- files modified
- APIs
- DB changes
- tests/checks
- known issues
- explicitly deferred scope
- recommended next sub-phase

## 56.4 Review gate

After each sub-phase:

1. review summary
2. inspect important code
3. run/confirm checks
4. fix issues
5. continue only when approved

## 56.5 Scope control

Claude Code must not:

- pre-build later sub-phases
- silently change DB schema
- invent financial rules
- replace the required stack
- move server data into normal Redux slices
- redesign unrelated pages

Necessary supporting code is allowed only when directly required by the active sub-phase.

---

# 57. Implementation Dependency Order

```text
Requirements
  ↓
Page Architecture
  ↓
Database
  ↓
Backend Foundation
  ↓
Authentication / RBAC
  ↓
Customers + Drivers + Settings
  ↓
Order Engine
  ↓
Driver Workflow
  ↓
Financial Engine
  ↓
Dashboard / Reports
  ↓
Frontend Foundation
  ↓
Management Portal
  ↓
Driver Portal
  ↓
Customer Portal
  ↓
Public Tracking
  ↓
System-wide Integration / Regression
  ↓
Production
```

Within a phase, follow sub-phase numbering unless a deliberate dependency exception is documented.

Important:

- no financial UI before finance backend
- no driver UI before secure driver APIs
- no wallet/payout UI before ledger invariants are tested
- authoritative rules stay backend-side
- customer/public data waits for stable privacy/ownership APIs

---

# 58. V1 Scope

Required V1 features:

1. Authentication and roles
2. Customer management
3. Driver management
4. Orders
5. Company Order / Delivery Only
6. Payment calculations
7. Driver assignment
8. Status workflow
9. Driver Portal
10. Successful / failed delivery
11. Customer wallets
12. Wallet transaction ledger
13. Customer payouts
14. Driver cash
15. Driver settlements
16. Customer Portal
17. Public tracking
18. Management dashboard
19. Search and filtering
20. Audit history

---

# 59. Features Deferred Beyond V1

Do not block V1 on:

- automatic delivery fee by area
- live maps
- route optimization
- GPS
- SMS
- WhatsApp
- email automation
- barcode/QR
- shipping labels
- invoices
- customer self-service order creation
- payout request workflow
- advanced analytics
- Excel/PDF export
- native app
- proof-of-delivery photos
- signatures
- OTP
- multi-branch
- multi-currency

The architecture may leave room for them without implementing them prematurely.

---

# 60. Definition of Done for V1

V1 is complete when:

- Admin/Dispatcher/Finance authenticate with correct permissions
- customers and drivers can be managed
- both order types can be created
- server calculations are correct
- assignment/reassignment history works
- driver sees only own assignments
- driver workflow works
- failed reasons are recorded
- Delivery Only wallet credit is correct
- Company Order does not credit wallet
- driver cash reflects actual collection
- payout changes wallet only
- settlement changes driver cash only
- company finance is separate
- collection differences require review
- Customer sees only own data
- Public Tracking exposes only safe data
- dashboard/reports are accurate
- critical actions are audited
- financial operations are atomic
- duplicate money operations are protected
- critical auth/finance/E2E tests pass
- responsive behavior is acceptable
- production backup/security/monitoring checks are complete

---

# 61. Current Project Status

```text
Requirements & business rules       COMPLETE
Frontend/page structure             COMPLETE
UI design reference                 AVAILABLE
Database design                     COMPLETE
Manual PostgreSQL SQL               COMPLETE
Implementation plan v1.1            COMPLETE
Execution model                     PHASE + SUB-PHASE

Phases 3–10                         COMPLETE
Phase 11 (Management Portal)        COMPLETE (11.1–11.16), final approval held
Phase 11.17.1 (Reqs + DB contract) COMPLETE (documentation/design), approved
Phase 11.17.2 (Database/Prisma+Migration) COMPLETE — migration applied to dev DB,
      schema.prisma synced, backfill verified
Phase 11.17.3 (Parcel Collection Backend) COMPLETE — parcel-collection module,
      failed_collection_reasons Settings API + Driver-safe list; requirePortal
      middleware; migration __1173__ (attempt started_at nullable).
Phase 11.17.4 (Order Engine Integration) COMPLETE — Create Order is parcel-aware
      (intake method + customer-derived collection snapshot + optional collection
      driver, atomic; optional final delivery driver for ALREADY_AT_COMPANY);
      hard delivery-assignment gate on assign / reassign / bulk-assign / create;
      Order cancellation integrated (reject from COLLECTED_FROM_SENDER; close the
      collection assignment ORDER_CANCELLED from ASSIGNED); migration __1174__
      dropped the temporary orders parcel-intake DB defaults. No new permissions.
      1593 / 1593 backend tests pass.
Backend regression baseline        1593 / 1593 (1568 + 25 Phase 11.17.4 tests)

NEXT: Phase 11.17.5 — Management UI Integration (after 11.17.4 review)
      Phase 12 (Driver Portal) is BLOCKED until Phase 11.17 is complete and approved.
```

**Phase 11.17.2 migration note.** This project does not use `prisma migrate` — the DB was
bootstrapped from hand-authored SQL and `schema.prisma` is kept in sync manually. Phase
11.17.2 therefore introduced `server/migrations/` (README + a reviewable SQL migration +
`apply.mjs` / `verify.mjs`) rather than switching the whole project onto Prisma Migrate. The
two `orders` enum columns carry a **temporary DB default** (`ALREADY_AT_COMPANY` /
`RECEIVED_AT_COMPANY`) so the not-yet-updated Create-Order path keeps working; **Phase
11.17.4 must set them explicitly from the request and drop both defaults**, and Phase
11.17.4 owns `received_at_company_at` / `received_at_company_by_id` for new orders.
