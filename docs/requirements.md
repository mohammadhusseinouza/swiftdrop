# Delivery Management System
## Complete Requirements Specification — Version 1

## 1. Project Overview

The Delivery Management System is a web-based system designed primarily for the internal management of a delivery company.

The system will manage the complete delivery lifecycle, including:

- Customers
- Employees
- Drivers
- Orders
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
- Assign and reassign drivers
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
- Assign drivers
- Reassign drivers
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

A driver can only access orders assigned to them.

Drivers can:

- View assigned orders
- View receiver information
- View delivery address
- View receiver phone number
- View delivery instructions
- View amount that must be collected
- Mark an order as picked up
- Start delivery
- Mark an order as delivered
- Mark a delivery attempt as failed
- Enter the actual amount collected
- View their delivery history
- View their current collected-cash balance

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

An order does not need to have a driver immediately when created.

An employee may:

### Create Order Only

The order remains ready for assignment.

or:

### Create and Assign

A driver is selected immediately.

Employees must be able to:

- Assign a driver
- Change the assigned driver
- Bulk assign multiple orders to one driver

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

---

# 18. Status Definitions

## Received

The order was entered into the system and received by the company.

## Ready for Pickup

The package is prepared and ready for a driver.

## Assigned

A driver has been assigned.

## Picked Up

The driver confirms possession of the package.

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

The order was cancelled.

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

The driver's main screen should show:

- Assigned
- Out for Delivery
- Completed
- Failed / Returned

For each assigned order, the driver sees only information necessary for delivery.

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
- Order amount
- Delivery fee
- Amount to collect
- Driver
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
- Driver
- Customer
- Order type
- Area
- Payment type
- Payment method
- Date range
- Assigned / unassigned
- Delivered / undelivered

Filters should be combinable.

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

## Delivery

- Assigned driver
- Assignment date
- Pickup date
- Out-for-delivery date
- Delivery date
- Failure information, if applicable

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

The customer-facing stages should be simplified to:

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

The public page must not expose:

- Customer wallet
- Company revenue
- Internal notes
- Internal employee information
- Driver cash information
- Full accounting details

Driver contact information should only be exposed later if the company explicitly decides to allow it.

---

# 37. Company Dashboard

The management dashboard should provide a quick operational overview.

## Order Statistics

- Orders received today
- Ready for pickup
- Unassigned
- Assigned
- Out for delivery
- Delivered today
- Failed today
- Returned
- Cancelled

## Driver Statistics

- Active drivers
- Drivers currently delivering
- Deliveries assigned per driver
- Deliveries completed today
- Cash currently held by drivers

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

- Orders assigned
- Orders delivered
- Failed attempts
- Delivery success rate
- Money collected
- Settlement history

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
- Driver assigned
- Driver reassigned
- Status changed
- Delivery failed
- Delivery completed
- Amount collected
- Wallet credited
- Customer payout created
- Driver settlement created
- Financial adjustment made

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
14. Optionally assign a driver.
15. Save order.

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

1. Customer gives package to company.
2. Employee creates Delivery Only order.
3. Driver assigned.
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

- My Orders
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
7. Driver assignment
8. Delivery statuses
9. Driver portal
10. Successful/failed delivery handling
11. Customer wallets
12. Wallet transactions
13. Customer payouts
14. Driver cash balances
15. Driver settlements
16. Customer portal
17. Public tracking
18. Dashboard
19. Search and filters
20. Audit history

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

---

# 53. Final System Structure

The complete system consists of these main business modules:

1. **Authentication & Authorization**
2. **Dashboard**
3. **Customer Management**
4. **Employee Management**
5. **Driver Management**
6. **Order Management**
7. **Delivery Assignment**
8. **Delivery Workflow**
9. **Driver Portal**
10. **Customer Portal**
11. **Public Tracking**
12. **Customer Wallet**
13. **Wallet Transactions**
14. **Customer Payouts**
15. **Driver Cash Management**
16. **Driver Settlements**
17. **Company Revenue / Finance**
18. **Reports**
19. **Audit Logs**
20. **System Settings**

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
