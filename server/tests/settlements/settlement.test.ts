import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { runDriverCashTransaction } from "../../src/modules/driver-cash/driver-cash-ledger.service";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestDriverRecord,
  cleanupTestOrder,
  cleanupTestPaymentMethod,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedDriverRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Driver Settlements (Phase 8.6)
//
// A settlement means the Driver hands physical cash back to the company:
// Driver Cash decreases, Customer Wallet/Company Finance/Orders are
// untouched. This suite exercises POST /api/v1/driver-settlements +
// GET /api/v1/driver-settlements end to end, reusing the approved Phase 8.1
// debitDriverSettlement ledger primitive.
// ============================================================

describe("Driver Settlements (Phase 8.6)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let inactiveMethodId: string;

  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdAreaIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverActor.email, driverActor.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      driver: driverLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const inactive = await prisma.payment_methods.create({
      data: { code: `PH86-INACTIVE-${uniqueSuffix()}`, name: "Phase86 Inactive Method", is_active: false },
    });
    inactiveMethodId = inactive.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestPaymentMethod(inactiveMethodId);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function createDriverWithAccount(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const driverId = await seedDriverRecord(user.id, { driverNumber: `PH86-DRV-${label}-${uniqueSuffix()}` });
    createdDriverIds.push(driverId);
    return driverId;
  }

  async function fundDriverCash(driverId: string, amount: string) {
    await runDriverCashTransaction({ driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal(amount) });
  }

  async function getCashAccount(driverId: string) {
    return prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
  }

  function settlementsPath(qs = "") {
    return `/api/v1/driver-settlements${qs}`;
  }

  // Phase 8.9: every POST now requires an Idempotency-Key header. Each call
  // gets a FRESH default key so pre-existing tests (each expecting an
  // independent logical settlement) are unaffected — pass idempotencyKey
  // explicitly only when a test deliberately wants to replay/collide.
  async function postSettlement(token: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(app).post(settlementsPath()).set(auth(token)).set("Idempotency-Key", idempotencyKey).send(body);
  }

  // ------------------------------------------------------------
  // End-to-end helpers (own local copies, mirroring
  // delivery-only-finance.test.ts / company-order-finance.test.ts) — used
  // only by the two dedicated Delivery Only / Company Order reconciliation
  // tests below.
  // ------------------------------------------------------------

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
      .send({ driverNumber: `PH86-DRV-${uniqueSuffix()}`, userId: user.id });
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
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase86 Receiver",
        receiverPhone: "+96170000086",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase86 St",
        description: "Phase86 settlement order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function deliverOrder(
    customerId: string,
    driverToken: string,
    driverId: string,
    overrides: Record<string, unknown> = {},
    actualAmountCollected = "105.00"
  ) {
    const order = await createBaseOrder(customerId, overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const deliver = await request(app)
      .post(`/api/v1/driver/orders/${order.id}/deliver`)
      .set(auth(driverToken))
      .send({ actualAmountCollected });
    assert.equal(deliver.status, 200, JSON.stringify(deliver.body));
    return order.id as string;
  }

  // ============================================================
  // RBAC (1-9)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated GET -> 401", async () => {
      const res = await request(app).get(settlementsPath());
      assert.equal(res.status, 401);
    });

    test("2. unauthenticated POST -> 401", async () => {
      const res = await postSettlement("", { driverId: admin.id, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 401);
    });

    test("3-4. ADMIN GET/POST allowed", async () => {
      const driverId = await createDriverWithAccount("admin-rbac");
      await fundDriverCash(driverId, "50");
      const list = await request(app).get(settlementsPath()).set(auth(tokens.admin));
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const post = await postSettlement(tokens.admin, { driverId, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 201, JSON.stringify(post.body));
    });

    test("5-6. FINANCE GET/POST allowed", async () => {
      const driverId = await createDriverWithAccount("finance-rbac");
      await fundDriverCash(driverId, "50");
      const list = await request(app).get(settlementsPath()).set(auth(tokens.finance));
      assert.equal(list.status, 200);
      const post = await postSettlement(tokens.finance, { driverId, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 201, JSON.stringify(post.body));
    });

    test("7. DISPATCHER -> 403 (GET and POST)", async () => {
      const list = await request(app).get(settlementsPath()).set(auth(tokens.dispatcher));
      assert.equal(list.status, 403);
      const post = await postSettlement(tokens.dispatcher, { driverId: admin.id, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 403);
    });

    test("8. DRIVER -> 403 (driver.cash.read_own is not settlements.read)", async () => {
      const list = await request(app).get(settlementsPath()).set(auth(tokens.driver));
      assert.equal(list.status, 403);
      const post = await postSettlement(tokens.driver, { driverId: admin.id, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 403);
    });

    test("9. CUSTOMER -> 403", async () => {
      const list = await request(app).get(settlementsPath()).set(auth(tokens.customer));
      assert.equal(list.status, 403);
      const post = await postSettlement(tokens.customer, { driverId: admin.id, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 403);
    });
  });

  // ============================================================
  // VALIDATION (10-19)
  // ============================================================

  describe("Validation", () => {
    test("10. malformed driverId -> 400", async () => {
      const res = await postSettlement(tokens.admin, { driverId: "not-a-uuid", amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 400);
    });

    test("11. nonexistent Driver -> 404", async () => {
      const res = await postSettlement(tokens.admin, {
        driverId: "00000000-0000-0000-0000-000000000000",
        amountReceived: "10",
        paymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 404);
    });

    test("12. inactive Driver with cash can still settle", async () => {
      const driverId = await createDriverWithAccount("inactive");
      await fundDriverCash(driverId, "50");
      await prisma.drivers.update({ where: { id: driverId }, data: { is_active: false } });
      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "20", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });

    test("13-16. amount validation: zero, negative, >2 decimals, overflow all rejected", async () => {
      const driverId = await createDriverWithAccount("amount-validation");
      await fundDriverCash(driverId, "1000");

      const zero = await postSettlement(tokens.admin, { driverId, amountReceived: "0", paymentMethodId: cashMethodId });
      assert.equal(zero.status, 400);
      const negative = await postSettlement(tokens.admin, { driverId, amountReceived: "-10", paymentMethodId: cashMethodId });
      assert.equal(negative.status, 400);
      const tooManyDecimals = await postSettlement(tokens.admin, { driverId, amountReceived: "100.001", paymentMethodId: cashMethodId });
      assert.equal(tooManyDecimals.status, 400);
      const overflow = await postSettlement(tokens.admin, {
        driverId,
        amountReceived: "999999999999999.99",
        paymentMethodId: cashMethodId,
      });
      assert.equal(overflow.status, 400);

      const count = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(count, 0, "no settlement row from any rejected request");
    });

    test("17. malformed paymentMethodId -> 400", async () => {
      const driverId = await createDriverWithAccount("bad-method-uuid");
      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "10", paymentMethodId: "not-a-uuid" });
      assert.equal(res.status, 400);
    });

    test("18. nonexistent payment method -> 400", async () => {
      const driverId = await createDriverWithAccount("missing-method");
      const res = await postSettlement(tokens.admin, {
        driverId,
        amountReceived: "10",
        paymentMethodId: "00000000-0000-0000-0000-000000000000",
      });
      assert.equal(res.status, 400);
    });

    test("19. inactive payment method -> 400", async () => {
      const driverId = await createDriverWithAccount("inactive-method");
      await fundDriverCash(driverId, "100");
      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "10", paymentMethodId: inactiveMethodId });
      assert.equal(res.status, 400);
      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "100", "rejected settlement must not touch Driver Cash");
    });
  });

  // ============================================================
  // BASIC SETTLEMENT (20-30)
  // ============================================================

  describe("Basic settlement", () => {
    test("20. full settlement: cash 1000, settle 1000 -> balance 0", async () => {
      const driverId = await createDriverWithAccount("full");
      await fundDriverCash(driverId, "1000");
      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "1000.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "0");
    });

    test("21-30. partial settlement: fields, linkage, snapshots, actor, payment method, number, notes all correct", async () => {
      const driverId = await createDriverWithAccount("partial");
      await fundDriverCash(driverId, "1245");

      const res = await postSettlement(tokens.finance, {
        driverId,
        amountReceived: "1000.00",
        paymentMethodId: cashMethodId,
        notes: "phase86 handover",
      });
      assert.equal(res.status, 201, JSON.stringify(res.body)); // 22

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "245"); // 21

      assert.equal(res.body.data.balanceBefore, "1245");
      assert.equal(res.body.data.amountReceived, "1000");
      assert.equal(res.body.data.balanceAfter, "245");
      assert.equal(res.body.data.driver.id, driverId);
      assert.equal(res.body.data.paymentMethod.id, cashMethodId); // 28
      assert.equal(res.body.data.receivedBy.id, finance.id); // 26
      assert.equal(res.body.data.notes, "phase86 handover"); // 30
      assert.ok(res.body.data.settlementNumber && res.body.data.settlementNumber.length > 0); // 29

      const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: res.body.data.id } });
      assert.equal(cashTx.type, "SETTLEMENT"); // 23
      assert.equal(cashTx.amount.toString(), "1000"); // 24 positive magnitude
      assert.equal(cashTx.balance_before.toString(), "1245"); // 25
      assert.equal(cashTx.balance_after.toString(), "245"); // 25
      assert.equal(cashTx.created_by_id, finance.id); // 27
      assert.equal(cashTx.driver_id, driverId);
    });

    test("settlement_number is unique across two settlements for the same driver", async () => {
      const driverId = await createDriverWithAccount("unique-number");
      await fundDriverCash(driverId, "200");
      const first = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });
      const second = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });
      assert.notEqual(first.body.data.settlementNumber, second.body.data.settlementNumber);
    });
  });

  // ============================================================
  // ZERO DRIVER CASH (extra)
  // ============================================================

  describe("Zero driver cash", () => {
    test("any positive settlement against a zero-balance Driver is rejected", async () => {
      const driverId = await createDriverWithAccount("zero-cash");
      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "1.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      const count = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(count, 0);
    });
  });

  // ============================================================
  // INSUFFICIENT BALANCE (31-35)
  // ============================================================

  describe("Insufficient balance", () => {
    test("31-35. cash 100, settle 101 -> rejected, nothing persisted, cash unchanged", async () => {
      const driverId = await createDriverWithAccount("insufficient");
      await fundDriverCash(driverId, "100");

      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "101.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 400, JSON.stringify(res.body)); // 31

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 0); // 32
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId, type: "SETTLEMENT" } });
      assert.equal(cashTxCount, 0); // 33
      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "100"); // 34
      // No audit row can exist: audit entity_id is always a real
      // driver_settlements.id (see settlement.service.ts), and
      // settlementCount above already proves none was created. // 35
    });
  });

  // ============================================================
  // CONCURRENCY (36-37)
  // ============================================================

  describe("Concurrency", () => {
    test("36. balance 100, concurrent 80+80 -> exactly one succeeds, final balance 20", async () => {
      const driverId = await createDriverWithAccount("conc-overspend");
      await fundDriverCash(driverId, "100");

      const [a, b] = await Promise.all([
        postSettlement(tokens.admin, { driverId, amountReceived: "80.00", paymentMethodId: cashMethodId }),
        postSettlement(tokens.admin, { driverId, amountReceived: "80.00", paymentMethodId: cashMethodId }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "20");
      assert.ok(!account.current_balance.isNegative());

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId, type: "SETTLEMENT" } });
      assert.equal(cashTxCount, 1);
    });

    test("37. balance 100, concurrent 60+40 -> both may succeed, final 0, snapshots reconcile with the ledger", async () => {
      const driverId = await createDriverWithAccount("conc-fit");
      await fundDriverCash(driverId, "100");

      const [a, b] = await Promise.all([
        postSettlement(tokens.admin, { driverId, amountReceived: "60.00", paymentMethodId: cashMethodId }),
        postSettlement(tokens.admin, { driverId, amountReceived: "40.00", paymentMethodId: cashMethodId }),
      ]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "0");

      const settlements = await prisma.driver_settlements.findMany({
        where: { driver_id: driverId },
        orderBy: { balance_before: "desc" },
      });
      assert.equal(settlements.length, 2);
      assert.equal(settlements[0].balance_before.toString(), "100");
      assert.equal(settlements[0].balance_after.toString(), settlements[1].balance_before.toString());
      assert.equal(settlements[1].balance_after.toString(), "0");

      // MANDATORY: each settlement's snapshot triple must exactly match its
      // own linked cash transaction — never a stale/impossible combination.
      for (const settlement of settlements) {
        const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settlement.id } });
        assert.equal(cashTx.balance_before.toString(), settlement.balance_before.toString());
        assert.equal(cashTx.amount.toString(), settlement.amount_received.toString());
        assert.equal(cashTx.balance_after.toString(), settlement.balance_after.toString());
      }
    });

    test("concurrent COLLECTION +50 and SETTLEMENT -80 serialize coherently (final 70)", async () => {
      const driverId = await createDriverWithAccount("conc-mixed");
      await fundDriverCash(driverId, "100");

      const [collectionResult, settlementRes] = await Promise.all([
        runDriverCashTransaction({ driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("50.00") }),
        postSettlement(tokens.admin, { driverId, amountReceived: "80.00", paymentMethodId: cashMethodId }),
      ]);
      assert.equal(settlementRes.status, 201, JSON.stringify(settlementRes.body));
      assert.ok(collectionResult.transaction.id);

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "70");
    });
  });

  // ============================================================
  // MONEY / ORDER SEPARATION (38-42)
  // ============================================================

  describe("Money separation", () => {
    test("38-41. Customer Wallet, Customer Payouts, and Company Finance are all completely unaffected", async () => {
      const driverId = await createDriverWithAccount("sep");
      await fundDriverCash(driverId, "200");
      const customerId = await freshCustomer();

      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      const walletTxBefore = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      const payoutsBefore = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      // company_financial_transactions has no settlement-scoped column, but
      // created_by_id is safe here: `admin` is this file's own dedicated
      // User, used by no other concurrently-running test file/module.
      const companyBefore = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });

      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "75.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), walletBefore.available_balance.toString()); // 38
      const walletTxAfter = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      assert.equal(walletTxAfter, walletTxBefore); // 39
      const payoutsAfter = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutsAfter, payoutsBefore); // 40
      const companyAfter = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      assert.equal(companyAfter, companyBefore); // 41
      assert.equal(companyAfter, 0);
    });

    test("42. no Orders/delivery_attempts/order_status_history are touched by a settlement", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("orders-unchanged");
      // A real delivered Order is what already put cash in this Driver's
      // account — proving settlement leaves it untouched is more meaningful
      // than settling cash from an unrelated internal fixture.
      const orderId = await deliverOrder(customerId, driver.token, driver.driverId);
      const orderBefore = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const attemptsBefore = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      const historyBefore = await prisma.order_status_history.count({ where: { order_id: orderId } });

      const res = await postSettlement(tokens.admin, { driverId: driver.driverId, amountReceived: "20.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.deepEqual(orderAfter, orderBefore);
      const attemptsAfter = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attemptsAfter, attemptsBefore);
      const historyAfter = await prisma.order_status_history.count({ where: { order_id: orderId } });
      assert.equal(historyAfter, historyBefore);
    });
  });

  // ============================================================
  // END-TO-END ACCOUNTING (43-44)
  // ============================================================

  describe("End-to-end accounting", () => {
    test("43. DELIVERY_ONLY delivery then full settlement: Driver 105->0, Wallet stays 100, Company fee stays 5", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-e2e-delivery-only");
      const orderId = await deliverOrder(customerId, driver.token, driver.driverId, { orderType: "DELIVERY_ONLY" });

      const cashBefore = await getCashAccount(driver.driverId);
      assert.equal(cashBefore.current_balance.toString(), "105");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100");
      const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeRevenue.amount.toString(), "5");

      const res = await postSettlement(tokens.admin, { driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const cashAfter = await getCashAccount(driver.driverId);
      assert.equal(cashAfter.current_balance.toString(), "0");
      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), "100", "settlement must not touch the customer wallet");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      assert.equal(walletTxCount, 1, "still only the original ORDER_CREDIT — settlement creates zero wallet transactions");
      const feeRevenueCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(feeRevenueCount, 1, "still only the original DELIVERY_FEE_REVENUE — settlement creates zero company rows");

      const settlementCashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: res.body.data.id } });
      assert.equal(settlementCashTx.amount.toString(), "105");
    });

    test("44. COMPANY_ORDER delivery then full settlement: Driver 45->0, Company revenue rows unchanged, Wallet unchanged", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-e2e-company-order");
      const orderId = await deliverOrder(
        customerId,
        driver.token,
        driver.driverId,
        { orderType: "COMPANY_ORDER", orderAmount: "40.00", deliveryFee: "5.00" },
        "45.00"
      );

      const cashBefore = await getCashAccount(driver.driverId);
      assert.equal(cashBefore.current_balance.toString(), "45");
      const productRevenue = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      assert.equal(productRevenue.amount.toString(), "40");
      const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      assert.equal(feeRevenue.amount.toString(), "5");
      const walletTxCountBefore = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCountBefore, 0);

      const res = await postSettlement(tokens.admin, { driverId: driver.driverId, amountReceived: "45.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const cashAfter = await getCashAccount(driver.driverId);
      assert.equal(cashAfter.current_balance.toString(), "0");
      const companyRowsAfter = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyRowsAfter, 2, "still exactly product + fee revenue — settlement creates zero new company rows");
      const productAfter = await prisma.company_financial_transactions.findUniqueOrThrow({ where: { id: productRevenue.id } });
      assert.equal(productAfter.amount.toString(), "40", "original revenue row is untouched");
      const walletTxCountAfter = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCountAfter, 0, "a COMPANY_ORDER settlement must never create a wallet transaction");
    });
  });

  // ============================================================
  // LIST (45-56)
  // ============================================================

  describe("Settlement list", () => {
    test("45. GET returns the new settlement", async () => {
      const driverId = await createDriverWithAccount("list-basic");
      await fundDriverCash(driverId, "50");
      const created = await postSettlement(tokens.admin, { driverId, amountReceived: "25.00", paymentMethodId: cashMethodId });
      const list = await request(app).get(settlementsPath()).set(auth(tokens.admin));
      assert.equal(list.status, 200);
      const found = list.body.data.find((s: { id: string }) => s.id === created.body.data.id);
      assert.ok(found);
    });

    test("46-49. money as strings, safe driver/paymentMethod/receivedBy summaries", async () => {
      const driverId = await createDriverWithAccount("list-dto");
      await fundDriverCash(driverId, "50");
      const created = await postSettlement(tokens.admin, { driverId, amountReceived: "25.00", paymentMethodId: cashMethodId });
      const list = await request(app).get(settlementsPath(`?driverId=${driverId}`)).set(auth(tokens.admin));
      const row = list.body.data.find((s: { id: string }) => s.id === created.body.data.id);
      assert.ok(row);
      assert.equal(typeof row.balanceBefore, "string"); // 46
      assert.equal(typeof row.amountReceived, "string");
      assert.equal(typeof row.balanceAfter, "string");
      assert.ok(row.driver.driverNumber && row.driver.user); // 47
      assert.ok(row.paymentMethod.code); // 48
      assert.ok(row.receivedBy.firstName); // 49
    });

    test("50-52. pagination defaults, explicit page/limit, max>100 rejected", async () => {
      const defaultPage = await request(app).get(settlementsPath()).set(auth(tokens.admin));
      assert.equal(defaultPage.body.meta.page, 1);
      assert.equal(defaultPage.body.meta.limit, 20);

      const explicit = await request(app).get(settlementsPath("?page=1&limit=5")).set(auth(tokens.admin));
      assert.equal(explicit.status, 200);
      assert.equal(explicit.body.meta.limit, 5);
      assert.ok(explicit.body.data.length <= 5);

      const tooLarge = await request(app).get(settlementsPath("?limit=101")).set(auth(tokens.admin));
      assert.equal(tooLarge.status, 400);
    });

    test("53. newest-first deterministic ordering", async () => {
      const driverId = await createDriverWithAccount("ordering");
      await fundDriverCash(driverId, "100");
      const a = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });
      const b = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });

      const list = await request(app).get(settlementsPath(`?driverId=${driverId}`)).set(auth(tokens.admin));
      const ids = list.body.data.map((s: { id: string }) => s.id);
      assert.deepEqual(ids, [b.body.data.id, a.body.data.id]);
    });

    test("54-55. driverId filter and search filter", async () => {
      const driverId = await createDriverWithAccount("filter");
      await fundDriverCash(driverId, "50");
      const created = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });

      const byDriver = await request(app).get(settlementsPath(`?driverId=${driverId}`)).set(auth(tokens.admin));
      assert.equal(byDriver.body.data.length, 1);
      assert.equal(byDriver.body.data[0].id, created.body.data.id);

      const bySearch = await request(app)
        .get(settlementsPath(`?search=${encodeURIComponent(created.body.data.settlementNumber)}`))
        .set(auth(tokens.admin));
      assert.ok(bySearch.body.data.some((s: { id: string }) => s.id === created.body.data.id));
    });

    test("56. no private/auth/internal ledger fields leak", async () => {
      const res = await request(app).get(settlementsPath("?limit=5")).set(auth(tokens.admin));
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /wallet/i);
      assert.doesNotMatch(serialized, /company_financial/i);
    });
  });

  // ============================================================
  // DRIVER OWN CASH INTEGRATION (57-59)
  // ============================================================

  describe("Driver own cash integration", () => {
    test("57-59. the linked Driver's own /driver/me/cash reflects the reduced balance and the SETTLEMENT row", async () => {
      const driver = await createDriverWithToken("driver-own-cash");
      await fundDriverCash(driver.driverId, "200");

      const settlement = await postSettlement(tokens.admin, {
        driverId: driver.driverId,
        amountReceived: "150.00",
        paymentMethodId: cashMethodId,
      });
      assert.equal(settlement.status, 201, JSON.stringify(settlement.body));

      const cashPage = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(cashPage.status, 200, JSON.stringify(cashPage.body));
      assert.equal(cashPage.body.data.account.currentBalance, "50"); // 57
      const entry = cashPage.body.data.transactions.find((t: { type: string }) => t.type === "SETTLEMENT"); // 58
      assert.ok(entry);
      assert.equal(entry.amount, "150");
      assert.ok(entry.settlement); // 59 — the Phase 8.1 DTO's safe settlement summary relation
      assert.equal(entry.settlement.id, settlement.body.data.id);
      const raw = JSON.stringify(cashPage.body);
      assert.equal(raw.includes("receivedBy"), false, "Driver cash page must not leak Management-only settlement fields");
    });
  });

  // ============================================================
  // APPEND-ONLY (60-63)
  // ============================================================

  describe("Append-only", () => {
    test("60-61. no public PATCH/DELETE settlement route", async () => {
      const driverId = await createDriverWithAccount("immutable");
      await fundDriverCash(driverId, "50");
      const created = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });

      const patchAttempt = await request(app)
        .patch(`/api/v1/driver-settlements/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ amountReceived: "999" });
      assert.equal(patchAttempt.status, 404);
      const deleteAttempt = await request(app).delete(`/api/v1/driver-settlements/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(deleteAttempt.status, 404);
    });

    test("62. later cash transactions never rewrite the settlement-linked cash transaction", async () => {
      const driverId = await createDriverWithAccount("immutable-tx");
      await fundDriverCash(driverId, "100");
      const created = await postSettlement(tokens.admin, { driverId, amountReceived: "20.00", paymentMethodId: cashMethodId });
      const linked = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: created.body.data.id } });
      const snapshot = { ...linked };

      await fundDriverCash(driverId, "5");
      const after = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: linked.id } });
      assert.deepEqual(after, snapshot);
    });

    test("63. the settlement row itself remains unchanged after a later collection/settlement", async () => {
      const driverId = await createDriverWithAccount("immutable-settlement");
      await fundDriverCash(driverId, "200");
      const first = await postSettlement(tokens.admin, { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId });
      const snapshot = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: first.body.data.id } });

      await fundDriverCash(driverId, "10");
      await postSettlement(tokens.admin, { driverId, amountReceived: "5.00", paymentMethodId: cashMethodId });

      const after = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: first.body.data.id } });
      assert.deepEqual(after, snapshot);
    });
  });

  // ============================================================
  // AUDIT (64-68)
  // ============================================================

  describe("Audit", () => {
    test("64-67. exactly one correct audit row on success", async () => {
      const driverId = await createDriverWithAccount("audit");
      await fundDriverCash(driverId, "80");
      const res = await postSettlement(tokens.finance, { driverId, amountReceived: "30.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: res.body.data.id } });
      assert.equal(auditRows.length, 1); // 64
      assert.equal(auditRows[0].actor_user_id, finance.id); // 65
      assert.equal(auditRows[0].action, "DRIVER_SETTLEMENT_COMPLETED"); // 66
      const metadata = auditRows[0].metadata as Record<string, unknown>;
      assert.equal(metadata.driverId, driverId); // 67
      assert.ok(metadata.cashTransactionId);
    });

    test("68. rollback path (missing cash account) leaves zero audit rows", async () => {
      const driverId = await createDriverWithAccount("audit-rollback");
      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driverId } });

      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 0);
      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "DRIVER_SETTLEMENT" } });
      for (const row of auditRows) {
        const settlement = await prisma.driver_settlements.findUnique({ where: { id: row.entity_id } });
        assert.notEqual(settlement?.driver_id, driverId);
      }

      await prisma.driver_cash_accounts.create({ data: { driver_id: driverId } });
    });
  });
});
