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
  type TestUser,
} from "../helpers/fixtures";

describe("Orders workflow backend (Phase 6.6 — Ready / Reschedule / Cancel / History)", () => {
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
      .send({ driverNumber: `PH66-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id };
  }

  async function createBaseOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerActive,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase66 Receiver",
        receiverPhone: "+96170000002",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase66 St",
        description: "Phase66 base order",
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

  // Creates a real order via the API, assigns it to `driverId` via the real
  // /assign endpoint (so a genuine order_assignments row + current_driver_id
  // exist and are mutually consistent), then — only if a status other than
  // ASSIGNED is requested — force-writes the target status directly via
  // Prisma. Direct force-write is necessary because Phase 7 (the driver
  // workflow that would organically produce PICKED_UP/FAILED_DELIVERY/etc.)
  // is not implemented yet; this never touches order_assignments, so the
  // assignment row stays perfectly consistent with current_driver_id.
  async function assignedOrderInStatus(status: string, driverId: string) {
    const order = await createBaseOrder();
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    if (status !== "ASSIGNED") {
      await prisma.orders.update({ where: { id: order.id }, data: { status: status as never } });
    }
    return order.id as string;
  }

  function readyPath(orderId: string) {
    return `/api/v1/orders/${orderId}/ready`;
  }
  function reschedulePath(orderId: string) {
    return `/api/v1/orders/${orderId}/reschedule`;
  }
  function cancelPath(orderId: string) {
    return `/api/v1/orders/${orderId}/cancel`;
  }
  function historyPath(orderId: string) {
    return `/api/v1/orders/${orderId}/history`;
  }
  function assignPath(orderId: string) {
    return `/api/v1/orders/${orderId}/assign`;
  }
  function reassignPath(orderId: string) {
    return `/api/v1/orders/${orderId}/reassign`;
  }

  // ===========================================================
  // RBAC (1-12)
  // ===========================================================

  describe("Authorization", () => {
    test("1-6. ready: unauthenticated -> 401, ADMIN/DISPATCHER allowed, FINANCE/DRIVER/CUSTOMER -> 403", async () => {
      const orderU = await createBaseOrder();
      const unauth = await request(app).post(readyPath(orderU.id)).send();
      assert.equal(unauth.status, 401);

      const orderAdmin = await createBaseOrder();
      const adminRes = await request(app).post(readyPath(orderAdmin.id)).set(auth(tokens.admin)).send();
      assert.equal(adminRes.status, 200);

      const orderDispatcher = await createBaseOrder();
      const dispatcherRes = await request(app).post(readyPath(orderDispatcher.id)).set(auth(tokens.dispatcher)).send();
      assert.equal(dispatcherRes.status, 200);

      for (const role of ["finance", "driver", "customer"] as const) {
        const order = await createBaseOrder();
        const res = await request(app).post(readyPath(order.id)).set(auth(tokens[role])).send();
        assert.equal(res.status, 403, `expected ${role} to be forbidden from ready`);
      }
    });

    test("7-12. reschedule/cancel: same RBAC matrix (ADMIN/DISPATCHER allowed, FINANCE/DRIVER/CUSTOMER forbidden)", async () => {
      const eligible = await createEligibleDriver();

      const failedU = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const unauth = await request(app).post(reschedulePath(failedU)).send({ reason: "unauth attempt" });
      assert.equal(unauth.status, 401);

      const failedAdmin = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const adminRes = await request(app).post(reschedulePath(failedAdmin)).set(auth(tokens.admin)).send({ reason: "admin reschedule" });
      assert.equal(adminRes.status, 200);

      const failedDispatcher = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const dispatcherRes = await request(app)
        .post(reschedulePath(failedDispatcher))
        .set(auth(tokens.dispatcher))
        .send({ reason: "dispatcher reschedule" });
      assert.equal(dispatcherRes.status, 200);

      for (const role of ["finance", "driver", "customer"] as const) {
        const failedOrder = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
        const res = await request(app).post(reschedulePath(failedOrder)).set(auth(tokens[role])).send({ reason: "attempt" });
        assert.equal(res.status, 403, `expected ${role} to be forbidden from reschedule`);
      }

      const cancelU = await createBaseOrder();
      const unauthCancel = await request(app).post(cancelPath(cancelU.id)).send({ reason: "unauth attempt" });
      assert.equal(unauthCancel.status, 401);

      const cancelAdmin = await createBaseOrder();
      const adminCancel = await request(app).post(cancelPath(cancelAdmin.id)).set(auth(tokens.admin)).send({ reason: "admin cancel" });
      assert.equal(adminCancel.status, 200);

      const cancelDispatcher = await createBaseOrder();
      const dispatcherCancel = await request(app)
        .post(cancelPath(cancelDispatcher.id))
        .set(auth(tokens.dispatcher))
        .send({ reason: "dispatcher cancel" });
      assert.equal(dispatcherCancel.status, 200);

      for (const role of ["finance", "driver", "customer"] as const) {
        const order = await createBaseOrder();
        const res = await request(app).post(cancelPath(order.id)).set(auth(tokens[role])).send({ reason: "attempt" });
        assert.equal(res.status, 403, `expected ${role} to be forbidden from cancel`);
      }
    });

    test("history: unauthenticated -> 401, ADMIN/DISPATCHER/FINANCE allowed, DRIVER/CUSTOMER -> 403", async () => {
      const order = await createBaseOrder();

      const unauth = await request(app).get(historyPath(order.id));
      assert.equal(unauth.status, 401);

      for (const role of ["admin", "dispatcher", "finance"] as const) {
        const res = await request(app).get(historyPath(order.id)).set(auth(tokens[role]));
        assert.equal(res.status, 200, `expected ${role} to be allowed to read history`);
      }

      for (const role of ["driver", "customer"] as const) {
        const res = await request(app).get(historyPath(order.id)).set(auth(tokens[role]));
        assert.equal(res.status, 403, `expected ${role} to be forbidden from history`);
      }
    });
  });

  // ===========================================================
  // READY TRANSITION (13-17)
  // ===========================================================

  describe("Ready transition", () => {
    test("13-17. RECEIVED -> ready succeeds: status, one history row, actor, no driver/financial mutation", async () => {
      const order = await createBaseOrder();
      const before = new Date();

      const res = await request(app).post(readyPath(order.id)).set(auth(tokens.admin)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "READY_FOR_PICKUP");
      assert.equal(res.body.data.currentDriver, null);
      assert.ok(new Date(res.body.data.updatedAt ?? res.body.data.createdAt).getTime() >= 0);

      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id }, orderBy: { created_at: "asc" } });
      assert.equal(history.length, 2); // RECEIVED (create) + READY_FOR_PICKUP (ready)
      assert.equal(history[1].from_status, "RECEIVED");
      assert.equal(history[1].to_status, "READY_FOR_PICKUP");
      assert.equal(history[1].changed_by_id, admin.id);
      assert.ok(history[1].created_at.getTime() >= before.getTime());

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(orderRow.current_driver_id, null);
      assert.equal(orderRow.assigned_at, null);
      assert.equal(orderRow.order_amount.toString(), "100");
      assert.equal(orderRow.amount_to_collect.toString(), "105");

      const assignments = await prisma.order_assignments.count({ where: { order_id: order.id } });
      assert.equal(assignments, 0, "ready must not create any assignment row");
    });

    const NOT_READYABLE = [
      "READY_FOR_PICKUP",
      "ASSIGNED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED_DELIVERY",
      "RESCHEDULED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of NOT_READYABLE) {
      test(`ready rejects from ${status}`, async () => {
        const orderId = await seedOrderWithStatus(status);
        const res = await request(app).post(readyPath(orderId)).set(auth(tokens.admin)).send();
        assert.equal(res.status, 400, `expected ${status} to be rejected`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }

    test("data-consistency defensive check: RECEIVED order with an unexpected current driver -> sanitized 500, order untouched", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await seedOrderWithStatus("RECEIVED", { currentDriverId: eligible.driverId });

      const res = await request(app).post(readyPath(orderId)).set(auth(tokens.admin)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|PrismaClient|at Object|stack/i);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "RECEIVED", "the order must not be silently repaired or transitioned");
    });
  });

  // ===========================================================
  // RESCHEDULE TRANSITION (18-26)
  // ===========================================================

  describe("Reschedule transition", () => {
    test("18-26. FAILED_DELIVERY -> reschedule succeeds: status, history w/ reason+notes, assignment fully preserved", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);

      const beforeOrder = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const beforeAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(beforeAssignments.length, 1);
      const assignmentId = beforeAssignments[0].id;

      const res = await request(app)
        .post(reschedulePath(orderId))
        .set(auth(tokens.admin))
        .send({ reason: "Receiver requested a different day", notes: "call before arriving" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "RESCHEDULED");
      assert.equal(res.body.data.currentDriver.id, eligible.driverId);

      // 21-22: current_driver_id / assigned_at preserved exactly
      const afterOrder = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(afterOrder.current_driver_id, beforeOrder.current_driver_id);
      assert.equal(afterOrder.assigned_at?.getTime(), beforeOrder.assigned_at?.getTime());

      // 23-24: the exact same assignment row, untouched
      const afterAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(afterAssignments.length, 1, "reschedule must not create a new assignment row");
      assert.equal(afterAssignments[0].id, assignmentId);
      assert.equal(afterAssignments[0].is_current, true);
      assert.equal(afterAssignments[0].ended_at, null);

      // 25-26: one status-history row, reason + notes recorded
      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } });
      const rescheduleRow = history.find((h) => h.to_status === "RESCHEDULED");
      assert.ok(rescheduleRow);
      assert.equal(rescheduleRow?.from_status, "FAILED_DELIVERY");
      assert.equal(rescheduleRow?.changed_by_id, admin.id);
      assert.equal(rescheduleRow?.reason, "Receiver requested a different day");
      assert.equal(rescheduleRow?.notes, "call before arriving");

      const deliveryAttempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(deliveryAttempts, 0, "reschedule must not create/modify delivery_attempts");
    });

    const NOT_RESCHEDULABLE = [
      "RECEIVED",
      "READY_FOR_PICKUP",
      "ASSIGNED",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "RESCHEDULED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of NOT_RESCHEDULABLE) {
      test(`reschedule rejects from ${status}`, async () => {
        const orderId = await seedOrderWithStatus(status);
        const res = await request(app).post(reschedulePath(orderId)).set(auth(tokens.admin)).send({ reason: "attempt" });
        assert.equal(res.status, 400, `expected ${status} to be rejected`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }

    test("reason validation: missing/empty -> 400, over 500 chars -> 400, notes optional", async () => {
      const eligible = await createEligibleDriver();

      const orderMissing = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const missing = await request(app).post(reschedulePath(orderMissing)).set(auth(tokens.admin)).send({});
      assert.equal(missing.status, 400);
      assert.equal(missing.body.error.code, "VALIDATION_ERROR");

      const orderEmpty = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const empty = await request(app).post(reschedulePath(orderEmpty)).set(auth(tokens.admin)).send({ reason: "   " });
      assert.equal(empty.status, 400);

      const orderLong = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const long = await request(app)
        .post(reschedulePath(orderLong))
        .set(auth(tokens.admin))
        .send({ reason: "x".repeat(501) });
      assert.equal(long.status, 400);

      const orderNoNotes = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const noNotes = await request(app).post(reschedulePath(orderNoNotes)).set(auth(tokens.admin)).send({ reason: "no notes given" });
      assert.equal(noNotes.status, 200, JSON.stringify(noNotes.body));
      const row = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: orderNoNotes, to_status: "RESCHEDULED" } });
      assert.equal(row.notes, null);
    });

    test("assignment-integrity defensive checks: null current driver -> 500, mismatched assignment table -> 500", async () => {
      const orderNullDriver = await seedOrderWithStatus("FAILED_DELIVERY");
      const resNull = await request(app).post(reschedulePath(orderNullDriver)).set(auth(tokens.admin)).send({ reason: "attempt" });
      assert.equal(resNull.status, 500);
      assert.equal(resNull.body.error.code, "INTERNAL_ERROR");

      const eligible = await createEligibleDriver();
      const orderMismatch = await seedOrderWithStatus("FAILED_DELIVERY", { currentDriverId: eligible.driverId });
      const resMismatch = await request(app).post(reschedulePath(orderMismatch)).set(auth(tokens.admin)).send({ reason: "attempt" });
      assert.equal(resMismatch.status, 500);
      assert.equal(resMismatch.body.error.code, "INTERNAL_ERROR");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderMismatch } });
      assert.equal(row.status, "FAILED_DELIVERY", "must not be silently transitioned despite the inconsistency");
    });
  });

  // ===========================================================
  // RESCHEDULED REASSIGN INTEGRATION (27-34)
  // ===========================================================

  describe("RESCHEDULED reassignment integration", () => {
    test("27-32. RESCHEDULED -> reassign succeeds: status ASSIGNED, one status-history row, assignment ended/created", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("RESCHEDULED", driverA.driverId);

      const beforeAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(beforeAssignments.length, 1);
      const oldAssignmentId = beforeAssignments[0].id;

      const res = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "retry with a different driver" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "ASSIGNED");
      assert.equal(res.body.data.currentDriver.id, driverB.driverId);

      // 29: exactly one new status-history row RESCHEDULED -> ASSIGNED
      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } });
      const transitionRows = history.filter((h) => h.from_status === "RESCHEDULED" && h.to_status === "ASSIGNED");
      assert.equal(transitionRows.length, 1);
      assert.equal(transitionRows[0].changed_by_id, admin.id);

      // 30-32: old assignment ended with the reassign reason, new one current
      const oldAssignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: oldAssignmentId } });
      assert.equal(oldAssignment.is_current, false);
      assert.equal(oldAssignment.end_reason, "retry with a different driver");
      const allAssignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      assert.equal(allAssignments.length, 2);
      const current = allAssignments.filter((a) => a.is_current);
      assert.equal(current.length, 1);
      assert.equal(current[0].driver_id, driverB.driverId);
    });

    test("33. ordinary ASSIGNED -> reassign -> ASSIGNED still creates no status-history row (unchanged regression)", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("ASSIGNED", driverA.driverId);

      const res = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "ordinary reassign" });
      assert.equal(res.status, 200);

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId } });
      assert.ok(!history.some((h) => h.from_status === "ASSIGNED" && h.to_status === "ASSIGNED"));
    });

    test("34. direct FAILED_DELIVERY -> reassign remains unsupported; same-driver RESCHEDULED reassign rejected", async () => {
      const eligible = await createEligibleDriver();
      const other = await createEligibleDriver();

      const failedOrder = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const res = await request(app)
        .post(reassignPath(failedOrder))
        .set(auth(tokens.admin))
        .send({ driverId: other.driverId, reason: "attempt direct reassign" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");

      const rescheduledOrder = await assignedOrderInStatus("RESCHEDULED", eligible.driverId);
      const sameDriver = await request(app)
        .post(reassignPath(rescheduledOrder))
        .set(auth(tokens.admin))
        .send({ driverId: eligible.driverId, reason: "no-op attempt" });
      assert.equal(sameDriver.status, 400);
      assert.equal(sameDriver.body.error.code, "VALIDATION_ERROR");
    });
  });

  // ===========================================================
  // CANCEL — PRE-ASSIGNMENT (35-39)
  // ===========================================================

  describe("Cancel from pre-assignment statuses", () => {
    test("35-39. RECEIVED -> cancel succeeds: status, cancelledAt, one history row, no assignment/financial mutation", async () => {
      const order = await createBaseOrder();

      const res = await request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "customer changed mind" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "CANCELLED");
      assert.ok(res.body.data.cancelledAt);
      assert.equal(res.body.data.currentDriver, null);
      assert.equal(res.body.data.deliveredAt, null);
      assert.equal(res.body.data.financial.needsFinancialReview, false);
      assert.equal(res.body.data.financial.actualAmountCollected, null);

      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id } });
      const cancelRow = history.find((h) => h.to_status === "CANCELLED");
      assert.equal(cancelRow?.from_status, "RECEIVED");
      assert.equal(cancelRow?.reason, "customer changed mind");

      const assignments = await prisma.order_assignments.count({ where: { order_id: order.id } });
      assert.equal(assignments, 0);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.financial_status, "PENDING", "cancellation must not finalize financial_status");
    });

    test("READY_FOR_PICKUP -> cancel succeeds", async () => {
      const orderId = await seedOrderWithStatus("READY_FOR_PICKUP");
      const res = await request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "no longer needed" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "CANCELLED");

      const history = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: orderId, to_status: "CANCELLED" } });
      assert.equal(history.from_status, "READY_FOR_PICKUP");
    });
  });

  // ===========================================================
  // CANCEL — WITH ASSIGNMENT (40-47)
  // ===========================================================

  describe("Cancel from assigned statuses", () => {
    for (const status of ["ASSIGNED", "FAILED_DELIVERY", "RESCHEDULED"]) {
      test(`40-47. ${status} -> cancel succeeds: driver cleared, assignment closed, history row`, async () => {
        const eligible = await createEligibleDriver();
        const orderId = await assignedOrderInStatus(status, eligible.driverId);
        const assignmentBefore = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId, is_current: true } });

        const res = await request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: `cancelling from ${status}` });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.status, "CANCELLED");
        assert.equal(res.body.data.currentDriver, null);

        const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
        assert.equal(orderRow.current_driver_id, null);
        assert.equal(orderRow.assigned_at, null);

        const assignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: assignmentBefore.id } });
        assert.equal(assignment.is_current, false);
        assert.ok(assignment.ended_at);
        assert.equal(assignment.end_reason, `cancelling from ${status}`);

        const history = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: orderId, to_status: "CANCELLED" } });
        assert.equal(history.from_status, status);
      });
    }
  });

  // ===========================================================
  // INVALID CANCEL (48-56)
  // ===========================================================

  describe("Invalid cancel", () => {
    const NOT_CANCELLABLE = ["PICKED_UP", "OUT_FOR_DELIVERY", "DELIVERED", "RETURNED_TO_COMPANY", "RETURNED_TO_CUSTOMER", "CANCELLED"];

    for (const status of NOT_CANCELLABLE) {
      test(`48-56. cancel rejects from ${status}`, async () => {
        const orderId = await seedOrderWithStatus(status);
        const res = await request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "attempt" });
        assert.equal(res.status, 400, `expected ${status} to be rejected`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }

    test("missing/empty reason -> 400", async () => {
      const order = await createBaseOrder();
      const res = await request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({});
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("data-consistency defensive check: pre-assignment status with an unexpected current driver -> 500", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await seedOrderWithStatus("READY_FOR_PICKUP", { currentDriverId: eligible.driverId });
      const res = await request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "attempt" });
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });
  });

  // ===========================================================
  // CONCURRENCY (57-59)
  // ===========================================================

  describe("Concurrency", () => {
    test("57. ready vs assign race on the same RECEIVED order: the order ends in exactly one coherent state", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();

      const [readyRes, assignRes] = await Promise.all([
        request(app).post(readyPath(order.id)).set(auth(tokens.admin)).send(),
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId }),
      ]);

      // /assign accepts BOTH RECEIVED and READY_FOR_PICKUP as source statuses,
      // so — besides the obvious "one wins the RECEIVED claim, the other 409s"
      // — a valid serialization is: /ready commits RECEIVED -> READY_FOR_PICKUP,
      // then /assign legitimately proceeds READY_FOR_PICKUP -> ASSIGNED, and
      // BOTH return 200. (/ready that reads the already-ASSIGNED order 400s.)
      // What must always hold is a single coherent final state with no
      // assignment-history corruption.
      const ctx = JSON.stringify({ ready: readyRes.body, assign: assignRes.body });
      assert.ok([200, 400, 409].includes(readyRes.status), `ready status ${readyRes.status} ${ctx}`);
      assert.ok([200, 409].includes(assignRes.status), `assign status ${assignRes.status} ${ctx}`);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      const currentAssignments = await prisma.order_assignments.count({
        where: { order_id: order.id, is_current: true },
      });

      if (assignRes.status === 200) {
        // assign succeeded (directly from RECEIVED, or from READY_FOR_PICKUP
        // after /ready won) — the order is ASSIGNED to the eligible driver.
        assert.equal(row.status, "ASSIGNED", ctx);
        assert.equal(row.current_driver_id, eligible.driverId, ctx);
        assert.equal(currentAssignments, 1, ctx);
      } else {
        // assign lost the race -> /ready is the only mutation that landed.
        assert.equal(assignRes.status, 409, ctx);
        assert.equal(readyRes.status, 200, ctx);
        assert.equal(row.status, "READY_FOR_PICKUP", ctx);
        assert.equal(row.current_driver_id, null, ctx);
        assert.equal(currentAssignments, 0, ctx);
      }
    });

    test("58. reschedule vs cancel race on the same FAILED_DELIVERY order: exactly one succeeds", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);

      const [rescheduleRes, cancelRes] = await Promise.all([
        request(app).post(reschedulePath(orderId)).set(auth(tokens.admin)).send({ reason: "reschedule race" }),
        request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "cancel race" }),
      ]);

      const statuses = [rescheduleRes.status, cancelRes.status].sort();
      assert.deepEqual(statuses, [200, 409], JSON.stringify({ reschedule: rescheduleRes.body, cancel: cancelRes.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (rescheduleRes.status === 200) {
        assert.equal(row.status, "RESCHEDULED");
        assert.equal(row.current_driver_id, eligible.driverId, "reschedule must preserve the driver");
      } else {
        assert.equal(row.status, "CANCELLED");
        assert.equal(row.current_driver_id, null);
      }
    });

    test("59. cancel vs reassign race on the same RESCHEDULED order: exactly one succeeds", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("RESCHEDULED", driverA.driverId);

      const [cancelRes, reassignRes] = await Promise.all([
        request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "cancel race" }),
        request(app).post(reassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "reassign race" }),
      ]);

      const statuses = [cancelRes.status, reassignRes.status].sort();
      assert.deepEqual(statuses, [200, 409], JSON.stringify({ cancel: cancelRes.body, reassign: reassignRes.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (cancelRes.status === 200) {
        assert.equal(row.status, "CANCELLED");
        assert.equal(row.current_driver_id, null);
      } else {
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, driverB.driverId);
      }
    });
  });

  // ===========================================================
  // GENERIC PATCH CONCURRENCY GUARD (60-62)
  // ===========================================================

  describe("Generic PATCH concurrency guard", () => {
    test("60-62. a stale PATCH racing a cancel never silently overwrites a cancelled order", async () => {
      const order = await createBaseOrder();

      const [patchRes, cancelRes] = await Promise.all([
        request(app).patch(`/api/v1/orders/${order.id}`).set(auth(tokens.admin)).send({ receiverName: "Raced Edit" }),
        request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "concurrency guard check" }),
      ]);

      // Nothing else can invalidate cancel's own WHERE clause here, so it
      // must always succeed regardless of ordering.
      assert.equal(cancelRes.status, 200, JSON.stringify(cancelRes.body));
      assert.ok([200, 409].includes(patchRes.status), JSON.stringify(patchRes.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, "CANCELLED");

      if (patchRes.status === 200) {
        assert.equal(row.receiver_name, "Raced Edit", "PATCH committed before cancel — its write must be visible");
      } else {
        assert.equal(patchRes.body.error.code, "CONFLICT");
        assert.notEqual(row.receiver_name, "Raced Edit", "a stale PATCH rejected with 409 must never apply its write");
      }
    });

    test("a PATCH attempted after a status transition has already completed is rejected up front", async () => {
      const order = await createBaseOrder();
      const cancel = await request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "cancel first" });
      assert.equal(cancel.status, 200);

      const patch = await request(app).patch(`/api/v1/orders/${order.id}`).set(auth(tokens.admin)).send({ receiverName: "Too Late" });
      assert.equal(patch.status, 400);
      assert.equal(patch.body.error.code, "VALIDATION_ERROR");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.notEqual(row.receiver_name, "Too Late");
    });
  });

  // ===========================================================
  // HISTORY API (63-72)
  // ===========================================================

  describe("History API", () => {
    test("63-64. malformed UUID -> 400, missing Order -> 404", async () => {
      const badId = await request(app).get("/api/v1/orders/not-a-uuid/history").set(auth(tokens.admin));
      assert.equal(badId.status, 400);

      const missing = await request(app)
        .get(historyPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.admin));
      assert.equal(missing.status, 404);
      assert.equal(missing.body.error.code, "NOT_FOUND");
    });

    test("65-72. correct shape, oldest-first, changedBy resolved, safe assignment history, no leaks", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("ASSIGNED", driverA.driverId);
      const reassign = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "history coverage" });
      assert.equal(reassign.status, 200);

      const res = await request(app).get(historyPath(orderId)).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.orderId, orderId);

      // 65: statusHistory oldest-first (RECEIVED create, ASSIGNED)
      const statusHistory = res.body.data.statusHistory;
      assert.ok(statusHistory.length >= 2);
      for (let i = 1; i < statusHistory.length; i++) {
        assert.ok(new Date(statusHistory[i - 1].createdAt).getTime() <= new Date(statusHistory[i].createdAt).getTime());
      }

      // 66-67: changedBy is a resolved object, not a bare id
      assert.deepEqual(Object.keys(statusHistory[0].changedBy).sort(), ["firstName", "id", "lastName"]);
      assert.equal(statusHistory[0].changedBy.id, admin.id);
      assert.ok(statusHistory[0].changedById === undefined, "changedById must not appear alongside the new changedBy shape");

      // 68: assignmentHistory oldest-first, two rows (initial assign + reassign)
      const assignmentHistory = res.body.data.assignmentHistory;
      assert.equal(assignmentHistory.length, 2);
      assert.ok(new Date(assignmentHistory[0].assignedAt).getTime() <= new Date(assignmentHistory[1].assignedAt).getTime());
      assert.equal(assignmentHistory[1].isCurrent, true);
      assert.equal(assignmentHistory[1].driver.id, driverB.driverId);

      // 69: safe driver/actor summaries only
      assert.deepEqual(Object.keys(assignmentHistory[0].driver).sort(), ["driverNumber", "id", "user"]);
      assert.deepEqual(Object.keys(assignmentHistory[0].assignedBy).sort(), ["firstName", "id", "lastName"]);

      // 70: no leaks
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);

      // 71-72: OrderDetail reuses the same changedBy shape (no duplicate DTO)
      const detail = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.deepEqual(Object.keys(detail.body.data.statusHistory[0].changedBy).sort(), ["firstName", "id", "lastName"]);
      assert.deepEqual(detail.body.data.statusHistory, statusHistory);
      assert.deepEqual(detail.body.data.assignmentHistory, assignmentHistory);
    });
  });

  // ===========================================================
  // NO SIDE EFFECTS (73-76)
  // ===========================================================

  describe("No side effects", () => {
    test("73-76. ready/reschedule/cancel create zero finance ledger rows and zero delivery_attempts", async () => {
      const eligible = await createEligibleDriver();

      const orderReady = await createBaseOrder();
      const ready = await request(app).post(readyPath(orderReady.id)).set(auth(tokens.admin)).send();
      assert.equal(ready.status, 200);

      const orderReschedule = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const reschedule = await request(app)
        .post(reschedulePath(orderReschedule))
        .set(auth(tokens.admin))
        .send({ reason: "side effect check" });
      assert.equal(reschedule.status, 200);

      const orderCancel = await assignedOrderInStatus("ASSIGNED", eligible.driverId);
      const cancel = await request(app).post(cancelPath(orderCancel)).set(auth(tokens.admin)).send({ reason: "side effect check" });
      assert.equal(cancel.status, 200);

      const orderIds = [orderReady.id, orderReschedule, orderCancel];
      const walletTx = await prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } });
      const driverCashTx = await prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } });
      const companyFinanceTx = await prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } });
      const deliveryAttempts = await prisma.delivery_attempts.count({ where: { order_id: { in: orderIds } } });
      assert.equal(walletTx, 0);
      assert.equal(driverCashTx, 0);
      assert.equal(companyFinanceTx, 0);
      assert.equal(deliveryAttempts, 0);
    });
  });

  // ===========================================================
  // REGRESSION SMOKE (77-89)
  // ===========================================================

  describe("Create/detail/list/update/assign/reassign/bulk regression smoke", () => {
    test("77-89. every Order Engine endpoint still works alongside the new workflow endpoints", async () => {
      const eligible = await createEligibleDriver();
      const eligibleB = await createEligibleDriver();

      const order = await createBaseOrder();
      assert.ok(order.id);

      const detail = await request(app).get(`/api/v1/orders/${order.id}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);

      const list = await request(app).get(`/api/v1/orders?search=${encodeURIComponent("Phase66 Receiver")}`).set(auth(tokens.admin));
      assert.equal(list.status, 200);

      const patch = await request(app).patch(`/api/v1/orders/${order.id}`).set(auth(tokens.admin)).send({ receiverName: "Phase66 Edited" });
      assert.equal(patch.status, 200);

      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(assign.status, 200);

      const reassign = await request(app)
        .post(reassignPath(order.id))
        .set(auth(tokens.admin))
        .send({ driverId: eligibleB.driverId, reason: "regression smoke" });
      assert.equal(reassign.status, 200);

      const bulkOrder = await createBaseOrder();
      const bulk = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [bulkOrder.id], driverId: eligible.driverId });
      assert.equal(bulk.status, 200);

      const readyOrder = await createBaseOrder();
      const ready = await request(app).post(readyPath(readyOrder.id)).set(auth(tokens.admin)).send();
      assert.equal(ready.status, 200);
    });
  });
});
