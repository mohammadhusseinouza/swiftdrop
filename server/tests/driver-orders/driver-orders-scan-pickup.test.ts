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

// POST /api/v1/driver/orders/scan-pickup — barcode entry point to the
// existing pickup transition. The printed label's Code128 barcode encodes the
// order's tracking code verbatim, so `barcode` here is a tracking code.
describe("Driver Portal — Scan Barcode Pickup", () => {
  let app: Express;
  let admin: TestUser;
  let adminToken: string;
  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  const SCAN_PATH = "/api/v1/driver/orders/scan-pickup";

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    const login = await loginTestUser(app, admin.email, admin.password);
    adminToken = login.accessToken as string;
    assert.ok(adminToken);

    customerId = await seedCustomerRecord(admin.id);
    area = await createTestArea();
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  async function createDriverWithToken() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(adminToken))
      .send({ driverNumber: `SCAN-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  // Real Create Order + real Assign — the same path production orders take.
  async function createOrderAssignedTo(driverId: string) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(adminToken))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Scan Receiver",
        receiverPhone: "+96170000099",
        receiverAreaId: area.id,
        receiverAddress: "1 Scan St",
        description: "Scan pickup order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    const assign = await request(app)
      .post(`/api/v1/orders/${res.body.data.id}/assign`)
      .set(auth(adminToken))
      .send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    return {
      id: res.body.data.id as string,
      trackingCode: res.body.data.trackingCode as string,
      orderNumber: res.body.data.orderNumber as string,
    };
  }

  async function seedHeldOrder(driverId: string, status: string) {
    const id = await seedTestOrder(customerId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      status: status as never,
      currentDriverId: driverId,
    });
    createdOrderIds.push(id);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id }, select: { tracking_code: true } });
    return { id, trackingCode: row.tracking_code };
  }

  function scan(token: string, barcode: unknown) {
    return request(app).post(SCAN_PATH).set(auth(token)).send({ barcode });
  }

  async function pickupHistoryCount(orderId: string) {
    return prisma.order_status_history.count({
      where: { order_id: orderId, from_status: "ASSIGNED", to_status: "PICKED_UP" },
    });
  }

  test("valid label for my ASSIGNED order -> PICKED_UP with the normal history row", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);

    const res = await scan(driver.token, order.trackingCode);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.success, true);
    assert.equal(res.body.data.id, order.id);
    assert.equal(res.body.data.status, "PICKED_UP");

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, "PICKED_UP");
    assert.ok(row.picked_up_at);
    assert.equal(row.current_driver_id, driver.driverId);

    const history = await prisma.order_status_history.findMany({
      where: { order_id: order.id, to_status: "PICKED_UP" },
    });
    assert.equal(history.length, 1);
    assert.equal(history[0].from_status, "ASSIGNED");
    assert.equal(history[0].changed_by_id, driver.userId);
  });

  test("surrounding whitespace from a scanner / manual entry is tolerated", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);
    const res = await scan(driver.token, `  ${order.trackingCode}\n`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
  });

  test("another driver's order -> identical 404, no details leaked, order untouched", async () => {
    const owner = await createDriverWithToken();
    const other = await createDriverWithToken();
    const order = await createOrderAssignedTo(owner.driverId);

    const res = await scan(other.token, order.trackingCode);
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, "NOT_FOUND");
    assert.equal(res.body.error.message, "Order not found");
    assert.ok(!JSON.stringify(res.body).includes(order.orderNumber));
    assert.ok(!JSON.stringify(res.body).includes(order.id));

    const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, "ASSIGNED");
    assert.equal(await pickupHistoryCount(order.id), 0);
  });

  test("unknown barcode -> 404 Order not found", async () => {
    const driver = await createDriverWithToken();
    const res = await scan(driver.token, "TRK-DOESNOTEXIST");
    assert.equal(res.status, 404);
    assert.equal(res.body.error.message, "Order not found");
  });

  test("tracking codes are matched exactly (no case folding)", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);
    const res = await scan(driver.token, order.trackingCode.toLowerCase());
    assert.equal(res.status, 404);
  });

  test("malformed barcode values -> 400 VALIDATION_ERROR", async () => {
    const driver = await createDriverWithToken();
    for (const bad of ["", "   ", "TRK 123", "TRK-\u0001", "طرد", "x".repeat(101), 12345, null]) {
      const res = await scan(driver.token, bad);
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(bad)}`);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    }
  });

  test("scanning the same label twice -> second is 409 ALREADY_PICKED_UP, one history row", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);

    assert.equal((await scan(driver.token, order.trackingCode)).status, 200);
    const again = await scan(driver.token, order.trackingCode);
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, "CONFLICT");
    assert.equal(again.body.error.message, "Order already picked up");
    assert.equal(again.body.error.details.reason, "ALREADY_PICKED_UP");
    assert.equal(await pickupHistoryCount(order.id), 1);
  });

  test("concurrent duplicate scans -> exactly one pickup succeeds", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);

    const results = await Promise.all([
      scan(driver.token, order.trackingCode),
      scan(driver.token, order.trackingCode),
      scan(driver.token, order.trackingCode),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      assert.ok(["ALREADY_PICKED_UP", "ORDER_CHANGED"].includes(r.body.error.details.reason));
    }
    assert.equal(await pickupHistoryCount(order.id), 1);
  });

  for (const [status, reason, message] of [
    ["OUT_FOR_DELIVERY", "ALREADY_PICKED_UP", "Order already picked up"],
    ["RESCHEDULED", "ALREADY_PICKED_UP", "Order already picked up"],
    ["DELIVERED", "ALREADY_DELIVERED", "Order already delivered"],
    ["CANCELLED", "ORDER_CANCELLED", "Order is cancelled"],
    ["READY_FOR_PICKUP", "INVALID_STATUS", "Order cannot be picked up while its status is READY_FOR_PICKUP"],
  ] as const) {
    test(`held order in ${status} -> 409 ${reason}, order untouched`, async () => {
      const driver = await createDriverWithToken();
      const order = await seedHeldOrder(driver.driverId, status);
      const res = await scan(driver.token, order.trackingCode);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, reason);
      assert.equal(res.body.error.message, message);
      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.status, status);
      assert.equal(await prisma.order_status_history.count({ where: { order_id: order.id } }), 0);
    });
  }

  test("order cancelled by Management after assignment -> 404 (driver no longer holds it)", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);
    const cancel = await request(app)
      .post(`/api/v1/orders/${order.id}/cancel`)
      .set(auth(adminToken))
      .send({ reason: "Customer cancelled" });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

    const res = await scan(driver.token, order.trackingCode);
    assert.equal(res.status, 404);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, "CANCELLED");
    assert.equal(await pickupHistoryCount(order.id), 0);
  });

  test("order reassigned away -> old driver 404, new driver can scan it", async () => {
    const first = await createDriverWithToken();
    const second = await createDriverWithToken();
    const order = await createOrderAssignedTo(first.driverId);
    const reassign = await request(app)
      .post(`/api/v1/orders/${order.id}/reassign`)
      .set(auth(adminToken))
      .send({ driverId: second.driverId, reason: "Route change" });
    assert.equal(reassign.status, 200, JSON.stringify(reassign.body));

    assert.equal((await scan(first.token, order.trackingCode)).status, 404);
    const res = await scan(second.token, order.trackingCode);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const history = await prisma.order_status_history.findFirstOrThrow({
      where: { order_id: order.id, to_status: "PICKED_UP" },
    });
    assert.equal(history.changed_by_id, second.userId);
  });

  test("reassigned between resolve and pickup -> claim fails closed (404), no pickup", async () => {
    const first = await createDriverWithToken();
    const second = await createDriverWithToken();
    const order = await createOrderAssignedTo(first.driverId);

    // Race the scan against a reassignment; whichever wins, the order must
    // end up with at most one pickup, by its current driver.
    const [scanRes, reassignRes] = await Promise.all([
      scan(first.token, order.trackingCode),
      request(app)
        .post(`/api/v1/orders/${order.id}/reassign`)
        .set(auth(adminToken))
        .send({ driverId: second.driverId, reason: "Race" }),
    ]);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    if (scanRes.status === 200) {
      // Pickup won — reassignment is then rejected by its own rules.
      assert.equal(row.status, "PICKED_UP");
      assert.notEqual(reassignRes.status, 200);
      assert.equal(row.current_driver_id, first.driverId);
    } else {
      assert.ok([404, 409].includes(scanRes.status), JSON.stringify(scanRes.body));
      assert.equal(reassignRes.status, 200, JSON.stringify(reassignRes.body));
      assert.equal(row.status, "ASSIGNED");
      assert.equal(row.current_driver_id, second.driverId);
    }
    assert.ok((await pickupHistoryCount(order.id)) <= 1);
  });

  test("Management users and anonymous callers cannot use the driver scan endpoint", async () => {
    const driver = await createDriverWithToken();
    const order = await createOrderAssignedTo(driver.driverId);
    const asAdmin = await scan(adminToken, order.trackingCode);
    assert.equal(asAdmin.status, 403);
    const anon = await request(app).post(SCAN_PATH).send({ barcode: order.trackingCode });
    assert.equal(anon.status, 401);
    const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
    assert.equal(row.status, "ASSIGNED");
  });

  test("the existing manual pickup endpoint is unchanged (non-ASSIGNED still 400)", async () => {
    const driver = await createDriverWithToken();
    const order = await seedHeldOrder(driver.driverId, "OUT_FOR_DELIVERY");
    const res = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driver.token));
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, "VALIDATION_ERROR");
  });
});
