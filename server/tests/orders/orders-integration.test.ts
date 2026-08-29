// Phase 6.7 — Order Engine Integration Tests.
//
// Unlike the per-sub-phase suites (orders.test.ts, orders-list.test.ts,
// orders-update.test.ts, orders-assignment.test.ts, orders-workflow.test.ts —
// each of which already exhaustively covers its own endpoint), this file
// exercises realistic END-TO-END Management flows that cross feature
// boundaries: create -> list/search -> edit -> ready -> assign -> reassign
// -> cancel -> history, financial-engine-vs-persisted-value drift, area/
// customer/payment-method historical-reference behavior, and cross-feature
// concurrency (a workflow transition racing a generic PATCH or another
// workflow transition). It intentionally does NOT re-litigate every RBAC/
// validation branch already covered per-endpoint — see the Phase 6.7 closing
// report for exactly what is re-confirmed here vs. left to those files.
import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { calculateOrderFinancials } from "../../src/modules/orders/order-financial.service";
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
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

describe("Order Engine integration (Phase 6.7)", () => {
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
  const createdPaymentMethodIds: string[] = [];
  // Fixtures deliberately seeded with a data-consistency violation (to
  // exercise the "never silently repair" 500 defensive checks) — excluded
  // from the suite-wide consistency scan, which only asserts over orders
  // that went through normal, consistent workflow operations.
  const intentionallyInconsistentOrderIds: string[] = [];

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
    for (const id of createdPaymentMethodIds) await cleanupTestPaymentMethod(id);
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
      .send({ driverNumber: `PH67-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
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
        receiverName: "Phase67 Receiver",
        receiverPhone: "+96170000003",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase67 St",
        description: "Phase67 integration order",
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

  // Same force-write pattern established in Phase 6.6's test file: create +
  // assign for real (so a genuine, mutually-consistent order_assignments row
  // exists), then force the status directly only when it isn't ASSIGNED —
  // Phase 7's driver workflow (which would organically produce these
  // statuses) does not exist yet.
  async function assignedOrderInStatus(status: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    if (status !== "ASSIGNED") {
      await prisma.orders.update({ where: { id: order.id }, data: { status: status as never } });
    }
    return order.id as string;
  }

  function readyPath(id: string) {
    return `/api/v1/orders/${id}/ready`;
  }
  function reschedulePath(id: string) {
    return `/api/v1/orders/${id}/reschedule`;
  }
  function cancelPath(id: string) {
    return `/api/v1/orders/${id}/cancel`;
  }
  function historyPath(id: string) {
    return `/api/v1/orders/${id}/history`;
  }
  function assignPath(id: string) {
    return `/api/v1/orders/${id}/assign`;
  }
  function reassignPath(id: string) {
    return `/api/v1/orders/${id}/reassign`;
  }
  function detailPath(id: string) {
    return `/api/v1/orders/${id}`;
  }

  // ============================================================
  // DATABASE CONSISTENCY SCAN — reusable invariant checker.
  // Detects (A) driver set, no current assignment; (B) driver null, a
  // current assignment exists; (C) more than one current assignment;
  // (D) current assignment's driver differs from orders.current_driver_id.
  // Scoped to explicitly-passed, test-owned order ids only — never a global
  // table scan — so it stays safe under Node's parallel test-file execution.
  // ============================================================
  async function assertAssignmentConsistency(orderIds: string[]) {
    for (const orderId of orderIds) {
      const order = await prisma.orders.findUnique({ where: { id: orderId } });
      if (!order) continue; // some fixtures are seeded, not real orders — still fine to skip if absent
      const current = await prisma.order_assignments.findMany({ where: { order_id: orderId, is_current: true } });

      assert.ok(current.length <= 1, `order ${orderId}: more than one is_current assignment row (C)`);

      if (order.current_driver_id !== null) {
        assert.equal(current.length, 1, `order ${orderId}: current_driver_id set but no is_current assignment row (A)`);
        assert.equal(current[0]?.driver_id, order.current_driver_id, `order ${orderId}: current assignment driver mismatch (D)`);
      } else {
        assert.equal(current.length, 0, `order ${orderId}: current_driver_id is null but a current assignment row exists (B)`);
      }
    }
  }

  async function assertNoFinanceOrDeliverySideEffects(orderIds: string[]) {
    const [walletTx, driverCashTx, companyFinanceTx, deliveryAttempts, payouts, settlements] = await Promise.all([
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.delivery_attempts.count({ where: { order_id: { in: orderIds } } }),
      prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
      prisma.driver_settlements.count({ where: { driver_id: { in: createdDriverIds } } }),
    ]);
    assert.equal(walletTx, 0, "wallet_transactions must stay at zero for Phase 6 operations");
    assert.equal(driverCashTx, 0, "driver_cash_transactions must stay at zero for Phase 6 operations");
    assert.equal(companyFinanceTx, 0, "company_financial_transactions must stay at zero for Phase 6 operations");
    assert.equal(deliveryAttempts, 0, "delivery_attempts belongs to Phase 7 — must stay at zero");
    assert.equal(payouts, 0, "customer_payouts must stay at zero for Phase 6 operations");
    assert.equal(settlements, 0, "driver_settlements must stay at zero for Phase 6 operations");
  }

  function assertNoSensitiveLeak(body: unknown) {
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /password_hash/i);
    assert.doesNotMatch(serialized, /refresh_token/i);
    assert.doesNotMatch(serialized, /auth_sessions/i);
    assert.doesNotMatch(serialized, /driver_cash/i);
    assert.doesNotMatch(serialized, /wallet_transactions/i);
    assert.doesNotMatch(serialized, /company_financial/i);
    assert.doesNotMatch(serialized, /"prepared"|PrismaClientKnownRequestError/i);
  }

  // ============================================================
  // FLOW A — NORMAL UNASSIGNED ORDER
  // ============================================================

  describe("Flow A — normal unassigned order", () => {
    test("create -> RECEIVED -> ready -> assign, detail/list/history all agree", async () => {
      const eligible = await createEligibleDriver();

      const order = await createBaseOrder();
      assert.equal(order.status, "RECEIVED");
      assert.equal(order.currentDriver, null);
      assert.equal(order.financial.amountToCollect, "105");
      const created = await prisma.order_status_history.findMany({ where: { order_id: order.id } });
      assert.equal(created.length, 1);
      assert.equal(created[0].from_status, null);
      assert.equal(created[0].to_status, "RECEIVED");

      const ready = await request(app).post(readyPath(order.id)).set(auth(tokens.dispatcher)).send();
      assert.equal(ready.status, 200, JSON.stringify(ready.body));
      assert.equal(ready.body.data.status, "READY_FOR_PICKUP");

      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.dispatcher)).send({ driverId: eligible.driverId });
      assert.equal(assign.status, 200, JSON.stringify(assign.body));
      assert.equal(assign.body.data.status, "ASSIGNED");

      const [detail, list, history] = await Promise.all([
        request(app).get(detailPath(order.id)).set(auth(tokens.admin)),
        request(app).get(`/api/v1/orders?search=${encodeURIComponent(order.orderNumber)}`).set(auth(tokens.admin)),
        request(app).get(historyPath(order.id)).set(auth(tokens.admin)),
      ]);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "ASSIGNED");
      assert.equal(detail.body.data.currentDriver.id, eligible.driverId);

      assert.equal(list.status, 200);
      assert.equal(list.body.data.length, 1);
      assert.equal(list.body.data[0].status, "ASSIGNED");
      assert.equal(list.body.data[0].currentDriver.id, eligible.driverId);

      assert.equal(history.status, 200);
      const toStatuses = history.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
      assert.deepEqual(toStatuses, ["RECEIVED", "READY_FOR_PICKUP", "ASSIGNED"]);
      assert.equal(history.body.data.assignmentHistory.length, 1);
      assert.equal(history.body.data.assignmentHistory[0].isCurrent, true);

      await assertAssignmentConsistency([order.id]);
    });
  });

  // ============================================================
  // FLOW B — IMMEDIATE ASSIGNMENT (no /ready in between)
  // ============================================================

  describe("Flow B — immediate assignment", () => {
    test("RECEIVED -> assign directly: history is null->RECEIVED, RECEIVED->ASSIGNED, no fake READY_FOR_PICKUP", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();

      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(assign.status, 200);
      assert.equal(assign.body.data.status, "ASSIGNED");

      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id }, orderBy: { created_at: "asc" } });
      assert.equal(history.length, 2);
      assert.equal(history[0].from_status, null);
      assert.equal(history[0].to_status, "RECEIVED");
      assert.equal(history[1].from_status, "RECEIVED");
      assert.equal(history[1].to_status, "ASSIGNED");
      assert.ok(!history.some((h) => h.to_status === "READY_FOR_PICKUP"), "no fake READY_FOR_PICKUP event");

      await assertAssignmentConsistency([order.id]);
    });
  });

  // ============================================================
  // FLOW C — REASSIGNMENT
  // ============================================================

  describe("Flow C — reassignment", () => {
    test("assign A -> reassign B: A preserved+ended, B is sole current, status stays ASSIGNED, no fake history, DTOs agree", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const order = await createBaseOrder();

      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      assert.equal(assign.status, 200);
      const oldAssignmentId = (await prisma.order_assignments.findFirstOrThrow({ where: { order_id: order.id } })).id;

      const reassign = await request(app)
        .post(reassignPath(order.id))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "flow C reassignment" });
      assert.equal(reassign.status, 200, JSON.stringify(reassign.body));
      assert.equal(reassign.body.data.status, "ASSIGNED");
      assert.equal(reassign.body.data.currentDriver.id, driverB.driverId);

      const oldAssignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: oldAssignmentId } });
      assert.equal(oldAssignment.is_current, false);
      assert.ok(oldAssignment.ended_at);
      assert.equal(oldAssignment.end_reason, "flow C reassignment");

      const allAssignments = await prisma.order_assignments.findMany({ where: { order_id: order.id } });
      assert.equal(allAssignments.length, 2, "old assignment permanently preserved");
      const current = allAssignments.filter((a) => a.is_current);
      assert.equal(current.length, 1);
      assert.equal(current[0].driver_id, driverB.driverId);

      const statusHistory = await prisma.order_status_history.findMany({ where: { order_id: order.id } });
      assert.ok(!statusHistory.some((h) => h.from_status === "ASSIGNED" && h.to_status === "ASSIGNED"));

      const [detail, list, history] = await Promise.all([
        request(app).get(detailPath(order.id)).set(auth(tokens.admin)),
        request(app).get(`/api/v1/orders?driverId=${driverB.driverId}`).set(auth(tokens.admin)),
        request(app).get(historyPath(order.id)).set(auth(tokens.admin)),
      ]);
      assert.equal(detail.body.data.currentDriver.id, driverB.driverId);
      assert.ok(list.body.data.some((o: { id: string }) => o.id === order.id));
      assert.equal(history.body.data.assignmentHistory.filter((a: { isCurrent: boolean }) => a.isCurrent).length, 1);

      await assertAssignmentConsistency([order.id]);
    });
  });

  // ============================================================
  // FLOW D — BULK ASSIGNMENT
  // ============================================================

  describe("Flow D — bulk assignment", () => {
    test("mixed RECEIVED + READY_FOR_PICKUP orders bulk-assign atomically, no partial state", async () => {
      const eligible = await createEligibleDriver();
      const orderReceived = await createBaseOrder();
      const orderReady = await createBaseOrder();
      const readyRes = await request(app).post(readyPath(orderReady.id)).set(auth(tokens.admin)).send();
      assert.equal(readyRes.status, 200);

      const orderIds = [orderReceived.id, orderReady.id];
      const bulk = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.dispatcher))
        .send({ orderIds, driverId: eligible.driverId });
      assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
      assert.equal(bulk.body.data.assignedCount, 2);

      for (const id of orderIds) {
        const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, eligible.driverId);
        const assignments = await prisma.order_assignments.findMany({ where: { order_id: id } });
        assert.equal(assignments.length, 1);
        assert.equal(assignments[0].is_current, true);
      }
      const receivedHistory = await prisma.order_status_history.findFirstOrThrow({
        where: { order_id: orderReceived.id, to_status: "ASSIGNED" },
      });
      assert.equal(receivedHistory.from_status, "RECEIVED");
      const readyHistory = await prisma.order_status_history.findFirstOrThrow({
        where: { order_id: orderReady.id, to_status: "ASSIGNED" },
      });
      assert.equal(readyHistory.from_status, "READY_FOR_PICKUP");

      await assertAssignmentConsistency(orderIds);
    });
  });

  // ============================================================
  // FLOW E — CANCELLATION BEFORE ASSIGNMENT
  // ============================================================

  describe("Flow E — cancellation before assignment", () => {
    for (const status of ["RECEIVED", "READY_FOR_PICKUP"]) {
      test(`${status} -> cancel: cancelledAt set, no driver, no assignment mutation, exact history`, async () => {
        const orderId =
          status === "RECEIVED" ? (await createBaseOrder()).id : await seedOrderWithStatus("READY_FOR_PICKUP");

        const cancel = await request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: `flow E ${status}` });
        assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
        assert.equal(cancel.body.data.status, "CANCELLED");
        assert.ok(cancel.body.data.cancelledAt);
        assert.equal(cancel.body.data.currentDriver, null);

        const assignments = await prisma.order_assignments.count({ where: { order_id: orderId } });
        assert.equal(assignments, 0);

        const history = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: orderId, to_status: "CANCELLED" } });
        assert.equal(history.reason, `flow E ${status}`);

        await assertAssignmentConsistency([orderId]);
      });
    }
  });

  // ============================================================
  // FLOW F — CANCELLATION AFTER ASSIGNMENT
  // ============================================================

  describe("Flow F — cancellation after assignment", () => {
    test("create -> assign -> cancel: driver cleared, assignment ended+preserved, no finance/delivery side effects", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      const assign = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assert.equal(assign.status, 200);
      const assignmentId = (await prisma.order_assignments.findFirstOrThrow({ where: { order_id: order.id } })).id;

      const cancel = await request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "flow F cancellation" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.equal(cancel.body.data.status, "CANCELLED");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.current_driver_id, null);
      assert.equal(row.assigned_at, null);

      const assignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: assignmentId } });
      assert.equal(assignment.is_current, false);
      assert.ok(assignment.ended_at);
      assert.equal(assignment.end_reason, "flow F cancellation");

      const history = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: order.id, to_status: "CANCELLED" } });
      assert.equal(history.reason, "flow F cancellation");
      assert.equal(assignment.end_reason, history.reason, "cancellation reason stored consistently in both history contexts");

      await assertAssignmentConsistency([order.id]);
      await assertNoFinanceOrDeliverySideEffects([order.id]);
    });
  });

  // ============================================================
  // FLOW G — FAILED / RESCHEDULED FIXTURE FLOW
  // ============================================================

  describe("Flow G — FAILED_DELIVERY fixture -> reschedule -> reassign", () => {
    test("FAILED_DELIVERY -> reschedule (driver preserved) -> reassign (new driver, one history row)", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("FAILED_DELIVERY", driverA.driverId);

      const beforeAssignment = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });

      const reschedule = await request(app)
        .post(reschedulePath(orderId))
        .set(auth(tokens.admin))
        .send({ reason: "flow G reschedule" });
      assert.equal(reschedule.status, 200, JSON.stringify(reschedule.body));
      assert.equal(reschedule.body.data.status, "RESCHEDULED");
      assert.equal(reschedule.body.data.currentDriver.id, driverA.driverId, "original driver preserved by reschedule");

      const afterRescheduleAssignment = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(afterRescheduleAssignment.id, beforeAssignment.id);
      assert.equal(afterRescheduleAssignment.is_current, true);

      const reassign = await request(app)
        .post(reassignPath(orderId))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "flow G reassign" });
      assert.equal(reassign.status, 200, JSON.stringify(reassign.body));
      assert.equal(reassign.body.data.status, "ASSIGNED");
      assert.equal(reassign.body.data.currentDriver.id, driverB.driverId);

      const oldAssignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: beforeAssignment.id } });
      assert.equal(oldAssignment.is_current, false, "reassignment ends the old assignment");

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId } });
      const rescheduledToAssigned = history.filter((h) => h.from_status === "RESCHEDULED" && h.to_status === "ASSIGNED");
      assert.equal(rescheduledToAssigned.length, 1, "exactly one RESCHEDULED -> ASSIGNED history row");
      assert.ok(!history.some((h) => h.from_status === "ASSIGNED" && h.to_status === "ASSIGNED"), "no fake ASSIGNED -> ASSIGNED row");

      await assertAssignmentConsistency([orderId]);
    });
  });

  // ============================================================
  // FLOW H — FAILED -> CANCELLED
  // ============================================================

  describe("Flow H — FAILED_DELIVERY fixture -> cancel", () => {
    test("FAILED_DELIVERY -> cancel: assignment closes, driver cleared, no financial finalization", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const assignmentId = (await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } })).id;

      const cancel = await request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "flow H cancel" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));
      assert.equal(cancel.body.data.status, "CANCELLED");
      assert.equal(cancel.body.data.currentDriver, null);

      const assignment = await prisma.order_assignments.findUniqueOrThrow({ where: { id: assignmentId } });
      assert.equal(assignment.is_current, false);
      assert.ok(assignment.ended_at);

      const history = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: orderId, to_status: "CANCELLED" } });
      assert.equal(history.from_status, "FAILED_DELIVERY");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.financial_status, "PENDING", "no financial finalization from cancellation");
      assert.equal(row.actual_amount_collected, null);
      assert.equal(row.needs_financial_review, false);

      await assertAssignmentConsistency([orderId]);
    });
  });

  // ============================================================
  // FINANCIAL CONSISTENCY — API/persisted values must never drift from the
  // pure Phase 6.1 domain engine.
  // ============================================================

  describe("Financial consistency", () => {
    const CASES: Array<{
      label: string;
      orderType: "COMPANY_ORDER" | "DELIVERY_ONLY";
      paymentType: "CASH_ON_DELIVERY" | "PARTIALLY_PAID" | "ALREADY_PAID";
      orderAmount: string;
      deliveryFee: string;
      prepaidOrderAmount: string;
      prepaidDeliveryFee: string;
    }> = [
      {
        label: "COMPANY_ORDER + CASH_ON_DELIVERY",
        orderType: "COMPANY_ORDER",
        paymentType: "CASH_ON_DELIVERY",
        orderAmount: "200.00",
        deliveryFee: "8.00",
        prepaidOrderAmount: "0",
        prepaidDeliveryFee: "0",
      },
      {
        label: "COMPANY_ORDER + PARTIALLY_PAID",
        orderType: "COMPANY_ORDER",
        paymentType: "PARTIALLY_PAID",
        orderAmount: "200.00",
        deliveryFee: "8.00",
        prepaidOrderAmount: "50.00",
        prepaidDeliveryFee: "0",
      },
      {
        label: "COMPANY_ORDER + ALREADY_PAID",
        orderType: "COMPANY_ORDER",
        paymentType: "ALREADY_PAID",
        orderAmount: "200.00",
        deliveryFee: "8.00",
        prepaidOrderAmount: "200.00",
        prepaidDeliveryFee: "0",
      },
      {
        label: "DELIVERY_ONLY + CASH_ON_DELIVERY",
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        orderAmount: "150.00",
        deliveryFee: "6.00",
        prepaidOrderAmount: "0",
        prepaidDeliveryFee: "0",
      },
      {
        label: "DELIVERY_ONLY + PARTIALLY_PAID",
        orderType: "DELIVERY_ONLY",
        paymentType: "PARTIALLY_PAID",
        orderAmount: "150.00",
        deliveryFee: "6.00",
        prepaidOrderAmount: "30.00",
        prepaidDeliveryFee: "6.00",
      },
      {
        label: "DELIVERY_ONLY + ALREADY_PAID",
        orderType: "DELIVERY_ONLY",
        paymentType: "ALREADY_PAID",
        orderAmount: "150.00",
        deliveryFee: "6.00",
        prepaidOrderAmount: "150.00",
        prepaidDeliveryFee: "0",
      },
    ];

    for (const c of CASES) {
      test(`${c.label}: API/persisted values match the pure Phase 6.1 calculator`, async () => {
        const prepaidTotal = new Prisma.Decimal(c.prepaidOrderAmount).plus(c.prepaidDeliveryFee);
        const expected = calculateOrderFinancials({
          orderAmount: new Prisma.Decimal(c.orderAmount),
          deliveryFee: new Prisma.Decimal(c.deliveryFee),
          prepaidOrderAmount: new Prisma.Decimal(c.prepaidOrderAmount),
          prepaidDeliveryFee: new Prisma.Decimal(c.prepaidDeliveryFee),
        });

        const order = await createBaseOrder({
          orderType: c.orderType,
          paymentType: c.paymentType,
          orderAmount: c.orderAmount,
          deliveryFee: c.deliveryFee,
          prepaidOrderAmount: c.prepaidOrderAmount,
          prepaidDeliveryFee: c.prepaidDeliveryFee,
          prepaidPaymentMethodId: prepaidTotal.isZero() ? undefined : cashMethodId,
          collectionPaymentMethodId: expected.amountToCollect.isZero() ? undefined : cashMethodId,
        });

        assert.equal(order.financial.remainingOrderAmount, expected.remainingOrderAmount.toString());
        assert.equal(order.financial.remainingDeliveryFee, expected.remainingDeliveryFee.toString());
        assert.equal(order.financial.amountToCollect, expected.amountToCollect.toString());

        const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
        assert.equal(row.remaining_order_amount.toString(), expected.remainingOrderAmount.toString());
        assert.equal(row.remaining_delivery_fee.toString(), expected.remainingDeliveryFee.toString());
        assert.equal(row.amount_to_collect.toString(), expected.amountToCollect.toString());

        const detail = await request(app).get(detailPath(order.id)).set(auth(tokens.admin));
        assert.equal(detail.body.data.financial.amountToCollect, expected.amountToCollect.toString());
      });
    }
  });

  // ============================================================
  // DELIVERY_ONLY OWNERSHIP REGRESSION
  // ============================================================

  describe("DELIVERY_ONLY ownership regression", () => {
    test("remainingOrderAmount is customer-owned, remainingDeliveryFee is company-owned; zero ledger rows created", async () => {
      const order = await createBaseOrder({
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        orderAmount: "80.00",
        deliveryFee: "4.00",
      });
      assert.equal(order.financial.remainingOrderAmount, "80");
      assert.equal(order.financial.remainingDeliveryFee, "4");
      assert.equal(order.financial.amountToCollect, "84");
      assert.equal(order.orderType, "DELIVERY_ONLY");

      await assertNoFinanceOrDeliverySideEffects([order.id]);
    });
  });

  // ============================================================
  // EDIT + FINANCE INTEGRATION
  // ============================================================

  describe("Edit + finance integration", () => {
    test("editing financial inputs recomputes derived values everywhere, no extra status row, no ledger effects", async () => {
      const order = await createBaseOrder({ orderAmount: "100.00", deliveryFee: "5.00" });
      assert.equal(order.financial.amountToCollect, "105");
      const historyBefore = await prisma.order_status_history.count({ where: { order_id: order.id } });

      const patch = await request(app)
        .patch(detailPath(order.id))
        .set(auth(tokens.admin))
        .send({ orderAmount: "130.00", deliveryFee: "7.00" });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      assert.equal(patch.body.data.financial.remainingOrderAmount, "130");
      assert.equal(patch.body.data.financial.remainingDeliveryFee, "7");
      assert.equal(patch.body.data.financial.amountToCollect, "137");

      const detail = await request(app).get(detailPath(order.id)).set(auth(tokens.admin));
      assert.equal(detail.body.data.financial.amountToCollect, "137");

      const list = await request(app).get(`/api/v1/orders?search=${encodeURIComponent(order.orderNumber)}`).set(auth(tokens.admin));
      assert.equal(list.body.data[0].amountToCollect, "137");

      const historyAfter = await prisma.order_status_history.count({ where: { order_id: order.id } });
      assert.equal(historyAfter, historyBefore, "a generic financial edit must not create a status-history row");

      await assertNoFinanceOrDeliverySideEffects([order.id]);
    });
  });

  // ============================================================
  // EDIT + AREA SNAPSHOT
  // ============================================================

  describe("Edit + area snapshot", () => {
    test("renaming Area A doesn't retroactively change the snapshot; explicit Area B change does", async () => {
      const areaA = await createTestArea();
      createdAreaIds.push(areaA.id);
      const areaB = await createTestArea();
      createdAreaIds.push(areaB.id);

      const order = await createBaseOrder({ receiverAreaId: areaA.id });
      assert.equal(order.receiver.area, areaA.name);

      const rename = await request(app)
        .patch(`/api/v1/settings/areas/${areaA.id}`)
        .set(auth(tokens.admin))
        .send({ name: `${areaA.name} Renamed` });
      assert.equal(rename.status, 200, JSON.stringify(rename.body));

      const unrelatedEdit = await request(app)
        .patch(detailPath(order.id))
        .set(auth(tokens.admin))
        .send({ description: "unrelated edit after area rename" });
      assert.equal(unrelatedEdit.status, 200);
      assert.equal(unrelatedEdit.body.data.receiver.area, areaA.name, "snapshot must remain the ORIGINAL name");
      assert.equal(unrelatedEdit.body.data.receiver.areaId, areaA.id);

      const explicitChange = await request(app)
        .patch(detailPath(order.id))
        .set(auth(tokens.admin))
        .send({ receiverAreaId: areaB.id });
      assert.equal(explicitChange.status, 200, JSON.stringify(explicitChange.body));
      assert.equal(explicitChange.body.data.receiver.areaId, areaB.id);
      assert.equal(explicitChange.body.data.receiver.area, areaB.name);
    });
  });

  // ============================================================
  // HISTORICAL REFERENCE BEHAVIOR
  // ============================================================

  describe("Historical reference behavior", () => {
    test("existing Order stays readable/listable after its Customer/Area/PaymentMethod are deactivated; new selection is still rejected", async () => {
      const dedicatedCustomer = await seedCustomerRecord(admin.id);
      createdCustomerIds.push(dedicatedCustomer);
      const dedicatedArea = await createTestArea();
      createdAreaIds.push(dedicatedArea.id);
      const dedicatedMethod = await request(app)
        .post("/api/v1/settings/payment-methods")
        .set(auth(tokens.admin))
        .send({ code: `PH67-PM-${Math.random().toString(36).slice(2, 8).toUpperCase()}`, name: "Phase67 Test Method" });
      assert.equal(dedicatedMethod.status, 201, JSON.stringify(dedicatedMethod.body));
      const dedicatedMethodId = dedicatedMethod.body.data.id as string;
      createdPaymentMethodIds.push(dedicatedMethodId);

      const order = await createBaseOrder({
        customerId: dedicatedCustomer,
        receiverAreaId: dedicatedArea.id,
        collectionPaymentMethodId: dedicatedMethodId,
      });

      await request(app).patch(`/api/v1/customers/${dedicatedCustomer}`).set(auth(tokens.admin)).send({ isActive: false });
      await request(app).patch(`/api/v1/settings/areas/${dedicatedArea.id}`).set(auth(tokens.admin)).send({ isActive: false });
      await request(app).patch(`/api/v1/settings/payment-methods/${dedicatedMethodId}`).set(auth(tokens.admin)).send({ isActive: false });

      const detail = await request(app).get(detailPath(order.id)).set(auth(tokens.admin));
      assert.equal(detail.status, 200, "the Order must remain readable after its references are deactivated");
      assert.equal(detail.body.data.customer.id, dedicatedCustomer);

      const list = await request(app).get(`/api/v1/orders?search=${encodeURIComponent(order.orderNumber)}`).set(auth(tokens.admin));
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((o: { id: string }) => o.id === order.id), "the Order must remain listable");

      const unrelatedEdit = await request(app)
        .patch(detailPath(order.id))
        .set(auth(tokens.admin))
        .send({ description: "edit after references deactivated" });
      assert.equal(unrelatedEdit.status, 200, "an unrelated edit must not require the stale references to be active");
      assert.equal(unrelatedEdit.body.data.customer.id, dedicatedCustomer, "the inactive Customer reference is preserved");

      // Newly selecting the now-inactive references (a different Order,
      // first-time selection) must still be rejected.
      const newOrderBadCustomer = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId: dedicatedCustomer,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Reject Inactive Customer",
          receiverPhone: "+96170000004",
          receiverAreaId: areaActive.id,
          receiverAddress: "1 Reject St",
          description: "must be rejected",
          orderAmount: "10.00",
          deliveryFee: "1.00",
          collectionPaymentMethodId: cashMethodId,
        });
      assert.equal(newOrderBadCustomer.status, 400);

      const newOrderBadArea = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId: customerActive,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Reject Inactive Area",
          receiverPhone: "+96170000005",
          receiverAreaId: dedicatedArea.id,
          receiverAddress: "1 Reject St",
          description: "must be rejected",
          orderAmount: "10.00",
          deliveryFee: "1.00",
          collectionPaymentMethodId: cashMethodId,
        });
      assert.equal(newOrderBadArea.status, 400);

      const newOrderBadMethod = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId: customerActive,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Reject Inactive Method",
          receiverPhone: "+96170000006",
          receiverAreaId: areaActive.id,
          receiverAddress: "1 Reject St",
          description: "must be rejected",
          orderAmount: "10.00",
          deliveryFee: "1.00",
          collectionPaymentMethodId: dedicatedMethodId,
        });
      assert.equal(newOrderBadMethod.status, 400);
    });
  });

  // ============================================================
  // LIST CONSISTENCY
  // ============================================================

  describe("List consistency", () => {
    test("GET /orders reflects the current state immediately after each workflow action", async () => {
      const eligible = await createEligibleDriver();
      const eligibleB = await createEligibleDriver();
      const order = await createBaseOrder();

      async function currentListRow() {
        const res = await request(app).get(`/api/v1/orders?search=${encodeURIComponent(order.orderNumber)}`).set(auth(tokens.admin));
        assert.equal(res.status, 200);
        return res.body.data[0];
      }

      await request(app).post(readyPath(order.id)).set(auth(tokens.admin)).send();
      assert.equal((await currentListRow()).status, "READY_FOR_PICKUP");

      await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      let row = await currentListRow();
      assert.equal(row.status, "ASSIGNED");
      assert.equal(row.currentDriver.id, eligible.driverId);

      await request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligibleB.driverId, reason: "list check" });
      row = await currentListRow();
      assert.equal(row.currentDriver.id, eligibleB.driverId);

      await request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "list check cancel" });
      row = await currentListRow();
      assert.equal(row.status, "CANCELLED");
      assert.equal(row.currentDriver, null);
    });
  });

  // ============================================================
  // DETAIL / HISTORY CONSISTENCY
  // ============================================================

  describe("Detail / history consistency", () => {
    test("GET /orders/:id and GET /orders/:id/history agree on both histories, ordering, and current-assignment marking", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const order = await createBaseOrder();
      await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      await request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "consistency check" });

      const [detail, history] = await Promise.all([
        request(app).get(detailPath(order.id)).set(auth(tokens.admin)),
        request(app).get(historyPath(order.id)).set(auth(tokens.admin)),
      ]);

      assert.deepEqual(detail.body.data.statusHistory, history.body.data.statusHistory);
      assert.deepEqual(detail.body.data.assignmentHistory, history.body.data.assignmentHistory);

      for (let i = 1; i < detail.body.data.statusHistory.length; i++) {
        assert.ok(
          new Date(detail.body.data.statusHistory[i - 1].createdAt).getTime() <=
            new Date(detail.body.data.statusHistory[i].createdAt).getTime()
        );
      }
      const currentEntries = detail.body.data.assignmentHistory.filter((a: { isCurrent: boolean }) => a.isCurrent);
      assert.equal(currentEntries.length, 1);
      assert.equal(currentEntries[0].driver.id, driverB.driverId);
      assert.equal(detail.body.data.currentDriver.id, driverB.driverId);
    });
  });

  // ============================================================
  // STATUS HISTORY INVARIANTS
  // ============================================================

  describe("Status history invariants", () => {
    test("initial row null->RECEIVED; generic PATCH creates none; ASSIGNED->ASSIGNED reassign creates none", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const order = await createBaseOrder();

      const initial = await prisma.order_status_history.findMany({ where: { order_id: order.id } });
      assert.equal(initial.length, 1);
      assert.equal(initial[0].from_status, null);
      assert.equal(initial[0].to_status, "RECEIVED");

      await request(app).patch(detailPath(order.id)).set(auth(tokens.admin)).send({ description: "no status change" });
      const afterPatch = await prisma.order_status_history.count({ where: { order_id: order.id } });
      assert.equal(afterPatch, 1);

      await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });
      await request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "no-op status" });
      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id } });
      assert.ok(!history.some((h) => h.from_status === "ASSIGNED" && h.to_status === "ASSIGNED"));

      const distinctIds = new Set(history.map((h) => h.id));
      assert.equal(distinctIds.size, history.length, "no duplicate rows");
    });
  });

  // ============================================================
  // ASSIGNMENT HISTORY INVARIANTS
  // ============================================================

  describe("Assignment history invariants", () => {
    test("unassigned/cancelled orders have zero current-assignment rows; ended rows preserve ended_at/end_reason", async () => {
      const freshOrder = await createBaseOrder();
      const freshCount = await prisma.order_assignments.count({ where: { order_id: freshOrder.id, is_current: true } });
      assert.equal(freshCount, 0);

      const eligible = await createEligibleDriver();
      const cancelledOrder = await createBaseOrder();
      await request(app).post(assignPath(cancelledOrder.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      await request(app).post(cancelPath(cancelledOrder.id)).set(auth(tokens.admin)).send({ reason: "assignment invariant check" });
      const cancelledCurrentCount = await prisma.order_assignments.count({ where: { order_id: cancelledOrder.id, is_current: true } });
      assert.equal(cancelledCurrentCount, 0);
      const endedRow = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: cancelledOrder.id } });
      assert.ok(endedRow.ended_at);
      assert.equal(endedRow.end_reason, "assignment invariant check");

      await assertAssignmentConsistency([freshOrder.id, cancelledOrder.id]);
    });
  });

  // ============================================================
  // CONCURRENCY REVIEW — re-run key races across the integrated engine,
  // verifying final DB invariants (not only HTTP status codes).
  // ============================================================

  describe("Concurrency review", () => {
    test("assign vs assign: exactly one winner, invariants hold", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const order = await createBaseOrder();

      const [a, b] = await Promise.all([
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId }),
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverB.driverId }),
      ]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409]);
      await assertAssignmentConsistency([order.id]);
    });

    test("reassign vs reassign: exactly one winner, invariants hold", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const driverC = await createEligibleDriver();
      const order = await createBaseOrder();
      await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverA.driverId });

      const [b, c] = await Promise.all([
        request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "race B" }),
        request(app).post(reassignPath(order.id)).set(auth(tokens.admin)).send({ driverId: driverC.driverId, reason: "race C" }),
      ]);
      assert.deepEqual([b.status, c.status].sort(), [200, 409]);
      await assertAssignmentConsistency([order.id]);
    });

    test("ready vs assign: exactly one winner, invariants hold", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      const [ready, assign] = await Promise.all([
        request(app).post(readyPath(order.id)).set(auth(tokens.admin)).send(),
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId }),
      ]);
      assert.deepEqual([ready.status, assign.status].sort(), [200, 409]);
      await assertAssignmentConsistency([order.id]);
    });

    test("reschedule vs cancel: exactly one winner, invariants hold", async () => {
      const eligible = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("FAILED_DELIVERY", eligible.driverId);
      const [reschedule, cancel] = await Promise.all([
        request(app).post(reschedulePath(orderId)).set(auth(tokens.admin)).send({ reason: "race reschedule" }),
        request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "race cancel" }),
      ]);
      assert.deepEqual([reschedule.status, cancel.status].sort(), [200, 409]);
      await assertAssignmentConsistency([orderId]);
    });

    test("cancel vs reassign: exactly one winner, invariants hold", async () => {
      const driverA = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const orderId = await assignedOrderInStatus("RESCHEDULED", driverA.driverId);
      const [cancel, reassign] = await Promise.all([
        request(app).post(cancelPath(orderId)).set(auth(tokens.admin)).send({ reason: "race cancel" }),
        request(app).post(reassignPath(orderId)).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "race reassign" }),
      ]);
      assert.deepEqual([cancel.status, reassign.status].sort(), [200, 409]);
      await assertAssignmentConsistency([orderId]);
    });

    test("stale PATCH vs cancel: no silent overwrite of a cancelled order", async () => {
      const order = await createBaseOrder();
      const [patch, cancel] = await Promise.all([
        request(app).patch(detailPath(order.id)).set(auth(tokens.admin)).send({ description: "raced description" }),
        request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "race cancel" }),
      ]);
      assert.equal(cancel.status, 200);
      assert.ok([200, 409].includes(patch.status));
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, "CANCELLED");
      if (patch.status === 409) {
        assert.notEqual(row.description, "raced description");
      }
      await assertAssignmentConsistency([order.id]);
    });

    test("bulk assign racing a single assignment: whole batch is all-or-nothing", async () => {
      const eligibleBulk = await createEligibleDriver();
      const eligibleRacer = await createEligibleDriver();
      const orderX = await createBaseOrder();
      const orderY = await createBaseOrder();

      const [bulk, single] = await Promise.all([
        request(app)
          .post("/api/v1/orders/bulk-assign")
          .set(auth(tokens.admin))
          .send({ orderIds: [orderX.id, orderY.id], driverId: eligibleBulk.driverId }),
        request(app).post(assignPath(orderY.id)).set(auth(tokens.admin)).send({ driverId: eligibleRacer.driverId }),
      ]);

      if (bulk.status === 200) {
        assert.equal(single.status, 409);
        for (const id of [orderX.id, orderY.id]) {
          const row = await prisma.orders.findUniqueOrThrow({ where: { id } });
          assert.equal(row.current_driver_id, eligibleBulk.driverId);
        }
      } else {
        assert.equal(bulk.status, 409);
        assert.equal(single.status, 200);
        const rowX = await prisma.orders.findUniqueOrThrow({ where: { id: orderX.id } });
        assert.equal(rowX.current_driver_id, null, "the rolled-back bulk batch must not partially assign orderX");
      }
      await assertAssignmentConsistency([orderX.id, orderY.id]);
    });

    test("NEW: ready vs cancel on a RECEIVED order — exactly one original-state transition wins, no duplicate history", async () => {
      const order = await createBaseOrder();
      const [ready, cancel] = await Promise.all([
        request(app).post(readyPath(order.id)).set(auth(tokens.admin)).send(),
        request(app).post(cancelPath(order.id)).set(auth(tokens.admin)).send({ reason: "race ready-vs-cancel" }),
      ]);
      assert.deepEqual([ready.status, cancel.status].sort(), [200, 409]);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.ok(["READY_FOR_PICKUP", "CANCELLED"].includes(row.status));

      const history = await prisma.order_status_history.findMany({ where: { order_id: order.id } });
      const nonInitial = history.filter((h) => h.from_status !== null);
      assert.equal(nonInitial.length, 1, "exactly one real transition must be recorded, no duplicate");
      await assertAssignmentConsistency([order.id]);
    });

    test("NEW: PATCH vs ready on a RECEIVED order — both may safely coexist, no lost update", async () => {
      const order = await createBaseOrder();
      const [patch, ready] = await Promise.all([
        request(app).patch(detailPath(order.id)).set(auth(tokens.admin)).send({ description: "patch-vs-ready description" }),
        request(app).post(readyPath(order.id)).set(auth(tokens.admin)).send(),
      ]);
      assert.ok([200, 409].includes(patch.status), JSON.stringify(patch.body));
      assert.ok([200, 409].includes(ready.status), JSON.stringify(ready.body));
      // At least one of the two must succeed — this is not a genuine field
      // conflict (PATCH never writes status, ready never writes description).
      assert.ok(patch.status === 200 || ready.status === 200, "at least one of the two non-conflicting writes must succeed");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      if (ready.status === 200) {
        assert.equal(row.status, "READY_FOR_PICKUP");
      } else {
        assert.equal(row.status, "RECEIVED");
      }
      if (patch.status === 200) {
        assert.equal(row.description, "patch-vs-ready description", "a successful PATCH must never be silently lost");
      }
      await assertAssignmentConsistency([order.id]);
    });

    test("NEW: PATCH vs assign on a RECEIVED order — both may safely coexist, no lost update, correct final assignment", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();
      const [patch, assign] = await Promise.all([
        request(app).patch(detailPath(order.id)).set(auth(tokens.admin)).send({ description: "patch-vs-assign description" }),
        request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId }),
      ]);
      assert.ok([200, 409].includes(patch.status), JSON.stringify(patch.body));
      assert.equal(assign.status, 200, "assign never conflicts with a PATCH that doesn't touch status/driver fields");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, "ASSIGNED");
      assert.equal(row.current_driver_id, eligible.driverId);
      if (patch.status === 200) {
        assert.equal(row.description, "patch-vs-assign description", "a successful PATCH must never be silently lost");
      }

      const assignments = await prisma.order_assignments.count({ where: { order_id: order.id } });
      assert.equal(assignments, 1);
      const history = await prisma.order_status_history.findFirstOrThrow({ where: { order_id: order.id, to_status: "ASSIGNED" } });
      assert.equal(history.from_status, "RECEIVED");

      await assertAssignmentConsistency([order.id]);
    });
  });

  // ============================================================
  // BULK ATOMICITY REVIEW
  // ============================================================

  describe("Bulk atomicity review", () => {
    test("missing member, assigned member, invalid-status member all leave every other order untouched", async () => {
      const eligible = await createEligibleDriver();
      const eligibleOther = await createEligibleDriver();

      // Missing member
      const order1 = await createBaseOrder();
      const missingRes = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order1.id, "00000000-0000-0000-0000-000000000000"], driverId: eligible.driverId });
      assert.equal(missingRes.status, 404);
      const row1 = await prisma.orders.findUniqueOrThrow({ where: { id: order1.id } });
      assert.equal(row1.current_driver_id, null);

      // Already-assigned member
      const order2 = await createBaseOrder();
      const order3 = await createBaseOrder();
      await request(app).post(assignPath(order3.id)).set(auth(tokens.admin)).send({ driverId: eligibleOther.driverId });
      const assignedRes = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order2.id, order3.id], driverId: eligible.driverId });
      assert.equal(assignedRes.status, 409);
      const row2 = await prisma.orders.findUniqueOrThrow({ where: { id: order2.id } });
      assert.equal(row2.current_driver_id, null, "order2 must not be assigned even though it was individually eligible");

      // Invalid-status member
      const order4 = await createBaseOrder();
      const cancelledId = await seedOrderWithStatus("CANCELLED");
      const invalidRes = await request(app)
        .post("/api/v1/orders/bulk-assign")
        .set(auth(tokens.admin))
        .send({ orderIds: [order4.id, cancelledId], driverId: eligible.driverId });
      assert.equal(invalidRes.status, 400);
      const row4 = await prisma.orders.findUniqueOrThrow({ where: { id: order4.id } });
      assert.equal(row4.current_driver_id, null);

      await assertAssignmentConsistency([order1.id, order2.id, order3.id, order4.id, cancelledId]);
    });
  });

  // ============================================================
  // IDENTIFIER UNIQUENESS
  // ============================================================

  describe("Identifier uniqueness", () => {
    test("concurrent creates all produce unique, correctly-formatted order_number/tracking_code", async () => {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          request(app)
            .post("/api/v1/orders")
            .set(auth(tokens.admin))
            .send({
              customerId: customerActive,
              orderType: "DELIVERY_ONLY",
              paymentType: "CASH_ON_DELIVERY",
              receiverName: "Concurrent Create",
              receiverPhone: "+96170000007",
              receiverAreaId: areaActive.id,
              receiverAddress: "1 Concurrent St",
              description: "identifier uniqueness check",
              orderAmount: "10.00",
              deliveryFee: "1.00",
              collectionPaymentMethodId: cashMethodId,
            })
        )
      );
      for (const res of results) {
        assert.equal(res.status, 201, JSON.stringify(res.body));
        createdOrderIds.push(res.body.data.id);
      }
      const orderNumbers = results.map((r) => r.body.data.orderNumber);
      const trackingCodes = results.map((r) => r.body.data.trackingCode);
      assert.equal(new Set(orderNumbers).size, orderNumbers.length);
      assert.equal(new Set(trackingCodes).size, trackingCodes.length);
      for (const n of orderNumbers) assert.match(n, /^ORD-\d{8}-[A-Z0-9]{6}$/);
      for (const t of trackingCodes) assert.match(t, /^TRK-[A-Z0-9]{12}$/);
    });
  });

  // ============================================================
  // SERVER-CONTROLLED FIELD REVIEW
  // ============================================================

  describe("Server-controlled field review", () => {
    test("POST + PATCH: client cannot control orderNumber/status/financialStatus/derived amounts/currentDriverId/timestamps/createdById", async () => {
      const eligible = await createEligibleDriver();
      const create = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.dispatcher))
        .send({
          customerId: customerActive,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Spoof Attempt",
          receiverPhone: "+96170000008",
          receiverAreaId: areaActive.id,
          receiverAddress: "1 Spoof St",
          description: "server-controlled field check",
          orderAmount: "20.00",
          deliveryFee: "2.00",
          collectionPaymentMethodId: cashMethodId,
          orderNumber: "SPOOFED-NUMBER",
          trackingCode: "SPOOFED-TRACKING",
          status: "DELIVERED",
          financialStatus: "FINALIZED",
          remainingOrderAmount: "0",
          amountToCollect: "0",
          actualAmountCollected: "999.00",
          needsFinancialReview: true,
          currentDriverId: eligible.driverId,
          createdById: dispatcher.id,
        });
      assert.equal(create.status, 201, JSON.stringify(create.body));
      createdOrderIds.push(create.body.data.id);
      assert.notEqual(create.body.data.orderNumber, "SPOOFED-NUMBER");
      assert.notEqual(create.body.data.trackingCode, "SPOOFED-TRACKING");
      assert.equal(create.body.data.status, "RECEIVED");
      assert.equal(create.body.data.financialStatus, "PENDING");
      assert.equal(create.body.data.financial.amountToCollect, "22");
      assert.equal(create.body.data.financial.actualAmountCollected, null);
      assert.equal(create.body.data.currentDriver, null);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: create.body.data.id } });
      assert.equal(row.created_by_id, dispatcher.id, "createdById always derives from the authenticated actor");

      const patch = await request(app)
        .patch(detailPath(create.body.data.id))
        .set(auth(tokens.admin))
        .send({
          description: "legit patch",
          status: "DELIVERED",
          currentDriverId: eligible.driverId,
          assignedAt: "2000-01-01T00:00:00.000Z",
          createdById: admin.id,
        });
      assert.equal(patch.status, 200, JSON.stringify(patch.body));
      assert.equal(patch.body.data.status, "RECEIVED");
      assert.equal(patch.body.data.currentDriver, null);
      const patchedRow = await prisma.orders.findUniqueOrThrow({ where: { id: create.body.data.id } });
      assert.equal(patchedRow.created_by_id, dispatcher.id, "createdById is immutable via PATCH");
    });
  });

  // ============================================================
  // RBAC REVIEW — final Phase 6 permission mapping, representative
  // endpoints from every permission category.
  // ============================================================

  describe("RBAC review", () => {
    test("ADMIN/DISPATCHER full access; FINANCE read-only; DRIVER/CUSTOMER no Management Order API access", async () => {
      const eligible = await createEligibleDriver();

      for (const role of ["admin", "dispatcher"] as const) {
        const order = await createBaseOrder();
        assert.equal((await request(app).get(detailPath(order.id)).set(auth(tokens[role]))).status, 200);
        assert.equal(
          (await request(app).patch(detailPath(order.id)).set(auth(tokens[role])).send({ description: "rbac check" })).status,
          200
        );
        assert.equal((await request(app).post(readyPath(order.id)).set(auth(tokens[role])).send()).status, 200);
        const order2 = await createBaseOrder();
        assert.equal(
          (await request(app).post(assignPath(order2.id)).set(auth(tokens[role])).send({ driverId: eligible.driverId })).status,
          200
        );
        assert.equal(
          (await request(app).post(cancelPath(order2.id)).set(auth(tokens[role])).send({ reason: "rbac cancel" })).status,
          200
        );
      }

      const financeOrder = await createBaseOrder();
      assert.equal((await request(app).get(detailPath(financeOrder.id)).set(auth(tokens.finance))).status, 200);
      assert.equal((await request(app).get(historyPath(financeOrder.id)).set(auth(tokens.finance))).status, 200);
      assert.equal(
        (await request(app).patch(detailPath(financeOrder.id)).set(auth(tokens.finance)).send({ description: "x" })).status,
        403
      );
      assert.equal((await request(app).post(readyPath(financeOrder.id)).set(auth(tokens.finance)).send()).status, 403);
      assert.equal(
        (await request(app).post(assignPath(financeOrder.id)).set(auth(tokens.finance)).send({ driverId: eligible.driverId })).status,
        403
      );
      assert.equal(
        (await request(app).post(cancelPath(financeOrder.id)).set(auth(tokens.finance)).send({ reason: "x" })).status,
        403
      );
      assert.equal(
        (
          await request(app)
            .post("/api/v1/orders")
            .set(auth(tokens.finance))
            .send({ customerId: customerActive, orderType: "DELIVERY_ONLY", paymentType: "CASH_ON_DELIVERY" })
        ).status,
        403
      );

      for (const role of ["driver", "customer"] as const) {
        const order = await createBaseOrder();
        assert.equal((await request(app).get(detailPath(order.id)).set(auth(tokens[role]))).status, 403, role);
        assert.equal((await request(app).get(historyPath(order.id)).set(auth(tokens[role]))).status, 403, role);
        assert.equal(
          (await request(app).patch(detailPath(order.id)).set(auth(tokens[role])).send({ description: "x" })).status,
          403,
          role
        );
        assert.equal((await request(app).post(readyPath(order.id)).set(auth(tokens[role])).send()).status, 403, role);
      }
    });
  });

  // ============================================================
  // ERROR CONTRACT REVIEW
  // ============================================================

  describe("Error contract review", () => {
    test("400/401/403/404/409/500 all use the standard error envelope and never leak internals", async () => {
      const eligible = await createEligibleDriver();
      const order = await createBaseOrder();

      const badBody = await request(app).post(reschedulePath(order.id)).set(auth(tokens.admin)).send({});
      const unauth = await request(app).get(detailPath(order.id));
      const forbidden = await request(app).post(readyPath(order.id)).set(auth(tokens.driver)).send();
      const notFound = await request(app).get(detailPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.admin));

      await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      const conflict = await request(app).post(assignPath(order.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });

      const eligible2 = await createEligibleDriver();
      const badOrder = await seedOrderWithStatus("RECEIVED", { currentDriverId: eligible2.driverId });
      intentionallyInconsistentOrderIds.push(badOrder);
      const internal = await request(app).post(readyPath(badOrder)).set(auth(tokens.admin)).send();

      for (const [res, expectedCode] of [
        [badBody, "VALIDATION_ERROR"],
        [unauth, "UNAUTHORIZED"],
        [forbidden, "FORBIDDEN"],
        [notFound, "NOT_FOUND"],
        [conflict, "CONFLICT"],
        [internal, "INTERNAL_ERROR"],
      ] as const) {
        assert.equal(res.body.success, false);
        assert.equal(res.body.error.code, expectedCode, JSON.stringify(res.body));
        assert.ok(typeof res.body.error.message === "string" && res.body.error.message.length > 0);
        assertNoSensitiveLeak(res.body);
        assert.doesNotMatch(JSON.stringify(res.body), /at [A-Za-z]+\.[A-Za-z]+ \(/); // no stack-trace-shaped text
      }
      assert.equal(badBody.status, 400);
      assert.equal(unauth.status, 401);
      assert.equal(forbidden.status, 403);
      assert.equal(notFound.status, 404);
      assert.equal(conflict.status, 409);
      assert.equal(internal.status, 500);
    });
  });

  // ============================================================
  // DTO SECURITY REVIEW
  // ============================================================

  describe("DTO security review", () => {
    test("create/detail/list/edit/assign/reassign/reschedule/cancel/history responses never leak sensitive data", async () => {
      const eligible = await createEligibleDriver();
      const driverB = await createEligibleDriver();
      const create = await createBaseOrder();
      assertNoSensitiveLeak(create);

      const detail = await request(app).get(detailPath(create.id)).set(auth(tokens.admin));
      assertNoSensitiveLeak(detail.body);

      const list = await request(app).get(`/api/v1/orders?search=${encodeURIComponent(create.orderNumber)}`).set(auth(tokens.admin));
      assertNoSensitiveLeak(list.body);

      const edit = await request(app).patch(detailPath(create.id)).set(auth(tokens.admin)).send({ description: "dto sweep" });
      assertNoSensitiveLeak(edit.body);

      const assign = await request(app).post(assignPath(create.id)).set(auth(tokens.admin)).send({ driverId: eligible.driverId });
      assertNoSensitiveLeak(assign.body);

      const reassign = await request(app)
        .post(reassignPath(create.id))
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "dto sweep reassign" });
      assertNoSensitiveLeak(reassign.body);

      const eligible2 = await createEligibleDriver();
      const failedOrder = await assignedOrderInStatus("FAILED_DELIVERY", eligible2.driverId);
      const reschedule = await request(app).post(reschedulePath(failedOrder)).set(auth(tokens.admin)).send({ reason: "dto sweep reschedule" });
      assertNoSensitiveLeak(reschedule.body);

      const cancel = await request(app).post(cancelPath(failedOrder)).set(auth(tokens.admin)).send({ reason: "dto sweep cancel" });
      assertNoSensitiveLeak(cancel.body);

      const history = await request(app).get(historyPath(create.id)).set(auth(tokens.admin));
      assertNoSensitiveLeak(history.body);
    });
  });

  // ============================================================
  // SUITE-WIDE FINAL VERIFICATION — every order created anywhere in this
  // file must satisfy the assignment-consistency invariants and must never
  // have produced a Phase 7/finance side effect.
  // ============================================================

  describe("Suite-wide final verification", () => {
    test("every order created by this suite satisfies assignment consistency and has zero finance/delivery side effects", async () => {
      assert.ok(createdOrderIds.length > 20, "sanity check: this suite should have created a substantial number of orders");
      const consistentOrderIds = createdOrderIds.filter((id) => !intentionallyInconsistentOrderIds.includes(id));
      await assertAssignmentConsistency(consistentOrderIds);
      await assertNoFinanceOrDeliverySideEffects(createdOrderIds);
    });
  });
});
