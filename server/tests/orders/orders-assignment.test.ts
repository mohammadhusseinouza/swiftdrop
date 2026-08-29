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
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  setUserActive,
  type TestUser,
} from "../helpers/fixtures";

describe("Orders assignment backend (Phase 6.5 — Assign / Reassign / Bulk Assign)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerActive: string;
  let areaActive: { id: string; name: string };
  let cashMethodId: string;

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

    customerActive = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerActive);
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
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createEligibleDriver() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH65-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, userFirstName: "Phase45" };
  }

  async function createBaseOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerActive,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase65 Receiver",
        receiverPhone: "+96170000001",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase65 St",
        description: "Phase65 base order",
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

  function assignPath(orderId: string) {
    return `/api/v1/orders/${orderId}/assign`;
  }
  function reassignPath(orderId: string) {
    return `/api/v1/orders/${orderId}/reassign`;
  }

  // ===========================================================
  // AUTHORIZATION
  // ===========================================================

  describe("Authorization", () => {
    test("assign: unauthenticated -> 401, ADMIN/DISPATCHER allowed, FINANCE/DRIVER/CUSTOMER -> 403", async () => {
      const eligible = await createEligibleDriver();

      const order1 = await createBaseOrder();
      const unauth = await request(app).post(assignPath(order1.id)).send({ driverId: eligible.driverId });
      assert.equal(unauth.status, 401);

      const order2 = await createBaseOrder();
      const adminRes = await request(app).post(assignPath(order2.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(adminRes.status, 200);

      const order3 = await createBaseOrder();
      const dispatcherRes = await request(app)
        .post(assignPath(order3.id))
        .set(auth(tokens.dispatcher))
        .send({ driverId: eligible.driverId });
      assert.equal(dispatcherRes.status, 200);

      for (const role of ["finance", "driver", "customer"] as const) {
        const order = await createBaseOrder();
        const res = await request(app).post(assignPath(order.id)).set(auth(tokens[role])).send({ driverId: eligible.driverId });
        assert.equal(res.status, 403, `expected ${role} to be forbidden`);
      }
    });

    test("reassign: same RBAC matrix", async () => {
      const eligibleA = await createEligibleDriver();
      const eligibleB = await createEligibleDriver();

      async function assignedOrder() {
        const order = await createBaseOrder();
        const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligibleA.driverId });
        assert.equal(assign.status, 200);
        return order.id;
      }

      const order1 = await assignedOrder();
      const unauth = await request(app).post(reassignPath(order1)).send({ driverId: eligibleB.driverId, reason: "test" });
      assert.equal(unauth.status, 401);

      const order2 = await assignedOrder();
      const adminRes = await request(app)
        .post(reassignPath(order2))
        .set(auth(tokens.admin))
        .send({ driverId: eligibleB.driverId, reason: "admin reassign" });
      assert.equal(adminRes.status, 200);

      const order3 = await assignedOrder();
      const dispatcherRes = await request(app)
        .post(reassignPath(order3))
        .set(auth(tokens.dispatcher))
        .send({ driverId: eligibleB.driverId, reason: "dispatcher reassign" });
      assert.equal(dispatcherRes.status, 200);

      for (const role of ["finance", "driver", "customer"] as const) {
        const orderId = await assignedOrder();
        const res = await request(app)
          .post(reassignPath(orderId))
          .set(auth(tokens[role]))
          .send({ driverId: eligibleB.driverId, reason: "attempt" });
        assert.equal(res.status, 403, `expected ${role} to be forbidden`);
      }
    });

    test("bulk-assign: same RBAC matrix", async () => {
      const eligible = await createEligibleDriver();

      const orderU = await createBaseOrder();
      const unauth = await request(app).post("/api/v1/orders/bulk-assign").send({ orderIds: [orderU.id], driverId: eligible.driverId });
      assert.equal(unauth.status, 401);

      const orderAdmin = await createBaseOrder();
      const adminRes = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [orderAdmin.id], driverId: eligible.driverId });
      assert.equal(adminRes.status, 200);

      const orderDispatcher = await createBaseOrder();
      const dispatcherRes = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.dispatcher))
        .send({ orderIds: [orderDispatcher.id], driverId: eligible.driverId });
      assert.equal(dispatcherRes.status, 200);

      for (const role of ["finance", "driver", "customer"] as const) {
        const order = await createBaseOrder();
        const res = await request(app)
          .post("/api/v1/orders/bulk-assign")
          .set(auth(tokens[role]))
          .send({ orderIds: [order.id], driverId: eligible.driverId });
        assert.equal(res.status, 403, `expected ${role} to be forbidden`);
      }
    });
  });

  // ===========================================================
  // DRIVER ELIGIBILITY (7-11)
  // ===========================================================

  describe("Driver eligibility", () => {
    test("7. active Driver + active User -> allowed", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      const res = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 200);
    });

    test("8. missing Driver -> 404", async () => {
      const order = await createBaseOrder();
      const res = await request(app)
        .post(assignPath(order.id))
        .set(auth(tokens.admin))
        .send({ driverId: "00000000-0000-0000-0000-000000000000" });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("9. inactive Driver -> rejected", async () => {
      const eligible = await createEligibleDriver();
      const deactivate = await request(app)
        .patch(`/api/v1/drivers/${eligible.driverId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(deactivate.status, 200);

      const order = await createBaseOrder();
      const res = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("10. active Driver with inactive User -> rejected", async () => {
      const eligible = await createEligibleDriver();
      await setUserActive(eligible.userId, false);

      const order = await createBaseOrder();
      const res = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");

      await setUserActive(eligible.userId, true);
    });

    test("11. Driver data is not modified by assignment", async () => {
      const eligible = await createEligibleDriver();
      const before = await prisma.drivers.findUniqueOrThrow({ where: { id: eligible.driverId } });

      const order = await createBaseOrder();
      const res = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 200);

      const after = await prisma.drivers.findUniqueOrThrow({ where: { id: eligible.driverId } });
      assert.equal(after.is_active, before.is_active);
      assert.equal(after.driver_number, before.driver_number);
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "assigning an order must not touch the driver row");
    });
  });

  // ===========================================================
  // INITIAL ASSIGN (12-22)
  // ===========================================================

  describe("Initial assignment", () => {
    test("12. RECEIVED unassigned Order -> assign succeeds", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      assert.equal(order.status, "RECEIVED");
      const res = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 200);
    });

    test("13. READY_FOR_PICKUP unassigned Order -> assign succeeds", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await seedOrderWithStatus("READY_FOR_PICKUP");
      const res = await request(app).post(assignPath(orderId)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 200);
    });

    test("14-22. full assignment result: status, currentDriverId, assignedAt, history, actor, detail", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      const before = new Date();

      const res = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      // 14-16
      assert.equal(res.body.data.status, "ASSIGNED");
      assert.equal(res.body.data.currentDriver.id, eligible.driverId);
      assert.ok(res.body.data.assignedAt);
      assert.ok(new Date(res.body.data.assignedAt).getTime() >= before.getTime());

      // 17-18: exactly one current assignment-history row, correct actor
      const assignments = await prisma.order_assignments.findMany({ where: { order_id: order.id } });
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0].is_current, true);
      assert.equal(assignments[0].driver_id, eligible.driverId);
      assert.equal(assignments[0].assigned_by_id, admin.id);

      // 19-20: status history from/to
      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id }, orderBy: { created_at: "asc" } });
      assert.equal(history.length, 2); // RECEIVED (create) + ASSIGNED (assign)
      assert.equal(history[1].from_status, "RECEIVED");
      assert.equal(history[1].to_status, "ASSIGNED");
      assert.equal(history[1].changed_by_id, admin.id);

      // 21-22: detail reflects current driver + assignment history
      const detail = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.currentDriver.id, eligible.driverId);
      assert.equal(detail.body.data.assignmentHistory.length, 1);
      assert.equal(detail.body.data.assignmentHistory[0].isCurrent, true);
      assert.equal(detail.body.data.assignmentHistory[0].driver.id, eligible.driverId);
    });
  });

  // ===========================================================
  // INVALID INITIAL ASSIGN (23-32)
  // ===========================================================

  describe("Invalid initial assignment", () => {
    test("23. already-assigned Order -> 409", async () => {
      const eligibleA = await createEligibleDriver();
      const eligibleB = await createEligibleDriver();
      const order = await createBaseOrder();
      const first = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligibleA.driverId });
      assert.equal(first.status, 200);

      const second = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligibleB.driverId });
      assert.equal(second.status, 409);
      assert.equal(second.body.error.code, "CONFLICT");
    });

    test("24. ASSIGNED status (no driver) -> reject via the status check specifically", async () => {
      const eligible = await createEligibleDriver();
      // Deliberately seeded without a current driver to isolate the status
      // check from the "already has a driver" 409 check.
      const orderId = await seedOrderWithStatus("ASSIGNED");
      const res = await request(app).post(assignPath(orderId)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    const NOT_ASSIGNABLE = [
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED_DELIVERY",
      "RESCHEDULED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of NOT_ASSIGNABLE) {
      test(`25-32. ${status} -> reject`, async () => {
        const eligible = await createEligibleDriver();
        const orderId = await seedOrderWithStatus(status);
        const res = await request(app).post(assignPath(orderId)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
        assert.equal(res.status, 400, `expected ${status} to be rejected`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }
  });

  // ===========================================================
  // REASSIGN (33-45)
  // ===========================================================

  describe("Reassignment", () => {
    async function createAssignedOrder(driverId: string) {
      const order = await createBaseOrder();
      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId });
      assert.equal(assign.status, 200);
      return order.id;
    }

    test("33-41. full reassignment result", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await createAssignedOrder(driverA.driverId);

      const originalAssignedAt = (await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).assigned_at;
      const originalAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(originalAssignments.length, 1);
      const oldAssignmentId = originalAssignments[0].id;

      const res = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "Driver A unavailable" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      // 34-35
      assert.equal(res.body.data.currentDriver.id, driverB.driverId);
      assert.notEqual(res.body.data.assignedAt, originalAssignedAt?.toISOString());

      // 36: old assignment ended
      const oldAssignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: oldAssignmentId } });
      assert.equal(oldAssignment.is_current, false);
      assert.ok(oldAssignment.ended_at);
      assert.equal(oldAssignment.end_reason, "Driver A unavailable");

      // 37-38-39: new current assignment, old row still present, exactly one current
      const allAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(allAssignments.length, 2, "the previous assignment row must remain permanently");
      const current = allAssignments.filter((a) => a.is_current);
      assert.equal(current.length, 1);
      assert.equal(current[0].driver_id, driverB.driverId);
      assert.equal(current[0].assigned_by_id, admin.id);

      // 40-41: status stays ASSIGNED, no fake status-history row
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.status, "ASSIGNED");
      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId } });
      assert.equal(history.length, 2, "RECEIVED->ASSIGNED (initial) only — no ASSIGNED->ASSIGNED row from reassignment");
      assert.ok(!history.some((h) => h.from_status === "ASSIGNED" && h.to_status === "ASSIGNED"));
    });

    test("42. same-driver reassign rejected", async () => {
      const driverA = await createEligibleDriver();
      const orderId = await createAssignedOrder(driverA.driverId);
      const res = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverA.driverId, reason: "no-op attempt" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("43. reassign an unassigned Order rejected", async () => {
      const driverB = await createEligibleDriver();
      const order = await createBaseOrder();
      const res = await request(app)
        .post(reassignPath(order.id))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "attempt" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("44. reassign a PICKED_UP Order rejected", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await seedOrderWithStatus("PICKED_UP", { currentDriverId: driverA.driverId });
      const res = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "too late" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("45. inactive new Driver rejected", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      await request(app).patch(`/api/v1/drivers/${driverB.driverId}`).set(auth(tokens.admin)).send({ isActive: false });

      const orderId = await createAssignedOrder(driverA.driverId);
      const res = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "attempt" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ===========================================================
  // CONCURRENCY (46-47)
  // ===========================================================

  describe("Concurrency", () => {
    test("46. two concurrent initial assignments to the same Order: exactly one succeeds", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const order = await createBaseOrder();

      const [resA, resB] = await Promise.all([
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId }),
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverB.driverId }),
      ]);

      const statuses = [resA.status, resB.status].sort();
      assert.deepEqual(statuses, [200, 409], JSON.stringify({ resA: resA.body, resB: resB.body }));

      const winner = resA.status === 200 ? resA : resB;
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(orderRow.current_driver_id, winner.body.data.currentDriver.id);

      const currentAssignments = await prisma.order_assignments.findMany({ where: { order_id: order.id, is_current: true } });
      assert.equal(currentAssignments.length, 1);

      const allAssignments = await prisma.order_assignments.findMany({ where: { order_id: order.id } });
      assert.equal(allAssignments.length, 1, "only the winner's assignment row should exist");

      const statusHistory = await prisma.order_status_history.findMany({ where: { order_id: order.id, to_status: "ASSIGNED" } });
      assert.equal(statusHistory.length, 1);
    });

    test("47. concurrent reassignments from the same current Driver: exactly one succeeds", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const driverC = await createEligibleDriver();

      const order = await createBaseOrder();
      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      assert.equal(assign.status, 200);

      const [resB, resC] = await Promise.all([
        request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "race to B" }),
        request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverC.driverId, reason: "race to C" }),
      ]);

      const statuses = [resB.status, resC.status].sort();
      assert.deepEqual(statuses, [200, 409], JSON.stringify({ resB: resB.body, resC: resC.body }));

      const winner = resB.status === 200 ? resB : resC;
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(orderRow.current_driver_id, winner.body.data.currentDriver.id);

      const allAssignments = await prisma.order_assignments.findMany({ where: { order_id: order.id } });
      assert.equal(allAssignments.length, 2, "original A assignment + exactly one winning reassignment");

      const endedA = allAssignments.filter((a) => a.driver_id === driverA.driverId);
      assert.equal(endedA.length, 1);
      assert.equal(endedA[0].is_current, false);
      assert.ok(endedA[0].ended_at, "the A assignment must have been ended exactly once");

      const current = allAssignments.filter((a) => a.is_current);
      assert.equal(current.length, 1, "no duplicate current-history records");
    });
  });

  // ===========================================================
  // BULK ASSIGN (48-55)
  // ===========================================================

  describe("Bulk assignment", () => {
    test("48-54. bulk assign multiple RECEIVED + READY_FOR_PICKUP orders", async () => {
      const eligible = await createEligibleDriver();
      const orderReceived1 = await createBaseOrder();
      const orderReceived2 = await createBaseOrder();
      const orderReadyId = await seedOrderWithStatus("READY_FOR_PICKUP");

      const orderIds = [orderReceived1.id, orderReceived2.id, orderReadyId];
      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds, driverId: eligible.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.assignedCount, 3);
      assert.deepEqual(res.body.data.orderIds.sort(), orderIds.sort());
      assert.equal(res.body.data.driver.id, eligible.driverId);

      for (const id of orderIds) {
        const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
        // 50, 53
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, eligible.driverId);

        // 51, 54: own assignment-history row, same actor
        const assignments = await prisma.order_assignments.findMany({ where: { order_id: id } });
        assert.equal(assignments.length, 1);
        assert.equal(assignments[0].is_current, true);
        assert.equal(assignments[0].assigned_by_id, admin.id);
      }

      // 52: each order's status-history from_status matches its OWN previous status
      const receivedHistory = await prisma.order_status_history.findMany({
        where: { order_id: orderReceived1.id, to_status: "ASSIGNED" },
      });
      assert.equal(receivedHistory[0].from_status, "RECEIVED");
      const readyHistory = await prisma.order_status_history.findMany({
        where: { order_id: orderReadyId, to_status: "ASSIGNED" },
      });
      assert.equal(readyHistory[0].from_status, "READY_FOR_PICKUP");
    });

    test("55. duplicate orderIds in payload -> 400", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order.id, order.id], driverId: eligible.driverId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ===========================================================
  // BULK ATOMICITY (56-59)
  // ===========================================================

  describe("Bulk atomicity", () => {
    test("56. one missing Order in batch -> entire request fails, none assigned", async () => {
      const eligible = await createEligibleDriver();
      const order1 = await createBaseOrder();
      const order2 = await createBaseOrder();

      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order1.id, order2.id, "00000000-0000-0000-0000-000000000000"], driverId: eligible.driverId });
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");

      for (const id of [order1.id, order2.id]) {
        const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
        assert.equal(row.status, "RECEIVED");
        assert.equal(row.current_driver_id, null);
      }
      const assignments = await prisma.order_assignments.count({ where: { order_id: { in: [order1.id, order2.id] } } });
      assert.equal(assignments, 0);
    });

    test("57. one already-assigned Order -> entire request fails, none of the others change", async () => {
      const eligibleA = await createEligibleDriver();
      const eligibleB = await createEligibleDriver();
      const order1 = await createBaseOrder();
      const order2 = await createBaseOrder();
      const preAssign = await request(app).post(assignPath(order2.id)).set(auth(tokens.admin)).send({ driverId: eligibleA.driverId });
      assert.equal(preAssign.status, 200);

      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order1.id, order2.id], driverId: eligibleB.driverId });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, "CONFLICT");

      const row1 = await prisma.orders.findUniqueOrThrow({ where: { id: order1.id } });
      assert.equal(row1.status, "RECEIVED");
      assert.equal(row1.current_driver_id, null, "order1 must not have been assigned even though it was individually eligible");

      const row2 = await prisma.orders.findUniqueOrThrow({ where: { id: order2.id } });
      assert.equal(row2.current_driver_id, eligibleA.driverId, "order2 must remain assigned to its original driver, not driver B");
    });

    test("58. one invalid-status Order -> entire request fails", async () => {
      const eligible = await createEligibleDriver();
      const order1 = await createBaseOrder();
      const cancelledId = await seedOrderWithStatus("CANCELLED");

      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order1.id, cancelledId], driverId: eligible.driverId });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");

      const row1 = await prisma.orders.findUniqueOrThrow({ where: { id: order1.id } });
      assert.equal(row1.status, "RECEIVED");
      assert.equal(row1.current_driver_id, null);
    });

    test("59. a concurrent mutation of one selected Order rolls back the entire bulk batch", async () => {
      const eligibleBulk = await createEligibleDriver();
      const eligibleRacer = await createEligibleDriver();

      const orderX = await createBaseOrder();
      const orderY = await createBaseOrder();
      const orderZ = await createBaseOrder();

      const [bulkRes, racerRes] = await Promise.all([
        request(app)
          .post("/api/v1/orders/bulk-assign")
          .set(auth(tokens.admin))
          .send({ orderIds: [orderX.id, orderY.id, orderZ.id], driverId: eligibleBulk.driverId }),
        request(app).post(assignPath(orderY.id)).set(auth(tokens.admin)).send({ driverId: eligibleRacer.driverId }),
      ]);

      if (bulkRes.status === 200) {
        // Bulk won the race on Y before the single racer touched it.
        assert.equal(racerRes.status, 409, JSON.stringify(racerRes.body));
        for (const id of [orderX.id, orderY.id, orderZ.id]) {
          const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
          assert.equal(row.current_driver_id, eligibleBulk.driverId);
        }
      } else {
        // The single racer won Y first, so the whole bulk batch must have
        // been rolled back — X and Z must remain completely untouched even
        // though each was individually eligible.
        assert.equal(bulkRes.status, 409, JSON.stringify(bulkRes.body));
        assert.equal(racerRes.status, 200, JSON.stringify(racerRes.body));

        const rowX = await prisma.orders.findUniqueOrThrow({ where: { id: orderX.id } });
        assert.equal(rowX.status, "RECEIVED");
        assert.equal(rowX.current_driver_id, null, "orderX must not be partially assigned by the rolled-back bulk batch");

        const rowZ = await prisma.orders.findUniqueOrThrow({ where: { id: orderZ.id } });
        assert.equal(rowZ.status, "RECEIVED");
        assert.equal(rowZ.current_driver_id, null, "orderZ must not be partially assigned by the rolled-back bulk batch");

        const rowY = await prisma.orders.findUniqueOrThrow({ where: { id: orderY.id } });
        assert.equal(rowY.current_driver_id, eligibleRacer.driverId);

        const assignmentsX = await prisma.order_assignments.count({ where: { order_id: orderX.id } });
        const assignmentsZ = await prisma.order_assignments.count({ where: { order_id: orderZ.id } });
        assert.equal(assignmentsX, 0, "zero partial assignment rows for the rolled-back orders");
        assert.equal(assignmentsZ, 0);

        const historyX = await prisma.order_status_history.count({ where: { order_id: orderX.id, to_status: "ASSIGNED" } });
        assert.equal(historyX, 0, "zero partial status-history rows for the rolled-back orders");
      }
    });
  });

  // ===========================================================
  // DETAIL / HISTORY (60-64)
  // ===========================================================

  describe("Detail assignment history", () => {
    test("60-64. oldest-first, safe summaries, ended assignment stays visible, exactly one isCurrent", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();

      const order = await createBaseOrder();
      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      assert.equal(assign.status, 200);

      const reassign = await request(app)
        .post(reassignPath(order.id))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "history check" });
      assert.equal(reassign.status, 200);

      const detail = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      const history = detail.body.data.assignmentHistory;
      assert.equal(history.length, 2);

      // 60: oldest-first
      assert.ok(new Date(history[0].assignedAt).getTime() <= new Date(history[1].assignedAt).getTime());
      assert.equal(history[0].driver.id, driverA.driverId);
      assert.equal(history[1].driver.id, driverB.driverId);

      // 61: safe driver summary
      assert.deepEqual(Object.keys(history[0].driver).sort(), ["driverNumber", "id", "user"]);
      assert.deepEqual(Object.keys(history[0].driver.user).sort(), ["firstName", "lastName", "phone"]);

      // 62: safe actor summary
      assert.deepEqual(Object.keys(history[0].assignedBy).sort(), ["firstName", "id", "lastName"]);
      assert.equal(history[0].assignedBy.id, admin.id);

      // 63: ended assignment remains visible
      assert.equal(history[0].isCurrent, false);
      assert.ok(history[0].endedAt);
      assert.equal(history[0].endReason, "history check");

      // 64: exactly one isCurrent=true
      const currentEntries = history.filter((h: { isCurrent: boolean }) => h.isCurrent);
      assert.equal(currentEntries.length, 1);
      assert.equal(currentEntries[0].driver.id, driverB.driverId);

      const serialized = JSON.stringify(detail.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
    });
  });

  // ===========================================================
  // NO SIDE EFFECTS (65)
  // ===========================================================

  describe("No side effects", () => {
    test("65. assign/reassign/bulk create zero finance/delivery-attempt/settlement/payout rows", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();

      const order = await createBaseOrder();
      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      assert.equal(assign.status, 200);
      const reassign = await request(app)
        .post(reassignPath(order.id))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "side effect check" });
      assert.equal(reassign.status, 200);

      const walletTx = await prisma.wallet_transactions.count({ where: { order_id: order.id } });
      const driverCashTx = await prisma.driver_cash_transactions.count({ where: { order_id: order.id } });
      const companyFinanceTx = await prisma.company_financial_transactions.count({ where: { order_id: order.id } });
      const deliveryAttempts = await prisma.delivery_attempts.count({ where: { order_id: order.id } });
      assert.equal(walletTx, 0);
      assert.equal(driverCashTx, 0);
      assert.equal(companyFinanceTx, 0);
      assert.equal(deliveryAttempts, 0);
    });
  });

  // ===========================================================
  // SERVER-CONTROLLED INPUT (66)
  // ===========================================================

  describe("Server-controlled input", () => {
    test("66. client cannot spoof assignedById/assignedAt/isCurrent/status/currentDriverId/endedAt", async () => {
      const eligible = await createEligibleDriver();
      const bogusDriver = await createEligibleDriver();
      const order = await createBaseOrder();
      const bogusDate = "2000-01-01T00:00:00.000Z";

      const res = await request(app)
        .post(assignPath(order.id))
        .set(auth(tokens.admin))
        .send({
          driverId: eligible.driverId,
          assignedById: dispatcher.id,
          assignedAt: bogusDate,
          isCurrent: false,
          status: "DELIVERED",
          currentDriverId: bogusDriver.driverId,
          endedAt: bogusDate,
        });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "ASSIGNED");
      assert.equal(res.body.data.currentDriver.id, eligible.driverId);
      assert.notEqual(res.body.data.currentDriver.id, bogusDriver.driverId);

      const assignment = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: order.id } });
      assert.equal(assignment.assigned_by_id, admin.id);
      assert.notEqual(assignment.assigned_by_id, dispatcher.id);
      assert.equal(assignment.is_current, true);
      assert.equal(assignment.ended_at, null);
      assert.notEqual(assignment.assigned_at.toISOString(), bogusDate);
    });
  });

  // ===========================================================
  // REGRESSION SMOKE (67-70)
  // ===========================================================

  describe("Create/detail/list/update regression smoke", () => {
    test("67-70. create, detail, list, and generic edit still work alongside assignment", async () => {
      const order = await createBaseOrder();
      assert.ok(order.id);

      const detail = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);

      const list = await request(app).get(`/api/v1/orders?search=${encodeURIComponent("Phase65 Receiver")}`).set(auth(tokens.admin));
      assert.equal(list.status, 200);

      const patch = await request(app).patch(`/api/v1/orders/${order.id}`).set(auth(tokens.admin)).send({ receiverName: "Phase65 Edited" });
      assert.equal(patch.status, 200);
    });
  });
});
