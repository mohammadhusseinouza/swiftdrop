import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { buildWorkflowQueueWhere } from "../../src/modules/orders/order-workflow-queue";
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
  type TestUser,
} from "../helpers/fixtures";

// POST /api/v1/orders/:id/unassign — remove the current delivery driver
// before pickup and return the Order to the unassigned queue.
describe("Orders unassign driver (POST /orders/:id/unassign)", () => {
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
  let failedReasonId: string;

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

    const reason = await prisma.failed_delivery_reasons.create({
      data: { name: `Unassign No Notes ${Math.random().toString(36).slice(2)}`, requires_notes: false, is_active: true },
    });
    failedReasonId = reason.id;
    createdReasonIds.push(reason.id);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdReasonIds) await cleanupTestFailedDeliveryReason(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function unassignPath(orderId: string) {
    return `/api/v1/orders/${orderId}/unassign`;
  }

  async function createDriverWithToken() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `UNASSIGN-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }

  async function createBaseOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerActive,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Unassign Receiver",
        receiverPhone: "+96170000031",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Unassign St",
        description: "Unassign test order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data.id as string;
  }

  async function markReady(orderId: string) {
    const res = await request(app).post(`/api/v1/orders/${orderId}/ready`).set(auth(tokens.admin)).send();
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  async function assign(orderId: string, driverId: string) {
    const res = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  async function reassign(orderId: string, driverId: string) {
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/reassign`)
      .set(auth(tokens.admin))
      .send({ driverId, reason: "switch driver" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  async function driverAction(orderId: string, token: string, action: string, body: Record<string, unknown> = {}) {
    const res = await request(app).post(`/api/v1/driver/orders/${orderId}/${action}`).set(auth(token)).send(body);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  // READY_FOR_PICKUP -> ASSIGNED (the standard flow).
  async function readyAssignedOrder(driverId: string) {
    const orderId = await createBaseOrder();
    await markReady(orderId);
    await assign(orderId, driverId);
    return orderId;
  }

  // Driver A: assign -> pickup -> start -> fail; Management reschedules and
  // reassigns to driver B. picked_up_at stays set from A's pickup.
  async function rescheduledReassignedOrder() {
    const driverA = await createDriverWithToken();
    const driverB = await createDriverWithToken();
    const orderId = await readyAssignedOrder(driverA.driverId);
    await driverAction(orderId, driverA.token, "pickup");
    await driverAction(orderId, driverA.token, "start-delivery");
    await driverAction(orderId, driverA.token, "fail", { failedReasonId: failedReasonId });
    const resched = await request(app)
      .post(`/api/v1/orders/${orderId}/reschedule`)
      .set(auth(tokens.admin))
      .send({ reason: "retry" });
    assert.equal(resched.status, 200, JSON.stringify(resched.body));
    await reassign(orderId, driverB.driverId);
    return { orderId, driverA, driverB };
  }

  // Driver picks up, starts, fails; Management reschedules. The driver is kept.
  async function rescheduledWithDriver() {
    const driver = await createDriverWithToken();
    const orderId = await readyAssignedOrder(driver.driverId);
    await driverAction(orderId, driver.token, "pickup");
    await driverAction(orderId, driver.token, "start-delivery");
    await driverAction(orderId, driver.token, "fail", { failedReasonId: failedReasonId });
    const resched = await request(app)
      .post(`/api/v1/orders/${orderId}/reschedule`)
      .set(auth(tokens.admin))
      .send({ reason: "retry" });
    assert.equal(resched.status, 200, JSON.stringify(resched.body));
    return { orderId, driver };
  }

  // RESCHEDULED -> reassign -> unassign: RESCHEDULED with no current driver.
  async function driverlessRescheduledOrder() {
    const { orderId, driverB } = await rescheduledReassignedOrder();
    const un = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId });
    assert.equal(un.status, 200, JSON.stringify(un.body));
    return orderId;
  }

  async function getDashboardCounts() {
    const res = await request(app).get("/api/v1/dashboard").set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return {
      unassigned: res.body.data.orders.unassigned as number,
      readyForDelivery: res.body.data.parcelCollection.readyForDeliveryAssignment as number,
      attentionReadyForDelivery: res.body.data.attention.counts.readyForDeliveryAssignment as number,
    };
  }

  async function inReadyForDeliveryQueue(orderId: string) {
    const { order_number } = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    const res = await request(app)
      .get("/api/v1/orders")
      .query({ workflowQueue: "READY_FOR_DELIVERY_ASSIGNMENT", search: order_number })
      .set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return (res.body.data as Array<{ id: string }>).some((o) => o.id === orderId);
  }

  async function seedOrderWithStatus(status: string, currentDriverId: string) {
    const id = await seedTestOrder(customerActive, admin.id, {
      areaId: areaActive.id,
      areaName: areaActive.name,
      status: status as never,
      currentDriverId,
      assignedAt: new Date(),
    } as never);
    createdOrderIds.push(id);
    return id;
  }

  async function orderSnapshot(orderId: string) {
    const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
    const assignments = await prisma.order_assignments.findMany({ where: { order_id: orderId }, orderBy: { assigned_at: "asc" } });
    const statusHistory = await prisma.order_status_history.count({ where: { order_id: orderId } });
    return { order, assignments, statusHistory };
  }

  async function expectRejectedWithoutMutation(orderId: string, driverId: string, expectedStatus: number) {
    const before = await orderSnapshot(orderId);
    const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId });
    assert.equal(res.status, expectedStatus, JSON.stringify(res.body));
    const after = await orderSnapshot(orderId);
    assert.equal(after.order.status, before.order.status);
    assert.equal(after.order.current_driver_id, before.order.current_driver_id);
    assert.deepEqual(after.assignments, before.assignments);
    assert.equal(after.statusHistory, before.statusHistory);
    return res;
  }

  // ===========================================================
  // Successful unassignment
  // ===========================================================

  describe("Successful unassignment before pickup", () => {
    test("READY_FOR_PICKUP -> assign -> unassign: driver removed, status READY_FOR_PICKUP, history kept", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);

      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.equal(res.body.data.status, "READY_FOR_PICKUP");
      assert.equal(res.body.data.currentDriver, null);
      assert.equal(res.body.data.assignedAt, null);
      assert.equal(res.body.data.pickedUpAt, null);

      const { order, assignments } = await orderSnapshot(orderId);
      assert.equal(order.status, "READY_FOR_PICKUP");
      assert.equal(order.current_driver_id, null);
      assert.equal(order.assigned_at, null);
      assert.equal(order.picked_up_at, null);

      // The assignment row is ended, never deleted — previous driver preserved.
      assert.equal(assignments.length, 1);
      assert.equal(assignments[0].driver_id, driver.driverId);
      assert.equal(assignments[0].is_current, false);
      assert.ok(assignments[0].ended_at);
      assert.equal(assignments[0].end_reason, "Driver unassigned");

      // Status history: prior rows intact + one row recording actor and time.
      const history = await prisma.order_status_history.findMany({
        where: { order_id: orderId },
        orderBy: { created_at: "asc" },
      });
      assert.deepEqual(
        history.slice(-3).map((h) => [h.from_status, h.to_status]),
        [
          ["RECEIVED", "READY_FOR_PICKUP"],
          ["READY_FOR_PICKUP", "ASSIGNED"],
          ["ASSIGNED", "READY_FOR_PICKUP"],
        ]
      );
      const last = history[history.length - 1];
      assert.equal(last.changed_by_id, admin.id);
      assert.equal(last.reason, "Driver unassigned");
      assert.ok(last.created_at);

      // Exposed through the API history/timeline as well.
      assert.ok(
        res.body.data.assignmentHistory.some(
          (a: { driver: { id: string }; isCurrent: boolean; endReason: string | null }) =>
            a.driver.id === driver.driverId && !a.isCurrent && a.endReason === "Driver unassigned"
        )
      );
    });

    test("dispatcher can unassign", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.dispatcher)).send({ driverId: driver.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const last = await prisma.order_status_history.findFirstOrThrow({
        where: { order_id: orderId },
        orderBy: { created_at: "desc" },
      });
      assert.equal(last.changed_by_id, dispatcher.id);
    });

    test("RECEIVED -> assign -> unassign restores RECEIVED (the actual pre-assignment state)", async () => {
      const driver = await createDriverWithToken();
      const orderId = await createBaseOrder();
      await assign(orderId, driver.driverId);

      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "RECEIVED");
      assert.equal(res.body.data.currentDriver, null);
    });

    test("Create & Assign (POST /orders with deliveryDriverId) -> unassign restores RECEIVED", async () => {
      const driver = await createDriverWithToken();
      const orderId = await createBaseOrder({ deliveryDriverId: driver.driverId });
      const created = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(created.status, "ASSIGNED");

      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "RECEIVED");
    });

    test("assign -> reassign -> unassign removes the CURRENT driver and restores the original pre-assignment status", async () => {
      const driverA = await createDriverWithToken();
      const driverB = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driverA.driverId);
      await reassign(orderId, driverB.driverId);

      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "READY_FOR_PICKUP");

      const { assignments } = await orderSnapshot(orderId);
      assert.equal(assignments.length, 2);
      assert.equal(assignments.filter((a) => a.is_current).length, 0);
      assert.equal(assignments[0].driver_id, driverA.driverId);
      assert.equal(assignments[0].end_reason, "switch driver");
      assert.equal(assignments[1].driver_id, driverB.driverId);
      assert.equal(assignments[1].end_reason, "Driver unassigned");
    });

    test("order can be assigned again after unassignment, and the new driver can pick it up", async () => {
      const driverA = await createDriverWithToken();
      const driverB = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driverA.driverId);
      const un = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      assert.equal(un.status, 200, JSON.stringify(un.body));

      // Previous driver loses access immediately.
      const oldDriverPickup = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverA.token)).send();
      assert.equal(oldDriverPickup.status, 404);

      await assign(orderId, driverB.driverId);
      const { order, assignments } = await orderSnapshot(orderId);
      assert.equal(order.status, "ASSIGNED");
      assert.equal(order.current_driver_id, driverB.driverId);
      assert.equal(assignments.length, 2);
      assert.deepEqual(
        assignments.map((a) => [a.driver_id, a.is_current]),
        [
          [driverA.driverId, false],
          [driverB.driverId, true],
        ]
      );

      await driverAction(orderId, driverB.token, "pickup");
      const afterPickup = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(afterPickup.status, "PICKED_UP");
    });

    test("the same driver can be reassigned after being unassigned", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      const un = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(un.status, 200);
      await assign(orderId, driver.driverId);
      const { assignments } = await orderSnapshot(orderId);
      assert.equal(assignments.length, 2);
      assert.equal(assignments.filter((a) => a.is_current).length, 1);
    });
  });

  // ===========================================================
  // Historical pickup by an EARLIER driver does not block unassigning the
  // CURRENT driver (RESCHEDULED -> ASSIGNED -> Unassign -> RESCHEDULED)
  // ===========================================================

  describe("Rescheduled order reassigned to a new driver", () => {
    test("new driver not yet picked up: unassign succeeds and restores RESCHEDULED; only the current row is ended", async () => {
      const { orderId, driverA, driverB } = await rescheduledReassignedOrder();

      const before = await orderSnapshot(orderId);
      assert.equal(before.order.status, "ASSIGNED");
      assert.equal(before.order.current_driver_id, driverB.driverId);
      assert.ok(before.order.picked_up_at, "picked_up_at is set from driver A's earlier pickup");
      const pickedUpAt = before.order.picked_up_at;
      const [rowA] = before.assignments;
      assert.equal(rowA.driver_id, driverA.driverId);
      assert.equal(rowA.is_current, false);

      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "RESCHEDULED");
      assert.equal(res.body.data.currentDriver, null);

      const after = await orderSnapshot(orderId);
      assert.equal(after.order.status, "RESCHEDULED");
      assert.equal(after.order.current_driver_id, null);
      assert.equal(after.order.assigned_at, null);
      assert.deepEqual(after.order.picked_up_at, pickedUpAt, "historical pickup timestamp untouched");

      assert.equal(after.assignments.length, 2);
      assert.deepEqual(after.assignments[0], rowA, "driver A's earlier assignment row is untouched");
      assert.equal(after.assignments[1].driver_id, driverB.driverId);
      assert.equal(after.assignments[1].is_current, false);
      assert.ok(after.assignments[1].ended_at);
      assert.equal(after.assignments[1].end_reason, "Driver unassigned");

      const last = await prisma.order_status_history.findFirstOrThrow({
        where: { order_id: orderId },
        orderBy: { created_at: "desc" },
      });
      assert.equal(last.from_status, "ASSIGNED");
      assert.equal(last.to_status, "RESCHEDULED");
      assert.equal(last.changed_by_id, admin.id);

      // Driver A's failed delivery attempt is preserved.
      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 1);
    });

    test("driverless RESCHEDULED order can be assigned again, then unassigned again back to RESCHEDULED", async () => {
      const { orderId, driverB } = await rescheduledReassignedOrder();
      const un = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId });
      assert.equal(un.status, 200, JSON.stringify(un.body));

      const driverC = await createDriverWithToken();
      await assign(orderId, driverC.driverId);
      const assigned = await orderSnapshot(orderId);
      assert.equal(assigned.order.status, "ASSIGNED");
      assert.equal(assigned.order.current_driver_id, driverC.driverId);
      assert.equal(assigned.assignments.filter((a) => a.is_current).length, 1);
      const enteredAssigned = await prisma.order_status_history.findFirstOrThrow({
        where: { order_id: orderId, to_status: "ASSIGNED" },
        orderBy: { created_at: "desc" },
      });
      assert.equal(enteredAssigned.from_status, "RESCHEDULED");

      const again = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverC.driverId });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal(again.body.data.status, "RESCHEDULED");

      // A newly assigned driver goes through the normal pickup flow.
      await assign(orderId, driverC.driverId);
      await driverAction(orderId, driverC.token, "pickup");
      const pickedUp = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(pickedUp.status, "PICKED_UP");
      assert.equal(pickedUp.current_driver_id, driverC.driverId);
    });

    test("driverless RESCHEDULED order can be cancelled", async () => {
      const { orderId, driverB } = await rescheduledReassignedOrder();
      const un = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId });
      assert.equal(un.status, 200, JSON.stringify(un.body));
      const before = await orderSnapshot(orderId);

      const cancel = await request(app)
        .post(`/api/v1/orders/${orderId}/cancel`)
        .set(auth(tokens.admin))
        .send({ reason: "customer cancelled" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      const after = await orderSnapshot(orderId);
      assert.equal(after.order.status, "CANCELLED");
      assert.equal(after.order.current_driver_id, null);
      assert.deepEqual(after.assignments, before.assignments, "no assignment row touched");
    });

    test("RESCHEDULED order that still has its driver cannot be assigned (reassign is required) -> 409", async () => {
      const driver = await createDriverWithToken();
      const other = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      await driverAction(orderId, driver.token, "pickup");
      await driverAction(orderId, driver.token, "start-delivery");
      await driverAction(orderId, driver.token, "fail", { failedReasonId: failedReasonId });
      const resched = await request(app).post(`/api/v1/orders/${orderId}/reschedule`).set(auth(tokens.admin)).send({ reason: "retry" });
      assert.equal(resched.status, 200);
      const res = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: other.driverId });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.current_driver_id, driver.driverId);
    });

    test("new driver picks up first -> unassign 409, assignment kept", async () => {
      const { orderId, driverB } = await rescheduledReassignedOrder();
      await driverAction(orderId, driverB.token, "pickup");
      const res = await expectRejectedWithoutMutation(orderId, driverB.driverId, 409);
      assert.equal(res.body.error.message, "The driver cannot be unassigned after pickup.");
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.status, "PICKED_UP");
      assert.equal(order.current_driver_id, driverB.driverId);
    });

    test("pickup vs unassign race on a rescheduled-then-reassigned order: exactly one wins", async () => {
      for (let i = 0; i < 3; i++) {
        const { orderId, driverB } = await rescheduledReassignedOrder();
        const [pickupRes, unassignRes] = await Promise.all([
          request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverB.token)).send(),
          request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId }),
        ]);
        const { order, assignments } = await orderSnapshot(orderId);
        const successes = [pickupRes.status, unassignRes.status].filter((s) => s === 200).length;
        assert.equal(successes, 1, JSON.stringify({ pickup: pickupRes.body, unassign: unassignRes.body }));
        const rowB = assignments[assignments.length - 1];
        if (pickupRes.status === 200) {
          assert.equal(unassignRes.status, 409);
          assert.equal(order.status, "PICKED_UP");
          assert.equal(order.current_driver_id, driverB.driverId);
          assert.equal(rowB.is_current, true);
        } else {
          assert.ok([404, 409].includes(pickupRes.status), JSON.stringify(pickupRes.body));
          assert.equal(order.status, "RESCHEDULED");
          assert.equal(order.current_driver_id, null);
          assert.equal(rowB.is_current, false);
        }
      }
    });
  });

  // ===========================================================
  // "Awaiting delivery assignment" consistency:
  //   current_driver_id IS NULL AND status IN (RECEIVED, READY_FOR_PICKUP, RESCHEDULED)
  // ===========================================================

  describe("Awaiting-assignment consistency (queue, dashboard, bulk assign)", () => {
    test("queue includes driverless RECEIVED / READY_FOR_PICKUP / RESCHEDULED, excludes RESCHEDULED with a driver", async () => {
      const received = await createBaseOrder();
      const ready = await createBaseOrder();
      await markReady(ready);
      const driverlessRescheduled = await driverlessRescheduledOrder();
      const { orderId: rescheduledWithItsDriver } = await rescheduledWithDriver();

      // Shared predicate (also used by the dashboard and reports).
      const ids = [received, ready, driverlessRescheduled, rescheduledWithItsDriver];
      const matched = await prisma.orders.findMany({
        where: { AND: [buildWorkflowQueueWhere("READY_FOR_DELIVERY_ASSIGNMENT"), { id: { in: ids } }] },
        select: { id: true },
      });
      assert.deepEqual(
        new Set(matched.map((o) => o.id)),
        new Set([received, ready, driverlessRescheduled])
      );

      // Orders List "Ready for Delivery" queue via the API.
      assert.equal(await inReadyForDeliveryQueue(received), true);
      assert.equal(await inReadyForDeliveryQueue(ready), true);
      assert.equal(await inReadyForDeliveryQueue(driverlessRescheduled), true);
      assert.equal(await inReadyForDeliveryQueue(rescheduledWithItsDriver), false);
    });

    test("dashboard unassigned / ready-for-delivery counts include driverless RESCHEDULED but not RESCHEDULED with a driver", async () => {
      // RESCHEDULED that keeps its driver: reschedule does not change the counts.
      const driver = await createDriverWithToken();
      const orderWithDriver = await readyAssignedOrder(driver.driverId);
      await driverAction(orderWithDriver, driver.token, "pickup");
      await driverAction(orderWithDriver, driver.token, "start-delivery");
      await driverAction(orderWithDriver, driver.token, "fail", { failedReasonId: failedReasonId });
      const beforeReschedule = await getDashboardCounts();
      const resched = await request(app)
        .post(`/api/v1/orders/${orderWithDriver}/reschedule`)
        .set(auth(tokens.admin))
        .send({ reason: "retry" });
      assert.equal(resched.status, 200);
      assert.deepEqual(await getDashboardCounts(), beforeReschedule);

      // Unassigning the reassigned driver (ASSIGNED -> driverless RESCHEDULED) adds exactly one.
      const { orderId, driverB } = await rescheduledReassignedOrder();
      const before = await getDashboardCounts();
      const un = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId });
      assert.equal(un.status, 200, JSON.stringify(un.body));
      const after = await getDashboardCounts();
      assert.equal(after.unassigned, before.unassigned + 1);
      assert.equal(after.readyForDelivery, before.readyForDelivery + 1);
      assert.equal(after.attentionReadyForDelivery, before.attentionReadyForDelivery + 1);

      // Assigning it again removes it.
      const driverC = await createDriverWithToken();
      await assign(orderId, driverC.driverId);
      assert.deepEqual(await getDashboardCounts(), before);
    });

    test("bulk assign accepts driverless RESCHEDULED alongside READY_FOR_PICKUP", async () => {
      const driver = await createDriverWithToken();
      const rescheduled = await driverlessRescheduledOrder();
      const ready = await createBaseOrder();
      await markReady(ready);

      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.dispatcher))
        .send({ orderIds: [rescheduled, ready], driverId: driver.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.assignedCount, 2);

      for (const id of [rescheduled, ready]) {
        const { order, assignments } = await orderSnapshot(id);
        assert.equal(order.status, "ASSIGNED");
        assert.equal(order.current_driver_id, driver.driverId);
        assert.equal(assignments.filter((a) => a.is_current).length, 1);
      }
      const entered = await prisma.order_status_history.findFirstOrThrow({
        where: { order_id: rescheduled, to_status: "ASSIGNED" },
        orderBy: { created_at: "desc" },
      });
      assert.equal(entered.from_status, "RESCHEDULED");

      // Unassign after a bulk assignment restores RESCHEDULED.
      const un = await request(app).post(unassignPath(rescheduled)).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(un.status, 200, JSON.stringify(un.body));
      assert.equal(un.body.data.status, "RESCHEDULED");
    });

    test("bulk assign rejects RESCHEDULED with a current driver (Reassign case); whole batch rolled back", async () => {
      const other = await createDriverWithToken();
      const { orderId: rescheduled, driver } = await rescheduledWithDriver();
      const ready = await createBaseOrder();
      await markReady(ready);

      const res = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [ready, rescheduled], driverId: other.driverId });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "CONFLICT");

      const r = await prisma.orders.findUniqueOrThrow({ where: { id: rescheduled } });
      assert.equal(r.status, "RESCHEDULED");
      assert.equal(r.current_driver_id, driver.driverId);
      const rd = await prisma.orders.findUniqueOrThrow({ where: { id: ready } });
      assert.equal(rd.status, "READY_FOR_PICKUP");
      assert.equal(rd.current_driver_id, null);
    });

    test("assign / bulk assign of a driverless RESCHEDULED order keep the orders.assign RBAC", async () => {
      const driver = await createDriverWithToken();
      const orderId = await driverlessRescheduledOrder();
      for (const role of ["finance", "driver", "customer"] as const) {
        const single = await request(app)
          .post(`/api/v1/orders/${orderId}/assign`)
          .set(auth(tokens[role]))
          .send({ driverId: driver.driverId });
        assert.equal(single.status, 403, `${role} single assign`);
        const bulk = await request(app)
          .post("/api/v1/orders/bulk-assign")
          .set(auth(tokens[role]))
          .send({ orderIds: [orderId], driverId: driver.driverId });
        assert.equal(bulk.status, 403, `${role} bulk assign`);
      }
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.status, "RESCHEDULED");
      assert.equal(order.current_driver_id, null);
    });
  });

  // ===========================================================
  // Rejected after pickup
  // ===========================================================

  describe("Rejected once the driver has picked up", () => {
    test("PICKED_UP -> 409 'cannot be unassigned after pickup', no mutation", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      await driverAction(orderId, driver.token, "pickup");

      const res = await expectRejectedWithoutMutation(orderId, driver.driverId, 409);
      assert.equal(res.body.success, false);
      assert.equal(res.body.error.code, "CONFLICT");
      assert.equal(res.body.error.message, "The driver cannot be unassigned after pickup.");
    });

    test("OUT_FOR_DELIVERY (picked up) -> 409", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      await driverAction(orderId, driver.token, "pickup");
      await driverAction(orderId, driver.token, "start-delivery");

      const res = await expectRejectedWithoutMutation(orderId, driver.driverId, 409);
      assert.equal(res.body.error.message, "The driver cannot be unassigned after pickup.");
    });

    test("FAILED_DELIVERY and then RESCHEDULED (picked up earlier, same driver retained) -> 409", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      await driverAction(orderId, driver.token, "pickup");
      await driverAction(orderId, driver.token, "start-delivery");
      await driverAction(orderId, driver.token, "fail", { failedReasonId: failedReasonId });

      const failedRes = await expectRejectedWithoutMutation(orderId, driver.driverId, 409);
      assert.equal(failedRes.body.error.message, "The driver cannot be unassigned after pickup.");

      const resched = await request(app)
        .post(`/api/v1/orders/${orderId}/reschedule`)
        .set(auth(tokens.admin))
        .send({ reason: "retry tomorrow" });
      assert.equal(resched.status, 200, JSON.stringify(resched.body));

      const reschedRes = await expectRejectedWithoutMutation(orderId, driver.driverId, 409);
      assert.equal(reschedRes.body.error.message, "The driver cannot be unassigned after pickup.");
    });

    for (const status of ["RETURNED_TO_COMPANY", "RETURNED_TO_CUSTOMER", "DELIVERED"]) {
      test(`${status} with a driver still recorded -> 409 (not mistaken for pre-pickup)`, async () => {
        const driver = await createDriverWithToken();
        const orderId = await seedOrderWithStatus(status, driver.driverId);
        const res = await expectRejectedWithoutMutation(orderId, driver.driverId, 409);
        assert.equal(res.body.error.message, "The driver cannot be unassigned after pickup.");
      });
    }
  });

  // ===========================================================
  // Authorization
  // ===========================================================

  describe("Authorization", () => {
    test("unauthenticated -> 401", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      const res = await request(app).post(unassignPath(orderId)).send({ driverId: driver.driverId });
      assert.equal(res.status, 401);
    });

    test("FINANCE (no orders.assign), DRIVER, CUSTOMER -> 403 with no mutation", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      for (const role of ["finance", "driver", "customer"] as const) {
        const res = await request(app).post(unassignPath(orderId)).set(auth(tokens[role])).send({ driverId: driver.driverId });
        assert.equal(res.status, 403, `expected ${role} to be forbidden`);
      }
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.status, "ASSIGNED");
      assert.equal(order.current_driver_id, driver.driverId);
    });

    test("the assigned driver themselves cannot self-unassign -> 403", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      const res = await request(app).post(unassignPath(orderId)).set(auth(driver.token)).send({ driverId: driver.driverId });
      assert.equal(res.status, 403);
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.current_driver_id, driver.driverId);
    });
  });

  // ===========================================================
  // Validation / no-driver / stale-driver
  // ===========================================================

  describe("Validation and stale state", () => {
    test("no current driver -> 409, no mutation", async () => {
      const driver = await createDriverWithToken();
      const orderId = await createBaseOrder();
      await markReady(orderId);
      const res = await expectRejectedWithoutMutation(orderId, driver.driverId, 409);
      assert.equal(res.body.error.code, "CONFLICT");
      assert.equal(res.body.error.message, "Order has no assigned driver to unassign");
    });

    test("nonexistent order -> 404", async () => {
      const driver = await createDriverWithToken();
      const res = await request(app)
        .post(unassignPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(tokens.admin))
        .send({ driverId: driver.driverId });
      assert.equal(res.status, 404);
    });

    test("missing / invalid driverId body -> 400", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      const missing = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({});
      assert.equal(missing.status, 400);
      const invalid = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: "nope" });
      assert.equal(invalid.status, 400);
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.current_driver_id, driver.driverId);
    });

    test("stale view: another manager reassigned first -> unassign of the old driver is 409, new driver kept", async () => {
      const driverA = await createDriverWithToken();
      const driverB = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driverA.driverId);
      await reassign(orderId, driverB.driverId);

      const res = await expectRejectedWithoutMutation(orderId, driverA.driverId, 409);
      assert.equal(res.body.error.code, "CONFLICT");
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.current_driver_id, driverB.driverId);
      assert.equal(order.status, "ASSIGNED");
    });
  });

  // ===========================================================
  // Concurrency
  // ===========================================================

  describe("Concurrency", () => {
    test("pickup vs unassign race: exactly one wins and state matches the winner", async () => {
      for (let i = 0; i < 4; i++) {
        const driver = await createDriverWithToken();
        const orderId = await readyAssignedOrder(driver.driverId);

        const [pickupRes, unassignRes] = await Promise.all([
          request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driver.token)).send(),
          request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId }),
        ]);

        const { order, assignments } = await orderSnapshot(orderId);
        const successes = [pickupRes.status, unassignRes.status].filter((s) => s === 200).length;
        assert.equal(successes, 1, JSON.stringify({ pickup: pickupRes.body, unassign: unassignRes.body }));

        if (pickupRes.status === 200) {
          assert.equal(unassignRes.status, 409, JSON.stringify(unassignRes.body));
          assert.equal(order.status, "PICKED_UP");
          assert.equal(order.current_driver_id, driver.driverId, "driver must never be removed after pickup");
          assert.equal(assignments.length, 1);
          assert.equal(assignments[0].is_current, true);
          assert.equal(assignments[0].ended_at, null);
        } else {
          assert.ok([404, 409].includes(pickupRes.status), JSON.stringify(pickupRes.body));
          assert.equal(order.status, "READY_FOR_PICKUP");
          assert.equal(order.current_driver_id, null);
          assert.equal(order.picked_up_at, null);
          assert.equal(assignments.length, 1);
          assert.equal(assignments[0].is_current, false);
        }
      }
    });

    test("reassign vs unassign race: never removes the newly assigned driver", async () => {
      for (let i = 0; i < 4; i++) {
        const driverA = await createDriverWithToken();
        const driverB = await createDriverWithToken();
        const orderId = await readyAssignedOrder(driverA.driverId);

        const [reassignRes, unassignRes] = await Promise.all([
          request(app)
            .post(`/api/v1/orders/${orderId}/reassign`)
            .set(auth(tokens.admin))
            .send({ driverId: driverB.driverId, reason: "race" }),
          request(app).post(unassignPath(orderId)).set(auth(tokens.dispatcher)).send({ driverId: driverA.driverId }),
        ]);

        const { order, assignments } = await orderSnapshot(orderId);
        const successes = [reassignRes.status, unassignRes.status].filter((s) => s === 200).length;
        assert.equal(successes, 1, JSON.stringify({ reassign: reassignRes.body, unassign: unassignRes.body }));
        assert.ok(assignments.filter((a) => a.is_current).length <= 1);

        if (reassignRes.status === 200) {
          assert.equal(unassignRes.status, 409, JSON.stringify(unassignRes.body));
          assert.equal(order.status, "ASSIGNED");
          assert.equal(order.current_driver_id, driverB.driverId, "newly assigned driver must be kept");
          assert.equal(assignments.length, 2);
          assert.deepEqual(
            assignments.map((a) => [a.driver_id, a.is_current]),
            [
              [driverA.driverId, false],
              [driverB.driverId, true],
            ]
          );
        } else {
          assert.ok([400, 409].includes(reassignRes.status), JSON.stringify(reassignRes.body));
          assert.equal(order.status, "READY_FOR_PICKUP");
          assert.equal(order.current_driver_id, null);
          assert.equal(assignments.length, 1);
          assert.equal(assignments[0].driver_id, driverA.driverId);
          assert.equal(assignments[0].is_current, false);
        }
      }
    });

    test("two concurrent unassigns: exactly one succeeds, one history row", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);
      const [r1, r2] = await Promise.all([
        request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId }),
        request(app).post(unassignPath(orderId)).set(auth(tokens.dispatcher)).send({ driverId: driver.driverId }),
      ]);
      assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify({ r1: r1.body, r2: r2.body }));
      const unassignRows = await prisma.order_status_history.count({
        where: { order_id: orderId, from_status: "ASSIGNED", to_status: "READY_FOR_PICKUP" },
      });
      assert.equal(unassignRows, 1);
    });
  });

  // ===========================================================
  // Financial neutrality
  // ===========================================================

  describe("Financial integrity", () => {
    test("unassignment creates no financial records and changes no balances or order amounts", async () => {
      const driver = await createDriverWithToken();
      const orderId = await readyAssignedOrder(driver.driverId);

      async function financialSnapshot() {
        const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
        const [driverCashTx, walletTx, companyTx, directCollections, payouts, settlements, auditRows, cashAccount, wallet] =
          await Promise.all([
            prisma.driver_cash_transactions.count({ where: { OR: [{ order_id: orderId }, { driver_id: driver.driverId }] } }),
            prisma.wallet_transactions.count({ where: { customer_id: customerActive } }),
            prisma.company_financial_transactions.count({ where: { order_id: orderId } }),
            prisma.company_direct_collections.count({ where: { order_id: orderId } }),
            prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
            prisma.driver_settlements.count({ where: { driver_id: driver.driverId } }),
            prisma.audit_logs.count({ where: { entity_id: orderId } }),
            prisma.driver_cash_accounts.findUnique({ where: { driver_id: driver.driverId } }),
            prisma.customer_wallets.findUnique({ where: { customer_id: customerActive } }),
          ]);
        return {
          driverCashTx,
          walletTx,
          companyTx,
          directCollections,
          payouts,
          settlements,
          auditRows,
          cashBalance: cashAccount?.current_balance.toString() ?? null,
          walletBalance: wallet?.available_balance.toString() ?? null,
          amounts: {
            orderAmount: order.order_amount.toString(),
            deliveryFee: order.delivery_fee.toString(),
            prepaidOrderAmount: order.prepaid_order_amount.toString(),
            prepaidDeliveryFee: order.prepaid_delivery_fee.toString(),
            remainingOrderAmount: order.remaining_order_amount.toString(),
            remainingDeliveryFee: order.remaining_delivery_fee.toString(),
            amountToCollect: order.amount_to_collect.toString(),
            actualAmountCollected: order.actual_amount_collected?.toString() ?? null,
            financialStatus: order.financial_status,
            needsFinancialReview: order.needs_financial_review,
            collectionPaymentMethodId: order.collection_payment_method_id,
          },
        };
      }

      const before = await financialSnapshot();
      const res = await request(app).post(unassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const after = await financialSnapshot();
      assert.deepEqual(after, before);
    });
  });
});
