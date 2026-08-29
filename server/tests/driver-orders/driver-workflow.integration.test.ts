// Phase 7.6 — Driver Workflow Tests (integration / Phase 7 review gate).
//
// Unlike the per-sub-phase suites (driver-orders.test.ts, -pickup, -start-
// delivery, -fail, -deliver — each already exhaustively covers its own
// endpoint), this file exercises complete, realistic Driver workflows that
// cross Phase 7.1-7.5 boundaries and interact with Phase 6 Management
// operations: full success/failure/retry sequences, wrong-driver/historical-
// driver security across every action, cross-action concurrency, the
// finalized-delivery-attempt model end-to-end, and a suite-wide zero-
// financial-side-effect sweep. It intentionally does NOT re-litigate every
// per-endpoint validation branch already covered in those files.
import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestDriverRecord,
  cleanupTestFailedDeliveryReason,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Driver Workflow integration (Phase 7.6)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerActive: string;
  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let reasonNoNotesId: string;
  let reasonRequiresNotesId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdReasonIds: string[] = [];

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

    const suffix = uniqueSuffix();
    const noNotesReason = await prisma.failed_delivery_reasons.create({
      data: { name: `Phase76 No Notes ${suffix}`, requires_notes: false, is_active: true },
    });
    reasonNoNotesId = noNotesReason.id;
    createdReasonIds.push(reasonNoNotesId);
    const requiresNotesReason = await prisma.failed_delivery_reasons.create({
      data: { name: `Phase76 Requires Notes ${suffix}`, requires_notes: true, is_active: true },
    });
    reasonRequiresNotesId = requiresNotesReason.id;
    createdReasonIds.push(reasonRequiresNotesId);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdReasonIds) await cleanupTestFailedDeliveryReason(id);
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
      .send({ driverNumber: `PH76-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
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
        receiverName: "Phase76 Receiver",
        receiverPhone: "+96170000014",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase76 St",
        description: "Phase76 workflow order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function assignOrder(orderId: string, driverId: string) {
    const res = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  async function pickup(orderId: string, driverToken: string) {
    const res = await request(app).post(pickupPath(orderId)).set(auth(driverToken)).send();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }
  async function startDelivery(orderId: string, driverToken: string) {
    const res = await request(app).post(startPath(orderId)).set(auth(driverToken)).send();
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }
  async function fail(orderId: string, driverToken: string, body: Record<string, unknown> = { failedReasonId: reasonNoNotesId }) {
    const res = await request(app).post(failPath(orderId)).set(auth(driverToken)).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }
  async function deliver(orderId: string, driverToken: string, body: Record<string, unknown>) {
    const res = await request(app).post(deliverPath(orderId)).set(auth(driverToken)).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }

  async function createOutForDeliveryOrder(driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(overrides);
    await assignOrder(order.id, driverId);
    await pickup(order.id, driverToken);
    await startDelivery(order.id, driverToken);
    return order.id as string;
  }

  function pickupPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/pickup`;
  }
  function startPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/start-delivery`;
  }
  function failPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/fail`;
  }
  function deliverPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/deliver`;
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

  async function assertAssignmentConsistency(orderIds: string[]) {
    for (const orderId of orderIds) {
      const order = await prisma.orders.findUnique({ where: { id: orderId } });
      if (!order) continue;
      const current = await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } });
      assert.ok(current.length <= 1, `order ${orderId}: more than one is_current assignment row`);
      if (order.current_driver_id !== null) {
        assert.equal(current.length, 1, `order ${orderId}: current_driver_id set but no is_current assignment row`);
        assert.equal(current[0]?.driver_id, order.current_driver_id, `order ${orderId}: current assignment driver mismatch`);
      } else {
        assert.equal(current.length, 0, `order ${orderId}: current_driver_id is null but a current assignment row exists`);
      }
    }
  }

  // expectedDriverCashCollections defaults to 0 (not-yet-delivered/failed
  // orders). Phase 8.7: a collection-difference (REVIEW_REQUIRED) delivery
  // DOES record its real actual amount in Driver Cash — pass 1 explicitly
  // for those call sites; only the Wallet/Company allocation stays zero.
  async function assertNoFinanceSideEffects(orderIds: string[], expectedDriverCashCollections = 0) {
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

  // Phase 8.3: an exact-collection DELIVERY_ONLY delivery now finalizes
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

  // Phase 8.3/8.7-aware replacement for the suite-wide blanket zero-finance
  // sweep: derives the expected finance state per order from the order's
  // own final columns instead of assuming finance never happens. Orders
  // that reached an exact DELIVERY_ONLY delivery are expected to be
  // FINALIZED with matching Wallet/Company/Driver-Cash ledger rows. A
  // collection-difference (REVIEW_REQUIRED) delivery is expected to have
  // recorded its actual amount in Driver Cash only (Phase 8.7), zero
  // Wallet/Company. Every other order (failed, not yet delivered, etc.)
  // must still have zero finance rows of any kind. This file never creates
  // a COMPANY_ORDER, so that branch isn't modeled here.
  async function assertFinanceMatchesOrderState(orderIds: string[]) {
    for (const orderId of orderIds) {
      const order = await prisma.orders.findUnique({ where: { id: orderId } });
      if (!order) continue;

      const isExactDeliveryOnlyFinance =
        order.status === "DELIVERED" && order.order_type === "DELIVERY_ONLY" && order.needs_financial_review === false;
      const isDifferenceDelivery = order.status === "DELIVERED" && order.needs_financial_review === true;

      if (isExactDeliveryOnlyFinance) {
        await assertExactDeliveryOnlyFinanceFinalized(orderId);
      } else if (isDifferenceDelivery) {
        const expectedCash = order.actual_amount_collected !== null && order.actual_amount_collected.greaterThan(0) ? 1 : 0;
        await assertNoFinanceSideEffects([orderId], expectedCash);
      } else {
        await assertNoFinanceSideEffects([orderId]);
      }
    }
  }

  // ============================================================
  // FLOW A — EXACT SUCCESSFUL DELIVERY
  // ============================================================

  describe("Flow A — exact successful delivery", () => {
    test("full ASSIGNED -> PICKED_UP -> OUT_FOR_DELIVERY -> DELIVERED, history, attempt, financial state", async () => {
      const driver = await createDriverWithToken("driverA-flowA");
      const order = await createBaseOrder();
      await assignOrder(order.id, driver.driverId);

      let detail = await request(app).get(driverDetailPath(order.id)).set(auth(driver.token));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "ASSIGNED");

      let attempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(attempts, 0);

      const pickupRes = await pickup(order.id, driver.token);
      assert.equal(pickupRes.body.data.status, "PICKED_UP");
      let row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.ok(row.picked_up_at);
      attempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(attempts, 0);

      const startRes = await startDelivery(order.id, driver.token);
      assert.equal(startRes.body.data.status, "OUT_FOR_DELIVERY");
      row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.ok(row.out_for_delivery_at);
      attempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(attempts, 0);

      const expectedOutForDeliveryAt = row.out_for_delivery_at;
      const deliverRes = await deliver(order.id, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.body.data.status, "DELIVERED");

      row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.ok(row.delivered_at);
      assert.equal(row.actual_amount_collected?.toString(), "105");
      assert.equal(row.collection_difference_reason, null);
      assert.equal(row.needs_financial_review, false);
      // Phase 8.3: an exact DELIVERY_ONLY delivery is now finalized in the
      // same transaction (Driver Cash + Wallet + Company revenue posted).
      assert.equal(row.financial_status, "FINALIZED");

      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id }, orderBy: { created_at: "asc" } });
      assert.deepEqual(
        history.map((h) => h.to_status),
        ["RECEIVED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED"]
      );

      attempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(attempts, 1);
      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: order.id } });
      assert.equal(attempt.attempt_number, 1);
      assert.equal(attempt.outcome, "DELIVERED");
      assert.equal(attempt.expected_collection.toString(), "105");
      assert.equal(attempt.actual_collection?.toString(), "105");
      assert.equal(attempt.failed_reason_id, null);
      assert.equal(attempt.started_at.getTime(), expectedOutForDeliveryAt?.getTime());
      assert.ok(attempt.completed_at);
      assert.ok(attempt.completed_at.getTime() >= attempt.started_at.getTime());

      await assertAssignmentConsistency([order.id]);
      await assertExactDeliveryOnlyFinanceFinalized(order.id);
    });
  });

  // ============================================================
  // FLOW B / C — COLLECTION SHORTAGE / OVERCOLLECTION
  // ============================================================

  describe("Flow B/C — collection shortage and overcollection", () => {
    test("shortage: expected 105 actual 95 -> DELIVERED, REVIEW_REQUIRED, no split guessed", async () => {
      const driver = await createDriverWithToken("driver-shortage");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "105");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" });
      assert.equal(res.body.data.status, "DELIVERED");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.actual_amount_collected?.toString(), "95");
      assert.equal(row.needs_financial_review, true);
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      assert.equal(row.collection_difference_reason, "shortage");
      // No split fields exist and none were computed — remaining amounts untouched.
      assert.equal(row.remaining_order_amount.toString(), "100");
      assert.equal(row.remaining_delivery_fee.toString(), "5");

      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(attempt.outcome, "DELIVERED");
      assert.equal(attempt.expected_collection.toString(), "105");
      assert.equal(attempt.actual_collection?.toString(), "95");

      // Phase 8.7: Driver Cash now records the real actual amount (95) even
      // though the collection differed — only Wallet/Company stay zero.
      await assertNoFinanceSideEffects([orderId], 1);
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95");
    });

    test("overcollection: expected 105 actual 110 -> DELIVERED, REVIEW_REQUIRED, never rejected", async () => {
      const driver = await createDriverWithToken("driver-over");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "110.00", collectionDifferenceReason: "overpaid" });
      assert.equal(res.body.data.status, "DELIVERED");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.needs_financial_review, true);
      assert.equal(row.financial_status, "REVIEW_REQUIRED");
      // Phase 8.7: Driver Cash records the actual 110, never the expected 105.
      await assertNoFinanceSideEffects([orderId], 1);
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "110");
    });
  });

  // ============================================================
  // FLOW D — ZERO-COLLECTION EXACT
  // ============================================================

  describe("Flow D — zero-collection exact", () => {
    test("fully prepaid order (amountToCollect=0), actual=0 -> DELIVERED, PENDING, no review", async () => {
      const driver = await createDriverWithToken("driver-zero");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId, {
        paymentType: "ALREADY_PAID",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
        collectionPaymentMethodId: undefined,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "0");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0" });
      assert.equal(res.body.data.status, "DELIVERED");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.needs_financial_review, false);
      // Phase 8.3: still an exact DELIVERY_ONLY delivery (0 === 0), so it
      // finalizes financially — but every component is zero, so no ledger
      // row is created for any of them (zero-amount rows are never posted).
      assert.equal(row.financial_status, "FINALIZED");

      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(attempt.expected_collection.toString(), "0");
      assert.equal(attempt.actual_collection?.toString(), "0");
      await assertExactDeliveryOnlyFinanceFinalized(orderId);
    });
  });

  // ============================================================
  // FLOW E — FAILURE
  // ============================================================

  describe("Flow E — failure", () => {
    test("create -> assign -> pickup -> start -> fail: FAILED_DELIVERY, driver retained, one FAILED attempt", async () => {
      const driver = await createDriverWithToken("driver-fail");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const res = await fail(orderId, driver.token, { failedReasonId: reasonNoNotesId });
      assert.equal(res.body.data.status, "FAILED_DELIVERY");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.current_driver_id, driver.driverId);
      assert.equal(row.actual_amount_collected, null, "failure must never mark expected amount as collected");

      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(attempt.attempt_number, 1);
      assert.equal(attempt.outcome, "FAILED");
      assert.equal(attempt.actual_collection, null);
      assert.equal(attempt.failed_reason_id, reasonNoNotesId);
      assert.equal(attempt.started_at.getTime(), before.out_for_delivery_at?.getTime());
      assert.ok(attempt.completed_at);

      await assertAssignmentConsistency([orderId]);
      await assertNoFinanceSideEffects([orderId]);
    });
  });

  // ============================================================
  // FLOW F — FAILURE WITH REQUIRED NOTES
  // ============================================================

  describe("Flow F — failure with required notes", () => {
    test("requires_notes=true: missing/whitespace notes rejected, valid notes succeeds and is preserved", async () => {
      const driver1 = await createDriverWithToken("driver-notes-1");
      const order1 = await createOutForDeliveryOrder(driver1.token, driver1.driverId);
      const missing = await request(app).post(failPath(order1)).set(auth(driver1.token)).send({ failedReasonId: reasonRequiresNotesId });
      assert.equal(missing.status, 400);

      const driver2 = await createDriverWithToken("driver-notes-2");
      const order2 = await createOutForDeliveryOrder(driver2.token, driver2.driverId);
      const whitespace = await request(app)
        .post(failPath(order2))
        .set(auth(driver2.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "   " });
      assert.equal(whitespace.status, 400);

      const driver3 = await createDriverWithToken("driver-notes-3");
      const order3 = await createOutForDeliveryOrder(driver3.token, driver3.driverId);
      const valid = await fail(order3, driver3.token, { failedReasonId: reasonRequiresNotesId, notes: "receiver was unreachable" });
      assert.equal(valid.status, 200);

      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: order3 } });
      assert.equal(attempt.notes, "receiver was unreachable");
      const historyRow = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: order3, to_status: "FAILED_DELIVERY" } });
      assert.equal(historyRow.notes, "receiver was unreachable");

      const canonicalReason = await prisma.failed_delivery_reasons.findFirstOrThrow({ where: { name: "Other" } });
      assert.equal(canonicalReason.requires_notes, true, "canonical reasons must never be mutated by this suite");
    });
  });

  // ============================================================
  // FLOW G — SAME-DRIVER RETRY THEN SUCCESS
  // ============================================================

  describe("Flow G — same-driver retry then success", () => {
    test("fail #1 -> reschedule -> same-driver start (no fake pickup) -> deliver #2", async () => {
      const driver = await createDriverWithToken("driver-retry-success");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await fail(orderId, driver.token, { failedReasonId: reasonNoNotesId, notes: "first attempt" });

      const reschedule = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "retry" });
      assert.equal(reschedule.status, 200);

      const attempt1 = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 1 } });

      const historyBeforeRetry = await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "PICKED_UP" } });
      assert.equal(historyBeforeRetry, 1, "only the original pickup — retry must not add a second PICKED_UP event");

      const startRes = await startDelivery(orderId, driver.token);
      assert.equal(startRes.body.data.status, "OUT_FOR_DELIVERY");

      const historyAfterRetryStart = await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "PICKED_UP" } });
      assert.equal(historyAfterRetryStart, 1, "retry start-delivery must not create a fake PICKED_UP transition");

      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.body.data.status, "DELIVERED");

      const allAttempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
      assert.equal(allAttempts.length, 2);
      assert.equal(allAttempts[0].attempt_number, 1);
      assert.equal(allAttempts[1].attempt_number, 2);

      const attempt1After = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: attempt1.id } });
      assert.deepEqual(attempt1After, attempt1, "attempt #1 must remain unchanged forever");

      assert.equal(allAttempts[1].outcome, "DELIVERED");
      assert.notEqual(allAttempts[1].started_at.getTime(), allAttempts[0].started_at.getTime());
      assert.ok(allAttempts[1].completed_at);

      const current = await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } });
      assert.equal(current.length, 1);
      assert.equal(current[0].driver_id, driver.driverId);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "DELIVERED");

      await assertExactDeliveryOnlyFinanceFinalized(orderId);
    });
  });

  // ============================================================
  // FLOW H — SAME-DRIVER RETRY THEN FAIL AGAIN
  // ============================================================

  describe("Flow H — same-driver retry then fail again", () => {
    test("fail #1 -> reschedule -> retry -> fail #2: independent attempts, both FAILED", async () => {
      const driver = await createDriverWithToken("driver-retry-fail");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await fail(orderId, driver.token, { failedReasonId: reasonRequiresNotesId, notes: "attempt one notes" });

      await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "retry setup" });
      await startDelivery(orderId, driver.token);
      await fail(orderId, driver.token, { failedReasonId: reasonNoNotesId, notes: "attempt two notes" });

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].outcome, "FAILED");
      assert.equal(attempts[1].outcome, "FAILED");
      assert.equal(attempts[0].notes, "attempt one notes");
      assert.equal(attempts[1].notes, "attempt two notes");
      assert.equal(attempts[0].failed_reason_id, reasonRequiresNotesId);
      assert.equal(attempts[1].failed_reason_id, reasonNoNotesId);
      assert.notEqual(attempts[0].started_at.getTime(), attempts[1].started_at.getTime());
      assert.notEqual(attempts[0].completed_at?.getTime(), attempts[1].completed_at?.getTime());

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "FAILED_DELIVERY");
      assert.equal(row.current_driver_id, driver.driverId);

      await assertAssignmentConsistency([orderId]);
      await assertNoFinanceSideEffects([orderId]);
    });
  });

  // ============================================================
  // FLOW I — RESCHEDULE + DIFFERENT DRIVER
  // ============================================================

  describe("Flow I — reschedule then reassign to a different Driver", () => {
    test("A fails -> reschedule -> reassign to B: A loses all access, B must pickup again (no OUT_FOR_DELIVERY jump)", async () => {
      const driverA = await createDriverWithToken("driverA-flowI");
      const driverB = await createDriverWithToken("driverB-flowI");
      const orderId = await createOutForDeliveryOrder(driverA.token, driverA.driverId);
      await fail(orderId, driverA.token, { failedReasonId: reasonNoNotesId });

      await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "reassign setup" });
      const reassign = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "different driver retry" });
      assert.equal(reassign.status, 200, JSON.stringify(reassign.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "ASSIGNED");
      assert.equal(row.current_driver_id, driverB.driverId);

      // Driver A: total loss of access.
      const aList = await request(app).get(driverListPath()).set(auth(driverA.token));
      assert.ok(!aList.body.data.some((o: { id: string }) => o.id === orderId));
      const aDetail = await request(app).get(driverDetailPath(orderId)).set(auth(driverA.token));
      assert.equal(aDetail.status, 404);
      const aPickup = await request(app).post(pickupPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(aPickup.status, 404);
      const aStart = await request(app).post(startPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(aStart.status, 404);
      const aFail = await request(app).post(failPath(orderId)).set(auth(driverA.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(aFail.status, 404);
      const aDeliver = await request(app).post(deliverPath(orderId)).set(auth(driverA.token)).send({ actualAmountCollected: "0" });
      assert.equal(aDeliver.status, 404);

      // Driver B cannot skip pickup — ASSIGNED -> OUT_FOR_DELIVERY is not a valid transition.
      const bStartTooSoon = await request(app).post(startPath(orderId)).set(auth(driverB.token)).send();
      assert.equal(bStartTooSoon.status, 400);
      assert.equal(bStartTooSoon.body.error.code, "VALIDATION_ERROR");

      const bDetail = await request(app).get(driverDetailPath(orderId)).set(auth(driverB.token));
      assert.equal(bDetail.status, 200);

      await pickup(orderId, driverB.token);
      await startDelivery(orderId, driverB.token);
      await deliver(orderId, driverB.token, { actualAmountCollected: "105.00" });

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].outcome, "FAILED");
      assert.equal(attempts[0].driver_id, driverA.driverId);
      assert.equal(attempts[1].outcome, "DELIVERED");
      assert.equal(attempts[1].driver_id, driverB.driverId);

      const assignmentHistory = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(assignmentHistory.length, 2);
      assert.ok(assignmentHistory.some((a) => a.driver_id === driverA.driverId && a.is_current === false));
      assert.ok(assignmentHistory.some((a) => a.driver_id === driverB.driverId && a.is_current === true));

      await assertAssignmentConsistency([orderId]);
    });
  });

  // ============================================================
  // FLOW J — CANCELLED DRIVER VISIBILITY
  // ============================================================

  describe("Flow J — cancelled Driver visibility", () => {
    test("cancel before pickup: driver loses access immediately, historical assignment restores nothing", async () => {
      const driver = await createDriverWithToken("driver-cancelled");
      const order = await createBaseOrder();
      await assignOrder(order.id, driver.driverId);

      const before = await request(app).get(driverDetailPath(order.id)).set(auth(driver.token));
      assert.equal(before.status, 200);

      const cancel = await request(app).post(`/api/v1/orders/${order.id}/cancel`).set(auth(tokens.admin)).send({ reason: "cancel before pickup" });
      assert.equal(cancel.status, 200);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.current_driver_id, null);
      const assignment = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: order.id } });
      assert.equal(assignment.is_current, false);

      const list = await request(app).get(driverListPath()).set(auth(driver.token));
      assert.ok(!list.body.data.some((o: { id: string }) => o.id === order.id));
      const detail = await request(app).get(driverDetailPath(order.id)).set(auth(driver.token));
      assert.equal(detail.status, 404);
      const pickupRes = await request(app).post(pickupPath(order.id)).set(auth(driver.token)).send();
      assert.equal(pickupRes.status, 404);
    });
  });

  // ============================================================
  // OWNERSHIP SECURITY MATRIX + HISTORICAL ASSIGNMENT SECURITY
  // ============================================================

  describe("Ownership security matrix", () => {
    test("Driver A cannot detail/pickup/start/fail/deliver Driver B's Order — all safe 404", async () => {
      const driverA = await createDriverWithToken("driverA-security");
      const driverB = await createDriverWithToken("driverB-security");
      const orderId = await createOutForDeliveryOrder(driverB.token, driverB.driverId);

      const detail = await request(app).get(driverDetailPath(orderId)).set(auth(driverA.token));
      assert.equal(detail.status, 404);
      const pickupRes = await request(app).post(pickupPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(pickupRes.status, 404);
      const startRes = await request(app).post(startPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(startRes.status, 404);
      const failRes = await request(app).post(failPath(orderId)).set(auth(driverA.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(failRes.status, 404);
      const deliverRes = await request(app).post(deliverPath(orderId)).set(auth(driverA.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 404);

      for (const res of [detail, pickupRes, startRes, failRes, deliverRes]) {
        assert.equal(res.body.error.code, "NOT_FOUND");
        assert.doesNotMatch(JSON.stringify(res.body), /another driver|belongs to/i);
      }
    });

    test("historical previous Driver retains order_assignments row but has zero operational access", async () => {
      const driverA = await createDriverWithToken("driverA-historical");
      const driverB = await createDriverWithToken("driverB-historical");
      const order = await createBaseOrder();
      await assignOrder(order.id, driverA.driverId);
      await pickup(order.id, driverA.token);
      // reassign is only valid from ASSIGNED/RESCHEDULED — force back via a
      // real fail+reschedule cycle to reach a legitimate reassignable state.
      await startDelivery(order.id, driverA.token);
      await fail(order.id, driverA.token, { failedReasonId: reasonNoNotesId });
      await request(app).post(`/api/v1/orders/${order.id}/reschedule`).set(auth(tokens.admin)).send({ reason: "setup" });
      await request(app)
        .post(`/api/v1/orders/${order.id}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "historical security check" });

      const historicalRow = await prisma.order_assignments.findFirst({ where: { order_id: order.id, driver_id: driverA.driverId } });
      assert.ok(historicalRow, "A's historical assignment row must still exist");
      assert.equal(historicalRow?.is_current, false);

      const detail = await request(app).get(driverDetailPath(order.id)).set(auth(driverA.token));
      assert.equal(detail.status, 404);
      const pickupRes = await request(app).post(pickupPath(order.id)).set(auth(driverA.token)).send();
      assert.equal(pickupRes.status, 404);
      const startRes = await request(app).post(startPath(order.id)).set(auth(driverA.token)).send();
      assert.equal(startRes.status, 404);
      const failRes = await request(app).post(failPath(order.id)).set(auth(driverA.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(failRes.status, 404);
      const deliverRes = await request(app).post(deliverPath(order.id)).set(auth(driverA.token)).send({ actualAmountCollected: "0" });
      assert.equal(deliverRes.status, 404);
    });
  });

  // ============================================================
  // DRIVER PROFILE SECURITY (RBAC)
  // ============================================================

  describe("Driver profile security", () => {
    test("DRIVER allowed; ADMIN without profile / CUSTOMER / DISPATCHER / FINANCE forbidden across all action routes", async () => {
      const driver = await createDriverWithToken("driver-rbac");
      const order = await createBaseOrder();
      await assignOrder(order.id, driver.driverId);

      assert.equal((await request(app).get(driverDetailPath(order.id)).set(auth(driver.token))).status, 200);
      assert.equal((await request(app).post(pickupPath(order.id)).set(auth(driver.token)).send()).status, 200);

      for (const role of ["admin", "customer", "dispatcher", "finance"] as const) {
        const listRes = await request(app).get(driverListPath()).set(auth(tokens[role]));
        assert.equal(listRes.status, 403, `${role} list`);
        const pickupRes = await request(app).post(pickupPath(order.id)).set(auth(tokens[role])).send();
        assert.equal(pickupRes.status, 403, `${role} pickup`);
        const startRes = await request(app).post(startPath(order.id)).set(auth(tokens[role])).send();
        assert.equal(startRes.status, 403, `${role} start`);
        const failRes = await request(app).post(failPath(order.id)).set(auth(tokens[role])).send({ failedReasonId: reasonNoNotesId });
        assert.equal(failRes.status, 403, `${role} fail`);
        const deliverRes = await request(app).post(deliverPath(order.id)).set(auth(tokens[role])).send({ actualAmountCollected: "0" });
        assert.equal(deliverRes.status, 403, `${role} deliver`);
      }
    });
  });

  // ============================================================
  // INVALID STATE MATRIX
  // ============================================================

  describe("Invalid state matrix", () => {
    test("terminal states DELIVERED/FAILED_DELIVERY reject every action", async () => {
      const driver = await createDriverWithToken("driver-terminal");
      const deliveredOrder = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await deliver(deliveredOrder, driver.token, { actualAmountCollected: "105.00" });

      for (const [action, body] of [
        [pickupPath(deliveredOrder), {}],
        [startPath(deliveredOrder), {}],
        [failPath(deliveredOrder), { failedReasonId: reasonNoNotesId }],
        [deliverPath(deliveredOrder), { actualAmountCollected: "0" }],
      ] as const) {
        const res = await request(app).post(action).set(auth(driver.token)).send(body);
        assert.equal(res.status, 400, `expected DELIVERED order to reject ${action}`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      }

      const driver2 = await createDriverWithToken("driver-terminal-failed");
      const failedOrder = await createOutForDeliveryOrder(driver2.token, driver2.driverId);
      await fail(failedOrder, driver2.token, { failedReasonId: reasonNoNotesId });

      const failedPickup = await request(app).post(pickupPath(failedOrder)).set(auth(driver2.token)).send();
      assert.equal(failedPickup.status, 400, "FAILED_DELIVERY must not accept direct pickup");
      const failedStart = await request(app).post(startPath(failedOrder)).set(auth(driver2.token)).send();
      assert.equal(failedStart.status, 400, "FAILED_DELIVERY must not accept direct start-delivery");
      const failedDeliver = await request(app).post(deliverPath(failedOrder)).set(auth(driver2.token)).send({ actualAmountCollected: "0" });
      assert.equal(failedDeliver.status, 400, "FAILED_DELIVERY must not accept direct deliver");
    });

    test("representative invalid sources for each action remain rejected", async () => {
      const driver = await createDriverWithToken("driver-matrix");

      const receivedOrder = await createBaseOrder();
      const pickupFromReceived = await request(app).post(pickupPath(receivedOrder.id)).set(auth(driver.token)).send();
      assert.equal(pickupFromReceived.status, 404, "unowned RECEIVED order is not visible to this driver at all");

      const assignedOrder = await createBaseOrder();
      await assignOrder(assignedOrder.id, driver.driverId);
      const startFromAssigned = await request(app).post(startPath(assignedOrder.id)).set(auth(driver.token)).send();
      assert.equal(startFromAssigned.status, 400);
      const failFromAssigned = await request(app).post(failPath(assignedOrder.id)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(failFromAssigned.status, 400);
      const deliverFromAssigned = await request(app)
        .post(deliverPath(assignedOrder.id))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "0" });
      assert.equal(deliverFromAssigned.status, 400);

      const pickedUpOrder = await createBaseOrder();
      await assignOrder(pickedUpOrder.id, driver.driverId);
      await pickup(pickedUpOrder.id, driver.token);
      const failFromPickedUp = await request(app).post(failPath(pickedUpOrder.id)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(failFromPickedUp.status, 400);
      const deliverFromPickedUp = await request(app)
        .post(deliverPath(pickedUpOrder.id))
        .set(auth(driver.token))
        .send({ actualAmountCollected: "0" });
      assert.equal(deliverFromPickedUp.status, 400);
    });
  });

  // ============================================================
  // DUPLICATE ACTION PROTECTION
  // ============================================================

  describe("Duplicate action protection", () => {
    test("repeated pickup/start/fail/deliver: first succeeds, second rejected, no duplicate side effects", async () => {
      const driverPickup = await createDriverWithToken("driver-dup-pickup");
      const orderPickup = await createBaseOrder();
      await assignOrder(orderPickup.id, driverPickup.driverId);
      await pickup(orderPickup.id, driverPickup.token);
      const secondPickup = await request(app).post(pickupPath(orderPickup.id)).set(auth(driverPickup.token)).send();
      assert.equal(secondPickup.status, 400);
      const pickupHistory = await prisma.order_status_history.count({ where: { order_id: orderPickup.id, to_status: "PICKED_UP" } });
      assert.equal(pickupHistory, 1);

      const driverStart = await createDriverWithToken("driver-dup-start");
      const orderStart = await createBaseOrder();
      await assignOrder(orderStart.id, driverStart.driverId);
      await pickup(orderStart.id, driverStart.token);
      await startDelivery(orderStart.id, driverStart.token);
      const secondStart = await request(app).post(startPath(orderStart.id)).set(auth(driverStart.token)).send();
      assert.equal(secondStart.status, 400);
      const startHistory = await prisma.order_status_history.count({ where: { order_id: orderStart.id, to_status: "OUT_FOR_DELIVERY" } });
      assert.equal(startHistory, 1);

      const driverFail = await createDriverWithToken("driver-dup-fail");
      const orderFail = await createOutForDeliveryOrder(driverFail.token, driverFail.driverId);
      await fail(orderFail, driverFail.token, { failedReasonId: reasonNoNotesId });
      const secondFail = await request(app).post(failPath(orderFail)).set(auth(driverFail.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(secondFail.status, 400);
      const failAttempts = await prisma.delivery_attempts.count({ where: { order_id: orderFail } });
      assert.equal(failAttempts, 1);

      const driverDeliver = await createDriverWithToken("driver-dup-deliver");
      const orderDeliver = await createOutForDeliveryOrder(driverDeliver.token, driverDeliver.driverId);
      await deliver(orderDeliver, driverDeliver.token, { actualAmountCollected: "105.00" });
      const secondDeliver = await request(app)
        .post(deliverPath(orderDeliver))
        .set(auth(driverDeliver.token))
        .send({ actualAmountCollected: "999.00" });
      assert.equal(secondDeliver.status, 400);
      const deliverAttempts = await prisma.delivery_attempts.count({ where: { order_id: orderDeliver } });
      assert.equal(deliverAttempts, 1);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderDeliver } });
      assert.equal(row.actual_amount_collected?.toString(), "105", "the rejected repeat deliver must never overwrite the finalized value");
    });
  });

  // ============================================================
  // CONCURRENCY
  // ============================================================

  describe("Concurrency", () => {
    test("pickup vs pickup: one winner, stable PICKED_UP, zero attempts", async () => {
      const driver = await createDriverWithToken("driver-conc-pickup");
      const order = await createBaseOrder();
      await assignOrder(order.id, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(pickupPath(order.id)).set(auth(driver.token)).send(),
        request(app).post(pickupPath(order.id)).set(auth(driver.token)).send(),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, "PICKED_UP");
      const history = await prisma.order_status_history.count({ where: { order_id: order.id, to_status: "PICKED_UP" } });
      assert.equal(history, 1);
      const attempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(attempts, 0);
    });

    test("start vs start: one winner, one transition, zero finalized attempts", async () => {
      const driver = await createDriverWithToken("driver-conc-start");
      const order = await createBaseOrder();
      await assignOrder(order.id, driver.driverId);
      await pickup(order.id, driver.token);

      const [a, b] = await Promise.all([
        request(app).post(startPath(order.id)).set(auth(driver.token)).send(),
        request(app).post(startPath(order.id)).set(auth(driver.token)).send(),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, "OUT_FOR_DELIVERY");
      const attempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(attempts, 0);
    });

    test("fail vs fail: one winner, one FAILED attempt, one attempt number", async () => {
      const driver = await createDriverWithToken("driver-conc-fail");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonRequiresNotesId, notes: "race" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].attempt_number, 1);
      assert.equal(attempts[0].outcome, "FAILED");
    });

    test("deliver vs deliver: one winner, one DELIVERED attempt, actual belongs to winner only", async () => {
      const driver = await createDriverWithToken("driver-conc-deliver");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" }),
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "50.00", collectionDifferenceReason: "race" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const winner = a.status === 200 ? a : b;
      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].outcome, "DELIVERED");
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.actual_amount_collected?.toString(), winner.body.data.collection.actualAmountCollected);
    });

    test("fail vs deliver: exactly one wins, exactly one finalized attempt matching final status", async () => {
      const driver = await createDriverWithToken("driver-conc-fail-vs-deliver");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const [deliverRes, failRes] = await Promise.all([
        request(app).post(deliverPath(orderId)).set(auth(driver.token)).send({ actualAmountCollected: "105.00" }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId }),
      ]);
      const statuses = [deliverRes.status, failRes.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.ok(["DELIVERED", "FAILED_DELIVERY"].includes(row.status));

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1, "never both a FAILED and a DELIVERED attempt for the same open attempt");
      assert.equal(attempts[0].outcome, row.status === "DELIVERED" ? "DELIVERED" : "FAILED");

      const openTransitions = await prisma.order_status_history.count({ where: { order_id: orderId, from_status: "OUT_FOR_DELIVERY" } });
      assert.equal(openTransitions, 1);

      if (row.status === "FAILED_DELIVERY") {
        assert.equal(row.actual_amount_collected, null, "a losing deliver must never leave partial collection fields");
      }
    });

    test("retry start-delivery vs Management reassign: exactly one compatible outcome, no mixed driver/status", async () => {
      const driverA = await createDriverWithToken("driverA-conc-retry-reassign");
      const driverB = await createDriverWithToken("driverB-conc-retry-reassign");
      const orderId = await createOutForDeliveryOrder(driverA.token, driverA.driverId);
      await fail(orderId, driverA.token, { failedReasonId: reasonNoNotesId });
      await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "concurrency setup" });

      const [start, reassign] = await Promise.all([
        request(app).post(startPath(orderId)).set(auth(driverA.token)).send(),
        request(app).post(`/api/v1/orders/${orderId}/reassign`).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "race" }),
      ]);
      const statuses = [start.status, reassign.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (start.status === 200) {
        assert.equal(row.status, "OUT_FOR_DELIVERY");
        assert.equal(row.current_driver_id, driverA.driverId, "must never be OUT_FOR_DELIVERY with Driver B");
      } else {
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, driverB.driverId);
      }
      const current = await prisma.order_assignments.count({ where: { order_id: orderId, is_current: true } });
      assert.equal(current, 1, "no duplicate current assignment");
    });

    test("retry start-delivery vs Management cancel: exactly one compatible outcome", async () => {
      const driver = await createDriverWithToken("driver-conc-retry-cancel");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await fail(orderId, driver.token, { failedReasonId: reasonNoNotesId });
      await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "concurrency setup" });

      const [start, cancel] = await Promise.all([
        request(app).post(startPath(orderId)).set(auth(driver.token)).send(),
        request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "race" }),
      ]);
      const statuses = [start.status, cancel.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.ok(["OUT_FOR_DELIVERY", "CANCELLED"].includes(row.status));
      await assertAssignmentConsistency([orderId]);
    });
  });

  // ============================================================
  // DRIVER LIST / STATUS FILTERS
  // ============================================================

  describe("Driver list status filters", () => {
    test("status filter is ownership-scoped for every workflow status including DELIVERED", async () => {
      const driverA = await createDriverWithToken("driverA-filters");
      const driverB = await createDriverWithToken("driverB-filters");

      const assignedOrder = await createBaseOrder();
      await assignOrder(assignedOrder.id, driverA.driverId);

      const deliveredOrder = await createOutForDeliveryOrder(driverA.token, driverA.driverId);
      await deliver(deliveredOrder, driverA.token, { actualAmountCollected: "105.00" });

      const otherDeliveredOrder = await createOutForDeliveryOrder(driverB.token, driverB.driverId);
      await deliver(otherDeliveredOrder, driverB.token, { actualAmountCollected: "105.00" });

      const assignedFiltered = await request(app).get(`${driverListPath()}?status=ASSIGNED`).set(auth(driverA.token));
      assert.ok(assignedFiltered.body.data.some((o: { id: string }) => o.id === assignedOrder.id));
      assert.ok(!assignedFiltered.body.data.some((o: { id: string }) => o.id === deliveredOrder));

      const deliveredFiltered = await request(app).get(`${driverListPath()}?status=DELIVERED`).set(auth(driverA.token));
      assert.ok(deliveredFiltered.body.data.some((o: { id: string }) => o.id === deliveredOrder));
      assert.ok(
        !deliveredFiltered.body.data.some((o: { id: string }) => o.id === otherDeliveredOrder),
        "no cross-driver leakage on the DELIVERED filter"
      );
    });
  });

  // ============================================================
  // DRIVER DTO / PRIVACY REVIEW
  // ============================================================

  describe("Driver DTO / privacy review", () => {
    test("list/detail/pickup/start/fail/deliver responses stay within the safe DriverOrderDetail shape", async () => {
      const driverFail = await createDriverWithToken("driver-dto-fail");
      const failOrder = await createOutForDeliveryOrder(driverFail.token, driverFail.driverId);
      const failRes = await fail(failOrder, driverFail.token, { failedReasonId: reasonNoNotesId });

      const driverDeliver = await createDriverWithToken("driver-dto-deliver");
      const deliverOrder = await createOutForDeliveryOrder(driverDeliver.token, driverDeliver.driverId);
      const deliverRes = await deliver(deliverOrder, driverDeliver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "dto review" });

      const list = await request(app).get(driverListPath()).set(auth(driverDeliver.token));
      const detail = await request(app).get(driverDetailPath(deliverOrder)).set(auth(driverDeliver.token));

      const SAFE_KEYS = ["collection", "id", "orderNumber", "orderType", "package", "receiver", "status", "timestamps", "trackingCode"].sort();
      for (const body of [failRes.body.data, deliverRes.body.data, detail.body.data]) {
        assert.deepEqual(Object.keys(body).sort(), SAFE_KEYS);
      }
      assert.deepEqual(Object.keys(list.body.data[0]).sort(), SAFE_KEYS);

      const serialized = JSON.stringify(failRes.body) + JSON.stringify(deliverRes.body) + JSON.stringify(list.body) + JSON.stringify(detail.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /wallet/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /company_financial/i);
      assert.doesNotMatch(serialized, /financialStatus/i);
      assert.doesNotMatch(serialized, /needsFinancialReview/i);
      assert.doesNotMatch(serialized, /collectionDifferenceReason/i);
      assert.doesNotMatch(serialized, /assignmentHistory/i);
      assert.doesNotMatch(serialized, /statusHistory/i);
    });
  });

  // ============================================================
  // MANAGEMENT REPRESENTATION CONSISTENCY
  // ============================================================

  describe("Management representation consistency", () => {
    test("Management detail/list/history reflect state immediately after every Driver action", async () => {
      const driver = await createDriverWithToken("driver-mgmt-consistency");
      const order = await createBaseOrder();
      await assignOrder(order.id, driver.driverId);

      await pickup(order.id, driver.token);
      let detail = await request(app).get(mgmtDetailPath(order.id)).set(auth(tokens.admin));
      assert.equal(detail.body.data.status, "PICKED_UP");

      await startDelivery(order.id, driver.token);
      detail = await request(app).get(mgmtDetailPath(order.id)).set(auth(tokens.admin));
      assert.equal(detail.body.data.status, "OUT_FOR_DELIVERY");

      await fail(order.id, driver.token, { failedReasonId: reasonNoNotesId });
      detail = await request(app).get(mgmtDetailPath(order.id)).set(auth(tokens.admin));
      assert.equal(detail.body.data.status, "FAILED_DELIVERY");
      assert.equal(detail.body.data.deliveryAttempts.length, 1);
      assert.equal(detail.body.data.deliveryAttempts[0].outcome, "FAILED");

      const list = await request(app).get(mgmtListPath("Phase76 Receiver")).set(auth(tokens.admin));
      assert.ok(list.body.data.some((o: { id: string; status: string }) => o.id === order.id && o.status === "FAILED_DELIVERY"));

      const history = await request(app).get(mgmtHistoryPath(order.id)).set(auth(tokens.admin));
      const toStatuses = history.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
      assert.deepEqual(toStatuses, ["RECEIVED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "FAILED_DELIVERY"]);
    });

    test("Management cannot generic-PATCH a DELIVERED or FAILED_DELIVERY order's workflow fields", async () => {
      const driverDelivered = await createDriverWithToken("driver-patch-delivered");
      const deliveredOrder = await createOutForDeliveryOrder(driverDelivered.token, driverDelivered.driverId);
      await deliver(deliveredOrder, driverDelivered.token, { actualAmountCollected: "105.00" });
      const patchDelivered = await request(app).patch(mgmtDetailPath(deliveredOrder)).set(auth(tokens.admin)).send({ description: "no" });
      assert.equal(patchDelivered.status, 400);
      assert.equal(patchDelivered.body.error.code, "VALIDATION_ERROR");

      const driverFailed = await createDriverWithToken("driver-patch-failed");
      const failedOrder = await createOutForDeliveryOrder(driverFailed.token, driverFailed.driverId);
      await fail(failedOrder, driverFailed.token, { failedReasonId: reasonNoNotesId });
      const patchFailed = await request(app).patch(mgmtDetailPath(failedOrder)).set(auth(tokens.admin)).send({ description: "no" });
      assert.equal(patchFailed.status, 400);
      assert.equal(patchFailed.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ============================================================
  // COLLECTION PAYMENT METHOD — GAP CONFIRMATION
  // ============================================================

  describe("Collection payment method", () => {
    test("collection_payment_method_id set at order creation persists unchanged through the full workflow (no delivery-time confirmation exists)", async () => {
      const driver = await createDriverWithToken("driver-payment-method");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.collection_payment_method_id, cashMethodId);

      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.collection_payment_method_id, cashMethodId, "no delivery-time payment-method confirmation mechanism exists yet — the original value is simply carried through unchanged");
    });
  });

  // ============================================================
  // SUITE-WIDE FINAL VERIFICATION
  // ============================================================

  describe("Suite-wide final verification", () => {
    test("every order created by this suite satisfies assignment consistency and zero finance side effects", async () => {
      assert.ok(createdOrderIds.length > 15, "sanity check: this suite should have created a substantial number of orders");
      await assertAssignmentConsistency(createdOrderIds);
      await assertFinanceMatchesOrderState(createdOrderIds);
    });
  });
});
