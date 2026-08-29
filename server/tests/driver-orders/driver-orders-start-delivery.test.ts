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

describe("Driver Portal — Start Delivery (Phase 7.3)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerActive: string;
  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let failedReasonId: string;

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
    const failedReason = await prisma.failed_delivery_reasons.findFirstOrThrow();
    failedReasonId = failedReason.id;
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
      .send({ driverNumber: `PH73-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
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
        receiverName: "Phase73 Receiver",
        receiverPhone: "+96170000011",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase73 St",
        description: "Phase73 start-delivery order",
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

  // Real assign + real pickup -> a genuinely consistent PICKED_UP order
  // owned by driverId (one real order_assignments row, is_current=true).
  async function createPickedUpOrder(driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    return order.id as string;
  }

  // Real assign -> pickup -> force FAILED_DELIVERY (Phase 7.4 doesn't exist
  // yet) -> real Management /reschedule -> a genuinely consistent
  // RESCHEDULED order with the SAME current driver/assignment preserved
  // (Phase 6.6's guarantee), optionally with a seeded finalized FAILED
  // delivery_attempts fixture representing the prior attempt.
  async function createRescheduledOrder(
    driverToken: string,
    driverId: string,
    opts: { seedPriorAttempt?: boolean; overrides?: Record<string, unknown> } = {}
  ) {
    const orderId = await createPickedUpOrder(driverToken, driverId, opts.overrides);
    const outForDeliveryStart = new Date();
    await prisma.orders.update({
      where: { id: orderId },
      data: { status: "FAILED_DELIVERY", out_for_delivery_at: outForDeliveryStart },
    });

    if (opts.seedPriorAttempt) {
      await prisma.delivery_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          attempt_number: 1,
          expected_collection: new Prisma.Decimal("105.00"),
          actual_collection: null,
          outcome: "FAILED",
          failed_reason_id: failedReasonId,
          notes: "Phase 7.3 test fixture — prior failed attempt",
          started_at: outForDeliveryStart,
          completed_at: new Date(),
        },
      });
    }

    const reschedule = await request(app)
      .post(`/api/v1/orders/${orderId}/reschedule`)
      .set(auth(tokens.admin))
      .send({ reason: "phase 7.3 test fixture reschedule" });
    assert.equal(reschedule.status, 200, JSON.stringify(reschedule.body));
    return orderId;
  }

  function startPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/start-delivery`;
  }
  function pickupPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/pickup`;
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

  async function assertNoFinanceSideEffects(orderIds: string[]) {
    const [walletTx, cashTx, companyTx, payouts, settlements] = await Promise.all([
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
      prisma.driver_settlements.count({ where: { driver_id: { in: createdDriverIds } } }),
    ]);
    assert.equal(walletTx, 0);
    assert.equal(cashTx, 0);
    assert.equal(companyTx, 0);
    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
  }

  // ============================================================
  // AUTH / OWNERSHIP (1-9)
  // ============================================================

  describe("Auth / ownership", () => {
    test("1. unauthenticated -> 401", async () => {
      const res = await request(app).post(startPath("00000000-0000-0000-0000-000000000000")).send();
      assert.equal(res.status, 401);
    });

    test("2. linked DRIVER own Order -> allowed", async () => {
      const driver = await createDriverWithToken("driver2");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);
      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. CUSTOMER -> 403", async () => {
      const res = await request(app).post(startPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.customer)).send();
      assert.equal(res.status, 403);
    });

    test("4. FINANCE -> 403", async () => {
      const res = await request(app).post(startPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.finance)).send();
      assert.equal(res.status, 403);
    });

    test("5. DISPATCHER -> 403 (real permission set lacks driver.orders.update_own)", async () => {
      const res = await request(app).post(startPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.dispatcher)).send();
      assert.equal(res.status, 403);
    });

    test("6. ADMIN without Driver profile -> safe 403", async () => {
      const res = await request(app).post(startPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.admin)).send();
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|relation|foreign key/i);
    });

    test("7. Driver A cannot start Driver B's Order -> 404", async () => {
      const driverA = await createDriverWithToken("driverA-7");
      const driverB = await createDriverWithToken("driverB-7");
      const orderB = await createPickedUpOrder(driverB.token, driverB.driverId);
      const res = await request(app).post(startPath(orderB)).set(auth(driverA.token)).send();
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("8. historical previous Driver cannot start after reassignment", async () => {
      const driverA = await createDriverWithToken("driverA-8");
      const driverB = await createDriverWithToken("driverB-8");
      const orderId = await createPickedUpOrder(driverA.token, driverA.driverId);
      // Reassignment isn't allowed from PICKED_UP, so force this order back
      // to ASSIGNED to exercise a real reassign, then re-pickup as A is no
      // longer current — simpler: directly seed the historical-access
      // scenario via a RESCHEDULED->reassign path instead.
      await prisma.orders.update({ where: { id: orderId }, data: { status: "FAILED_DELIVERY" } });
      const reschedule = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "setup" });
      assert.equal(reschedule.status, 200);
      const reassign = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "historical access regression" });
      assert.equal(reassign.status, 200);

      const res = await request(app).post(startPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(res.status, 404);
    });

    test("9. nonexistent Order -> same safe 404 contract", async () => {
      const driverA = await createDriverWithToken("driverA-9");
      const driverB = await createDriverWithToken("driverB-9");
      const orderB = await createPickedUpOrder(driverB.token, driverB.driverId);

      const forOther = await request(app).post(startPath(orderB)).set(auth(driverA.token)).send();
      const forMissing = await request(app).post(startPath("00000000-0000-0000-0000-000000000000")).set(auth(driverA.token)).send();
      assert.equal(forOther.status, forMissing.status);
      assert.equal(forOther.body.error.code, forMissing.body.error.code);
      assert.equal(forOther.status, 404);
    });
  });

  // ============================================================
  // NORMAL START (10-18)
  // ============================================================

  describe("Normal start", () => {
    test("10-18. PICKED_UP -> OUT_FOR_DELIVERY: timestamps, assignment preserved, exactly one history row", async () => {
      const driver = await createDriverWithToken("driver-normal");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const assignmentBefore = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "OUT_FOR_DELIVERY");
      assert.ok(res.body.data.timestamps.outForDeliveryAt);

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.status, "OUT_FOR_DELIVERY");
      assert.ok(after.out_for_delivery_at); // 11
      assert.equal(after.picked_up_at?.getTime(), before.picked_up_at?.getTime()); // 12
      assert.equal(after.assigned_at?.getTime(), before.assigned_at?.getTime()); // 13
      assert.equal(after.current_driver_id, driver.driverId); // 14

      const assignmentAfter = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(assignmentAfter.id, assignmentBefore.id);
      assert.equal(assignmentAfter.is_current, true); // 15
      assert.notEqual(after.updated_at.getTime(), before.updated_at.getTime()); // 16

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "OUT_FOR_DELIVERY" } });
      assert.equal(history.length, 1); // 17
      assert.equal(history[0].from_status, "PICKED_UP");
      assert.equal(history[0].changed_by_id, driver.userId); // 18
    });
  });

  // ============================================================
  // SAME-DRIVER RETRY (19-25)
  // ============================================================

  describe("Same-driver retry", () => {
    test("19-25. RESCHEDULED -> OUT_FOR_DELIVERY: no fake PICKED_UP, prior attempt untouched, no new attempt, new timestamp, same driver", async () => {
      const driver = await createDriverWithToken("driver-retry");
      const orderId = await createRescheduledOrder(driver.token, driver.driverId, { seedPriorAttempt: true });

      const priorAttempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      const beforeRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(beforeRow.status, "RESCHEDULED");

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "OUT_FOR_DELIVERY"); // 20

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } });
      assert.ok(!history.some((h) => h.to_status === "PICKED_UP" && h.from_status === "RESCHEDULED"), "no fake PICKED_UP event"); // 21
      const transitionRows = history.filter((h) => h.from_status === "RESCHEDULED" && h.to_status === "OUT_FOR_DELIVERY");
      assert.equal(transitionRows.length, 1);

      const priorAttemptAfter = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: priorAttempt.id } });
      assert.deepEqual(priorAttemptAfter, priorAttempt); // 22 — byte-for-byte unchanged

      const attemptCount = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attemptCount, 1, "no new delivery_attempt row was created"); // 23

      const afterRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.ok(afterRow.out_for_delivery_at);
      assert.notEqual(afterRow.out_for_delivery_at?.getTime(), beforeRow.out_for_delivery_at?.getTime(), "must be a NEW attempt timestamp"); // 24
      assert.equal(afterRow.current_driver_id, driver.driverId); // 25
    });
  });

  // ============================================================
  // INVALID STATES (26-34)
  // ============================================================

  describe("Invalid states", () => {
    const NOT_STARTABLE = [
      "RECEIVED",
      "READY_FOR_PICKUP",
      "ASSIGNED",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED_DELIVERY",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of NOT_STARTABLE) {
      test(`26-34. start-delivery rejects from ${status}`, async () => {
        const driver = await createDriverWithToken(`driver-invalid-${status}`);
        const orderId = await seedOrderWithStatus(status, { currentDriverId: driver.driverId });
        const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
        assert.equal(res.status, 400, `expected ${status} to be rejected as an invalid transition`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }
  });

  // ============================================================
  // REPEAT / CONCURRENCY (35-38)
  // ============================================================

  describe("Repeat and concurrency", () => {
    test("35-37. first succeeds, repeat rejected, exactly one transition history row", async () => {
      const driver = await createDriverWithToken("driver-repeat");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);

      const first = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(first.status, 200);

      const second = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(second.status, 400);
      assert.equal(second.body.error.code, "VALIDATION_ERROR");

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "OUT_FOR_DELIVERY" } });
      assert.equal(history.length, 1);
    });

    test("38. two simultaneous start-delivery requests: exactly one succeeds, loser 400 or 409, one history row, no attempt", async () => {
      const driver = await createDriverWithToken("driver-concurrency-38");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(startPath(orderId)).set(auth(driver.token)).send(),
        request(app).post(startPath(orderId)).set(auth(driver.token)).send(),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, JSON.stringify({ a: a.body, b: b.body }));
      assert.ok([400, 409].includes(statuses[1]), JSON.stringify({ a: a.body, b: b.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY");

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "OUT_FOR_DELIVERY" } });
      assert.equal(history.length, 1);

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);
    });
  });

  // ============================================================
  // RESCHEDULED RACES (39-40)
  // ============================================================

  describe("Rescheduled races", () => {
    test("39. RESCHEDULED start-delivery vs Management reassign: exactly one winner, consistent final state", async () => {
      const driverA = await createDriverWithToken("driverA-race39");
      const driverB = await createDriverWithToken("driverB-race39");
      const orderId = await createRescheduledOrder(driverA.token, driverA.driverId);

      const [start, reassign] = await Promise.all([
        request(app).post(startPath(orderId)).set(auth(driverA.token)).send(),
        request(app)
          .post(`/api/v1/orders/${orderId}/reassign`)
          .set(auth(tokens.admin))
          .send({ driverId: driverB.driverId, reason: "race with start-delivery" }),
      ]);
      // Exactly one must succeed. The loser can observe the race either via
      // the losing conditional updateMany (409) or, if its own pre-
      // transaction status read happens strictly after the winner's commit,
      // via its own status-validity check (400). Both are correct outcomes
      // of the same guard — see Phase 7.2/7.6's identical treatment.
      const startVsReassignStatuses = [start.status, reassign.status].sort();
      assert.equal(startVsReassignStatuses[0], 200, JSON.stringify({ start: start.body, reassign: reassign.body }));
      assert.ok([400, 409].includes(startVsReassignStatuses[1]), JSON.stringify({ start: start.body, reassign: reassign.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (start.status === 200) {
        assert.equal(row.status, "OUT_FOR_DELIVERY");
        assert.equal(row.current_driver_id, driverA.driverId);
        const detailB = await request(app).get(driverDetailPath(orderId)).set(auth(driverB.token));
        assert.equal(detailB.status, 404, "Driver B must never gain access after a lost reassign race");
      } else {
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, driverB.driverId);
        const detailA = await request(app).get(driverDetailPath(orderId)).set(auth(driverA.token));
        assert.equal(detailA.status, 404, "Driver A must lose access after losing the race");
        const failedStart = await request(app).post(startPath(orderId)).set(auth(driverA.token)).send();
        assert.equal(failedStart.status, 404);
      }

      const current = (await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } })).length;
      assert.equal(current, 1, "no mixed assignment state");
    });

    test("40. RESCHEDULED start-delivery vs Management cancel: exactly one winner, consistent final state", async () => {
      const driver = await createDriverWithToken("driver-race40");
      const orderId = await createRescheduledOrder(driver.token, driver.driverId);

      const [start, cancel] = await Promise.all([
        request(app).post(startPath(orderId)).set(auth(driver.token)).send(),
        request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "race with start-delivery" }),
      ]);
      // Same tolerant treatment as the reassign race above.
      const startVsCancelStatuses = [start.status, cancel.status].sort();
      assert.equal(startVsCancelStatuses[0], 200, JSON.stringify({ start: start.body, cancel: cancel.body }));
      assert.ok([400, 409].includes(startVsCancelStatuses[1]), JSON.stringify({ start: start.body, cancel: cancel.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (start.status === 200) {
        assert.equal(row.status, "OUT_FOR_DELIVERY");
        assert.equal(row.current_driver_id, driver.driverId);
        assert.equal(row.cancelled_at, null);
      } else {
        assert.equal(row.status, "CANCELLED");
        assert.equal(row.current_driver_id, null);
        const assignment = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
        assert.equal(assignment.is_current, false);
      }
    });
  });

  // ============================================================
  // ASSIGNMENT INTEGRITY (41-43)
  // ============================================================

  describe("Assignment integrity", () => {
    test("41. current_driver_id set but missing current assignment row -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-integrity-41");
      const orderId = await seedOrderWithStatus("PICKED_UP", { currentDriverId: driver.driverId });
      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "PICKED_UP", "must not be silently transitioned");
    });

    test("42. duplicate current assignment rows -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-integrity-42");
      const otherDriver = await createDriverWithToken("driver-integrity-42-other");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);
      await prisma.order_assignments.create({
        data: { order_id: orderId, driver_id: otherDriver.driverId, assigned_by_id: admin.id, is_current: true },
      });

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("43. mismatched current assignment driver -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-integrity-43");
      const otherDriver = await createDriverWithToken("driver-integrity-43-other");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);
      await prisma.order_assignments.updateMany({
        where: { order_id: orderId, is_current: true },
        data: { driver_id: otherDriver.driverId },
      });

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });
  });

  // ============================================================
  // VISIBILITY (44-47)
  // ============================================================

  describe("Visibility", () => {
    test("44-47. driver list/detail and management detail/history all reflect OUT_FOR_DELIVERY immediately", async () => {
      const driver = await createDriverWithToken("driver-visibility");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);

      const start = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(start.status, 200);

      const driverList = await request(app).get(driverListPath()).set(auth(driver.token));
      const listItem = driverList.body.data.find((o: { id: string }) => o.id === orderId);
      assert.ok(listItem);
      assert.equal(listItem.status, "OUT_FOR_DELIVERY");

      const driverDetail = await request(app).get(driverDetailPath(orderId)).set(auth(driver.token));
      assert.equal(driverDetail.body.data.status, "OUT_FOR_DELIVERY");

      const mgmtDetail = await request(app).get(mgmtDetailPath(orderId)).set(auth(tokens.admin));
      assert.equal(mgmtDetail.body.data.status, "OUT_FOR_DELIVERY");
      assert.ok(mgmtDetail.body.data.outForDeliveryAt);

      const mgmtHistory = await request(app).get(mgmtHistoryPath(orderId)).set(auth(tokens.admin));
      const toStatuses = mgmtHistory.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
      assert.deepEqual(toStatuses, ["RECEIVED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY"]);
    });
  });

  // ============================================================
  // DELIVERY ATTEMPT BEHAVIOR (48-50)
  // ============================================================

  describe("Delivery attempt behavior", () => {
    test("48. PICKED_UP start creates zero delivery_attempts", async () => {
      const driver = await createDriverWithToken("driver-attempt-48");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);
      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200);
      const count = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(count, 0);
    });

    test("49-50. RESCHEDULED retry start creates zero NEW delivery_attempts, prior finalized row byte-for-byte unchanged", async () => {
      const driver = await createDriverWithToken("driver-attempt-49");
      const orderId = await createRescheduledOrder(driver.token, driver.driverId, { seedPriorAttempt: true });
      const before = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200);

      const count = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(count, 1, "no new attempt row created");
      const after = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: before.id } });
      assert.deepEqual(after, before);
    });
  });

  // ============================================================
  // SIDE EFFECTS (51-53)
  // ============================================================

  describe("Side effects", () => {
    test("51-53. zero finance ledgers, financial fields unchanged, zero assignment-history changes", async () => {
      const driver = await createDriverWithToken("driver-side-effects");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const assignmentsBefore = await prisma.order_assignments.count({ where: { order_id: orderId } });

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200);

      await assertNoFinanceSideEffects([orderId]);

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.actual_amount_collected, before.actual_amount_collected);
      assert.equal(after.needs_financial_review, before.needs_financial_review);
      assert.equal(after.financial_status, before.financial_status);
      assert.equal(after.amount_to_collect.toString(), before.amount_to_collect.toString());

      const assignmentsAfter = await prisma.order_assignments.count({ where: { order_id: orderId } });
      assert.equal(assignmentsAfter, assignmentsBefore);
    });
  });

  // ============================================================
  // DTO SECURITY (54-55)
  // ============================================================

  describe("DTO security", () => {
    test("54-55. response is DriverOrderDetail with no Management/finance/auth leakage", async () => {
      const driver = await createDriverWithToken("driver-dto");
      const orderId = await createPickedUpOrder(driver.token, driver.driverId);

      const res = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200);
      assert.deepEqual(
        Object.keys(res.body.data).sort(),
        ["collection", "id", "orderNumber", "orderType", "package", "receiver", "status", "timestamps", "trackingCode"].sort()
      );

      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /wallet/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /company_financial/i);
      assert.doesNotMatch(serialized, /assignmentHistory/i);
      assert.doesNotMatch(serialized, /statusHistory/i);
    });
  });

  // ============================================================
  // REGRESSION (56-58)
  // ============================================================

  describe("Regression", () => {
    test("56-58. Phase 7.1 reads, Phase 7.2 pickup, and Phase 6 assign/reschedule/reassign/cancel all still work", async () => {
      const driver = await createDriverWithToken("driver-regression");

      const list = await request(app).get(driverListPath()).set(auth(driver.token));
      assert.equal(list.status, 200);

      const order = await createBaseOrder();
      const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(assign.status, 200);

      const pickup = await request(app).post(pickupPath(order.id)).set(auth(driver.token)).send();
      assert.equal(pickup.status, 200);

      const detail = await request(app).get(driverDetailPath(order.id)).set(auth(driver.token));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "PICKED_UP");

      const cancelOrder = await createBaseOrder();
      const cancel = await request(app).post(`/api/v1/orders/${cancelOrder.id}/cancel`).set(auth(tokens.admin)).send({ reason: "regression check" });
      assert.equal(cancel.status, 200);
    });
  });
});
