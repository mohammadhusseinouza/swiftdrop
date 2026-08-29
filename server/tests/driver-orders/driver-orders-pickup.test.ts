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

describe("Driver Portal — Pickup (Phase 7.2)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
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
      .send({ driverNumber: `PH72-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
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
        receiverName: "Phase72 Receiver",
        receiverPhone: "+96170000010",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase72 St",
        description: "Phase72 pickup order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function createOrderAssignedTo(driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    return order.id as string;
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

  async function assertNoSideEffects(orderIds: string[]) {
    const [attempts, walletTx, cashTx, companyTx, payouts, settlements] = await Promise.all([
      prisma.delivery_attempts.count({ where: { order_id: { in: orderIds } } }),
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.customer_payouts.count({ where: { customer_id: customerActive } }),
      prisma.driver_settlements.count({ where: { driver_id: { in: createdDriverIds } } }),
    ]);
    assert.equal(attempts, 0);
    assert.equal(walletTx, 0);
    assert.equal(cashTx, 0);
    assert.equal(companyTx, 0);
    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
  }

  // ============================================================
  // RBAC (1-6)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated pickup -> 401", async () => {
      const res = await request(app).post(pickupPath("00000000-0000-0000-0000-000000000000")).send();
      assert.equal(res.status, 401);
    });

    test("2. linked DRIVER -> success", async () => {
      const driver = await createDriverWithToken("driver2");
      const orderId = await createOrderAssignedTo(driver.driverId);
      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. CUSTOMER -> 403", async () => {
      const res = await request(app).post(pickupPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.customer)).send();
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
    });

    test("4. FINANCE -> 403", async () => {
      const res = await request(app).post(pickupPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.finance)).send();
      assert.equal(res.status, 403);
    });

    test("5. DISPATCHER -> 403 (real permission set lacks driver.orders.update_own)", async () => {
      const res = await request(app).post(pickupPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.dispatcher)).send();
      assert.equal(res.status, 403);
    });

    test("6. ADMIN without Driver profile -> safe 403", async () => {
      const res = await request(app).post(pickupPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.admin)).send();
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|relation|foreign key/i);
    });
  });

  // ============================================================
  // OWNERSHIP (7-11)
  // ============================================================

  describe("Ownership", () => {
    test("7. Driver A picks up own assigned Order -> 200", async () => {
      const driverA = await createDriverWithToken("driverA-7");
      const orderId = await createOrderAssignedTo(driverA.driverId);
      const res = await request(app).post(pickupPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "PICKED_UP");
    });

    test("8. Driver A pickup Driver B's Order -> 404", async () => {
      const driverA = await createDriverWithToken("driverA-8");
      const driverB = await createDriverWithToken("driverB-8");
      const orderB = await createOrderAssignedTo(driverB.driverId);
      const res = await request(app).post(pickupPath(orderB)).set(auth(driverA.token)).send();
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("9. Driver A pickup nonexistent Order -> same safe 404 contract", async () => {
      const driverA = await createDriverWithToken("driverA-9");
      const driverB = await createDriverWithToken("driverB-9");
      const orderB = await createOrderAssignedTo(driverB.driverId);

      const forOther = await request(app).post(pickupPath(orderB)).set(auth(driverA.token)).send();
      const forMissing = await request(app).post(pickupPath("00000000-0000-0000-0000-000000000000")).set(auth(driverA.token)).send();
      assert.equal(forOther.status, forMissing.status);
      assert.equal(forOther.body.error.code, forMissing.body.error.code);
      assert.equal(forOther.status, 404);
    });

    test("10. historical previous Driver cannot pickup after reassignment", async () => {
      const driverA = await createDriverWithToken("driverA-10");
      const driverB = await createDriverWithToken("driverB-10");
      const orderId = await createOrderAssignedTo(driverA.driverId);
      const reassign = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "pickup ownership regression" });
      assert.equal(reassign.status, 200);

      const res = await request(app).post(pickupPath(orderId)).set(auth(driverA.token)).send();
      assert.equal(res.status, 404);
    });

    test("11. client spoofed driverId/currentDriverId in body has no effect", async () => {
      const driverA = await createDriverWithToken("driverA-11");
      const driverB = await createDriverWithToken("driverB-11");
      const orderB = await createOrderAssignedTo(driverB.driverId);

      const res = await request(app)
        .post(pickupPath(orderB))
        .set(auth(driverA.token))
        .send({ driverId: driverA.driverId, currentDriverId: driverA.driverId, pickedUpById: driverA.driverId });
      assert.equal(res.status, 404, "spoofed body fields must not widen ownership");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderB } });
      assert.equal(row.current_driver_id, driverB.driverId);
      assert.equal(row.status, "ASSIGNED");
    });
  });

  // ============================================================
  // VALID TRANSITION (12-20)
  // ============================================================

  describe("Valid transition", () => {
    test("12-20. ASSIGNED -> PICKED_UP: timestamps, assignment preserved, exactly one history row, correct actor", async () => {
      const driver = await createDriverWithToken("driver-transition");
      const orderId = await createOrderAssignedTo(driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const assignmentBefore = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });

      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "PICKED_UP");
      assert.ok(res.body.data.timestamps.pickedUpAt);

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.status, "PICKED_UP");
      assert.ok(after.picked_up_at); // 13
      assert.notEqual(after.updated_at.getTime(), before.updated_at.getTime()); // 14
      assert.equal(after.assigned_at?.getTime(), before.assigned_at?.getTime()); // 15
      assert.equal(after.current_driver_id, driver.driverId); // 16

      const assignmentAfter = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(assignmentAfter.id, assignmentBefore.id);
      assert.equal(assignmentAfter.is_current, true); // 17

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } });
      const pickupRows = history.filter((h) => h.to_status === "PICKED_UP");
      assert.equal(pickupRows.length, 1); // 18
      assert.equal(pickupRows[0].from_status, "ASSIGNED"); // 19
      assert.equal(pickupRows[0].changed_by_id, driver.userId); // 20
    });
  });

  // ============================================================
  // INVALID TRANSITIONS (21-30)
  // ============================================================

  describe("Invalid transitions", () => {
    const NOT_PICKUPABLE = [
      "RECEIVED",
      "READY_FOR_PICKUP",
      "PICKED_UP",
      "OUT_FOR_DELIVERY",
      "DELIVERED",
      "FAILED_DELIVERY",
      "RESCHEDULED",
      "RETURNED_TO_COMPANY",
      "RETURNED_TO_CUSTOMER",
      "CANCELLED",
    ];

    for (const status of NOT_PICKUPABLE) {
      test(`21-30. pickup rejects from ${status}`, async () => {
        const driver = await createDriverWithToken(`driver-invalid-${status}`);
        // Force-seed the fixture as owned by this driver regardless of
        // status (the pickupDriverOrder status check runs BEFORE the
        // assignment-integrity check, so this exercises the 400 branch
        // uniformly without needing a real order_assignments row for
        // statuses that could never legitimately carry a driver, e.g.
        // RECEIVED — that data-consistency case is covered separately by
        // the Assignment Integrity tests below).
        const orderId = await seedOrderWithStatus(status, { currentDriverId: driver.driverId });

        const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
        assert.equal(res.status, 400, `expected ${status} to be rejected as an invalid transition`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      });
    }
  });

  // ============================================================
  // REPEAT (31-33)
  // ============================================================

  describe("Repeat pickup", () => {
    test("31-33. first pickup succeeds, second is rejected, exactly one history row remains", async () => {
      const driver = await createDriverWithToken("driver-repeat");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const first = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(first.status, 200);

      const second = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(second.status, 400);
      assert.equal(second.body.error.code, "VALIDATION_ERROR");

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "PICKED_UP" } });
      assert.equal(history.length, 1);
    });
  });

  // ============================================================
  // ASSIGNMENT INTEGRITY (34-36)
  // ============================================================

  describe("Assignment integrity", () => {
    test("34. current_driver_id set but missing current assignment row -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-integrity-34");
      const orderId = await seedOrderWithStatus("ASSIGNED", { currentDriverId: driver.driverId });
      // seedTestOrder never creates an order_assignments row — this is
      // exactly the missing-assignment inconsistency.
      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "ASSIGNED", "must not be silently transitioned despite the inconsistency");
    });

    test("35. multiple current assignment rows -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-integrity-35");
      const otherAssigner = await createDriverWithToken("driver-integrity-35-other");
      const orderId = await createOrderAssignedTo(driver.driverId);
      // Directly inject a second is_current=true row to corrupt the
      // invariant — never reachable through any real API.
      await prisma.order_assignments.create({
        data: {
          order_id: orderId,
          driver_id: otherAssigner.driverId,
          assigned_by_id: admin.id,
          is_current: true,
        },
      });

      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });

    test("36. current assignment driver mismatch -> sanitized 500", async () => {
      const driver = await createDriverWithToken("driver-integrity-36");
      const otherDriver = await createDriverWithToken("driver-integrity-36-other");
      const orderId = await createOrderAssignedTo(driver.driverId);
      // Corrupt the single current assignment row to point at a different
      // driver than orders.current_driver_id.
      await prisma.order_assignments.updateMany({
        where: { order_id: orderId, is_current: true },
        data: { driver_id: otherDriver.driverId },
      });

      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
    });
  });

  // ============================================================
  // CONCURRENCY (37-39)
  // ============================================================

  describe("Concurrency", () => {
    test("37. two simultaneous pickup requests: exactly one succeeds, one history row, stable final state", async () => {
      const driver = await createDriverWithToken("driver-concurrency-37");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const [a, b] = await Promise.all([
        request(app).post(pickupPath(orderId)).set(auth(driver.token)).send(),
        request(app).post(pickupPath(orderId)).set(auth(driver.token)).send(),
      ]);
      // Exactly one must succeed. The loser can observe the race in either
      // of two equally-safe ways depending on precise timing: its
      // pre-transaction status read happens strictly after the winner's
      // commit (its own status check rejects with 400, never reaching the
      // transaction), or its read happens before the winner's commit but
      // its conditional updateMany loses the row-lock race inside the
      // transaction (409). Both are correct outcomes of the same
      // concurrency guard — see Phase 6.6/6.7's identical treatment of a
      // losing concurrent request's exact status code.
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200, JSON.stringify({ a: a.body, b: b.body }));
      assert.ok([400, 409].includes(statuses[1]), JSON.stringify({ a: a.body, b: b.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "PICKED_UP");
      assert.ok(row.picked_up_at);

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "PICKED_UP" } });
      assert.equal(history.length, 1);
    });

    test("38. pickup vs Management cancel: exactly one wins, no mixed state", async () => {
      const driver = await createDriverWithToken("driver-concurrency-38");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const [pickup, cancel] = await Promise.all([
        request(app).post(pickupPath(orderId)).set(auth(driver.token)).send(),
        request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "race with pickup" }),
      ]);
      // Exactly one must succeed. The loser can observe the race either via
      // the losing conditional updateMany (409) or, if its own pre-
      // transaction status read happens strictly after the winner's commit,
      // via its own status-validity check (400 — cancelOrder's
      // CANCELLABLE_STATUSES does not include PICKED_UP). Both are correct
      // outcomes of the same guard — see Phase 7.2's identical treatment.
      const pickupVsCancelStatuses = [pickup.status, cancel.status].sort();
      assert.equal(pickupVsCancelStatuses[0], 200, JSON.stringify({ pickup: pickup.body, cancel: cancel.body }));
      assert.ok([400, 409].includes(pickupVsCancelStatuses[1]), JSON.stringify({ pickup: pickup.body, cancel: cancel.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (pickup.status === 200) {
        assert.equal(row.status, "PICKED_UP");
        assert.ok(row.picked_up_at);
        assert.equal(row.current_driver_id, driver.driverId);
        assert.equal(row.cancelled_at, null);
      } else {
        assert.equal(row.status, "CANCELLED");
        assert.equal(row.picked_up_at, null, "cancel must never leave a picked_up_at written by a losing pickup");
        assert.equal(row.current_driver_id, null);
        const assignment = await prisma.order_assignments.findFirstOrThrow({ where: { order_id: orderId } });
        assert.equal(assignment.is_current, false);
      }

      const history = await prisma.order_status_history.findMany({ where: { order_id: orderId } });
      const nonInitial = history.filter((h) => h.from_status !== null && h.from_status !== "RECEIVED");
      assert.equal(nonInitial.length, 1, "exactly one real post-assignment transition, no duplicate");
    });

    test("39. pickup vs Management reassign: exactly one wins, no mixed status/driver/assignment state", async () => {
      const driverA = await createDriverWithToken("driverA-concurrency-39");
      const driverB = await createDriverWithToken("driverB-concurrency-39");
      const orderId = await createOrderAssignedTo(driverA.driverId);

      const [pickup, reassign] = await Promise.all([
        request(app).post(pickupPath(orderId)).set(auth(driverA.token)).send(),
        request(app).post(`/api/v1/orders/${orderId}/reassign`).set(auth(tokens.admin)).send({ driverId: driverB.driverId, reason: "race with pickup" }),
      ]);
      // Exactly one must succeed. The loser can observe the race either via
      // the losing conditional updateMany (409) or, if its own pre-
      // transaction status read happens strictly after the winner's commit,
      // via its own status-validity check (400 — reassignOrder's
      // REASSIGNABLE_SOURCE_STATUSES does not include PICKED_UP). Both are
      // correct outcomes of the same guard — see Phase 7.2's identical
      // treatment of the analogous double-pickup race.
      const pickupVsReassignStatuses = [pickup.status, reassign.status].sort();
      assert.equal(pickupVsReassignStatuses[0], 200, JSON.stringify({ pickup: pickup.body, reassign: reassign.body }));
      assert.ok([400, 409].includes(pickupVsReassignStatuses[1]), JSON.stringify({ pickup: pickup.body, reassign: reassign.body }));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      if (pickup.status === 200) {
        assert.equal(row.status, "PICKED_UP");
        assert.equal(row.current_driver_id, driverA.driverId, "Driver A must remain current");
        const detailB = await request(app).get(driverDetailPath(orderId)).set(auth(driverB.token));
        assert.equal(detailB.status, 404, "Driver B must never gain access after a lost reassign race");
      } else {
        assert.equal(row.status, "ASSIGNED");
        assert.equal(row.current_driver_id, driverB.driverId);
        const detailA = await request(app).get(driverDetailPath(orderId)).set(auth(driverA.token));
        assert.equal(detailA.status, 404, "Driver A must no longer have access after losing the race");
        const failedPickup = await request(app).post(pickupPath(orderId)).set(auth(driverA.token)).send();
        assert.equal(failedPickup.status, 404);
      }

      const assignments = await prisma.order_assignments.findMany({ where: { order_id: orderId } });
      const current = assignments.filter((a) => a.is_current);
      assert.equal(current.length, 1, "exactly one current assignment, no mixed state");
    });
  });

  // ============================================================
  // VISIBILITY (40-43)
  // ============================================================

  describe("Visibility", () => {
    test("40-43. driver list/detail and management detail/history all reflect PICKED_UP immediately", async () => {
      const driver = await createDriverWithToken("driver-visibility");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const pickup = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(pickup.status, 200);

      const driverList = await request(app).get(driverListPath()).set(auth(driver.token));
      assert.equal(driverList.status, 200);
      const listItem = driverList.body.data.find((o: { id: string }) => o.id === orderId);
      assert.ok(listItem, "driver list must still include the order after pickup");
      assert.equal(listItem.status, "PICKED_UP");

      const driverDetail = await request(app).get(driverDetailPath(orderId)).set(auth(driver.token));
      assert.equal(driverDetail.status, 200);
      assert.equal(driverDetail.body.data.status, "PICKED_UP");
      assert.ok(driverDetail.body.data.timestamps.pickedUpAt);

      const mgmtDetail = await request(app).get(mgmtDetailPath(orderId)).set(auth(tokens.admin));
      assert.equal(mgmtDetail.status, 200);
      assert.equal(mgmtDetail.body.data.status, "PICKED_UP");
      assert.ok(mgmtDetail.body.data.pickedUpAt);

      const mgmtHistory = await request(app).get(mgmtHistoryPath(orderId)).set(auth(tokens.admin));
      assert.equal(mgmtHistory.status, 200);
      const toStatuses = mgmtHistory.body.data.statusHistory.map((h: { toStatus: string }) => h.toStatus);
      assert.deepEqual(toStatuses, ["RECEIVED", "ASSIGNED", "PICKED_UP"]);
    });
  });

  // ============================================================
  // SIDE EFFECTS (44-46)
  // ============================================================

  describe("Side effects", () => {
    test("44-46. zero delivery_attempts/finance rows, financial fields unchanged", async () => {
      const driver = await createDriverWithToken("driver-side-effects");
      const orderId = await createOrderAssignedTo(driver.driverId);
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
      assert.equal(res.status, 200);

      await assertNoSideEffects([orderId]);

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.actual_amount_collected, before.actual_amount_collected);
      assert.equal(after.needs_financial_review, before.needs_financial_review);
      assert.equal(after.financial_status, before.financial_status);
      assert.equal(after.amount_to_collect.toString(), before.amount_to_collect.toString());
    });
  });

  // ============================================================
  // DTO SECURITY (47-48)
  // ============================================================

  describe("DTO security", () => {
    test("47-48. pickup response is DriverOrderDetail with no sensitive leakage", async () => {
      const driver = await createDriverWithToken("driver-dto");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const res = await request(app).post(pickupPath(orderId)).set(auth(driver.token)).send();
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
  // REGRESSION (49-52)
  // ============================================================

  describe("Regression", () => {
    test("49-52. Phase 7.1 list/detail, reassignment visibility, cancellation visibility all still correct", async () => {
      const driverA = await createDriverWithToken("driverA-regression");
      const driverB = await createDriverWithToken("driverB-regression");

      const listOrder = await createOrderAssignedTo(driverA.driverId);
      const list = await request(app).get(driverListPath()).set(auth(driverA.token));
      assert.equal(list.status, 200);
      assert.ok(list.body.data.some((o: { id: string }) => o.id === listOrder));

      const detail = await request(app).get(driverDetailPath(listOrder)).set(auth(driverA.token));
      assert.equal(detail.status, 200);

      const reassignOrder = await createOrderAssignedTo(driverA.driverId);
      const reassign = await request(app)
        .post(`/api/v1/orders/${reassignOrder}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "regression check" });
      assert.equal(reassign.status, 200);
      const afterReassignA = await request(app).get(driverDetailPath(reassignOrder)).set(auth(driverA.token));
      assert.equal(afterReassignA.status, 404);
      const afterReassignB = await request(app).get(driverDetailPath(reassignOrder)).set(auth(driverB.token));
      assert.equal(afterReassignB.status, 200);

      const cancelOrder = await createOrderAssignedTo(driverA.driverId);
      const cancel = await request(app).post(`/api/v1/orders/${cancelOrder}/cancel`).set(auth(tokens.admin)).send({ reason: "regression check" });
      assert.equal(cancel.status, 200);
      const afterCancel = await request(app).get(driverDetailPath(cancelOrder)).set(auth(driverA.token));
      assert.equal(afterCancel.status, 404);
    });
  });
});
