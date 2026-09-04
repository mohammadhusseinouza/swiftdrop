# CLAUDE.md

## Project: Delivery Management System

This file defines the mandatory implementation rules for Claude Code when working on this repository.

Claude Code must treat the project documentation in `/docs` as the source of truth and must not silently invent, replace, or simplify business rules.

---

# 1. Project Goal

Build a web-based delivery management system for internal company operations with four user experiences:

1. Management Portal
2. Driver Portal
3. Customer Portal
4. Public Tracking Page

The system manages:

- customers
- employees
- drivers
- orders
- driver assignment and reassignment
- delivery status tracking
- customer wallets
- customer payouts
- driver cash
- driver settlements
- company financial transactions
- reports
- audit logs
- system settings

The system contains important financial workflows. Correctness, traceability, authorization, and transactional consistency are more important than implementation shortcuts.

---

# 2. Source of Truth

Before implementing or modifying a feature, read the relevant project documents.

Expected documentation files:

```text
/docs/requirements.md
/docs/page-structure.md
/docs/implementation-plan.md
/docs/database.sql
```

The project may also contain:

```text
/docs/ui-reference/SwiftDrop.html
```

or another equivalent Claude Design HTML file.

Rules:

- `requirements.md` defines business behavior.
- `page-structure.md` defines frontend pages, navigation, layouts, and responsibilities.
- `implementation-plan.md` defines implementation order and architecture.
- `database.sql` defines the approved PostgreSQL structure.
- The Claude Design HTML is a visual reference only, not production architecture.
- Do not change approved business behavior because the UI reference implements something differently.
- If documentation conflicts, stop and clearly identify the conflict before changing behavior.
- Do not invent missing financial rules.

---

# 3. Required Technology Stack

## Frontend

Use:

- React
- TypeScript
- Vite
- Tailwind CSS
- React Router
- Redux Toolkit
- RTK Query
- React Hook Form
- Zod

## Backend

Use:

- Node.js
- Express.js
- TypeScript
- PostgreSQL
- Prisma ORM
- Zod
- bcrypt
- secure JWT/session-based authentication as implemented by the project

Do not introduce an alternative primary framework, ORM, state manager, or database without explicit approval.

---

# 4. Repository Structure

Preferred top-level structure:

```text
delivery-management-system/
├── client/
├── server/
├── docs/
├── CLAUDE.md
└── README.md
```

Do not mix frontend and backend application code.

---

# 5. Backend Structure

Preferred backend structure:

```text
server/
├── prisma/
│   └── schema.prisma
│
├── src/
│   ├── app.ts
│   ├── server.ts
│   ├── config/
│   ├── db/
│   ├── middleware/
│   ├── modules/
│   │   ├── auth/
│   │   ├── users/
│   │   ├── customers/
│   │   ├── drivers/
│   │   ├── orders/
│   │   ├── delivery/
│   │   ├── wallets/
│   │   ├── payouts/
│   │   ├── settlements/
│   │   ├── finance/
│   │   ├── dashboard/
│   │   ├── reports/
│   │   ├── audit/
│   │   ├── settings/
│   │   └── tracking/
│   ├── routes/
│   └── shared/
├── package.json
├── tsconfig.json
└── .env
```

A normal backend module should generally contain:

```text
module/
├── module.routes.ts
├── module.controller.ts
├── module.service.ts
├── module.schema.ts
├── module.types.ts
└── module.utils.ts
```

Controllers should remain thin.
Use service functions for business logic.
Do not create unnecessary abstraction layers.

---

# 6. API Conventions

Use the API prefix:

```text
/api/v1
```

Use REST-style resources where appropriate.

Examples:

```text
GET    /api/v1/customers
POST   /api/v1/customers
GET    /api/v1/customers/:id
PATCH  /api/v1/customers/:id

GET    /api/v1/orders
POST   /api/v1/orders
GET    /api/v1/orders/:id
PATCH  /api/v1/orders/:id
```

Use explicit action endpoints for workflow transitions instead of allowing arbitrary status updates.

Examples:

```text
POST /api/v1/orders/:id/ready
POST /api/v1/orders/:id/assign
POST /api/v1/orders/:id/reassign
POST /api/v1/orders/:id/reschedule
POST /api/v1/orders/:id/cancel

POST /api/v1/driver/orders/:id/pickup
POST /api/v1/driver/orders/:id/start-delivery
POST /api/v1/driver/orders/:id/deliver
POST /api/v1/driver/orders/:id/fail
```

Do not implement generic client-controlled order status mutation.

---

# 7. Standard API Response Shape

Successful single-resource response:

```json
{
  "success": true,
  "data": {}
}
```

Successful list response:

```json
{
  "success": true,
  "data": [],
  "meta": {
    "page": 1,
    "limit": 20,
    "total": 0,
    "totalPages": 0
  }
}
```

Error response:

```json
{
  "success": false,
  "error": {
    "code": "ERROR_CODE",
    "message": "Readable error message"
  }
}
```

Validation errors may include structured field details.

Do not leak:

- stack traces
- SQL errors
- Prisma internals
- secrets
- password hashes
- authentication tokens
- internal-only financial details to unauthorized users

---

# 8. Roles

Initial roles:

```text
ADMIN
DISPATCHER
FINANCE
DRIVER
CUSTOMER
```

## Admin
Full system access.

## Dispatcher
Operational access such as customers, drivers, orders, assignment, delivery workflow, and operational dashboard. Financial permissions may be restricted.

## Finance
Financial access such as customer wallets, payouts, driver balances, settlements, finance reports, and authorized financial adjustments.

## Driver
Can access only their own assigned work and permitted delivery information.

## Customer
Can access only their own customer portal records.

---

# 9. Authorization Rules

Frontend permission guards are for user experience only.
The backend is the authoritative security boundary.

Every sensitive endpoint must enforce authentication and authorization server-side.

Prevent IDOR.

Do not trust a customer-provided customer ID for customer portal access.

Prefer:

```text
GET /api/v1/customer/me/orders
GET /api/v1/customer/me/wallet
GET /api/v1/customer/me/transactions
GET /api/v1/customer/me/payouts
```

Likewise drivers should use authenticated identity for driver portal queries.

---

# 10. Customer Model

One customer can participate in both order types:

1. Company Order
2. Delivery Only

Do not create separate customer types for these use cases.

Customer portal authentication may be optional for a customer record.
A management-created customer may exist without a linked login account.

---

# 11. Receiver Model

Receiver information belongs to the order as snapshot data.

Do not normalize the receiver into a separate required customer entity for V1.

Order receiver fields may include:

- receiver name
- primary phone
- alternative phone
- area
- full address
- building/floor
- map link
- delivery instructions

Historical order receiver data must not silently change when customer/default address data changes.

---

# 12. Order Types

Supported V1 order types:

```text
COMPANY_ORDER
DELIVERY_ONLY
```

## COMPANY_ORDER

On successful delivery:

- collected unpaid order value belongs to the company
- collected delivery fee belongs to the company
- no customer wallet credit is created

## DELIVERY_ONLY

On successful delivery:

- unpaid order amount collected through the delivery belongs to the customer
- delivery fee belongs to the company
- the qualifying customer amount is credited to the customer wallet

Do not mix these accounting rules.

---

# 13. Order Payment Fields

The backend must distinguish order-value prepayment from delivery-fee prepayment.

Use concepts equivalent to:

```text
orderAmount
deliveryFee

prepaidOrderAmount
prepaidDeliveryFee

remainingOrderAmount
remainingDeliveryFee

amountToCollect
```

The server calculates:

```text
remainingOrderAmount =
  orderAmount - prepaidOrderAmount

remainingDeliveryFee =
  deliveryFee - prepaidDeliveryFee

amountToCollect =
  remainingOrderAmount + remainingDeliveryFee
```

The frontend may display calculations, but client-calculated monetary values are not authoritative.
The backend must recalculate and validate all financial totals.

---

# 14. Payment Types

Supported business payment types:

```text
CASH_ON_DELIVERY
ALREADY_PAID
PARTIALLY_PAID
```

Payment type is not the same as payment method.

Payment methods can include configurable values such as cash, card, bank transfer, Whish, and other.

Do not hard-code all payment methods into frontend business logic if they are stored in settings/reference data.

---

# 15. Money Rules

Never use JavaScript floating-point numbers for authoritative monetary database values.

Use PostgreSQL `NUMERIC` / Prisma `Decimal`.

Be explicit when converting or serializing money.
Do not silently round financial values in business logic.
Do not introduce multi-currency behavior unless explicitly requested.

---

# 16. Order Statuses

Supported internal statuses:

```text
RECEIVED
READY_FOR_PICKUP
ASSIGNED
PICKED_UP
OUT_FOR_DELIVERY
DELIVERED
FAILED_DELIVERY
RESCHEDULED
RETURNED_TO_COMPANY
RETURNED_TO_CUSTOMER
CANCELLED
```

Status transitions must be validated by backend business logic.
Do not allow arbitrary transitions.
Every significant status transition must create history.

---

# 17. Order Assignment

Orders may be:

- created unassigned
- created and assigned
- assigned later
- reassigned
- bulk assigned where allowed

Keep:

- current driver on the order for efficient querying
- permanent assignment history in `order_assignments`

Reassignment must not destroy previous assignment records.
Inactive drivers should not normally receive new assignments.

---

# 18. Delivery Attempts

Delivery failures and retries must remain traceable.

Example:

```text
Attempt 1 -> Receiver unavailable
Attempt 2 -> Rescheduled
Attempt 3 -> Delivered
```

Do not overwrite old failed-delivery information.

---

# 19. Failed Delivery Rules

Failed delivery does not automatically:

- credit the customer wallet
- create normal company delivery revenue
- mark the expected amount as collected

Store a configured failed-delivery reason and notes where required.

Initial reasons include:

- receiver did not answer
- receiver unavailable
- receiver refused
- incorrect address
- incomplete address
- customer requested rescheduling
- unable to contact receiver
- other

If "other" requires notes according to settings, validate it server-side.

---

# 20. Delivered Action

The driver's delivered action must include:

- expected collection
- actual collection
- optional/required reason when they differ

Expected amount may be prefilled in the UI.

If actual amount differs from expected:

- save actual amount
- save difference reason
- mark the order for financial review

Do not silently treat expected amount as actual amount.

---

# 21. Financial Difference Rule

For a Delivery Only order, if actual collected differs from expected, do not guess how the shortage/excess should be divided between customer money and company delivery revenue.

Required behavior:

1. Record the actual amount in driver cash.
2. Set a financial-review flag/status.
3. Preserve the difference reason.
4. Do not automatically invent the final customer/company split.
5. Require an authorized resolution path.

Do not change this rule unless the project documentation is explicitly updated.

---

# 22. Customer Wallet

A customer wallet represents money the company owes to the customer.

Wallet money primarily comes from successfully delivered Delivery Only orders.

The wallet must use a transaction ledger.

Use:

```text
customer_wallets
wallet_transactions
```

Wallet transaction types include:

```text
ORDER_CREDIT
PAYOUT
ADJUSTMENT
REVERSAL
```

Do not delete or silently edit finalized ledger transactions.
Prefer reversal/correction transactions.

---

# 23. Available vs Pending Customer Money

Available balance:

- finalized customer money from completed/delivered transactions
- withdrawable subject to business rules

Pending amount:

- potential customer money on active Delivery Only orders
- not yet withdrawable

Pending should normally be derived from qualifying active orders rather than treated as finalized wallet money.

---

# 24. Customer Payouts

A normal payout transaction must atomically:

1. verify available wallet balance
2. verify permissions
3. create payout record
4. create wallet debit transaction
5. update wallet cached/current balance if used
6. create audit records
7. commit

Do not allow a normal V1 payout to make the wallet negative.

---

# 25. Driver Cash

Driver cash is money physically collected by a driver and not yet handed over to the company.

Driver cash is separate from customer wallet balances.

Use:

```text
driver_cash_accounts
driver_cash_transactions
```

Driver cash transaction types include:

```text
COLLECTION
SETTLEMENT
ADJUSTMENT
REVERSAL
```

---

# 26. Driver Settlement

A driver settlement represents cash handed by the driver to the company.

Example:

```text
Driver cash before: $1,000
Settlement:         $1,000
Driver cash after:      $0
```

A settlement reduces driver cash only.
It must not reduce the customer wallet.

This is a mandatory accounting invariant.

---

# 27. Company Financial Ledger

Company money must be tracked separately from:

- customer liabilities
- driver cash balances

Use company financial transactions for concepts such as:

```text
DELIVERY_FEE_REVENUE
COMPANY_ORDER_REVENUE
ADJUSTMENT
REVERSAL
```

Do not calculate company revenue by treating all collected driver cash as revenue.

---

# 28. Mandatory Database Transactions

Use PostgreSQL/Prisma transactions for multi-record financial operations.

Critical transactional operations include:

- Mark Delivered
- Customer Payout
- Driver Settlement
- Financial Adjustment / Reversal

Example successful Delivery Only delivery:

```text
BEGIN

validate order
validate driver
validate workflow state
validate actual collection

update order
create order status history
create delivery result/attempt

increase driver cash
create driver cash transaction

credit qualifying customer amount
create wallet transaction

create company delivery fee transaction

create audit log

COMMIT
```

If any required operation fails:

```text
ROLLBACK
```

Never implement these as unrelated requests from the frontend.

---

# 29. Idempotency and Duplicate Financial Protection

Financial operations must not accidentally execute twice.

Protect against duplicate:

- wallet order credits
- delivery cash collection transactions
- company revenue records
- payouts
- settlements

Use database uniqueness, business checks, transactional guards, or appropriate idempotency mechanisms.

Do not depend only on disabling a frontend button.

---

# 30. Audit Logging

Audit at least:

- order creation/editing
- driver assignment/reassignment
- status changes
- failed delivery
- successful delivery
- actual collection changes
- wallet credits
- payouts
- driver settlements
- financial adjustments
- relevant settings/permission changes

Audit data may include:

```text
actor
action
entity type
entity ID
previous values
new values
metadata
timestamp
```

Do not expose sensitive audit details to unauthorized roles.

---

# 31. Database Rules

The project uses PostgreSQL.
The approved SQL schema may be manually imported into PostgreSQL.

Prisma must remain consistent with the actual database.

Important:

- Do not run destructive migrations automatically.
- Do not drop tables.
- Do not reset the database.
- Do not delete production/reference data.
- Do not rename approved columns/tables casually.
- Do not modify the schema without identifying the required change first.
- Keep SQL and Prisma definitions synchronized when schema changes are approved.

---

# 32. Frontend Application Structure

Preferred frontend structure:

```text
client/src/
├── app/
│   ├── store.ts
│   └── hooks.ts
├── services/
│   ├── api.ts
│   ├── authApi.ts
│   ├── ordersApi.ts
│   ├── customersApi.ts
│   ├── driversApi.ts
│   ├── walletsApi.ts
│   ├── payoutsApi.ts
│   ├── settlementsApi.ts
│   ├── financeApi.ts
│   ├── reportsApi.ts
│   └── settingsApi.ts
├── features/
│   ├── auth/
│   ├── orders/
│   └── ui/
├── components/
├── layouts/
├── pages/
│   ├── management/
│   ├── driver/
│   ├── customer/
│   └── public/
├── routes/
├── types/
└── utils/
```

---

# 33. Redux Toolkit Rules

Use Redux Toolkit and `configureStore`.

Use typed Redux hooks.

Use normal Redux slices only for true client/global state such as:

- authenticated user summary
- role/permissions
- sidebar state
- global UI state
- selected rows
- persistent table/filter preferences where appropriate

Do not mirror all server API data into ordinary Redux slices.

---

# 34. RTK Query Rules

Use RTK Query as the default server-state/data-fetching layer.

Use RTK Query for:

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

Use cache tags and invalidation deliberately.

After a successful delivery, invalidate relevant data such as:

```text
order
driver orders
driver cash
customer wallet when applicable
dashboard/finance summaries when applicable
```

Avoid duplicate manual cache logic.

---

# 35. Frontend Forms

Use React Hook Form and Zod where appropriate.

The frontend validates input for usability.
The backend repeats authoritative validation.

Never trust frontend validation as security or business enforcement.

Calculated money shown on forms is preview-only until validated/recalculated by the server.

---

# 36. Management Portal Routes

```text
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

Management is desktop-first but must remain responsive.

---

# 37. Driver Portal Routes

```text
/driver/orders
/driver/orders/:id
/driver/out-for-delivery
/driver/completed
/driver/failed
/driver/cash
```

Driver portal is mobile-first.

Driver cards should prioritize:

- receiver
- phone
- address
- amount to collect
- call action
- location action
- workflow action

Do not expose unrelated or unauthorized financial/management data.

---

# 38. Customer Portal Routes

```text
/customer/dashboard
/customer/orders
/customer/orders/:id
/customer/wallet
/customer/transactions
/customer/payouts
/customer/profile
```

Customer portal should remain simple.
The customer sees only their own data.

---

# 39. Public Tracking

Public route:

```text
/track
```

Public API should return a safe DTO only.

Public tracking may expose:

- tracking code
- simplified status
- safe basic timeline/progress information

Do not expose:

- customer wallet
- internal financial records
- driver cash
- internal notes
- management-only history
- audit logs
- private customer information

---

# 40. Customer/Public Status Mapping

Conceptually:

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

Exception statuses should use approved customer-safe wording.

Keep the mapping reusable and consistent.

---

# 41. UI Reference Rules

The provided Claude Design HTML is a design reference.

Use it for:

- visual hierarchy
- spacing
- layout
- components
- colors
- typography direction
- interaction ideas
- responsive behavior

Do not:

- paste the bundled HTML into the React app as application architecture
- preserve fake/demo-only behavior as business logic
- let design code override approved requirements
- duplicate large sections instead of creating reusable React components

Rebuild the interface cleanly using React + Tailwind.

---

# 42. Shared Frontend Components

Prefer reusable components for recurring UI patterns such as:

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

Avoid premature over-generalization.

---

# 43. Frontend Page Responsibility

Do not create unnecessary top-level pages.

Examples:

- delivery assignment belongs to Orders / Create Order / Order Detail
- delivery workflow belongs to Order Detail and Driver Portal
- driver cash belongs to Driver Detail / Driver Cash / Settlements
- wallet history belongs to Wallet Detail and Customer Transactions
- order timeline belongs inside Order Detail

Keep navigation aligned with the approved page structure.

---

# 44. Search, Filters, Pagination

Order search must support relevant fields such as:

- order number
- tracking code
- customer
- receiver
- phone

Order filters may include:

- status
- driver
- customer
- order type
- area
- payment type
- payment method
- date
- assigned/unassigned
- delivered/undelivered

Filtering and pagination should be server-backed for potentially large datasets.

Do not load the entire database into the browser to filter it.

---

# 45. Error Handling

Backend:

- centralize error handling
- use typed/domain errors where useful
- return safe error messages
- log unexpected errors server-side

Frontend:

- provide loading states
- provide empty states
- provide recoverable error states
- avoid blank screens
- show useful mutation failure feedback

---

# 46. Validation

Validate:

- request body
- route params
- query params
- money constraints
- status transitions
- entity ownership
- permissions
- active/inactive status
- duplicate financial execution
- payout balance
- settlement balance
- assignment eligibility

Do not rely on TypeScript types as runtime validation.

---

# 47. Security

Mandatory security principles:

- hash passwords securely
- never store plaintext passwords
- use secure authentication handling
- enforce authorization server-side
- prevent IDOR
- validate all input
- restrict CORS appropriately
- protect secrets through environment variables
- do not commit `.env`
- do not log credentials/tokens
- rate-limit sensitive public/auth endpoints where appropriate
- protect public tracking from leaking internal information

---

# 48. Testing Strategy

Prioritize tests for:

## Unit tests

- payment calculations
- order status transition rules
- financial allocation rules
- customer/public status mapping

## Integration tests

- authentication
- authorization
- customer isolation
- driver isolation
- order creation
- assignment/reassignment
- successful delivery transaction
- failed delivery
- wallet credit
- payout
- driver cash collection
- settlement
- financial difference review
- idempotency protections

## End-to-end critical flows

### Delivery Only

```text
Create order
-> assign driver
-> pickup
-> out for delivery
-> deliver expected amount
-> driver cash increases
-> customer wallet increases by qualifying order portion
-> company delivery fee revenue is created
```

### Company Order

```text
Create order
-> deliver
-> driver cash increases
-> company revenue increases
-> customer wallet does not increase
```

### Payout

```text
Customer wallet has available balance
-> process payout
-> wallet decreases
-> payout record exists
-> driver cash is unchanged
```

### Driver Settlement

```text
Driver has collected cash
-> process settlement
-> driver cash decreases
-> customer wallet is unchanged
```

---

# 49. Logging and Observability

Log meaningful backend events without leaking secrets.

Prefer structured logs.

Financial audit history belongs in the database audit/ledger model, not only application logs.

---

# 50. Performance

Follow basic good practices:

- database indexes for common searches
- pagination
- avoid N+1 queries
- avoid unnecessary large nested relations
- use Prisma select/include deliberately
- cache server state correctly with RTK Query
- debounce UI search where appropriate

Correctness comes before micro-optimization.

---

# 51. Coding Standards

Use TypeScript consistently.

Avoid `any` unless justified.

Prefer:

- clear names
- small focused functions
- explicit business rules
- reusable utilities for repeated domain logic
- consistent import conventions
- predictable module boundaries

Do not:

- leave large commented-out blocks
- commit debug logs
- create duplicate helpers
- hide business logic inside controllers
- place critical business rules only in React components

---

# 52. Environment Variables

Secrets and environment-specific values belong in `.env`.

Provide `.env.example`.

Expected categories may include:

```text
DATABASE_URL
PORT
NODE_ENV
AUTH/JWT secrets
CLIENT_URL
```

Do not commit real secrets.

---

# 53. Official Implementation Execution Model

The detailed execution roadmap is defined in:

```text
/docs/implementation-plan.md
```

That document is authoritative for:

- phase numbering
- sub-phase numbering
- objective
- implementation scope
- APIs
- business rules
- checks/tests
- definition of done
- explicit "do not implement yet" boundaries
- review gates

This `CLAUDE.md` defines how Claude Code must execute that plan.

The normal implementation unit is:

```text
Phase
  -> Sub-phase
      -> One focused Claude Code session
          -> Tests / checks
              -> Session summary
                  -> Human review
                      -> Next sub-phase
```

Unless explicitly instructed otherwise, **one Claude Code session must target one sub-phase only**.

Do not implement an entire large phase in one session.

Example:

```text
Correct:
Implement Phase 6.1 only.

Incorrect by default:
Implement Phase 6.
```

Do not automatically continue from one sub-phase to another.

---

# 54. Official Phase and Sub-Phase Sequence

The following numbering must match `/docs/implementation-plan.md`.

## Phase 0 — Requirements and Business Rules — COMPLETE

```text
0.1 Roles and permissions
0.2 Customer and receiver model
0.3 Order/payment model
0.4 Financial rules
0.5 Workflow and V1 scope
```

## Phase 1 — UI / Page Architecture — COMPLETE

```text
1.1 Management Portal
1.2 Driver Portal
1.3 Customer Portal
1.4 Public Tracking
1.5 Routes/shared component responsibilities
```

## Phase 2 — Database Design — COMPLETE

```text
2.1 PostgreSQL relational model
2.2 Financial ledgers
2.3 Order/assignment/status/delivery history
2.4 Audit model
2.5 Manual PostgreSQL SQL scripts
2.6 Prisma model direction
```

## Phase 3 — Backend Foundation

```text
3.1 Backend Project Bootstrap
3.2 PostgreSQL + Prisma Connection
3.3 API Foundation + Global Middleware
```

## Phase 4 — Authentication and Authorization

```text
4.1 Auth Domain Foundation + First Admin
4.2 Login
4.3 Refresh / Logout / Current User
4.4 RBAC + Ownership Protection
4.5 Authentication / RBAC Tests
```

## Phase 5 — Core Management Data

```text
5.1 Customers Backend
5.2 Drivers Backend
5.3 Reference / Settings Data
5.4 Phase 5 Integration Tests
```

## Phase 6 — Order Engine

```text
6.1 Order Financial Calculations + Validation
6.2 Create Order + Order Detail
6.3 Order List / Search / Filters / Pagination
6.4 Order Editing
6.5 Assignment / Reassignment / Bulk Assignment
6.6 Ready / Reschedule / Cancel / History
6.7 Order Engine Integration Tests
```

## Phase 7 — Driver Delivery Workflow

```text
7.1 Driver-Scoped Order Access
7.2 Pickup
7.3 Start Delivery
7.4 Failed Delivery
7.5 Successful Delivery Operational Logic
7.6 Driver Workflow Tests
```

## Phase 8 — Financial Engine

```text
8.1 Driver Cash Ledger Foundation
8.2 Customer Wallet Ledger Foundation
8.3 Delivery Only Exact Successful Finance
8.4 Company Order Exact Successful Finance
8.5 Customer Payouts
8.6 Driver Settlements
8.7 Collection Difference Review
8.8 Adjustments + Reversals
8.9 Idempotency + Concurrency Protection
8.10 Financial Integration Tests
```

## Phase 9 — Dashboard / Finance / Reports / Audit APIs

```text
9.1 Management Dashboard API
9.2 Finance Summary + Transactions
9.3 Reports APIs
9.4 Audit Search API
```

## Phase 10 — Frontend Foundation

```text
10.1 React + TypeScript + Vite + Tailwind Bootstrap
10.2 Router + Layout Architecture
10.3 Redux Toolkit Store
10.4 RTK Query Foundation
10.5 Frontend Auth + Permission Guards
10.6 Shared UI + Design System
```

## Phase 11 — Management Portal

```text
11.1 Login Page
11.2 Management Shell
11.3 Orders List
11.4 Create Order
11.5 Order Detail
11.6 Customer Management
11.7 Driver Management
11.8 Wallet Management
11.9 Payouts
11.10 Driver Settlements
11.11 Management Dashboard
11.12 Finance Page
11.13 Reports
11.14 Employees + Permissions
11.15 Audit Logs
11.16 Settings
11.17 Parcel Intake & Collection Integration
  11.17.1 Requirements + Database Contract Update
  11.17.2 Database / Prisma + Migration
  11.17.3 Parcel Collection Backend
  11.17.4 Order Engine Integration
  11.17.5 Management UI Integration
  11.17.6 Dashboard + Reports + Audit + Tracking Contracts
  11.17.7 Full Regression + Visual Acceptance
```

Phase 12 (Driver Portal) is BLOCKED until every Phase 11.17 gate passes.

## Phase 12 — Driver Portal

```text
12.1 Driver Layout + Assigned Orders
12.2 Driver Order Detail + Pickup/Start
12.3 Delivered + Failed Actions
12.4 Completed + Failed History
12.5 Driver Cash Page
12.6 Mobile Responsiveness Review
```

Phase 12 must account for the Parcel Intake feature (see Phase 11.17 and Section 72):
the Driver Portal is built around assigned **jobs** (COLLECTION and DELIVERY), a Driver
may hold both job types for the same Order, the Driver confirms `COLLECTED_FROM_SENDER`
but never confirms company receipt, and Failed Collection is separate from Failed Delivery.
Do not begin Phase 12 until Phase 11.17 is complete and approved.

## Phase 13 — Customer Portal

```text
13.1 Customer Shell + Dashboard
13.2 Customer Orders
13.3 Customer Order Detail + Tracking
13.4 Wallet
13.5 Transactions + Payout History
13.6 Profile
```

## Phase 14 — Public Tracking

```text
14.1 Public Tracking Backend API
14.2 Public Tracking UI
14.3 Public Privacy Tests
```

## Phase 15 — Integration / Testing / Regression

```text
15.1 Backend Unit Test Completion
15.2 Backend Integration Test Completion
15.3 Financial Regression Suite
15.4 Authorization / Security Regression
15.5 Frontend Integration Tests
15.6 End-to-End Critical Flows
15.7 Responsive / Browser Review
15.8 Release Candidate Regression
```

## Phase 16 — Production Hardening + Deployment

```text
16.1 Production Environment
16.2 Security Hardening
16.3 Docker / Reproducible Build
16.4 CI/CD
16.5 Database Backup + Recovery
16.6 Logging + Monitoring
16.7 Production Deploy + Smoke Test
```

Do not renumber, merge, or skip sub-phases without explicit instruction.

---

# 55. Claude Code Session Start Rule

When the user asks Claude Code to implement a sub-phase, Claude Code must begin by:

1. Read this `CLAUDE.md`.
2. Read `/docs/implementation-plan.md`.
3. Read the relevant business requirements from `/docs/requirements.md`.
4. Read `/docs/page-structure.md` when frontend/page behavior is involved.
5. Read the approved SQL/Prisma database definitions when backend/database behavior is involved.
6. Inspect the existing repository before creating new abstractions or files.
7. Identify only the direct dependencies needed for the requested sub-phase.
8. Implement the requested sub-phase only.

Claude Code should not re-plan the entire project at the start of every session.

If a direct conflict between documents blocks correct implementation, stop and clearly identify:

- conflicting documents/sections
- why the conflict matters
- what decision is required

For non-blocking implementation details, follow existing project conventions.

---

# 56. Sub-Phase Scope Rule

A sub-phase is a hard default scope boundary.

Claude Code may create small supporting code outside the named module only when that code is a direct technical dependency of the active sub-phase.

Supporting code must not become an excuse to implement later business features.

Claude Code must not:

- pre-build later sub-phases
- automatically continue into the next sub-phase
- implement later UI because a backend endpoint now exists
- implement future financial flows while working on order CRUD
- implement dashboards/reports before the relevant source modules exist
- add deferred V1+ features without explicit instruction

Example:

If implementing:

```text
Phase 6.1 — Order Financial Calculations + Validation
```

Claude Code may add:

- calculation utilities
- Zod schemas
- Decimal helpers
- unit tests

Claude Code must not also add:

- `POST /orders`
- order assignment
- driver delivery
- wallet credits
- React forms

unless explicitly required by the sub-phase document.

---

# 57. Required Session Closing Report

At the end of every implementation sub-phase, Claude Code must stop and provide this report:

```text
Sub-phase completed:
<phase.sub-phase name>

Files created:
- ...

Files modified:
- ...

Routes/APIs added:
- ...

Database changes:
- none
or
- explicit approved changes

Business rules implemented:
- ...

Tests/checks run:
- ...

Results:
- ...

Known issues:
- ...

Explicitly not implemented:
- ...

Recommended next sub-phase:
<next numbered sub-phase>
```

Do not state that a sub-phase is complete when required checks fail.

If a check cannot be run, clearly state:

- which check
- why it could not run
- what remains unverified

---

# 58. Review Gate Rule

Claude Code does not decide on its own to cross a review gate.

After every sub-phase:

```text
Implement
  ↓
Run checks/tests
  ↓
Report
  ↓
STOP
  ↓
Human review
  ↓
Next instruction
```

At the end of a complete phase, perform the review gate described in `/docs/implementation-plan.md`.

Critical mandatory review gates include:

- Phase 4 — authentication/RBAC/IDOR
- Phase 6 — order calculations/workflow/assignment
- Phase 7 — driver ownership/state machine
- Phase 8 — financial engine deep review
- Phase 10 — Redux/RTK Query/frontend architecture
- Phase 14 — public data leakage
- Phase 15 — release candidate
- Phase 16 — production readiness

---

# 59. Existing Code Rule

Before creating a new file, module, helper, component, middleware, service, or abstraction:

- inspect whether an equivalent already exists
- reuse project conventions
- avoid duplicate implementations
- preserve working code unless a change is required
- prefer extending existing architecture over introducing a parallel architecture

Do not rewrite large working sections merely to match personal preference.

---

# 60. Refactoring Rule

Refactor only when it is directly justified by:

- correctness
- security
- data integrity
- maintainability
- required feature implementation
- clear duplication reduction

Do not perform unrelated broad refactors during a sub-phase.

If a larger refactor is desirable but not necessary:

- mention it in the closing report
- do not perform it automatically

---

# 61. Database Change Rule

The manually created PostgreSQL database is an approved project artifact.

Prisma must remain synchronized with the actual PostgreSQL schema.

If implementation appears to require a database change:

1. Check `/docs/requirements.md`.
2. Check `/docs/implementation-plan.md`.
3. Check the approved SQL and Prisma schema.
4. Explain exactly why the current schema is insufficient.
5. Identify affected tables, columns, enums, constraints, and indexes.
6. Avoid changing the database if the requirement can be implemented correctly without a schema change.
7. If the change is genuinely required, update both approved SQL and Prisma definitions as appropriate.
8. Preserve existing data where possible.
9. Never run a destructive reset automatically.
10. Never silently drop or recreate tables.

Claude Code must not automatically execute commands equivalent to:

```text
prisma migrate reset
DROP DATABASE
DROP TABLE
TRUNCATE important business data
```

unless the user explicitly requests and approves the destructive operation.

---

# 62. Business Rule Gap Rule

Do not invent missing financial/business behavior.

This rule is especially strict for ambiguity involving:

- ownership of collected money
- customer wallet credit
- company revenue
- delivery fee allocation
- shortages
- excess collection
- refunds
- reversals
- payouts
- settlements
- failed delivery
- status transitions
- authorization
- financial review resolution

If documentation does not define the required business behavior:

- identify the exact ambiguity
- preserve known data
- avoid irreversible financial posting
- ask for/flag the decision instead of guessing

The approved collection-difference rule is already defined and must be followed.

---

# 63. Financial Implementation Rules

Financial correctness has a higher priority than implementation speed.

Maintain these mandatory invariants:

```text
Customer Wallet
!=
Driver Cash
!=
Company Revenue
```

A customer payout:

```text
changes customer wallet
does not change driver cash
```

A driver settlement:

```text
changes driver cash
does not change customer wallet
```

A COMPANY_ORDER successful delivery:

```text
driver cash += actual qualifying collection
company revenue += qualifying company amounts
customer wallet += 0
```

A DELIVERY_ONLY exact successful delivery:

```text
driver cash += actual qualifying collection
customer wallet += qualifying unpaid order portion
company revenue += qualifying delivery fee
```

For ambiguous collection differences:

```text
driver cash records actual physical cash
financial review is required
customer/company split must not be guessed
```

Critical financial operations must use atomic PostgreSQL/Prisma transactions.

Finalized financial history must not be silently edited or deleted.

Use authorized adjustment/reversal records.

---

# 64. Idempotency and Concurrency Rule

Do not rely on frontend button disabling to protect money.

Protect against duplicate/concurrent:

- successful delivery financial posting
- wallet order credits
- driver COLLECTION records
- company revenue records
- payouts
- settlements
- reversals

Use appropriate:

- unique constraints
- transactional checks
- database locking/isolation where required
- idempotency keys where justified

Phase 8.9 is the dedicated hardening sub-phase, but earlier financial code should not be designed in a way that prevents proper idempotency later.

---

# 65. Redux Toolkit and RTK Query Rule

Use Redux Toolkit.

Use `configureStore`.

Use normal Redux slices only for true client/global state such as:

- authenticated user summary
- role/permissions if globally required
- sidebar
- modal/global UI state
- selected table rows
- persistent filters/preferences where justified

Use RTK Query as the default server-state layer for:

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

Do not duplicate RTK Query server data into ordinary Redux slices.

Use cache tags/invalidation deliberately.

After a mutation, invalidate only the data domains that became stale.

---

# 66. Frontend Design Reference Rule

The Claude Design HTML is a visual reference only.

Use it for:

- visual hierarchy
- spacing
- typography direction
- color direction
- component appearance
- responsive behavior
- interaction ideas

Do not:

- paste the bundled HTML as React application architecture
- reproduce demo-only data logic as business logic
- allow UI reference behavior to override requirements
- build duplicate page-specific components when a reusable component already exists

Rebuild production UI in React + TypeScript + Tailwind CSS.

---

# 67. Testing Rule

Testing happens throughout implementation.

Do not defer all testing to Phase 15.

Each sub-phase must run the tests/checks specified by `/docs/implementation-plan.md`.

At minimum, appropriate work should use:

- TypeScript typecheck
- backend/frontend build checks
- unit tests for domain logic
- integration tests for API/database behavior
- authorization tests
- financial transaction tests
- E2E tests when full user journeys are available

Phase 15 is for completion and full-system regression, not the first time critical behavior is tested.

---

# 68. Definition of Done Rule

A UI rendering is not enough to mark a feature complete.

Where applicable, completion requires:

- correct route/API
- runtime validation
- authentication
- authorization
- ownership protection
- server-side business rules
- correct DB behavior
- transaction boundary
- idempotency/duplicate protection where relevant
- history/audit
- safe errors
- loading state
- empty state
- frontend error handling
- RTK Query cache behavior
- responsive behavior
- passing tests/checks
- successful typecheck/build
- no obvious security regression

The detailed definition of done for the active sub-phase in `/docs/implementation-plan.md` is authoritative.

---

# 69. V1 Scope Discipline

Do not add later-phase features without explicit instruction.

Deferred beyond V1 unless separately requested:

- automatic area pricing
- live maps
- route optimization
- live driver GPS
- SMS automation
- WhatsApp automation
- email automation
- barcode / QR workflows
- advanced shipping labels
- invoices
- customer-created delivery orders
- customer payout request workflow
- advanced analytics
- Excel/PDF export
- native mobile app
- proof-of-delivery photos
- signatures
- delivery OTP
- multi-branch
- multi-currency

Design for reasonable extensibility without implementing these prematurely.

---

# 70. Current Project Status

Current approved state:

```text
Phase 0 — Requirements                 COMPLETE
Phase 1 — UI/Page Architecture         COMPLETE
Phase 2 — Database Design              COMPLETE

NEXT:
Phase 3.1 — Backend Project Bootstrap
```

The next normal Claude Code implementation instruction should be:

```text
Implement Phase 3.1 only.
```

After implementation, tests/checks, summary, and review, proceed to:

```text
Phase 3.2 — PostgreSQL + Prisma Connection
```

Do not skip directly to authentication or frontend work.

---

# 71. Final Priority Principle

For this project, priority order is:

```text
1. Financial correctness
2. Security and authorization
3. Data integrity and auditability
4. Business-rule correctness
5. Maintainable architecture
6. User experience
7. Visual polish
```

Never sacrifice the first four priorities for convenience, speed, or UI appearance.

When uncertain:

1. follow the project documentation
2. preserve financial traceability
3. preserve historical data
4. avoid inventing business rules
5. stop at the active sub-phase boundary

---

# 72. Parcel Intake & Collection (Phase 11.17)

A newly approved cross-cutting feature. Full spec:
`/docs/delivery_management_system_parcel_intake_collection_feature_change_spec_v1.md`.
Database contract: `/docs/parcel-intake-collection-database-contract.md`.

Mandatory rules:

- **Parcel Intake Method is independent of Order Type.** `ALREADY_AT_COMPANY` and
  `DRIVER_COLLECTION` both apply to `COMPANY_ORDER` and `DELIVERY_ONLY`. All four
  combinations are valid. Never hard-wire an Order Type to one Intake Method.
- **Parcel Collection is a different domain from financial cash collection.** The
  existing `collection` names (`amountToCollect`, `actualAmountCollected`,
  `collectionPaymentMethod`, `collectionDifferenceReason`, `DriverCashTransactionType.COLLECTION`)
  stay about MONEY collected from the receiver. New parcel work MUST use `Parcel`-prefixed
  names (`ParcelIntakeMethod`, `ParcelCollectionStatus`, `parcel_collection_assignments`,
  `parcel_collection_attempts`, `failed_collection_reasons`, etc.).
- **Collection and Delivery assignments are separate permanent histories.**
  `parcel_collection_assignments` is separate from `order_assignments`;
  `parcel_collection_attempts` is separate from `delivery_attempts`. Reassignment ends the
  previous record and never overwrites it.
- **`orders.current_driver_id` remains the final DELIVERY driver only.** The current
  Collection driver is a separate column (`current_parcel_collection_driver_id`) that always
  mirrors the single open `parcel_collection_assignments` row.
- The same physical Driver may perform both the Collection job and the Delivery job for one
  Order at different times; they are still separate assignments/responsibilities.
- **Collection assignment lifecycle (all steps are one transaction — status + assignment row
  + `current_parcel_collection_driver_id` change together):**
  - `ALREADY_AT_COMPANY`: no assignment row; pointer `NULL`; status `RECEIVED_AT_COMPANY`.
  - Assign / reassign: open a new current row (`is_current=true`, `ended_at=NULL`); on
    reassign, first end the old row with `end_reason=REASSIGNED`; set the pointer; status
    `ASSIGNED`. Reassignment is allowed **only before `COLLECTED_FROM_SENDER`**.
  - `COLLECTED_FROM_SENDER`: append a `COLLECTED` attempt; **do NOT end the assignment and
    do NOT clear the pointer** — the driver still has custody in transit.
  - Collection Failed: append a `FAILED` attempt; end the current row
    (`end_reason=FAILED`); clear the pointer; status `FAILED`.
  - `RESCHEDULED`: Management approval of another attempt; no current row; pointer `NULL`;
    no scheduled-date field in V1. A later assignment opens a brand-new row.
  - `RECEIVED_AT_COMPANY`: end the current row (`end_reason=RECEIVED_AT_COMPANY`); clear the
    pointer; set `received_at_company_at` / `received_at_company_by_id`.
  - **Order cancellation:** allowed from `AWAITING_ASSIGNMENT` / `ASSIGNED` / `FAILED` /
    `RESCHEDULED` under existing order-cancel rules. From `ASSIGNED`, the cancel handler
    ends the current row (`end_reason=ORDER_CANCELLED`) and clears the pointer **in the same
    transaction** as the order status change. **Cancellation is rejected from
    `COLLECTED_FROM_SENDER`** (driver holds the parcel — confirm `RECEIVED_AT_COMPANY`
    first) — enforce on every cancel path server-side. Order cancellation never changes
    `parcel_collection_status` and never fabricates an attempt row. No "cancelled while
    driver holds parcel" workflow, no `RETURNED` outcome in V1.
  - `end_reason` is a fixed enum:
    `REASSIGNED | FAILED | RECEIVED_AT_COMPANY | ORDER_CANCELLED`. `ORDER_CANCELLED` ≠ the
    Failed Collection Reason "Collection cancelled by sender". Invariants:
    `is_current = (ended_at IS NULL)`; at most one current row per Order (partial unique
    index); a cancelled Order never has a current row or a non-null pointer. Full contract:
    `/docs/parcel-intake-collection-database-contract.md` §4.1 / §4.3 / §8.
- **The Collection Driver confirms `COLLECTED_FROM_SENDER`. Authorized Management confirms
  `RECEIVED_AT_COMPANY`.** A Driver must never perform the company-receipt step.
- The Management Orders **list DTO** (`OrderSummary`) carries `parcelIntakeMethod` +
  `parcelCollectionStatus` (Phase 11.17.5 — scalar passthrough of the two NOT NULL `orders`
  columns, no join, no business logic). Parcel-intake list FILTERS, a collection-driver
  column, and collection-aware quick-tab semantics are a DEFERRED CONTRACT (Phase 11.17.6) —
  never simulate them client-side over one paginated page, and never issue one
  `GET /orders/:id/parcel-collection` per row. There is no backend Driver
  collection-history endpoint yet (also deferred to 11.17.6); Driver Detail Delivery
  metrics must keep their exact meaning.
- Frontend (Phase 11.17.5): Create Order is **one atomic request** — the collection driver
  (`parcelCollectionDriverId`, DRIVER_COLLECTION) and the delivery driver
  (`deliveryDriverId`, ALREADY_AT_COMPANY) go in the `POST /orders` body, not a second
  request. The frontend always sends `parcelIntakeMethod` explicitly (the backend's
  omitted → `ALREADY_AT_COMPANY` resolution is legacy-client compatibility only).
- **Delivery-driver assignment is forbidden until `parcel_collection_status = RECEIVED_AT_COMPANY`.**
  LIVE since Phase 11.17.4 via `isParcelReadyForDelivery()` + the condition in the
  conditional claim of `assignOrder` / `reassignOrder` / `bulkAssignOrders` and the Create
  Order path. Bulk delivery assignment stays atomic: one ineligible order 409s the whole
  batch.
- For `ALREADY_AT_COMPANY`, `parcel_collection_status` is `RECEIVED_AT_COMPANY` immediately;
  `received_at_company_at` = order creation time; `received_at_company_by_id` = order creator.
  There is no `NOT_REQUIRED` status. Phase 11.17.4 made Create Order parcel-aware: an omitted
  `parcelIntakeMethod` resolves to `ALREADY_AT_COMPANY` **at the service layer** (never a DB
  default — the temporary `orders` DB defaults were dropped by migration `__1174__`); the
  columns stay NOT NULL and are always written by the service.
- Create Order: `parcelCollectionDriverId` (DRIVER_COLLECTION) and `deliveryDriverId`
  ("Create & Assign", ALREADY_AT_COMPANY only) are DISTINCT fields, both additionally require
  `orders.assign`, and the whole create is one transaction (a driver failure rolls it back).
  The collection snapshot is derived from the Customer (request override wins) and its
  required fields (contact/phone/address/area) are validated → 400.
- Order cancellation (Phase 11.17.4): **rejected 409 from `COLLECTED_FROM_SENDER`** (driver
  holds the parcel — confirm receipt first). From `parcel_collection_status = ASSIGNED` the
  cancel handler ends the collection assignment (`end_reason = ORDER_CANCELLED`) and clears
  the pointer in the same transaction as the order status change; `parcel_collection_status`
  stays `ASSIGNED` as the last historical stage (there is **no** `ParcelCollectionStatus.CANCELLED`).
  A cancelled order therefore may show `parcel_collection_status = ASSIGNED` with a NULL
  pointer and no current assignment — a valid terminal-order combination, never "corruption",
  never auto-repaired.
- **Failed Collection and Failed Delivery are separate** — separate attempt tables and
  separate configurable reason catalogs. Failed Collection does not auto-cancel the Order.
- **Parcel Collection is financially neutral in V1.** It creates ZERO wallet posting, ZERO
  driver-cash posting, ZERO company-finance posting, no payout, no settlement, no fee.
- Customer collection contact/address data is **snapshotted onto the Order** at creation
  (same principle as the receiver snapshot); later Customer edits must not rewrite it.
- `OrderStatus.RECEIVED` no longer proves physical company possession — it means the Order
  is recorded in the system. Company possession is read from `parcel_collection_status` /
  receipt fields.
- Do NOT grant the DRIVER role `settings.read` for Failed Collection Reasons; the Driver
  Portal gets active reasons through a narrow Driver-safe endpoint.
- **Existing (pre-feature) Orders backfill as `ALREADY_AT_COMPANY` / `RECEIVED_AT_COMPANY`**,
  receipt time = `created_at`, receipt confirmer = `created_by_id`. No existing delivery
  assignment may be reinterpreted as Collection work.
- **Phase 12 (Driver Portal) remains blocked until all Phase 11.17 gates pass and are approved.**
