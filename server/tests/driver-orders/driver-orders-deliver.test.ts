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
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

describe("Driver Portal — Successful Delivery (Phase 7.5)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerActive: string;
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

    customerActive = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerActive);
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
    await Promise.all([admin, dispatcher, finance, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH75-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  async function createBaseOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerActive,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase75 Receiver",
        receiverPhone: "+96170000013",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase75 St",
        description: "Phase75 deliver order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function seedOrderWithStatus(status: string, overrides: Record<string, unknown> = {}) {
    const id = await seedTestOrder(customerActive, admin.id, {
      areaId: areaActive.id,
      areaName: areaActive.name,
      status: status as never,
      ...overrides,
    } as never);
    createdOrderIds.push(id);
    return id;
  }

  async function createOutForDeliveryOrder(driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(overrides);
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
  function startPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/start-delivery`;
  }
  function driverListPath() {
    return "/api/v1/driver/me/orders";
  }
  function driverDetailPath(orderId: string) {
    return `/api/v1/driver/me/orders/${orderId}`;
  }
  function mgmtDetailPath(orderId: string) {
    return `/api/v1/orders/${orderId}`;
  }
  function mgmtHistoryPath(orderId: string) {
    return `/api/v1/orders/${orderId}/history`;
  }
  function mgmtListPath(search: string) {
    return `/api/v1/orders?search=${encodeURIComponent(search)}`;
  }

  // Phase 8.7: a collection-difference delivery now DOES record the real
  // actual amount in Driver Cash (reusing the same Phase 8.1 primitive as
  // an exact delivery) — the only thing that stays unallocated until an
  // authorized Finance/Admin resolution is the Wallet/Company ownership
  // split. expectedDriverCashCollections defaults to 1 (every call site in
  // this file uses a nonzero actualAmountCollected); pass 0 explicitly for
  // a zero-actual difference scenario.
  async function assertNoWalletOrCompanySideEffects(orderIds: string[], expectedDriverCashCollections = 1) {
    const [walletTx, cashTx, companyTx, payouts, settlements] = await Promise.all([
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
      prisma.driver_settlements.count({ where: { driver_id: { in: createdDriverIds } } }),
    ]);
    assert.equal(walletTx, 0);
    assert.equal(cashTx, expectedDriverCashCollections, "Phase 8.7: a difference delivery records actual physical cash in Driver Cash");
    assert.equal(companyTx, 0);
    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
  }

  // Phase 8.3: an exact-collection DELIVERY_ONLY delivery finalizes
  // Driver Cash / Wallet / Company revenue in the same transaction. This
  // asserts the finance rows a fully-collected exact delivery must have
  // created (never a payout/settlement, never a second row of any kind).
  async function assertExactDeliveryOnlyFinanceFinalized(orderId: string) {
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.order_type, "DELIVERY_ONLY");
    assert.equal(row.needs_financial_review, false);
    assert.equal(row.financial_status, "FINALIZED");

    const [driverCashTx, walletTx, companyTx, payouts, settlements] = await Promise.all([
      prisma.driver_cash_transactions.findMany({ where: { order_id: orderId } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId } }),
      prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
      prisma.driver_settlements.count({ where: { driver_id: { in: createdDriverIds } } }),
    ]);

    const expectDriverCash = row.actual_amount_collected !== null && row.actual_amount_collected.greaterThan(0);
    const expectWalletCredit = row.remaining_order_amount.greaterThan(0);
    const expectCompanyRevenue = row.remaining_delivery_fee.greaterThan(0);

    assert.equal(driverCashTx.length, expectDriverCash ? 1 : 0, `order ${orderId}: driver_cash_transactions mismatch`);
    assert.equal(walletTx.length, expectWalletCredit ? 1 : 0, `order ${orderId}: wallet_transactions mismatch`);
    assert.equal(companyTx.length, expectCompanyRevenue ? 1 : 0, `order ${orderId}: company_financial_transactions mismatch`);

    if (expectDriverCash) {
      assert.equal(driverCashTx[0].type, "COLLECTION");
      assert.equal(driverCashTx[0].amount.toString(), row.actual_amount_collected!.toString());
    }
    if (expectWalletCredit) {
      assert.equal(walletTx[0].type, "ORDER_CREDIT");
      assert.equal(walletTx[0].credit.toString(), row.remaining_order_amount.toString());
    }
    if (expectCompanyRevenue) {
      assert.equal(companyTx[0].type, "DELIVERY_FEE_REVENUE");
      assert.equal(companyTx[0].amount.toString(), row.remaining_delivery_fee.toString());
    }

    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
  }

  // Phase 8.4: an exact-collection COMPANY_ORDER delivery finalizes
  // Driver Cash / Company product+fee revenue in the same transaction —
  // NEVER the customer wallet (mandatory Company Order invariant).
  async function assertExactCompanyOrderFinanceFinalized(orderId: string) {
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    assert.equal(row.order_type, "COMPANY_ORDER");
    assert.equal(row.needs_financial_review, false);
    assert.equal(row.financial_status, "FINALIZED");

    const [driverCashTx, walletTxCount, companyTx, payouts, settlements] = await Promise.all([
      prisma.driver_cash_transactions.findMany({ where: { order_id: orderId } }),
      prisma.wallet_transactions.count({ where: { order_id: orderId } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId } }),
      prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
      prisma.driver_settlements.count({ where: { driver_id: { in: createdDriverIds } } }),
    ]);

    const expectDriverCash = row.actual_amount_collected !== null && row.actual_amount_collected.greaterThan(0);
    const expectProductRevenue = row.remaining_order_amount.greaterThan(0);
    const expectFeeRevenue = row.remaining_delivery_fee.greaterThan(0);

    assert.equal(driverCashTx.length, expectDriverCash ? 1 : 0, `order ${orderId}: driver_cash_transactions mismatch`);
    assert.equal(walletTxCount, 0, `order ${orderId}: COMPANY_ORDER must never create a wallet_transactions row`);

    const productTx = companyTx.filter((t) => t.type === "COMPANY_ORDER_PRODUCT_REVENUE");
    const feeTx = companyTx.filter((t) => t.type === "DELIVERY_FEE_REVENUE");
    assert.equal(productTx.length, expectProductRevenue ? 1 : 0, `order ${orderId}: product revenue mismatch`);
    assert.equal(feeTx.length, expectFeeRevenue ? 1 : 0, `order ${orderId}: fee revenue mismatch`);
    assert.equal(companyTx.length, productTx.length + feeTx.length, `order ${orderId}: unexpected company_financial_transactions rows`);

    if (expectDriverCash) {
      assert.equal(driverCashTx[0].type, "COLLECTION");
      assert.equal(driverCashTx[0].amount.toString(), row.actual_amount_collected!.toString());
    }
    if (expectProductRevenue) {
      assert.equal(productTx[0].amount.toString(), row.remaining_order_amount.toString());
    }
    if (expectFeeRevenue) {
      assert.equal(feeTx[0].amount.toString(), row.remaining_delivery_fee.toString());
    }

    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
  }

  // ============================================================
  // AUTH / OWNERSHIP (1-9)
  // ============================================================

  describe("Auth / ownership", () => {
    test("1. unauthenticated -> 401", async () => {
      const res = await request(app).post(deliverPath("00000000-0000-0000-0000-000000000000")).send({ actualAmountCollected: "0" });
      assert.equal(res.status, 401);
    });

    test("2. current linked Driver -> allowed", async () => {
      const driver = await createDriverWithToken("driver2");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. Customer -> 403", async () => {
      const res = await request(app)
        .post(deliverPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.customer))
        .send({ actualAmountCollected: "0" });
      assert.equal(res.status, 403);
    });

    test("4. Finance -> 403", async () => {
      const res = await request(app)
        .post(deliverPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.finance))
        .send({ actualAmountCollected: "0" });
      assert.equal(res.status, 403);
    });

    test("5. Dispatcher -> 403 (real permission set lacks driver.orders.update_own)", async () => {
      const res = await request(app)
        .post(deliverPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.dispatcher))
        .send({ actualAmountCollected: "0" });
      assert.equal(res.status, 403);
    });

    test("6. Admin without Driver profile -> 403", async () => {
      const res = await request(app)
        .post(deliverPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.admin))
        .send({ actualAmountCollected: "0" });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("7. Driver A cannot deliver Driver B's Order -> 404", async () => {
      const driverA = await createDriverWithToken("driverA-7");
      const driverB = await createDriverWithToken("driverB-7");
      const orderB = await createOutForDeliveryOrder(driverB.token, driverB.driverId);
      const res = await request(app).post(deliverPath(orderB)).set(auth(driverA.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 404);
    });

    test("8. historical previous Driver -> 404", async () => {
      const driverA = await createDriverWithToken("driverA-8");
      const driverB = await createDriverWithToken("driverB-8");
      const orderId = await createOutForDeliveryOrder(driverA.token, driverA.driverId);
      await prisma.orders.update({ where: { id: orderId }, data: { status: "FAILED_DELIVERY" } });
      const reschedule = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "setup" });
      assert.equal(reschedule.status, 200);
      const reassign = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "historical access regression" });
      assert.equal(reassign.status, 200);

      const res = await request(app).post(deliverPath(orderId)).set(auth(driverA.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 404);
    });

    test("9. missing Order -> identical safe 404", async () => {
      const driverA = await createDriverWithToken("driverA-9");
      const driverB = await createDriverWithToken("driverB-9");
      const orderB = await createOutForDeliveryOrder(driverB.token, driverB.driverId);

      const forOther = await request(app).post(deliverPath(orderB)).set(auth(driverA.token)).send({ actualAmountCollected: "105.00" });
      const forMissing = await request(app)
        .post(deliverPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(driverA.token))
        .send({ actualAmountCollected: "105.00" });
      assert.equal(forOther.status, forMissing.status);
      assert.equal(forOther.body.error.code, forMissing.body.error.code);
      assert.equal(forOther.status, 404);
    });
  });

  // ============================================================
  // EXACT DELIVERY (10-21)
  // ============================================================

  describe("Exact delivery", () => {
    test("10-21. OUT_FOR_DELIVERY -> DELIVERED, exact collection, everything preserved correctly", async () => {
      const driver = await createDriverWithToken("driver-exact");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const assignmentBefore = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });

      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED"); // 10, 11

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.actual_amount_collected?.toString(), "105"); // 12
      assert.equal(after.collection_difference_reason, null); // 13
      assert.equal(after.needs_financial_review, false); // 14
      // Phase 8.3: an exact DELIVERY_ONLY delivery finalizes finance in the
      // same transaction.
      assert.equal(after.financial_status, "FINALIZED"); // 15
      assert.ok(after.delivered_at); // 16
      assert.equal(after.out_for_delivery_at?.getTime(), before.out_for_delivery_at?.getTime()); // 17
      assert.equal(after.picked_up_at?.getTime(), before.picked_up_at?.getTime()); // 18
      assert.equal(after.assigned_at?.getTime(), before.assigned_at?.getTime()); // 19
      assert.equal(after.current_driver_id, driver.driverId); // 20

      const assignmentAfter = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(assignmentAfter.id, assignmentBefore.id);
      assert.equal(assignmentAfter.is_current, true); // 21

      assert.equal(after.cancelled_at, null);

      await assertExactDeliveryOnlyFinanceFinalized(orderId);
    });
  });

  // ============================================================
  // ZERO COLLECTION (22-24)
  // ============================================================

  describe("Zero collection", () => {
    test("22-24. expected=0 actual=0 is a valid exact delivered success", async () => {
      const driver = await createDriverWithToken("driver-zero");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId, {
        orderAmount: "0",
        deliveryFee: "0",
        collectionPaymentMethodId: undefined,
      });
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.amount_to_collect.toString(), "0");

      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.actual_amount_collected?.toString(), "0"); // 22
      assert.equal(typeof res.body.data.collection.actualAmountCollected, "string"); // 23
      assert.equal(after.needs_financial_review, false); // 24
      assert.equal(after.collection_difference_reason, null);
    });
  });

  // ============================================================
  // SHORT COLLECTION (25-29)
  // ============================================================

  describe("Short collection", () => {
    test("25-29. expected 105 actual 95 + reason -> DELIVERED with review required", async () => {
      const driver = await createDriverWithToken("driver-short");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "receiver paid less" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED"); // 25

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.actual_amount_collected?.toString(), "95"); // 26
      assert.equal(after.collection_difference_reason, "receiver paid less"); // 27
      assert.equal(after.needs_financial_review, true); // 28
      assert.equal(after.financial_status, "REVIEW_REQUIRED"); // 29
    });
  });

  // ============================================================
  // OVER COLLECTION (30-32)
  // ============================================================

  describe("Over collection", () => {
    test("30-32. expected 105 actual 110 + reason -> DELIVERED with review required, never rejected", async () => {
      const driver = await createDriverWithToken("driver-over");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "110.00", collectionDifferenceReason: "receiver overpaid" });
      assert.equal(res.status, 200, JSON.stringify(res.body)); // 30
      assert.equal(res.body.data.status, "DELIVERED");

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.needs_financial_review, true); // 31
      assert.equal(after.financial_status, "REVIEW_REQUIRED"); // 32
    });
  });

  // ============================================================
  // DIFFERENCE VALIDATION (33-36)
  // ============================================================

  describe("Difference validation", () => {
    test("33. difference + missing reason -> 400", async () => {
      const driver = await createDriverWithToken("driver-diff-33");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "95.00" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("34. difference + whitespace reason -> 400", async () => {
      const driver = await createDriverWithToken("driver-diff-34");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "   " });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("35. exact + no reason -> success", async () => {
      const driver = await createDriverWithToken("driver-diff-35");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("36. exact + unnecessary supplied reason -> stored reason null", async () => {
      const driver = await createDriverWithToken("driver-diff-36");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "105.00", collectionDifferenceReason: "not actually needed" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.collection_difference_reason, null);
      assert.equal(row.needs_financial_review, false);
      assert.equal(row.financial_status, "FINALIZED"); // Phase 8.3
    });
  });

  // ============================================================
  // MONEY VALIDATION (37-40)
  // ============================================================

  describe("Money validation", () => {
    test("37. negative actual -> 400", async () => {
      const driver = await createDriverWithToken("driver-money-37");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "-1.00" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("38. >2 decimal places -> 400", async () => {
      const driver = await createDriverWithToken("driver-money-38");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.001" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("39. exceeds NUMERIC(14,2) range -> 400", async () => {
      const driver = await createDriverWithToken("driver-money-39");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "9999999999999.99" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("40. Decimal exactness: 0.30 vs 0.30 must be exact, not floating-point drift", async () => {
      const driver = await createDriverWithToken("driver-money-40");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId, { orderAmount: "0.10", deliveryFee: "0.20" });
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.amount_to_collect.toString(), "0.3");

      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "0.30" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.needs_financial_review, false, "0.30 must be recognized as exactly equal to 0.30, not a float drift difference");
      assert.equal(after.actual_amount_collected?.toString(), "0.3");
    });
  });

  // ============================================================
  // DELIVERY ATTEMPT (41-48)
  // ============================================================

  describe("Delivery attempt", () => {
    test("41-48. exactly one DELIVERED attempt with correct fields", async () => {
      const driver = await createDriverWithToken("driver-attempt");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200);

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1); // 41
      const attempt = attempts[0];
      assert.equal(attempt.outcome, "DELIVERED"); // 42
      assert.equal(attempt.expected_collection.toString(), before.amount_to_collect.toString()); // 43
      assert.equal(attempt.actual_collection?.toString(), "105"); // 44
      assert.equal(attempt.failed_reason_id, null); // 45
      assert.equal(attempt.started_at.getTime(), before.out_for_delivery_at?.getTime()); // 46
      assert.ok(attempt.completed_at); // 47
      assert.equal(attempt.attempt_number, 1); // 48
    });
  });

  // ============================================================
  // PRIOR FAILED ATTEMPT (49-55)
  // ============================================================

  describe("Prior failed attempt", () => {
    test("49-55. fail #1 -> reschedule -> retry start -> deliver #2: sequential attempts, #1 unchanged", async () => {
      const driver = await createDriverWithToken("driver-retry");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const fail1 = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonId });
      assert.equal(fail1.status, 200, JSON.stringify(fail1.body)); // 49

      const reschedule = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "retry" });
      assert.equal(reschedule.status, 200); // 50

      const attempt1 = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 1 } });

      const start2 = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(start2.status, 200, JSON.stringify(start2.body)); // 51

      const deliver2 = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(deliver2.status, 200, JSON.stringify(deliver2.body)); // 52

      const allAttempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
      assert.equal(allAttempts.length, 2); // 53
      assert.equal(allAttempts[0].attempt_number, 1);
      assert.equal(allAttempts[1].attempt_number, 2);

      const attempt1After = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: attempt1.id } });
      assert.deepEqual(attempt1After, attempt1); // 54 — unchanged
      assert.equal(attempt1After.outcome, "FAILED");

      assert.equal(allAttempts[1].outcome, "DELIVERED"); // 55

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "DELIVERED");

      const current = await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } });
      assert.equal(current.length, 1);

      // Phase 8.3: attempt #2 is a real exact DELIVERY_ONLY delivery, so it
      // finalizes finance — attempt #1 (FAILED) never did.
      await assertExactDeliveryOnlyFinanceFinalized(orderId);
    });
  });

  // ============================================================
  // STATUS HISTORY (56-58)
  // ============================================================

  describe("Status history", () => {
    test("56-58. exactly one OUT_FOR_DELIVERY -> DELIVERED row, correct actor, no reason misuse", async () => {
      const driver = await createDriverWithToken("driver-history");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage explanation" });
      assert.equal(res.status, 200);

      const rows = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "DELIVERED" } });
      assert.equal(rows.length, 1); // 56
      assert.equal(rows[0].from_status, "OUT_FOR_DELIVERY");
      assert.equal(rows[0].changed_by_id, driver.userId); // 57
      assert.equal(rows[0].reason, null); // 58 — collection-difference reason must not leak into status-transition reason
      assert.equal(rows[0].notes, null);
    });
  });

  // ============================================================
  // INVALID STATES (59-68)
  // ============================================================

  describe("Invalid states", () => {
    const NOT_DELIVERABLE = [
      "RECEIVED",
      "READY_FOR_PICKUP",
      "ASSIGNED",
      "PICKED_UP",
      "DELIVERED",
      "FAILED_DELIVERY",
      "RESCHEDULED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of NOT_DELIVERABLE) {
      test(`59-68. deliver rejects from ${status}`, async () => {
        const driver = await createDriverWithToken(`driver-invalid-${status}`);
        const orderId = await seedOrderWithStatus(status, { currentDriverId: driver.driverId });
        const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
        assert.equal(res.status, 400, `expected ${status} to be rejected as an invalid transition`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }
  });

  // ============================================================
  // CONSISTENCY (69-72)
  // ============================================================

  describe("Consistency", () => {
    test("69. OUT_FOR_DELIVERY with null out_for_delivery_at -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-69");
      const orderId = await seedOrderWithStatus("OUT_FOR_DELIVERY", { currentDriverId: driver.driverId });
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY");
      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);
    });

    test("70. missing current assignment -> 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-70");
      const orderId = await seedOrderWithStatus("OUT_FOR_DELIVERY", { currentDriverId: driver.driverId });
      await prisma.orders.update({ where: { id: orderId }, data: { out_for_delivery_at: new Date() } });
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("71. duplicate current assignments -> 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-71");
      const otherDriver = await createDriverWithToken("driver-consistency-71-other");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await prisma.order_assignments.create({
        data: { order_id: orderId, driver_id: otherDriver.driverId, assigned_by_id: admin.id, is_current: true },
      });
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("72. mismatched current assignment -> 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-72");
      const otherDriver = await createDriverWithToken("driver-consistency-72-other");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await prisma.order_assignments.updateMany({
        where: { order_id: orderId, is_current: true },
        data: { driver_id: otherDriver.driverId },
      });
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });
  });

  // ============================================================
  // CONCURRENCY (73-74)
  // ============================================================

  describe("Concurrency", () => {
    test("73. two simultaneous deliver requests: exactly one success, one attempt, one transition", async () => {
      const driver = await createDriverWithToken("driver-concurrency-73");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" }),
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "100.00", collectionDifferenceReason: "race" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, JSON.stringify({ a: a.body, b: b.body }));
      assert.ok([400, 409].includes(statuses[1]), JSON.stringify({ a: a.body, b: b.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "DELIVERED");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 1);

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "DELIVERED" } });
      assert.equal(history.length, 1);

      // exactly one actual collection value was persisted, matching whichever request won
      const winner = a.status === 200 ? a : b;
      assert.equal(row.actual_amount_collected?.toString(), winner.body.data.collection.actualAmountCollected);
    });

    test("74. deliver vs fail: exactly one succeeds, final state matches exactly one finalized attempt", async () => {
      const driver = await createDriverWithToken("driver-concurrency-74");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const [deliver, fail] = await Promise.all([
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonId }),
      ]);
      const statuses = [deliver.status, fail.status].sort();
      assert.equal(statuses[0], 200, JSON.stringify({ deliver: deliver.body, fail: fail.body }));
      assert.ok([400, 409].includes(statuses[1]), JSON.stringify({ deliver: deliver.body, fail: fail.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.ok(["DELIVERED", "FAILED_DELIVERY"].includes(row.status));

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1, "exactly one finalized attempt for the open OUT_FOR_DELIVERY attempt");
      assert.equal(attempts[0].outcome, row.status === "DELIVERED" ? "DELIVERED" : "FAILED");

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId } });
      const openAttemptTransitions = history.filter((h) => h.from_status === "OUT_FOR_DELIVERY");
      assert.equal(openAttemptTransitions.length, 1, "exactly one status transition out of OUT_FOR_DELIVERY");
    });
  });

  // ============================================================
  // MANAGEMENT REPRESENTATION (75-81)
  // ============================================================

  describe("Management representation", () => {
    test("75-81. detail/list/history all reflect a successful delivery", async () => {
      const driver = await createDriverWithToken("driver-mgmt");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "mgmt representation check" });
      assert.equal(res.status, 200);

      const detail = await request(app).get(mgmtDetailPath(orderId)).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "DELIVERED"); // 75
      assert.ok(detail.body.data.deliveredAt); // 76
      assert.equal(typeof detail.body.data.financial.actualAmountCollected, "string"); // 77
      assert.equal(detail.body.data.financial.actualAmountCollected, "95");
      assert.equal(detail.body.data.financial.collectionDifferenceReason, "mgmt representation check"); // 78

      const deliveredAttempt = detail.body.data.deliveryAttempts.find((a: { outcome: string }) => a.outcome === "DELIVERED");
      assert.ok(deliveredAttempt); // 79
      assert.equal(deliveredAttempt.actualCollection, "95");

      const list = await request(app).get(mgmtListPath("Phase75 Receiver")).set(auth(tokens.admin));
      const listItem = list.body.data.find((o: { id: string }) => o.id === orderId);
      assert.ok(listItem); // 80
      assert.equal(listItem.status, "DELIVERED");
      assert.equal(listItem.actualAmountCollected, "95");
      assert.equal(listItem.needsFinancialReview, true);

      const history = await request(app).get(mgmtHistoryPath(orderId)).set(auth(tokens.admin));
      const toStatuses = history.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
      assert.deepEqual(toStatuses, ["RECEIVED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"]); // 81
    });
  });

  // ============================================================
  // DRIVER REPRESENTATION (82-86)
  // ============================================================

  describe("Driver representation", () => {
    test("82-86. driver response/detail/list reflect delivery, no Management finance leakage", async () => {
      const driver = await createDriverWithToken("driver-representation");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200); // 82
      assert.deepEqual(
        Object.keys(res.body.data).sort(),
        ["collection", "id", "orderNumber", "orderType", "package", "receiver", "status", "timestamps", "trackingCode"].sort()
      );
      assert.equal(res.body.data.collection.actualAmountCollected, "105"); // 83

      const detail = await request(app).get(driverDetailPath(orderId)).set(auth(driver.token));
      assert.equal(detail.status, 200); // 84
      assert.equal(detail.body.data.status, "DELIVERED");

      const list = await request(app).get(`${driverListPath()}?status=DELIVERED`).set(auth(driver.token));
      assert.equal(list.status, 200); // 85
      assert.ok(list.body.data.some((o: { id: string }) => o.id === orderId));

      const serialized = JSON.stringify(res.body) + JSON.stringify(detail.body);
      assert.doesNotMatch(serialized, /financialStatus/i);
      assert.doesNotMatch(serialized, /needsFinancialReview/i);
      assert.doesNotMatch(serialized, /collectionDifferenceReason/i);
      assert.doesNotMatch(serialized, /wallet/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /company_financial/i); // 86
    });
  });

  // ============================================================
  // NO FINANCE SIDE EFFECTS (87-90)
  // ============================================================

  describe("No finance side effects", () => {
    // Phase 8.3 superseded the original "no finance yet exists" premise for
    // the exact branch: an exact DELIVERY_ONLY delivery now finalizes real
    // ledger rows. Phase 8.7 further superseded the difference branch: a
    // difference (REVIEW_REQUIRED) delivery now records real Driver Cash
    // too — only the Wallet/Company ownership split remains unallocated.
    // This test verifies exactly that split.
    test("87-90. exact delivery finalizes ledger rows; difference delivery records Driver Cash only, no Wallet/Company allocation", async () => {
      const driver = await createDriverWithToken("driver-no-finance");

      // customerActive's wallet is shared across this whole suite, so assert
      // the DELTA this test's own exact delivery produces, not an absolute
      // balance.
      const walletBefore = await prisma.customer_wallets.findUnique({ where: { customer_id: customerActive } });
      const walletBalanceBefore = walletBefore?.available_balance ?? new Prisma.Decimal(0);

      const exactOrder = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const exactRes = await request(app).post(deliverPath(exactOrder)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(exactRes.status, 200);

      const diffOrder = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const diffRes = await request(app)
        .post(deliverPath(diffOrder))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "80.00", collectionDifferenceReason: "no finance side effect check" });
      assert.equal(diffRes.status, 200);

      await assertExactDeliveryOnlyFinanceFinalized(exactOrder); // 87
      await assertNoWalletOrCompanySideEffects([diffOrder]); // 88 (Driver Cash now expected under Phase 8.7)

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerActive } });
      assert.equal(wallet.available_balance.minus(walletBalanceBefore).toString(), "100"); // 89 — credited by the exact order only

      // driver is freshly created for this test, so its cash account started
      // at 0. Phase 8.7: the difference delivery ALSO credits this same
      // Driver Cash account with its own actual amount (80), on top of the
      // exact delivery's 105 — Driver Cash reflects physical custody
      // regardless of exact-vs-difference outcome, so the total is 185, not
      // 105-only as it was before Phase 8.7 existed.
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "185"); // 90 — 105 (exact) + 80 (difference)
    });
  });

  // ============================================================
  // ORDER TYPE BOUNDARY (91-93)
  // ============================================================

  describe("Order type boundary", () => {
    test("91. COMPANY_ORDER exact delivery: operationally delivered AND finance finalized (Phase 8.4)", async () => {
      const driver = await createDriverWithToken("driver-company");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId, { orderType: "COMPANY_ORDER" });
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");
      await assertExactCompanyOrderFinanceFinalized(orderId);
    });

    test("92. DELIVERY_ONLY exact delivery: operationally delivered AND finance finalized (Phase 8.3)", async () => {
      const driver = await createDriverWithToken("driver-delivery-only");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId, { orderType: "DELIVERY_ONLY" });
      const res = await request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200);
      await assertExactDeliveryOnlyFinanceFinalized(orderId);
    });

    test("93. DELIVERY_ONLY difference: REVIEW_REQUIRED, no guessed allocation", async () => {
      const driver = await createDriverWithToken("driver-delivery-only-diff");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId, {
        orderType: "DELIVERY_ONLY",
        orderAmount: "100.00",
        deliveryFee: "5.00",
      });
      const res = await request(app)
        .post(deliverPath(orderId))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "95.00", collectionDifferenceReason: "shortage, unknown allocation" });
      assert.equal(res.status, 200);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      assert.equal(row.needs_financial_review, true);
      // No split fields exist/changed — remainingOrderAmount/remainingDeliveryFee stay at their original computed values.
      assert.equal(row.remaining_order_amount.toString(), "100");
      assert.equal(row.remaining_delivery_fee.toString(), "5");
      await assertNoWalletOrCompanySideEffects([orderId]);
    });
  });

  // ============================================================
  // REGRESSION (94-97)
  // ============================================================

  describe("Regression", () => {
    test("94-97. Phase 7.1 reads, 7.2 pickup, 7.3 start-delivery, 7.4 fail all still work", async () => {
      const driver = await createDriverWithToken("driver-regression");

      const list = await request(app).get(driverListPath()).set(auth(driver.token));
      assert.equal(list.status, 200);

      const order = await createBaseOrder();
      const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(assign.status, 200);
      const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driver.token)).send();
      assert.equal(pickup.status, 200);
      const start = await request(app).post(startPath(order.id)).set(auth(driver.token)).send();
      assert.equal(start.status, 200);
      const fail = await request(app).post(failPath(order.id)).set(auth(driver.token)).send({ failedReasonId: reasonId });
      assert.equal(fail.status, 200);
    });
  });
});
