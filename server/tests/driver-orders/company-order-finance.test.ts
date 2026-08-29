import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestDriverRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 8.4 — Company Order Exact Successful Finance
//
// Dedicated finance-focused suite for the exact-collection COMPANY_ORDER
// branch of POST /api/v1/driver/orders/:id/deliver. Operational workflow
// correctness is already covered by Phase 7.5/7.6's own test files — this
// suite assumes that machinery works and focuses purely on the NEW
// financial posting this sub-phase adds: Driver Cash collection, Company
// product+delivery-fee revenue, the audit record, atomicity/rollback, and
// idempotency/duplicate protection. The single mandatory invariant checked
// throughout: a COMPANY_ORDER must NEVER credit the customer wallet.
// ============================================================

describe("Company Order Exact Successful Finance (Phase 8.4)", () => {
  let app: Express;
  let admin: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let reasonId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);

    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const reason = await prisma.failed_delivery_reasons.findFirstOrThrow();
    reasonId = reason.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function freshCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH84-DRV-${uniqueSuffix()}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  async function createBaseOrder(customerId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "COMPANY_ORDER",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase84 Receiver",
        receiverPhone: "+96170000084",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase84 St",
        description: "Phase84 finance order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function createOutForDeliveryOrder(customerId: string, driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(customerId, overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return order.id as string;
  }

  function deliverPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/deliver`;
  }
  function failPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/fail`;
  }

  async function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(deliverPath(orderId)).set(auth(token)).send(body);
  }

  // expectedDriverCashCollections defaults to 0 (the all-prepaid exact case
  // this helper was first written for, where actual=0 legitimately posts no
  // Driver Cash row). Phase 8.7: a collection-difference delivery DOES
  // record its real actual amount in Driver Cash — pass 1 explicitly for
  // those call sites, since only the Wallet/Company allocation stays zero
  // until an authorized Finance/Admin resolution.
  async function assertNoFinanceSideEffects(
    orderIds: string[],
    customerId: string,
    driverId: string,
    expectedDriverCashCollections = 0
  ) {
    const [walletTx, cashTx, companyTx, payouts, settlements] = await Promise.all([
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } }),
      // Scoped to this test's own Customer/Driver — Phase 8.5/8.6 now
      // legitimately write customer_payouts/driver_settlements rows from
      // concurrently-running test files, so an unscoped global count here
      // would be flaky the same way the wallet.test.ts money-separation
      // check already documented for company_financial_transactions.
      prisma.customer_payouts.count({ where: { customer_id: customerId } }),
      prisma.driver_settlements.count({ where: { driver_id: driverId } }),
    ]);
    assert.equal(walletTx, 0);
    assert.equal(cashTx, expectedDriverCashCollections, "Phase 8.7: a difference delivery records actual physical cash in Driver Cash");
    assert.equal(companyTx, 0);
    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
  }

  // Zero wallet_transactions AND unchanged available_balance must hold for
  // every exact COMPANY_ORDER scenario in this suite.
  async function assertZeroWalletImpact(customerId: string, orderId: string, balanceBefore: Prisma.Decimal) {
    const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
    assert.equal(walletTxCount, 0, "a COMPANY_ORDER must never create a wallet_transactions row");
    const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
    assert.equal(wallet.available_balance.toString(), balanceBefore.toString(), "a COMPANY_ORDER must leave the wallet balance byte-for-byte unchanged");
  }

  // ============================================================
  // 1-6. CORE COMPANY ORDER FINANCE SCENARIOS
  // ============================================================

  describe("Core Company Order finance scenarios", () => {
    test("1. full COD: driver cash += 105, product revenue += 100, fee revenue += 5, wallet += 0, FINALIZED", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-full-cod");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");
      assert.equal(orderRow.needs_financial_review, false);
      assert.equal(orderRow.collection_difference_reason, null);

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");

      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTx.amount.toString(), "100");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTx.amount.toString(), "5");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });

    test("2. partial order prepayment: prepaid order 40, remaining order 60 + fee 5 due, actual 65", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-partial-order");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "40.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "65");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "65.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "65");
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTx.amount.toString(), "60", "must post only the remaining 60, never the full 100");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTx.amount.toString(), "5");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });

    test("3. order fully prepaid, fee due: driver cash += 5, product revenue no row, fee += 5", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-order-prepaid");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "5");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "5.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "5");
      const productTxCount = await prisma.company_financial_transactions.count({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTxCount, 0, "no product revenue row when remaining_order_amount is zero");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTx.amount.toString(), "5");

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });

    test("4. fee prepaid, order due: driver cash += 100, product revenue += 100, fee revenue no row", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-fee-prepaid");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "100");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "100");
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTx.amount.toString(), "100");
      const feeTxCount = await prisma.company_financial_transactions.count({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTxCount, 0, "no fee revenue row when remaining_delivery_fee is zero");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });

    test("5. fully prepaid: actual 0 -> DELIVERED, FINALIZED, zero ledger rows", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-all-prepaid");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
        collectionPaymentMethodId: undefined,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "0");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");

      await assertNoFinanceSideEffects([orderId], customerId, driver.driverId);

      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(attempt.outcome, "DELIVERED");
      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditRows.length, 1, "still create a finalization audit even when every component is zero");
      assert.equal(auditRows[0].action, "COMPANY_ORDER_FINANCE_FINALIZED");
    });

    test("6. Decimal exactness: order 0.10, fee 0.20, actual 0.30 -> exact split with no float drift", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-decimal");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderAmount: "0.10",
        deliveryFee: "0.20",
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "0.3");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0.30" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "0.3");
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTx.amount.toString(), "0.1");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTx.amount.toString(), "0.2");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });
  });

  // ============================================================
  // 7-10. WALLET INVARIANT
  // ============================================================

  describe("Wallet invariant", () => {
    test("7-9. Company Order creates zero wallet transactions; availableBalance and transaction history stay byte-for-byte unchanged", async () => {
      const customerId = await freshCustomer();

      // Give this customer's wallet real pre-existing balance/history
      // BEFORE the Company Order under test, so the invariant is
      // meaningfully proven — not just "started at zero, stayed at zero".
      const priorDriver = await createDriverWithToken("driver-preexisting-wallet-history");
      const priorOrder = await createOutForDeliveryOrder(customerId, priorDriver.token, priorDriver.driverId, { orderType: "DELIVERY_ONLY" });
      const priorDeliver = await deliver(priorOrder, priorDriver.token, { actualAmountCollected: "105.00" });
      assert.equal(priorDeliver.status, 200, JSON.stringify(priorDeliver.body));

      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletBefore.available_balance.toString(), "100", "sanity check: prior DELIVERY_ONLY order really did credit the wallet");
      const historyBefore = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });
      assert.equal(historyBefore.length, 1);

      const companyDriver = await createDriverWithToken("driver-company-wallet-invariant");
      const companyOrderId = await createOutForDeliveryOrder(customerId, companyDriver.token, companyDriver.driverId, { orderType: "COMPANY_ORDER" });
      const res = await deliver(companyOrderId, companyDriver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body)); // 7

      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), walletBefore.available_balance.toString()); // 8
      assert.deepEqual(walletAfter, walletBefore, "the wallet row must be byte-for-byte unchanged, including updated_at");

      const historyAfter = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });
      assert.deepEqual(historyAfter, historyBefore); // 9 — no new wallet transaction, earlier row untouched

      const companyOrderWalletTxCount = await prisma.wallet_transactions.count({ where: { order_id: companyOrderId } });
      assert.equal(companyOrderWalletTxCount, 0);
    });
  });

  // ============================================================
  // 11-14. REFERENCES / AUDIT
  // ============================================================

  describe("Financial transaction references and audit", () => {
    test("11-13. product/fee revenue rows and audit carry correct order/actor/payment-method references", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-references");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTx.order_id, orderId);
      assert.equal(productTx.created_by_id, driver.userId);
      assert.equal(productTx.payment_method_id, cashMethodId);

      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTx.order_id, orderId);
      assert.equal(feeTx.created_by_id, driver.userId);
      assert.equal(feeTx.payment_method_id, cashMethodId);

      const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(cashTx.created_by_id, driver.userId);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditRows.length, 1); // 13
      assert.equal(auditRows[0].action, "COMPANY_ORDER_FINANCE_FINALIZED");
      assert.equal(auditRows[0].actor_user_id, driver.userId);
    });

    test("14. audit row is created inside the same transaction (rollback leaves zero audit rows)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-audit-rollback");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driver.driverId } });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 500);

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0);

      await prisma.driver_cash_accounts.create({ data: { driver_id: driver.driverId } });
    });
  });

  // ============================================================
  // 15-18. ROLLBACK
  // ============================================================

  describe("Atomicity / rollback", () => {
    test("15. missing Driver Cash account -> 500, full rollback, no company revenue, no wallet mutation", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-missing-cash-account");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driver.driverId } });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY");
      assert.equal(row.financial_status, "PENDING");
      assert.equal(row.delivered_at, null);
      assert.equal(row.actual_amount_collected, null);

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);
      const history = await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "DELIVERED" } });
      assert.equal(history, 0);

      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 0);
      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));

      await prisma.driver_cash_accounts.create({ data: { driver_id: driver.driverId } });
    });

    test("16. forced product-revenue idempotency collision -> full rollback (including Driver Cash)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-product-collision");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.company_financial_transactions.create({
        data: {
          type: "COMPANY_ORDER_PRODUCT_REVENUE",
          amount: new Prisma.Decimal("1.00"),
          idempotency_key: `delivery:${orderId}:company-product-revenue`,
        },
      });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.ok([409, 500].includes(res.status), JSON.stringify(res.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY", "colliding on the product revenue key must roll back the whole transaction");
      assert.equal(row.financial_status, "PENDING");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);

      // Driver Cash ran before the product-revenue step — must be rolled
      // back too.
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "0");
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 0);

      // No fee-revenue row was ever created (product revenue failed first).
      const feeTxCount = await prisma.company_financial_transactions.count({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTxCount, 0);

      // Only the one deliberately pre-seeded collision row remains.
      const collisionRows = await prisma.company_financial_transactions.findMany({
        where: { idempotency_key: `delivery:${orderId}:company-product-revenue` },
      });
      assert.equal(collisionRows.length, 1);
      assert.equal(collisionRows[0].amount.toString(), "1");

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0);

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));

      await prisma.company_financial_transactions.deleteMany({
        where: { idempotency_key: `delivery:${orderId}:company-product-revenue` },
      });
    });

    test("17. forced fee-revenue idempotency collision -> full rollback (product revenue AND Driver Cash roll back too)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-fee-collision");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.company_financial_transactions.create({
        data: {
          type: "DELIVERY_FEE_REVENUE",
          amount: new Prisma.Decimal("1.00"),
          idempotency_key: `delivery:${orderId}:delivery-fee-revenue`,
        },
      });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.ok([409, 500].includes(res.status), JSON.stringify(res.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY");
      assert.equal(row.financial_status, "PENDING");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);

      // Product revenue was created EARLIER in the same transaction than
      // the fee-revenue step — proving ordering cannot leave a partial
      // Company Finance posting.
      const productTxCount = await prisma.company_financial_transactions.count({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTxCount, 0);

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "0");
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 0);

      const collisionRows = await prisma.company_financial_transactions.findMany({
        where: { idempotency_key: `delivery:${orderId}:delivery-fee-revenue` },
      });
      assert.equal(collisionRows.length, 1);
      assert.equal(collisionRows[0].amount.toString(), "1");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));

      await prisma.company_financial_transactions.deleteMany({
        where: { idempotency_key: `delivery:${orderId}:delivery-fee-revenue` },
      });
    });
  });

  // ============================================================
  // 19-21. DUPLICATE / CONCURRENCY
  // ============================================================

  describe("Duplicate / concurrency protection", () => {
    test("19. sequential duplicate deliver cannot double-post", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-seq-dup");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const first = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const second = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(second.status, 400, JSON.stringify(second.body));

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 1);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 2, "exactly one product revenue row and one fee revenue row");
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 1);

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });

    test("20. concurrent deliver vs deliver posts exactly once", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-conc-dup");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 1);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 2);

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTx.amount.toString(), "100");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });

    test("21. deliver vs fail: exactly one outcome, zero finance from the loser", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-conc-fail-dup");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const [deliverRes, failRes] = await Promise.all([
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonId }),
      ]);
      const statuses = [deliverRes.status, failRes.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });

      if (row.status === "DELIVERED") {
        assert.equal(cashTxCount, 1);
        assert.equal(companyTxCount, 2);
      } else {
        assert.equal(row.status, "FAILED_DELIVERY");
        assert.equal(cashTxCount, 0);
        assert.equal(companyTxCount, 0);
      }

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });
  });

  // ============================================================
  // 22-27. REGRESSION BOUNDARIES
  // ============================================================

  describe("Regression boundaries", () => {
    test("22. exact DELIVERY_ONLY still credits the wallet correctly (Phase 8.3 unaffected)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-delivery-only-regression");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "DELIVERY_ONLY" });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100");
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");

      const productTxCount = await prisma.company_financial_transactions.count({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productTxCount, 0, "DELIVERY_ONLY must never create a COMPANY_ORDER_PRODUCT_REVENUE row"); // 25
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeTx.amount.toString(), "5");

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditRows[0].action, "DELIVERY_ONLY_FINANCE_FINALIZED");
    });

    test("23. COMPANY_ORDER collection difference remains REVIEW_REQUIRED, Driver Cash records actual, zero Wallet/Company allocation (Phase 8.7)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-company-diff");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "COMPANY_ORDER" });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "REVIEW_REQUIRED");
      assert.equal(orderRow.needs_financial_review, true);
      assert.equal(orderRow.collection_difference_reason, "shortage");
      assert.equal(orderRow.remaining_order_amount.toString(), "100", "no split is ever guessed — remaining amounts untouched");
      assert.equal(orderRow.remaining_delivery_fee.toString(), "5");

      await assertNoFinanceSideEffects([orderId], customerId, driver.driverId, 1);
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95", "Driver Cash records the actual amount, never the guessed expected split");
    });

    test("24. DELIVERY_ONLY collection difference remains REVIEW_REQUIRED, Driver Cash records actual, zero Wallet/Company allocation (Phase 8.7)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-delivery-only-diff");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "DELIVERY_ONLY" });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "110.00", collectionDifferenceReason: "overpaid" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "REVIEW_REQUIRED");

      await assertNoFinanceSideEffects([orderId], customerId, driver.driverId, 1);
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "110");
    });

    test("26-27. no payout/settlement/adjustment/reversal row is ever created by an exact Company Order /deliver", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-boundary-rows");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const payouts = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payouts, 0);
      const settlements = await prisma.driver_settlements.count({ where: { driver_id: driver.driverId } });
      assert.equal(settlements, 0);
      const companyAdjustmentsOrReversals = await prisma.company_financial_transactions.count({
        where: { order_id: orderId, type: { in: ["ADJUSTMENT", "REVERSAL"] } },
      });
      assert.equal(companyAdjustmentsOrReversals, 0);
      const cashAdjustmentsOrReversals = await prisma.driver_cash_transactions.count({
        where: { order_id: orderId, type: { in: ["ADJUSTMENT", "REVERSAL", "SETTLEMENT"] } },
      });
      assert.equal(cashAdjustmentsOrReversals, 0);
    });
  });

  // ============================================================
  // 28-30. REPRESENTATION
  // ============================================================

  describe("Management / Driver representation", () => {
    test("28. Management order detail reflects FINALIZED financial status after exact Company Order delivery", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-mgmt-repr");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const detail = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "DELIVERED");
      assert.equal(detail.body.data.financialStatus, "FINALIZED");
      assert.equal(detail.body.data.financial.needsFinancialReview, false);
    });

    test("29. Driver's own cash page shows the Company Order collection, no Company Finance internals leaked", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-cash-repr");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const cashPage = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(cashPage.status, 200, JSON.stringify(cashPage.body));
      assert.equal(cashPage.body.data.account.currentBalance, "105");
      const entry = cashPage.body.data.transactions.find((t: { order: { id: string } | null }) => t.order?.id === orderId);
      assert.ok(entry);
      assert.equal(entry.type, "COLLECTION");
      assert.equal(entry.amount, "105");
      const raw = JSON.stringify(cashPage.body);
      assert.equal(raw.includes("PRODUCT_REVENUE"), false, "Driver cash page must never leak Company Finance internals");
      assert.equal(raw.includes("wallet"), false);
    });

    test("30. inactive Customer does not block exact Company Order finalization", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-inactive-customer");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.customers.update({ where: { id: customerId }, data: { is_active: false } });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");

      await assertZeroWalletImpact(customerId, orderId, new Prisma.Decimal(0));
    });
  });
});
