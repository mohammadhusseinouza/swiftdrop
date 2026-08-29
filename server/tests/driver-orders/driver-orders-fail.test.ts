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
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Driver Portal — Failed Delivery (Phase 7.4)", () => {
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

    // Dedicated temporary reasons — never mutate the canonical seeded rows.
    const suffix = uniqueSuffix();
    const noNotesReason = await prisma.failed_delivery_reasons.create({
      data: { name: `Phase74 No Notes Required ${suffix}`, requires_notes: false, is_active: true },
    });
    reasonNoNotesId = noNotesReason.id;
    createdReasonIds.push(reasonNoNotesId);

    const requiresNotesReason = await prisma.failed_delivery_reasons.create({
      data: { name: `Phase74 Notes Required ${suffix}`, requires_notes: true, is_active: true },
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
      .send({ driverNumber: `PH74-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
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
        receiverName: "Phase74 Receiver",
        receiverPhone: "+96170000012",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase74 St",
        description: "Phase74 fail-delivery order",
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

  // Real assign -> real pickup -> real start-delivery -> a genuinely
  // consistent OUT_FOR_DELIVERY order owned by driverId with a real
  // out_for_delivery_at and a real, consistent order_assignments row.
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
  // RBAC / OWNERSHIP (1-9)
  // ============================================================

  describe("RBAC / ownership", () => {
    test("1. unauthenticated fail -> 401", async () => {
      const res = await request(app).post(failPath("00000000-0000-0000-0000-000000000000")).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 401);
    });

    test("2. linked Driver own Order -> success", async () => {
      const driver = await createDriverWithToken("driver2");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. Customer -> 403", async () => {
      const res = await request(app)
        .post(failPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.customer))
        .send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 403);
    });

    test("4. Finance -> 403", async () => {
      const res = await request(app)
        .post(failPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.finance))
        .send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 403);
    });

    test("5. Dispatcher -> 403 (real permission set lacks driver.orders.update_own)", async () => {
      const res = await request(app)
        .post(failPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.dispatcher))
        .send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 403);
    });

    test("6. Admin without Driver profile -> safe 403", async () => {
      const res = await request(app)
        .post(failPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.admin))
        .send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|relation|foreign key/i);
    });

    test("7. Driver A cannot fail Driver B's Order -> 404", async () => {
      const driverA = await createDriverWithToken("driverA-7");
      const driverB = await createDriverWithToken("driverB-7");
      const orderB = await createOutForDeliveryOrder(driverB.token, driverB.driverId);
      const res = await request(app).post(failPath(orderB)).set(auth(driverA.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("8. historical previous Driver cannot fail after reassignment", async () => {
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

      const res = await request(app).post(failPath(orderId)).set(auth(driverA.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 404);
    });

    test("9. nonexistent Order -> identical safe 404", async () => {
      const driverA = await createDriverWithToken("driverA-9");
      const driverB = await createDriverWithToken("driverB-9");
      const orderB = await createOutForDeliveryOrder(driverB.token, driverB.driverId);

      const forOther = await request(app).post(failPath(orderB)).set(auth(driverA.token)).send({ failedReasonId: reasonNoNotesId });
      const forMissing = await request(app)
        .post(failPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(driverA.token))
        .send({ failedReasonId: reasonNoNotesId });
      assert.equal(forOther.status, forMissing.status);
      assert.equal(forOther.body.error.code, forMissing.body.error.code);
      assert.equal(forOther.status, 404);
    });
  });

  // ============================================================
  // REASON VALIDATION (10-16)
  // ============================================================

  describe("Reason validation", () => {
    test("10. active non-required-notes reason -> succeeds without notes", async () => {
      const driver = await createDriverWithToken("driver-reason-10");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("11. active reason with notes -> succeeds", async () => {
      const driver = await createDriverWithToken("driver-reason-11");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonNoNotesId, notes: "gate was locked" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("12. requires_notes=true + no notes -> 400", async () => {
      const driver = await createDriverWithToken("driver-reason-12");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonRequiresNotesId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("13. requires_notes=true + whitespace notes -> 400", async () => {
      const driver = await createDriverWithToken("driver-reason-13");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "   " });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("14. inactive reason -> 400", async () => {
      const suffix = uniqueSuffix();
      const inactiveReason = await prisma.failed_delivery_reasons.create({
        data: { name: `Phase74 Inactive ${suffix}`, requires_notes: false, is_active: false },
      });
      createdReasonIds.push(inactiveReason.id);

      const driver = await createDriverWithToken("driver-reason-14");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: inactiveReason.id });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("15. nonexistent reason -> 400", async () => {
      const driver = await createDriverWithToken("driver-reason-15");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: "00000000-0000-0000-0000-000000000000" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("16. selected reason row remains unchanged", async () => {
      const before = await prisma.failed_delivery_reasons.findUniqueOrThrow({ where: { id: reasonNoNotesId } });
      const driver = await createDriverWithToken("driver-reason-16");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 200);
      const after = await prisma.failed_delivery_reasons.findUniqueOrThrow({ where: { id: reasonNoNotesId } });
      assert.deepEqual(after, before);
    });
  });

  // ============================================================
  // SUCCESSFUL FAIL (17-32)
  // ============================================================

  describe("Successful fail", () => {
    test("17-32. OUT_FOR_DELIVERY -> FAILED_DELIVERY with a fully correct finalized attempt", async () => {
      const driver = await createDriverWithToken("driver-success");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const assignmentBefore = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });

      const res = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "receiver refused package" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "FAILED_DELIVERY"); // 17

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.current_driver_id, driver.driverId); // 18
      assert.equal(after.assigned_at?.getTime(), before.assigned_at?.getTime()); // 19

      const assignmentAfter = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(assignmentAfter.id, assignmentBefore.id);
      assert.equal(assignmentAfter.is_current, true); // 20

      assert.equal(after.out_for_delivery_at?.getTime(), before.out_for_delivery_at?.getTime()); // 21
      assert.equal(after.delivered_at, null); // 22

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1); // 23
      const attempt = attempts[0];
      assert.equal(attempt.outcome, "FAILED"); // 24
      assert.equal(attempt.driver_id, driver.driverId); // 25
      assert.equal(attempt.expected_collection.toString(), before.amount_to_collect.toString()); // 26
      assert.equal(attempt.actual_collection, null); // 27
      assert.equal(attempt.failed_reason_id, reasonRequiresNotesId); // 28
      assert.equal(attempt.notes, "receiver refused package"); // 29
      assert.equal(attempt.started_at.getTime(), before.out_for_delivery_at?.getTime()); // 30
      assert.ok(attempt.completed_at); // 31
      assert.equal(attempt.attempt_number, 1); // 32
    });
  });

  // ============================================================
  // STATUS HISTORY (33-36)
  // ============================================================

  describe("Status history", () => {
    test("33-36. exactly one OUT_FOR_DELIVERY -> FAILED_DELIVERY row, correct actor/reason/notes", async () => {
      const driver = await createDriverWithToken("driver-history");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const reason = await prisma.failed_delivery_reasons.findUniqueOrThrow({ where: { id: reasonRequiresNotesId } });

      const res = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "address unreachable" });
      assert.equal(res.status, 200);

      const rows = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "FAILED_DELIVERY" } });
      assert.equal(rows.length, 1); // 33
      assert.equal(rows[0].from_status, "OUT_FOR_DELIVERY");
      assert.equal(rows[0].changed_by_id, driver.userId); // 34
      assert.equal(rows[0].reason, reason.name); // 35
      assert.equal(rows[0].notes, "address unreachable"); // 36
    });
  });

  // ============================================================
  // INVALID STATES (37-46)
  // ============================================================

  describe("Invalid states", () => {
    const NOT_FAILABLE = [
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

    for (const status of NOT_FAILABLE) {
      test(`37-46. fail rejects from ${status}`, async () => {
        const driver = await createDriverWithToken(`driver-invalid-${status}`);
        const orderId = await seedOrderWithStatus(status, { currentDriverId: driver.driverId });
        const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
        assert.equal(res.status, 400, `expected ${status} to be rejected as an invalid transition`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }
  });

  // ============================================================
  // CONSISTENCY FAILURES (47-50)
  // ============================================================

  describe("Consistency failures", () => {
    test("47. OUT_FOR_DELIVERY + null out_for_delivery_at -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-47");
      const orderId = await seedOrderWithStatus("OUT_FOR_DELIVERY", { currentDriverId: driver.driverId });
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY", "must not be silently transitioned");
      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);
    });

    test("48. missing current assignment -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-48");
      const orderId = await seedOrderWithStatus("OUT_FOR_DELIVERY", {
        currentDriverId: driver.driverId,
        assignedAt: new Date(),
      });
      await prisma.orders.update({ where: { id: orderId }, data: { out_for_delivery_at: new Date() } });
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("49. duplicate current assignments -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-49");
      const otherDriver = await createDriverWithToken("driver-consistency-49-other");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await prisma.order_assignments.create({
        data: { order_id: orderId, driver_id: otherDriver.driverId, assigned_by_id: admin.id, is_current: true },
      });

      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("50. mismatched current assignment driver -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-consistency-50");
      const otherDriver = await createDriverWithToken("driver-consistency-50-other");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      await prisma.order_assignments.updateMany({
        where: { order_id: orderId, is_current: true },
        data: { driver_id: otherDriver.driverId },
      });

      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });
  });

  // ============================================================
  // REPEAT / CONCURRENCY (51-54)
  // ============================================================

  describe("Repeat and concurrency", () => {
    test("51-53. first fail succeeds, repeat rejected, exactly one attempt remains", async () => {
      const driver = await createDriverWithToken("driver-repeat");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const first = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(first.status, 200);

      const second = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(second.status, 400);
      assert.equal(second.body.error.code, "VALIDATION_ERROR");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 1);
    });

    test("54. two simultaneous fail requests: exactly one 200, loser 400 or 409, one attempt, one transition", async () => {
      const driver = await createDriverWithToken("driver-concurrency-54");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, JSON.stringify({ a: a.body, b: b.body }));
      assert.ok([400, 409].includes(statuses[1]), JSON.stringify({ a: a.body, b: b.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "FAILED_DELIVERY");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 1);

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "FAILED_DELIVERY" } });
      assert.equal(history.length, 1);
    });
  });

  // ============================================================
  // RETRY ATTEMPTS (55-61)
  // ============================================================

  describe("Retry attempts", () => {
    test("55-61. two real failed attempts across a reschedule retry: sequential numbering, independent data", async () => {
      const driver = await createDriverWithToken("driver-retry");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);

      const fail1 = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "reason A notes" });
      assert.equal(fail1.status, 200, JSON.stringify(fail1.body));

      const reschedule = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "retry setup" });
      assert.equal(reschedule.status, 200);

      const attempt1AfterReschedule = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 1 } });

      const start2 = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(start2.status, 200, JSON.stringify(start2.body));

      const fail2 = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonNoNotesId, notes: "reason B notes" });
      assert.equal(fail2.status, 200, JSON.stringify(fail2.body));

      const allAttempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
      assert.equal(allAttempts.length, 2);
      assert.equal(allAttempts[0].attempt_number, 1);
      assert.equal(allAttempts[1].attempt_number, 2); // 55, 58, 60

      const attempt1Final = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: attempt1AfterReschedule.id } });
      assert.deepEqual(attempt1Final, attempt1AfterReschedule); // 56, 59 — Attempt 1 never overwritten

      assert.notEqual(allAttempts[0].started_at.getTime(), allAttempts[1].started_at.getTime()); // 61
      assert.equal(allAttempts[0].failed_reason_id, reasonRequiresNotesId);
      assert.equal(allAttempts[0].notes, "reason A notes");
      assert.equal(allAttempts[1].failed_reason_id, reasonNoNotesId);
      assert.equal(allAttempts[1].notes, "reason B notes");

      const current = await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } });
      assert.equal(current.length, 1); // 57 — only one current assignment

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "FAILED_DELIVERY");

      await assertNoFinanceSideEffects([orderId]);
    });
  });

  // ============================================================
  // MANAGEMENT DETAIL (62-69)
  // ============================================================

  describe("Management detail deliveryAttempts", () => {
    test("62-63. exposes deliveryAttempts; a no-attempt Order returns an empty array", async () => {
      const noAttemptOrder = await createBaseOrder();
      const noAttemptDetail = await request(app).get(mgmtDetailPath(noAttemptOrder.id)).set(auth(tokens.admin));
      assert.equal(noAttemptDetail.status, 200);
      assert.deepEqual(noAttemptDetail.body.data.deliveryAttempts, []); // 63

      const driver = await createDriverWithToken("driver-mgmt-detail");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const fail = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "mgmt detail check" });
      assert.equal(fail.status, 200);

      const detail = await request(app).get(mgmtDetailPath(orderId)).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.deliveryAttempts.length, 1); // 62
    });

    test("64-69. attempts oldest-first, correct serialization, safe DTOs, no leaks", async () => {
      const driver = await createDriverWithToken("driver-mgmt-dto");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const fail1 = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "attempt one" });
      assert.equal(fail1.status, 200);
      await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "second attempt setup" });
      await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      const fail2 = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonNoNotesId, notes: "attempt two" });
      assert.equal(fail2.status, 200);

      const detail = await request(app).get(mgmtDetailPath(orderId)).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      const attempts = detail.body.data.deliveryAttempts;
      assert.equal(attempts.length, 2);
      assert.ok(attempts[0].attemptNumber < attempts[1].attemptNumber); // 64

      assert.equal(typeof attempts[0].expectedCollection, "string"); // 65
      assert.equal(attempts[0].expectedCollection, "105");
      assert.equal(attempts[0].actualCollection, null); // 66

      assert.deepEqual(Object.keys(attempts[0].failedReason).sort(), ["id", "name"].sort()); // 67
      assert.equal(attempts[0].failedReason.id, reasonRequiresNotesId);

      assert.deepEqual(Object.keys(attempts[0].driver).sort(), ["driverNumber", "id", "user"].sort()); // 68
      assert.deepEqual(Object.keys(attempts[0].driver.user).sort(), ["firstName", "lastName", "phone"].sort());

      const serialized = JSON.stringify(detail.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /driver_cash_account/i);
      assert.doesNotMatch(serialized, /wallet/i); // 69
    });
  });

  // ============================================================
  // VISIBILITY / INTEGRATION (70-76)
  // ============================================================

  describe("Visibility / integration", () => {
    test("70-76. driver + management visibility consistent; reschedule works after real failure", async () => {
      const driver = await createDriverWithToken("driver-visibility");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const fail = await request(app)
        .post(failPath(orderId))
        .set(auth(driver.token))
        .send({ failedReasonId: reasonRequiresNotesId, notes: "visibility check" });
      assert.equal(fail.status, 200);

      const driverList = await request(app).get(driverListPath()).set(auth(driver.token));
      assert.ok(driverList.body.data.some((o: { id: string }) => o.id === orderId)); // 70

      const driverDetail = await request(app).get(driverDetailPath(orderId)).set(auth(driver.token));
      assert.equal(driverDetail.body.data.status, "FAILED_DELIVERY"); // 71

      const mgmtList = await request(app).get(mgmtListPath("Phase74 Receiver")).set(auth(tokens.admin));
      assert.ok(mgmtList.body.data.some((o: { id: string; status: string }) => o.id === orderId && o.status === "FAILED_DELIVERY")); // 72

      const mgmtDetail = await request(app).get(mgmtDetailPath(orderId)).set(auth(tokens.admin));
      assert.equal(mgmtDetail.body.data.deliveryAttempts.length, 1); // 73

      const mgmtHistory = await request(app).get(mgmtHistoryPath(orderId)).set(auth(tokens.admin));
      const toStatuses = mgmtHistory.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
      assert.deepEqual(toStatuses, ["RECEIVED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "FAILED_DELIVERY"]); // 74

      const attemptBefore = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      const reschedule = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "post-fail reschedule" });
      assert.equal(reschedule.status, 200, JSON.stringify(reschedule.body)); // 75
      const attemptAfter = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: attemptBefore.id } });
      assert.deepEqual(attemptAfter, attemptBefore); // 76
    });
  });

  // ============================================================
  // NO FINANCE (77-80)
  // ============================================================

  describe("No finance", () => {
    test("77-80. financial fields unchanged, zero finance ledger rows", async () => {
      const driver = await createDriverWithToken("driver-no-finance");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
      assert.equal(res.status, 200);

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.actual_amount_collected, before.actual_amount_collected); // 77
      assert.equal(after.needs_financial_review, before.needs_financial_review); // 78
      assert.equal(after.financial_status, before.financial_status); // 79
      assert.equal(after.amount_to_collect.toString(), before.amount_to_collect.toString());
      assert.equal(after.remaining_order_amount.toString(), before.remaining_order_amount.toString());
      assert.equal(after.remaining_delivery_fee.toString(), before.remaining_delivery_fee.toString());

      await assertNoFinanceSideEffects([orderId]); // 80
    });
  });

  // ============================================================
  // DTO SECURITY (81-82)
  // ============================================================

  describe("DTO security", () => {
    test("81-82. /fail response is DriverOrderDetail with no Management/finance/auth leakage", async () => {
      const driver = await createDriverWithToken("driver-dto");
      const orderId = await createOutForDeliveryOrder(driver.token, driver.driverId);
      const res = await request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonNoNotesId });
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
      assert.doesNotMatch(serialized, /deliveryAttempts/i);
    });
  });

  // ============================================================
  // REGRESSION (83-86)
  // ============================================================

  describe("Regression", () => {
    test("83-86. Phase 7.1 reads, 7.2 pickup, 7.3 start-delivery, Phase 6 reschedule/cancel/reassign all still work", async () => {
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

      const cancelOrder = await createBaseOrder();
      const cancel = await request(app).post(`/api/v1/orders/${cancelOrder.id}/cancel`).set(auth(tokens.admin)).send({ reason: "regression check" });
      assert.equal(cancel.status, 200);

      const reassignOrder = await createBaseOrder();
      const driverB = await createDriverWithToken("driver-regression-b");
      const assignForReassign = await request(app)
        .post(`/api/v1/orders/${reassignOrder.id}/assign`)
        .set(auth(tokens.admin))
        .send({ driverId: driver.driverId });
      assert.equal(assignForReassign.status, 200);
      const reassign = await request(app)
        .post(`/api/v1/orders/${reassignOrder.id}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "regression check" });
      assert.equal(reassign.status, 200);
    });
  });
});
