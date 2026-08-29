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
  type TestUser,
} from "../helpers/fixtures";

describe("Driver Portal — Order Access (Phase 7.1)", () => {
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

  // Creates a DRIVER-role user, links a drivers row, and logs in — returns
  // both the driver id (for assignment) and a ready-to-use bearer token.
  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH71-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
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
        receiverName: "Phase71 Receiver",
        receiverPhone: "+96170000009",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase71 St",
        description: "Phase71 driver-portal order",
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

  function listPath() {
    return "/api/v1/driver/me/orders";
  }
  function detailPath(id: string) {
    return `/api/v1/driver/me/orders/${id}`;
  }

  // ============================================================
  // AUTHORIZATION (1-7)
  // ============================================================

  describe("Authorization", () => {
    test("1-2. unauthenticated list/detail -> 401", async () => {
      const list = await request(app).get(listPath());
      assert.equal(list.status, 401);
      const detail = await request(app).get(detailPath("00000000-0000-0000-0000-000000000000"));
      assert.equal(detail.status, 401);
    });

    test("3. DRIVER with driver.orders.read_own + linked profile -> allowed", async () => {
      const driver = await createDriverWithToken("driver3");
      const list = await request(app).get(listPath()).set(auth(driver.token));
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const orderId = await createOrderAssignedTo(driver.driverId);
      const detail = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(detail.status, 200, JSON.stringify(detail.body));
    });

    test("4. CUSTOMER -> 403", async () => {
      const list = await request(app).get(listPath()).set(auth(tokens.customer));
      assert.equal(list.status, 403);
      assert.equal(list.body.error.code, "FORBIDDEN");
    });

    test("5. DISPATCHER -> 403 (real permission set lacks driver.orders.read_own)", async () => {
      const list = await request(app).get(listPath()).set(auth(tokens.dispatcher));
      assert.equal(list.status, 403);
      assert.equal(list.body.error.code, "FORBIDDEN");
    });

    test("6. FINANCE -> 403", async () => {
      const list = await request(app).get(listPath()).set(auth(tokens.finance));
      assert.equal(list.status, 403);
      assert.equal(list.body.error.code, "FORBIDDEN");
    });

    test("7. permission-holder without a linked Driver profile -> safe 403 (ADMIN holds the permission but has no drivers row)", async () => {
      const list = await request(app).get(listPath()).set(auth(tokens.admin));
      assert.equal(list.status, 403);
      assert.equal(list.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(list.body), /prisma|relation|foreign key/i);

      const detail = await request(app).get(detailPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.admin));
      assert.equal(detail.status, 403);
    });
  });

  // ============================================================
  // OWNERSHIP (8-12)
  // ============================================================

  describe("Ownership", () => {
    test("8-9. Driver A sees Order assigned to A, not Order assigned to B", async () => {
      const driverA = await createDriverWithToken("driverA-8");
      const driverB = await createDriverWithToken("driverB-8");
      const orderA = await createOrderAssignedTo(driverA.driverId);
      const orderB = await createOrderAssignedTo(driverB.driverId);

      const listA = await request(app).get(listPath()).set(auth(driverA.token));
      assert.equal(listA.status, 200);
      const idsA = listA.body.data.map((o: { id: string }) => o.id);
      assert.ok(idsA.includes(orderA));
      assert.ok(!idsA.includes(orderB), "Driver A's list must never contain Driver B's order");
    });

    test("10. Driver A detail for B's Order -> 404", async () => {
      const driverA = await createDriverWithToken("driverA-10");
      const driverB = await createDriverWithToken("driverB-10");
      const orderB = await createOrderAssignedTo(driverB.driverId);

      const res = await request(app).get(detailPath(orderB)).set(auth(driverA.token));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("11. Driver A detail for a nonexistent Order -> the identical safe 404 contract", async () => {
      const driverA = await createDriverWithToken("driverA-11");
      const driverB = await createDriverWithToken("driverB-11");
      const orderB = await createOrderAssignedTo(driverB.driverId);

      const forOther = await request(app).get(detailPath(orderB)).set(auth(driverA.token));
      const forMissing = await request(app)
        .get(detailPath("00000000-0000-0000-0000-000000000000"))
        .set(auth(driverA.token));

      assert.equal(forOther.status, forMissing.status);
      assert.equal(forOther.body.error.code, forMissing.body.error.code);
      assert.equal(forOther.status, 404);
    });

    test("12. no driverId query/body/param input can widen scope", async () => {
      const driverA = await createDriverWithToken("driverA-12");
      const driverB = await createDriverWithToken("driverB-12");
      const orderB = await createOrderAssignedTo(driverB.driverId);

      const listSpoof = await request(app)
        .get(`${listPath()}?driverId=${driverB.driverId}`)
        .set(auth(driverA.token));
      assert.equal(listSpoof.status, 200);
      assert.ok(!listSpoof.body.data.some((o: { id: string }) => o.id === orderB));

      const detailSpoof = await request(app)
        .get(detailPath(orderB))
        .set(auth(driverA.token))
        .send({ driverId: driverA.driverId, currentDriverId: driverA.driverId });
      assert.equal(detailSpoof.status, 404);
    });
  });

  // ============================================================
  // REASSIGNMENT VISIBILITY (13-19)
  // ============================================================

  describe("Reassignment visibility", () => {
    test("13-19. reassignment immediately moves list/detail visibility from A to B, same tokens reused", async () => {
      const driverA = await createDriverWithToken("driverA-reassign");
      const driverB = await createDriverWithToken("driverB-reassign");
      const orderId = await createOrderAssignedTo(driverA.driverId);

      const aListBefore = await request(app).get(listPath()).set(auth(driverA.token));
      assert.ok(aListBefore.body.data.some((o: { id: string }) => o.id === orderId));
      const aDetailBefore = await request(app).get(detailPath(orderId)).set(auth(driverA.token));
      assert.equal(aDetailBefore.status, 200);

      const reassign = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "phase 7.1 reassignment visibility check" });
      assert.equal(reassign.status, 200, JSON.stringify(reassign.body));

      const aListAfter = await request(app).get(listPath()).set(auth(driverA.token));
      assert.ok(!aListAfter.body.data.some((o: { id: string }) => o.id === orderId), "A must no longer see the order");
      const aDetailAfter = await request(app).get(detailPath(orderId)).set(auth(driverA.token));
      assert.equal(aDetailAfter.status, 404);

      const bListAfter = await request(app).get(listPath()).set(auth(driverB.token));
      assert.ok(bListAfter.body.data.some((o: { id: string }) => o.id === orderId), "B must now see the order");
      const bDetailAfter = await request(app).get(detailPath(orderId)).set(auth(driverB.token));
      assert.equal(bDetailAfter.status, 200);
    });
  });

  // ============================================================
  // CANCEL VISIBILITY (20-23)
  // ============================================================

  describe("Cancel visibility", () => {
    test("20-23. cancellation immediately removes list/detail visibility (current_driver_id cleared)", async () => {
      const driver = await createDriverWithToken("driver-cancel");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const before = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(before.status, 200);

      const cancel = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "visibility check" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

      const list = await request(app).get(listPath()).set(auth(driver.token));
      assert.ok(!list.body.data.some((o: { id: string }) => o.id === orderId));
      const detail = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(detail.status, 404);
    });
  });

  // ============================================================
  // RESCHEDULED VISIBILITY (24-27)
  // ============================================================

  describe("RESCHEDULED visibility", () => {
    test("24-27. FAILED_DELIVERY (seeded fixture) -> reschedule: RESCHEDULED order stays visible to the same driver", async () => {
      const driver = await createDriverWithToken("driver-reschedule");
      const orderId = await createOrderAssignedTo(driver.driverId);
      // Phase 7 failure action doesn't exist yet — force the fixture state
      // directly, exactly as Phase 6.6/6.7's own test suites do.
      await prisma.orders.update({ where: { id: orderId }, data: { status: "FAILED_DELIVERY" } });

      const failedDetail = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(failedDetail.status, 200);
      assert.equal(failedDetail.body.data.status, "FAILED_DELIVERY");

      const reschedule = await request(app)
        .post(`/api/v1/orders/${orderId}/reschedule`)
        .set(auth(tokens.admin))
        .send({ reason: "phase 7.1 rescheduled visibility check" });
      assert.equal(reschedule.status, 200, JSON.stringify(reschedule.body));

      const list = await request(app).get(listPath()).set(auth(driver.token));
      assert.ok(list.body.data.some((o: { id: string }) => o.id === orderId), "RESCHEDULED order must remain visible to the same driver");

      const detail = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "RESCHEDULED");
    });
  });

  // ============================================================
  // FAILED DELIVERY VISIBILITY (28)
  // ============================================================

  describe("FAILED_DELIVERY visibility", () => {
    test("28. FAILED_DELIVERY with a current driver remains visible for read access", async () => {
      const driver = await createDriverWithToken("driver-failed-visible");
      const orderId = await createOrderAssignedTo(driver.driverId);
      await prisma.orders.update({ where: { id: orderId }, data: { status: "FAILED_DELIVERY" } });

      const list = await request(app).get(listPath()).set(auth(driver.token));
      assert.ok(list.body.data.some((o: { id: string }) => o.id === orderId));
      const detail = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "FAILED_DELIVERY");
    });
  });

  // ============================================================
  // LIST (29-39)
  // ============================================================

  describe("List", () => {
    test("29-32. pagination default/page/limit/max, invalid pagination -> 400", async () => {
      const driver = await createDriverWithToken("driver-pagination");
      for (let i = 0; i < 3; i++) {
        await createOrderAssignedTo(driver.driverId);
      }

      const defaultRes = await request(app).get(listPath()).set(auth(driver.token));
      assert.equal(defaultRes.status, 200);
      assert.equal(defaultRes.body.meta.page, 1);
      assert.equal(defaultRes.body.meta.limit, 20);

      const paged = await request(app).get(`${listPath()}?page=1&limit=2`).set(auth(driver.token));
      assert.equal(paged.status, 200);
      assert.equal(paged.body.data.length, 2);
      assert.equal(paged.body.meta.limit, 2);

      const maxed = await request(app).get(`${listPath()}?limit=100`).set(auth(driver.token));
      assert.equal(maxed.status, 200);

      const overMax = await request(app).get(`${listPath()}?limit=101`).set(auth(driver.token));
      assert.equal(overMax.status, 400);

      const badPage = await request(app).get(`${listPath()}?page=0`).set(auth(driver.token));
      assert.equal(badPage.status, 400);
    });

    test("33-36. search by orderNumber/trackingCode/receiverName/receiverPhone", async () => {
      const driver = await createDriverWithToken("driver-search");
      const order = await createOrderAssignedTo(driver.driverId, {
        receiverName: "Phase71 Searchable Receiver",
        receiverPhone: "+96170001234",
      });
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: order } });

      for (const term of [orderRow.order_number, orderRow.tracking_code, "Searchable Receiver", "70001234"]) {
        const res = await request(app).get(`${listPath()}?search=${encodeURIComponent(term)}`).set(auth(driver.token));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.some((o: { id: string }) => o.id === order), `expected search "${term}" to find the order`);
      }
    });

    test("37-39. status filter composes with ownership; another driver's order never leaks in", async () => {
      const driverA = await createDriverWithToken("driverA-status");
      const driverB = await createDriverWithToken("driverB-status");
      const assignedOrder = await createOrderAssignedTo(driverA.driverId);
      const otherOrder = await createOrderAssignedTo(driverB.driverId);
      await prisma.orders.update({ where: { id: otherOrder }, data: { status: "ASSIGNED" } });

      const filtered = await request(app).get(`${listPath()}?status=ASSIGNED`).set(auth(driverA.token));
      assert.equal(filtered.status, 200);
      assert.ok(filtered.body.data.some((o: { id: string }) => o.id === assignedOrder));
      assert.ok(!filtered.body.data.some((o: { id: string }) => o.id === otherOrder), "no order from another driver may ever leak in");

      const wrongStatus = await request(app).get(`${listPath()}?status=RESCHEDULED`).set(auth(driverA.token));
      assert.equal(wrongStatus.status, 200);
      assert.ok(!wrongStatus.body.data.some((o: { id: string }) => o.id === assignedOrder));
    });
  });

  // ============================================================
  // DTO SECURITY (40-44)
  // ============================================================

  describe("DTO security", () => {
    test("40-44. exact safe field set, amountToCollect is a string, payment-method summary safe, no sensitive leaks", async () => {
      const driver = await createDriverWithToken("driver-dto");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const list = await request(app).get(listPath()).set(auth(driver.token));
      assert.equal(list.status, 200);
      const listItem = list.body.data.find((o: { id: string }) => o.id === orderId);
      assert.ok(listItem);
      assert.deepEqual(
        Object.keys(listItem).sort(),
        ["collection", "id", "orderNumber", "orderType", "package", "receiver", "status", "timestamps", "trackingCode"].sort()
      );
      assert.deepEqual(
        Object.keys(listItem.receiver).sort(),
        ["address", "altPhone", "area", "buildingFloor", "instructions", "mapLink", "name", "phone"].sort()
      );
      assert.deepEqual(
        Object.keys(listItem.package).sort(),
        ["description", "notes", "packageCount", "quantity", "weightKg"].sort()
      );
      assert.deepEqual(
        Object.keys(listItem.collection).sort(),
        ["amountToCollect", "actualAmountCollected", "paymentMethod"].sort()
      );
      assert.deepEqual(
        Object.keys(listItem.timestamps).sort(),
        ["assignedAt", "deliveredAt", "outForDeliveryAt", "pickedUpAt"].sort()
      );

      assert.equal(typeof listItem.collection.amountToCollect, "string");
      assert.equal(listItem.collection.amountToCollect, "105");
      assert.ok(listItem.collection.paymentMethod);
      assert.deepEqual(Object.keys(listItem.collection.paymentMethod).sort(), ["code", "id", "name"].sort());
      assert.equal(listItem.collection.paymentMethod.code, "CASH");

      const detail = await request(app).get(detailPath(orderId)).set(auth(driver.token));
      assert.equal(detail.status, 200);
      assert.deepEqual(Object.keys(detail.body.data).sort(), Object.keys(listItem).sort());

      const serialized = JSON.stringify(list.body) + JSON.stringify(detail.body);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /wallet/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /company_financial/i);
      assert.doesNotMatch(serialized, /payout/i);
      assert.doesNotMatch(serialized, /assignmentHistory/i);
      assert.doesNotMatch(serialized, /statusHistory/i);
      assert.doesNotMatch(serialized, /"prepared"|PrismaClientKnownRequestError/i);
    });
  });

  // ============================================================
  // READ-ONLY GUARANTEE (45-46)
  // ============================================================

  describe("Read-only guarantee", () => {
    test("45-46. list and detail cause zero DB mutations", async () => {
      const driver = await createDriverWithToken("driver-readonly");
      const orderId = await createOrderAssignedTo(driver.driverId);

      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const [historyBefore, assignmentsBefore, attemptsBefore, walletBefore, cashBefore, companyBefore] = await Promise.all([
        prisma.order_status_history.count({ where: { order_id: orderId } }),
        prisma.order_assignments.count({ where: { order_id: orderId } }),
        prisma.delivery_attempts.count({ where: { order_id: orderId } }),
        prisma.wallet_transactions.count({ where: { order_id: orderId } }),
        prisma.driver_cash_transactions.count({ where: { order_id: orderId } }),
        prisma.company_financial_transactions.count({ where: { order_id: orderId } }),
      ]);

      await request(app).get(listPath()).set(auth(driver.token));
      await request(app).get(listPath()).set(auth(driver.token));
      await request(app).get(detailPath(orderId)).set(auth(driver.token));
      await request(app).get(detailPath(orderId)).set(auth(driver.token));

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "read access must never touch updated_at");
      assert.equal(after.status, before.status);

      const [historyAfter, assignmentsAfter, attemptsAfter, walletAfter, cashAfter, companyAfter] = await Promise.all([
        prisma.order_status_history.count({ where: { order_id: orderId } }),
        prisma.order_assignments.count({ where: { order_id: orderId } }),
        prisma.delivery_attempts.count({ where: { order_id: orderId } }),
        prisma.wallet_transactions.count({ where: { order_id: orderId } }),
        prisma.driver_cash_transactions.count({ where: { order_id: orderId } }),
        prisma.company_financial_transactions.count({ where: { order_id: orderId } }),
      ]);
      assert.equal(historyAfter, historyBefore);
      assert.equal(assignmentsAfter, assignmentsBefore);
      assert.equal(attemptsAfter, attemptsBefore);
      assert.equal(walletAfter, walletBefore);
      assert.equal(cashAfter, cashBefore);
      assert.equal(companyAfter, companyBefore);
    });
  });

  // ============================================================
  // HISTORICAL ASSIGNMENT DOES NOT GRANT ACCESS (47-50)
  // ============================================================

  describe("Historical assignment does not grant access", () => {
    test("47-50. A's old order_assignments row survives a reassignment to B, but A still cannot list/detail the order", async () => {
      const driverA = await createDriverWithToken("driverA-historical");
      const driverB = await createDriverWithToken("driverB-historical");
      const orderId = await createOrderAssignedTo(driverA.driverId);

      const reassign = await request(app)
        .post(`/api/v1/orders/${orderId}/reassign`)
        .set(auth(tokens.admin))
        .send({ driverId: driverB.driverId, reason: "historical-assignment regression check" });
      assert.equal(reassign.status, 200);

      const historicalRow = await prisma.order_assignments.findFirst({ where: { order_id: orderId, driver_id: driverA.driverId } });
      assert.ok(historicalRow, "A's historical assignment row must still exist");
      assert.equal(historicalRow?.is_current, false);

      const list = await request(app).get(listPath()).set(auth(driverA.token));
      assert.ok(!list.body.data.some((o: { id: string }) => o.id === orderId), "a historical (non-current) assignment must grant no access");
      const detail = await request(app).get(detailPath(orderId)).set(auth(driverA.token));
      assert.equal(detail.status, 404);
    });
  });

  // ============================================================
  // REGRESSION (51-54) — Management Order APIs unaffected by this module
  // ============================================================

  describe("Regression smoke", () => {
    test("51-54. Management create/assign/cancel/history all still work alongside the new Driver Portal routes", async () => {
      const driver = await createDriverWithToken("driver-regression");
      const order = await createBaseOrder();
      const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(assign.status, 200);
      const cancel = await request(app).post(`/api/v1/orders/${order.id}/cancel`).set(auth(tokens.admin)).send({ reason: "regression smoke" });
      assert.equal(cancel.status, 200);
      const history = await request(app).get(`/api/v1/orders/${order.id}/history`).set(auth(tokens.admin));
      assert.equal(history.status, 200);
      assert.ok(history.body.data.statusHistory.length >= 2);
    });
  });
});
