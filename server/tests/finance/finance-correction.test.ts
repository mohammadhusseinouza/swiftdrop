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
import { runWalletTransaction } from "../../src/modules/wallets/wallet-ledger.service";
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
// Driver Cash + Company Finance Adjustments/Reversals (Phase 8.8)
//
// POST /api/v1/finance/driver-cash/:driverId/adjust
// POST /api/v1/finance/driver-cash-transactions/:transactionId/reverse
// POST /api/v1/finance/company/adjust
// POST /api/v1/finance/company-transactions/:transactionId/reverse
// ============================================================

describe("Driver Cash + Company Finance Corrections (Phase 8.8)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;
  let areaActive: { id: string; name: string };
  let cashMethodId: string;

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
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH88-DRV-${uniqueSuffix()}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  async function fundDriverCash(driverId: string, amount: string) {
    return runDriverCashTransaction({ driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal(amount) });
  }

  async function getCashAccount(driverId: string) {
    return prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
  }

  async function freshCustomer() {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function deliverExactCompanyOrder(customerId: string, driverToken: string, driverId: string) {
    const orderRes = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "COMPANY_ORDER",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase88 Receiver",
        receiverPhone: "+96170000088",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase88 St",
        description: "Phase88 correction order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
      });
    assert.equal(orderRes.status, 201, JSON.stringify(orderRes.body));
    const orderId = orderRes.body.data.id as string;
    createdOrderIds.push(orderId);

    const assign = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const deliver = await request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(driverToken)).send({ actualAmountCollected: "105.00" });
    assert.equal(deliver.status, 200, JSON.stringify(deliver.body));
    return orderId;
  }

  function adjustDriverCashPath(driverId: string) {
    return `/api/v1/finance/driver-cash/${driverId}/adjust`;
  }
  function reverseDriverCashPath(transactionId: string) {
    return `/api/v1/finance/driver-cash-transactions/${transactionId}/reverse`;
  }
  function adjustCompanyPath() {
    return `/api/v1/finance/company/adjust`;
  }
  function reverseCompanyPath(transactionId: string) {
    return `/api/v1/finance/company-transactions/${transactionId}/reverse`;
  }

  async function postAdjustDriverCash(token: string, driverId: string, body: Record<string, unknown>) {
    return request(app).post(adjustDriverCashPath(driverId)).set(auth(token)).send(body);
  }
  async function postReverseDriverCash(token: string, transactionId: string, body: Record<string, unknown>) {
    return request(app).post(reverseDriverCashPath(transactionId)).set(auth(token)).send(body);
  }
  async function postAdjustCompany(token: string, body: Record<string, unknown>) {
    return request(app).post(adjustCompanyPath()).set(auth(token)).send(body);
  }
  async function postReverseCompany(token: string, transactionId: string, body: Record<string, unknown>) {
    return request(app).post(reverseCompanyPath(transactionId)).set(auth(token)).send(body);
  }

  // ============================================================
  // RBAC
  // ============================================================

  describe("RBAC", () => {
    test("unauthenticated -> 401 for all four endpoints", async () => {
      const id = "00000000-0000-0000-0000-000000000000";
      assert.equal((await request(app).post(adjustDriverCashPath(id)).send({})).status, 401);
      assert.equal((await request(app).post(reverseDriverCashPath(id)).send({})).status, 401);
      assert.equal((await request(app).post(adjustCompanyPath()).send({})).status, 401);
      assert.equal((await request(app).post(reverseCompanyPath(id)).send({})).status, 401);
    });

    test("ADMIN and FINANCE allowed; DISPATCHER/CUSTOMER forbidden for driver-cash adjust", async () => {
      const driver = await createDriverWithToken("driver-rbac-cash");
      const body = { direction: "CREDIT", amount: "10.00", reason: "rbac" };
      const asAdmin = await postAdjustDriverCash(tokens.admin, driver.driverId, body);
      assert.equal(asAdmin.status, 201, JSON.stringify(asAdmin.body));
      const asFinance = await postAdjustDriverCash(tokens.finance, driver.driverId, body);
      assert.equal(asFinance.status, 201, JSON.stringify(asFinance.body));
      const asDispatcher = await postAdjustDriverCash(tokens.dispatcher, driver.driverId, body);
      assert.equal(asDispatcher.status, 403);
      const asCustomer = await postAdjustDriverCash(tokens.customer, driver.driverId, body);
      assert.equal(asCustomer.status, 403);
      const asDriverSelf = await postAdjustDriverCash(driver.token, driver.driverId, body);
      assert.equal(asDriverSelf.status, 403, "driver.cash.read_own must not authorize a Management correction");
    });

    test("ADMIN and FINANCE allowed; DISPATCHER/CUSTOMER forbidden for company adjust", async () => {
      const body = { direction: "CREDIT", amount: "10.00", reason: "rbac" };
      const asAdmin = await postAdjustCompany(tokens.admin, body);
      assert.equal(asAdmin.status, 201, JSON.stringify(asAdmin.body));
      const asFinance = await postAdjustCompany(tokens.finance, body);
      assert.equal(asFinance.status, 201, JSON.stringify(asFinance.body));
      const asDispatcher = await postAdjustCompany(tokens.dispatcher, body);
      assert.equal(asDispatcher.status, 403);
      const asCustomer = await postAdjustCompany(tokens.customer, body);
      assert.equal(asCustomer.status, 403);
    });
  });

  // ============================================================
  // DRIVER CASH ADJUSTMENT (8-12)
  // ============================================================

  describe("Driver Cash adjustment", () => {
    test("8. cash=100, CREDIT 50 -> 150", async () => {
      const driver = await createDriverWithToken("driver-cash-credit");
      await fundDriverCash(driver.driverId, "100");
      const res = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "50.00", reason: "found extra cash" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "ADJUSTMENT");
      assert.equal(res.body.data.amount, "50");
      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "150");
    });

    test("9. cash=100, DEBIT 40 -> 60", async () => {
      const driver = await createDriverWithToken("driver-cash-debit");
      await fundDriverCash(driver.driverId, "100");
      const res = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "DEBIT", amount: "40.00", reason: "shortfall correction" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "60");
    });

    test("10. debit beyond balance rejected", async () => {
      const driver = await createDriverWithToken("driver-cash-overdebit");
      await fundDriverCash(driver.driverId, "100");
      const res = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "DEBIT", amount: "101.00", reason: "too much" });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "100");
    });

    test("11. balanceBefore/After exact", async () => {
      const driver = await createDriverWithToken("driver-cash-snapshot");
      await fundDriverCash(driver.driverId, "245");
      const res = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "DEBIT", amount: "45.00", reason: "exact snapshot" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.balanceBefore, "245");
      assert.equal(res.body.data.balanceAfter, "200");
    });

    test("12. actor/reason/audit correct", async () => {
      const driver = await createDriverWithToken("driver-cash-audit");
      await fundDriverCash(driver.driverId, "100");
      const res = await postAdjustDriverCash(tokens.finance, driver.driverId, { direction: "CREDIT", amount: "15.00", reason: "reconciliation credit" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.createdBy.id, finance.id);
      assert.equal(res.body.data.notes, "reconciliation credit");

      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { action: "DRIVER_CASH_ADJUSTMENT_CREATED", entity_id: (await getCashAccount(driver.driverId)).id } });
      assert.equal(auditRow.actor_user_id, finance.id);
      const metadata = auditRow.metadata as Record<string, unknown>;
      assert.equal(metadata.direction, "CREDIT");
      assert.equal(metadata.amount, "15");
      assert.equal(metadata.reason, "reconciliation credit");
    });

    test("zero/negative/>2 decimals/blank-reason rejected", async () => {
      const driver = await createDriverWithToken("driver-cash-validation");
      await fundDriverCash(driver.driverId, "1000");
      assert.equal((await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "0", reason: "x" })).status, 400);
      assert.equal((await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "-5", reason: "x" })).status, 400);
      assert.equal((await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "5.001", reason: "x" })).status, 400);
      assert.equal((await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "10.00", reason: "  " })).status, 400);
    });
  });

  // ============================================================
  // COMPANY ADJUSTMENT (13-16)
  // ============================================================

  describe("Company adjustment", () => {
    test("13. CREDIT 50 creates ADJUSTMENT amount=+50", async () => {
      const res = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "50.00", reason: "misc company credit" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "ADJUSTMENT");
      assert.equal(res.body.data.amount, "50");
    });

    test("14. DEBIT 20 creates ADJUSTMENT amount=-20", async () => {
      const res = await postAdjustCompany(tokens.admin, { direction: "DEBIT", amount: "20.00", reason: "misc company debit" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.amount, "-20");
    });

    test("15. reason/actor/audit correct", async () => {
      const res = await postAdjustCompany(tokens.finance, { direction: "DEBIT", amount: "7.50", reason: "bank fee reconciliation" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.createdBy.id, finance.id);
      assert.equal(res.body.data.notes, "bank fee reconciliation");
      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { action: "COMPANY_FINANCIAL_ADJUSTMENT_CREATED", entity_id: res.body.data.id } });
      assert.equal(auditRow.actor_user_id, finance.id);
    });

    test("16. zero invalid", async () => {
      const res = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "0", reason: "x" });
      assert.equal(res.status, 400);
    });
  });

  // ============================================================
  // DRIVER COLLECTION REVERSAL (28-30)
  // ============================================================

  describe("Driver COLLECTION reversal", () => {
    test("28-29. reverse COLLECTION +100 -> cash back to original, original unchanged", async () => {
      const driver = await createDriverWithToken("driver-collection-reverse");
      const collection = await fundDriverCash(driver.driverId, "100");
      const snapshot = { ...collection.transaction };

      const res = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "duplicate collection entry" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "REVERSAL");
      assert.equal(res.body.data.amount, "100");

      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "0"); // 28

      const originalAfter = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: collection.transaction.id } });
      assert.deepEqual({ ...originalAfter }, snapshot); // 29
    });

    test("30. repeated reversal rejected", async () => {
      const driver = await createDriverWithToken("driver-collection-repeat");
      const collection = await fundDriverCash(driver.driverId, "100");
      const first = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "first" });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "second" });
      assert.equal(second.status, 409, JSON.stringify(second.body));
    });
  });

  // ============================================================
  // COLLECTION REVERSAL AFTER SETTLEMENT (31)
  // ============================================================

  describe("Collection reversal after settlement", () => {
    test("31. collection +100 then settlement -100 leaves cash=0; reversing the collection is rejected", async () => {
      const driver = await createDriverWithToken("driver-collection-after-settle");
      const collection = await fundDriverCash(driver.driverId, "100");
      const settlement = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ driverId: driver.driverId, amountReceived: "100.00", paymentMethodId: cashMethodId });
      assert.equal(settlement.status, 201, JSON.stringify(settlement.body));
      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "0");

      const res = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "would go negative" });
      assert.equal(res.status, 400, JSON.stringify(res.body));

      const reversalCount = await prisma.driver_cash_transactions.count({ where: { reversal_of_id: collection.transaction.id } });
      assert.equal(reversalCount, 0, "must not silently reverse the settlement too");
      const settlementRow = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: settlement.body.data.id } });
      assert.equal(settlementRow.amount_received.toString(), "100");
    });
  });

  // ============================================================
  // SETTLEMENT REVERSAL (32-35)
  // ============================================================

  describe("Settlement reversal", () => {
    test("32-35. reverse a SETTLEMENT cash tx -> cash restored, DriverSettlement row unchanged, audit records settlement reversal", async () => {
      const driver = await createDriverWithToken("driver-settlement-reverse");
      await fundDriverCash(driver.driverId, "100");
      const settlementRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ driverId: driver.driverId, amountReceived: "60.00", paymentMethodId: cashMethodId });
      assert.equal(settlementRes.status, 201, JSON.stringify(settlementRes.body));
      const settlementCashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settlementRes.body.data.id } });
      const settlementSnapshot = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: settlementRes.body.data.id } });
      const settlementRowSnapshot = { ...settlementSnapshot };

      const res = await postReverseDriverCash(tokens.admin, settlementCashTx.id, { reason: "settlement was recorded against the wrong driver" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.amount, "60");
      assert.equal(res.body.data.settlementId, null, "the reversal row must never copy the UNIQUE settlement_id relation");

      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "100"); // 32 — cash=100 restored

      const settlementRowAfter = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: settlementRes.body.data.id } });
      assert.deepEqual({ ...settlementRowAfter }, settlementRowSnapshot); // 33 — remains historical, unchanged

      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { action: "DRIVER_SETTLEMENT_REVERSED", entity_id: settlementRes.body.data.id } }); // 34
      assert.equal(auditRow.actor_user_id, admin.id);
      const metadata = auditRow.metadata as Record<string, unknown>;
      assert.equal(metadata.settlementId, settlementRes.body.data.id);

      const repeated = await postReverseDriverCash(tokens.admin, settlementCashTx.id, { reason: "repeat" }); // 35
      assert.equal(repeated.status, 409, JSON.stringify(repeated.body));
    });
  });

  // ============================================================
  // COMPANY REVENUE REVERSAL (36-38)
  // ============================================================

  describe("Company revenue reversal", () => {
    test("36-37. original DELIVERY_FEE_REVENUE +5, reverse -> REVERSAL -5, original unchanged", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-fee-revenue-reverse");
      const orderId = await deliverExactCompanyOrder(customerId, driver.token, driver.driverId);
      const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      const snapshot = { ...feeRevenue };

      const res = await postReverseCompany(tokens.admin, feeRevenue.id, { reason: "fee should not have been charged" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "REVERSAL");
      assert.equal(res.body.data.amount, "-5"); // 36

      const originalAfter = await prisma.company_financial_transactions.findUniqueOrThrow({ where: { id: feeRevenue.id } });
      assert.deepEqual({ ...originalAfter }, snapshot); // 37
    });

    test("38. PRODUCT_REVENUE +100, reverse -> REVERSAL -100", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-product-revenue-reverse");
      const orderId = await deliverExactCompanyOrder(customerId, driver.token, driver.driverId);
      const productRevenue = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" } });

      const res = await postReverseCompany(tokens.admin, productRevenue.id, { reason: "wrong order" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.amount, "-100");
    });
  });

  // ============================================================
  // COMPANY ADJUSTMENT REVERSAL (39-40)
  // ============================================================

  describe("Company adjustment reversal", () => {
    test("39. ADJUSTMENT -20, reverse -> REVERSAL +20", async () => {
      const adjustRes = await postAdjustCompany(tokens.admin, { direction: "DEBIT", amount: "20.00", reason: "original debit" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      const res = await postReverseCompany(tokens.admin, adjustRes.body.data.id, { reason: "undo debit" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.amount, "20");
    });

    test("40. ADJUSTMENT +30, reverse -> REVERSAL -30", async () => {
      const adjustRes = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "30.00", reason: "original credit" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      const res = await postReverseCompany(tokens.admin, adjustRes.body.data.id, { reason: "undo credit" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.amount, "-30");
    });
  });

  // ============================================================
  // REVERSAL OF A REVERSAL (Driver Cash + Company)
  // ============================================================

  describe("Reversal of a reversal", () => {
    test("Driver Cash: reversing a REVERSAL row is rejected", async () => {
      const driver = await createDriverWithToken("driver-reversal-of-reversal");
      const collection = await fundDriverCash(driver.driverId, "100");
      const first = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "undo" });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const res = await postReverseDriverCash(tokens.admin, first.body.data.id, { reason: "undo the undo" });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("Company: reversing a REVERSAL row is rejected", async () => {
      const adjustRes = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "10.00", reason: "x" });
      const first = await postReverseCompany(tokens.admin, adjustRes.body.data.id, { reason: "undo" });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const res = await postReverseCompany(tokens.admin, first.body.data.id, { reason: "undo the undo" });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });
  });

  // ============================================================
  // CORRUPT ORIGINAL (43-44)
  // ============================================================

  describe("Corrupt original", () => {
    test("43. Driver Cash tx with abs(after-before) != amount -> 500, no correction row", async () => {
      const driver = await createDriverWithToken("driver-corrupt-cash");
      const account = await getCashAccount(driver.driverId);
      const corrupt = await prisma.driver_cash_transactions.create({
        data: {
          account_id: account.id,
          driver_id: driver.driverId,
          type: "ADJUSTMENT",
          amount: new Prisma.Decimal("50.00"),
          balance_before: new Prisma.Decimal("0"),
          balance_after: new Prisma.Decimal("40"), // inconsistent with amount=50
        },
      });
      const res = await postReverseDriverCash(tokens.admin, corrupt.id, { reason: "attempt on corrupt row" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      const reversalCount = await prisma.driver_cash_transactions.count({ where: { reversal_of_id: corrupt.id } });
      assert.equal(reversalCount, 0);
    });

    test("44. Company revenue row with amount <= 0 -> 500, no correction row", async () => {
      const corrupt = await prisma.company_financial_transactions.create({
        data: { type: "DELIVERY_FEE_REVENUE", amount: new Prisma.Decimal("-5.00") },
      });
      const res = await postReverseCompany(tokens.admin, corrupt.id, { reason: "attempt on corrupt revenue row" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      const reversalCount = await prisma.company_financial_transactions.count({ where: { reversal_of_id: corrupt.id } });
      assert.equal(reversalCount, 0);
    });
  });

  // ============================================================
  // CONCURRENT REVERSAL (46-47)
  // ============================================================

  describe("Concurrent reversal", () => {
    test("46. two simultaneous Driver Cash reversal requests: exactly one succeeds", async () => {
      const driver = await createDriverWithToken("driver-conc-reverse");
      const collection = await fundDriverCash(driver.driverId, "100");
      const [a, b] = await Promise.all([
        postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "A" }),
        postReverseDriverCash(tokens.finance, collection.transaction.id, { reason: "B" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 201, JSON.stringify([a.body, b.body]));
      assert.ok([400, 409].includes(statuses[1]));
      const reversalCount = await prisma.driver_cash_transactions.count({ where: { reversal_of_id: collection.transaction.id } });
      assert.equal(reversalCount, 1);
    });

    test("47. two simultaneous Company reversal requests: exactly one succeeds", async () => {
      const adjustRes = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "40.00", reason: "base" });
      const originalId = adjustRes.body.data.id as string;
      const [a, b] = await Promise.all([
        postReverseCompany(tokens.admin, originalId, { reason: "A" }),
        postReverseCompany(tokens.finance, originalId, { reason: "B" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 201, JSON.stringify([a.body, b.body]));
      assert.ok([400, 409].includes(statuses[1]));
      const reversalCount = await prisma.company_financial_transactions.count({ where: { reversal_of_id: originalId } });
      assert.equal(reversalCount, 1);
    });
  });

  // ============================================================
  // ADJUSTMENT CONCURRENCY (49, 51)
  // ============================================================

  describe("Adjustment concurrency", () => {
    test("49. Driver Cash 100, concurrent DEBIT 80 + DEBIT 80: at most one succeeds", async () => {
      const driver = await createDriverWithToken("driver-conc-debit");
      await fundDriverCash(driver.driverId, "100");
      const [a, b] = await Promise.all([
        postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "DEBIT", amount: "80.00", reason: "A" }),
        postAdjustDriverCash(tokens.finance, driver.driverId, { direction: "DEBIT", amount: "80.00", reason: "B" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));
      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "20");
      assert.ok(!account.current_balance.isNegative());
    });

    test("51. Driver Cash adjustment DEBIT serializes correctly against a concurrent settlement", async () => {
      const driver = await createDriverWithToken("driver-adjust-vs-settle");
      await fundDriverCash(driver.driverId, "100");
      const [adjustRes, settleRes] = await Promise.all([
        postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "DEBIT", amount: "80.00", reason: "adjustment" }),
        request(app)
          .post("/api/v1/driver-settlements")
          .set(auth(tokens.finance))
          .set("Idempotency-Key", randomUUID())
          .send({ driverId: driver.driverId, amountReceived: "80.00", paymentMethodId: cashMethodId }),
      ]);
      const statuses = [adjustRes.status, settleRes.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([adjustRes.body, settleRes.body]));
      const account = await getCashAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "20");
      assert.ok(!account.current_balance.isNegative());
    });
  });

  // ============================================================
  // ROLLBACK (52-53, 55-56)
  // ============================================================

  describe("Rollback", () => {
    test("52. duplicate reversal idempotency collision rolls the balance mutation back (Driver Cash)", async () => {
      const driver = await createDriverWithToken("driver-idem-collision");
      const collection = await fundDriverCash(driver.driverId, "100");
      const account = await getCashAccount(driver.driverId);
      await prisma.driver_cash_transactions.create({
        data: {
          account_id: account.id,
          driver_id: driver.driverId,
          type: "REVERSAL",
          amount: new Prisma.Decimal("1.00"),
          balance_before: new Prisma.Decimal("999"),
          balance_after: new Prisma.Decimal("998"),
          idempotency_key: `reversal:driver-cash:${collection.transaction.id}`,
        },
      });
      const res = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "collides" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      const accountAfter = await getCashAccount(driver.driverId);
      assert.equal(accountAfter.current_balance.toString(), "100");
      await prisma.driver_cash_transactions.deleteMany({ where: { idempotency_key: `reversal:driver-cash:${collection.transaction.id}` } });
    });

    test("53. payout reversal failure leaves payout status COMPLETED (forced Wallet idempotency collision)", async () => {
      const customerId = await freshCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });
      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });

      await prisma.wallet_transactions.create({
        data: {
          wallet_id: payoutTx.wallet_id,
          customer_id: customerId,
          type: "REVERSAL",
          credit: new Prisma.Decimal("1.00"),
          debit: new Prisma.Decimal("0"),
          balance_before: new Prisma.Decimal("999"),
          balance_after: new Prisma.Decimal("1000"),
          idempotency_key: `reversal:wallet:${payoutTx.id}`,
        },
      });

      const res = await request(app)
        .post(`/api/v1/wallet-transactions/${payoutTx.id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "forced collision" });
      assert.equal(res.status, 409, JSON.stringify(res.body));

      const payoutAfter = await prisma.customer_payouts.findUniqueOrThrow({ where: { id: payoutRes.body.data.id } });
      assert.equal(payoutAfter.status, "COMPLETED");

      await prisma.wallet_transactions.deleteMany({ where: { idempotency_key: `reversal:wallet:${payoutTx.id}` } });
    });

    test("55. Driver Cash reversal failure (settlement scenario) leaves no partial cash change", async () => {
      const driver = await createDriverWithToken("driver-rollback-partial");
      const collection = await fundDriverCash(driver.driverId, "100");
      const account = await getCashAccount(driver.driverId);
      await prisma.driver_cash_transactions.create({
        data: {
          account_id: account.id,
          driver_id: driver.driverId,
          type: "REVERSAL",
          amount: new Prisma.Decimal("1.00"),
          balance_before: new Prisma.Decimal("999"),
          balance_after: new Prisma.Decimal("998"),
          idempotency_key: `reversal:driver-cash:${collection.transaction.id}`,
        },
      });
      const res = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "forced collision" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      const accountAfter = await getCashAccount(driver.driverId);
      assert.equal(accountAfter.current_balance.toString(), "100", "no partial cash change from the rolled-back collision");
      await prisma.driver_cash_transactions.deleteMany({ where: { idempotency_key: `reversal:driver-cash:${collection.transaction.id}` } });
    });

    test("56. Company reversal failure leaves no partial correction/audit", async () => {
      const adjustRes = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "60.00", reason: "base" });
      const originalId = adjustRes.body.data.id as string;
      await prisma.company_financial_transactions.create({
        data: { type: "REVERSAL", amount: new Prisma.Decimal("-1.00"), idempotency_key: `reversal:company:${originalId}` },
      });
      const res = await postReverseCompany(tokens.admin, originalId, { reason: "forced collision" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      const auditCount = await prisma.audit_logs.count({ where: { action: "COMPANY_FINANCIAL_TRANSACTION_REVERSED", entity_id: originalId } });
      assert.equal(auditCount, 0);
      const rows = await prisma.company_financial_transactions.findMany({ where: { idempotency_key: `reversal:company:${originalId}` } });
      assert.equal(rows.length, 1);
      await prisma.company_financial_transactions.deleteMany({ where: { idempotency_key: `reversal:company:${originalId}` } });
    });
  });

  // ============================================================
  // CROSS-LEDGER SEPARATION (58, 59, 61)
  // ============================================================

  describe("Cross-ledger separation", () => {
    test("58. Driver Cash adjustment leaves Wallet and Company Finance unchanged", async () => {
      const driver = await createDriverWithToken("driver-sep-cash");
      await fundDriverCash(driver.driverId, "100");
      const customerId = await freshCustomer();
      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      const companyBefore = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });

      const res = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "10.00", reason: "cash-only check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), walletBefore.available_balance.toString());
      const companyAfter = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      assert.equal(companyAfter, companyBefore);
    });

    test("59. Company adjustment leaves Wallet and Driver Cash unchanged", async () => {
      const driver = await createDriverWithToken("driver-sep-company");
      await fundDriverCash(driver.driverId, "100");
      const cashBefore = await getCashAccount(driver.driverId);

      const res = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "12.00", reason: "company-only check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const cashAfter = await getCashAccount(driver.driverId);
      assert.equal(cashAfter.current_balance.toString(), cashBefore.current_balance.toString());
    });

    test("61. Settlement reversal leaves Wallet and Company Finance unchanged", async () => {
      const driver = await createDriverWithToken("driver-sep-settlement");
      await fundDriverCash(driver.driverId, "100");
      const settlementRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ driverId: driver.driverId, amountReceived: "100.00", paymentMethodId: cashMethodId });
      const settlementCashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settlementRes.body.data.id } });

      const customerId = await freshCustomer();
      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      const companyBefore = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });

      const res = await postReverseDriverCash(tokens.admin, settlementCashTx.id, { reason: "settlement-reversal separation check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), walletBefore.available_balance.toString());
      const companyAfter = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      assert.equal(companyAfter, companyBefore);
    });
  });

  // ============================================================
  // OPERATIONAL IMMUTABILITY (63-64)
  // ============================================================

  describe("Operational immutability", () => {
    test("63. reversing a Driver COLLECTION never changes the linked Order", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-collection-order-immutable");
      const orderId = await deliverExactCompanyOrder(customerId, driver.token, driver.driverId);
      const orderBefore = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });

      const res = await postReverseDriverCash(tokens.admin, collectionTx.id, { reason: "collection order-immutability check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.deepEqual(orderAfter, orderBefore);
    });

    test("64. reversing Company revenue leaves the Order DELIVERED/FINALIZED", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-revenue-order-immutable");
      const orderId = await deliverExactCompanyOrder(customerId, driver.token, driver.driverId);
      const feeRevenue = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });

      const res = await postReverseCompany(tokens.admin, feeRevenue.id, { reason: "revenue order-immutability check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderAfter.status, "DELIVERED");
      assert.equal(orderAfter.financial_status, "FINALIZED");
    });
  });

  // ============================================================
  // READ INTEGRATION (66-67)
  // ============================================================

  describe("Read integration", () => {
    test("66-67. Driver own-cash history shows ADJUSTMENT/REVERSAL safely, no Finance-private notes leak", async () => {
      const driver = await createDriverWithToken("driver-own-cash-read");
      await fundDriverCash(driver.driverId, "100");
      const adjustRes = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "10.00", reason: "SECRET_FINANCE_REASON_TEXT" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { driver_id: driver.driverId, type: "COLLECTION" } });
      const reverseRes = await postReverseDriverCash(tokens.admin, collectionTx.id, { reason: "ANOTHER_SECRET_FINANCE_REASON" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));

      const cashPage = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(cashPage.status, 200, JSON.stringify(cashPage.body));
      assert.ok(cashPage.body.data.transactions.some((t: { type: string }) => t.type === "ADJUSTMENT")); // 66
      assert.ok(cashPage.body.data.transactions.some((t: { type: string }) => t.type === "REVERSAL"));
      const raw = JSON.stringify(cashPage.body);
      assert.equal(raw.includes("SECRET_FINANCE_REASON_TEXT"), false); // 67
      assert.equal(raw.includes("ANOTHER_SECRET_FINANCE_REASON"), false);
    });
  });

  // ============================================================
  // APPEND ONLY (69-71)
  // ============================================================

  describe("Append only", () => {
    test("69. original Driver Cash transaction unchanged after reversal", async () => {
      const driver = await createDriverWithToken("driver-append-only-cash");
      const collection = await fundDriverCash(driver.driverId, "100");
      const snapshot = { ...collection.transaction };
      const res = await postReverseDriverCash(tokens.admin, collection.transaction.id, { reason: "append-only check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const after = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: collection.transaction.id } });
      assert.deepEqual({ ...after }, snapshot);
    });

    test("70. original Company Finance transaction unchanged after reversal", async () => {
      const adjustRes = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "22.00", reason: "base" });
      const originalId = adjustRes.body.data.id as string;
      const before = await prisma.company_financial_transactions.findUniqueOrThrow({ where: { id: originalId } });
      const snapshot = { ...before };
      const res = await postReverseCompany(tokens.admin, originalId, { reason: "append-only check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const after = await prisma.company_financial_transactions.findUniqueOrThrow({ where: { id: originalId } });
      assert.deepEqual({ ...after }, snapshot);
    });

    test("71. original Settlement row unchanged after settlement-cash-transaction reversal", async () => {
      const driver = await createDriverWithToken("driver-append-only-settlement");
      await fundDriverCash(driver.driverId, "50");
      const settlementRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ driverId: driver.driverId, amountReceived: "50.00", paymentMethodId: cashMethodId });
      const settlementCashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settlementRes.body.data.id } });
      const before = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: settlementRes.body.data.id } });
      const snapshot = { ...before };

      const res = await postReverseDriverCash(tokens.admin, settlementCashTx.id, { reason: "append-only settlement check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const after = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: settlementRes.body.data.id } });
      assert.deepEqual({ ...after }, snapshot);
    });
  });
});
