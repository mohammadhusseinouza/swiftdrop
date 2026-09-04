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
  seedDriverRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// GET /api/v1/drivers/:id/parcel-collection-history (Phase 11.17.6, task
// §27-§29, §81). Base is parcel_collection_assignments — built entirely
// through the REAL assign/reassign/collected/failed/receive-at-company/
// cancel HTTP flows (never a direct-seed shortcut for the assignment rows
// themselves) so the fixture data is a genuine end-to-end exercise of the
// existing Phase 11.17.3/11.17.4 workflow.
// ============================================================

describe("Driver Parcel Collection history (Phase 11.17.6)", () => {
  let app: Express;
  let admin: TestUser;
  let driverXUser: TestUser;
  let driverYUser: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;
  let driverX: string;
  let driverY: string;

  const orderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    driverXUser = await createTestUser("DRIVER");
    driverYUser = await createTestUser("DRIVER");
    createdUserIds.push(driverXUser.id, driverYUser.id);

    const [adminLogin, xLogin, yLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, driverXUser.email, driverXUser.password),
      loginTestUser(app, driverYUser.email, driverYUser.password),
    ]);
    tokens = { admin: adminLogin.accessToken as string, driverX: xLogin.accessToken as string, driverY: yLogin.accessToken as string };
    for (const t of Object.values(tokens)) assert.ok(t);

    driverX = await seedDriverRecord(driverXUser.id);
    driverY = await seedDriverRecord(driverYUser.id);
    createdDriverIds.push(driverX, driverY);

    area = await createTestArea();
    createdAreaIds.push(area.id);
    customerId = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerId);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  async function seedCollectionOrder() {
    const id = await seedTestOrder(customerId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "AWAITING_ASSIGNMENT",
    });
    orderIds.push(id);
    return id;
  }

  let orderReassign: string;
  let orderFailed: string;
  let orderReceived: string;
  let orderCancelled: string;

  before(async () => {
    // orderReassign: X assigned -> reassigned to Y -> reassigned back to X.
    // driverX ends up with TWO assignment rows on the SAME order (§81).
    orderReassign = await seedCollectionOrder();
    await request(app).post(`/api/v1/orders/${orderReassign}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    await request(app).post(`/api/v1/orders/${orderReassign}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverY });
    const backToX = await request(app)
      .post(`/api/v1/orders/${orderReassign}/parcel-collection/reassign`)
      .set(auth(tokens.admin))
      .send({ driverId: driverX });
    assert.equal(backToX.status, 200, JSON.stringify(backToX.body));

    // orderFailed: X assigned -> driver reports Failed Collection.
    orderFailed = await seedCollectionOrder();
    await request(app).post(`/api/v1/orders/${orderFailed}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    const failRes = await request(app)
      .post(`/api/v1/driver/orders/${orderFailed}/parcel-collection/failed`)
      .set(auth(tokens.driverX))
      .send({ failedCollectionReasonId: reason.id });
    assert.equal(failRes.status, 200, JSON.stringify(failRes.body));

    // orderReceived: X assigned -> collected -> received at company.
    orderReceived = await seedCollectionOrder();
    await request(app).post(`/api/v1/orders/${orderReceived}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    const collectedRes = await request(app)
      .post(`/api/v1/driver/orders/${orderReceived}/parcel-collection/collected`)
      .set(auth(tokens.driverX))
      .send({});
    assert.equal(collectedRes.status, 200, JSON.stringify(collectedRes.body));
    const receiveRes = await request(app)
      .post(`/api/v1/orders/${orderReceived}/parcel-collection/receive-at-company`)
      .set(auth(tokens.admin))
      .send({});
    assert.equal(receiveRes.status, 200, JSON.stringify(receiveRes.body));

    // orderCancelled: X assigned -> Order cancelled while ASSIGNED (contract
    // §4.3: closes the assignment with end_reason ORDER_CANCELLED).
    orderCancelled = await seedCollectionOrder();
    await request(app).post(`/api/v1/orders/${orderCancelled}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    const cancelRes = await request(app)
      .post(`/api/v1/orders/${orderCancelled}/cancel`)
      .set(auth(tokens.admin))
      .send({ reason: "Phase 11.17.6 test cancellation" });
    assert.equal(cancelRes.status, 200, JSON.stringify(cancelRes.body));
  });

  test("authorization: drivers.read required, unauthenticated -> 401, a DRIVER-role account -> 403", async () => {
    const res = await request(app).get(`/api/v1/drivers/${driverX}/parcel-collection-history`).set(auth(tokens.driverX));
    // The DRIVER role does not hold the Management drivers.read permission
    // — expect 403, never a silent empty 200.
    assert.equal(res.status, 403);

    const unauth = await request(app).get(`/api/v1/drivers/${driverX}/parcel-collection-history`);
    assert.equal(unauth.status, 401);

    // Sanity: ADMIN (which does hold drivers.read) succeeds.
    const ok = await request(app).get(`/api/v1/drivers/${driverX}/parcel-collection-history`).set(auth(tokens.admin));
    assert.equal(ok.status, 200);
  });

  test("server-paginated, newest-assignment-first, and returns every expected historical row for driver X", async () => {
    const res = await request(app)
      .get(`/api/v1/drivers/${driverX}/parcel-collection-history`)
      .query({ limit: 100 })
      .set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.meta);
    assert.equal(typeof res.body.meta.total, "number");

    type Row = {
      assignmentId: string;
      order: { id: string; orderNumber: string; orderType: string };
      assignedAt: string;
      endedAt: string | null;
      endReason: string | null;
      isCurrent: boolean;
      parcelCollectionStatus: string;
    };
    const rows = res.body.data as Row[];

    const forOrder = (orderId: string) => rows.filter((r) => r.order.id === orderId);

    // Same Order appears TWICE for driver X's two separate assignments.
    assert.equal(forOrder(orderReassign).length, 2);
    const reassignRows = forOrder(orderReassign).sort((a, b) => new Date(a.assignedAt).getTime() - new Date(b.assignedAt).getTime());
    assert.equal(reassignRows[0].endReason, "REASSIGNED");
    assert.equal(reassignRows[0].isCurrent, false);
    assert.equal(reassignRows[1].endReason, null);
    assert.equal(reassignRows[1].isCurrent, true);

    assert.equal(forOrder(orderFailed).length, 1);
    assert.equal(forOrder(orderFailed)[0].endReason, "FAILED");
    assert.equal(forOrder(orderFailed)[0].isCurrent, false);

    assert.equal(forOrder(orderReceived).length, 1);
    assert.equal(forOrder(orderReceived)[0].endReason, "RECEIVED_AT_COMPANY");
    assert.equal(forOrder(orderReceived)[0].isCurrent, false);
    assert.equal(forOrder(orderReceived)[0].parcelCollectionStatus, "RECEIVED_AT_COMPANY");

    assert.equal(forOrder(orderCancelled).length, 1);
    assert.equal(forOrder(orderCancelled)[0].endReason, "ORDER_CANCELLED");
    assert.equal(forOrder(orderCancelled)[0].isCurrent, false);

    // Deterministic ordering (assigned_at DESC, id DESC) — newest first.
    for (let i = 1; i < rows.length; i++) {
      assert.ok(new Date(rows[i - 1].assignedAt).getTime() >= new Date(rows[i].assignedAt).getTime());
    }

    // No finance field anywhere in the row shape.
    for (const row of rows) {
      assert.deepEqual(Object.keys(row).sort(), ["assignedAt", "assignmentId", "endReason", "endedAt", "isCurrent", "order", "parcelCollectionStatus"]);
      assert.deepEqual(Object.keys(row.order).sort(), ["id", "orderNumber", "orderType"]);
    }
  });

  test("driver Y (only ever reassigned-away, never current) shows exactly one historical row, ended REASSIGNED", async () => {
    const res = await request(app)
      .get(`/api/v1/drivers/${driverY}/parcel-collection-history`)
      .query({ limit: 100 })
      .set(auth(tokens.admin));
    assert.equal(res.status, 200);
    const rows = res.body.data as Array<{ order: { id: string }; endReason: string | null; isCurrent: boolean }>;
    const forReassignOrder = rows.filter((r) => r.order.id === orderReassign);
    assert.equal(forReassignOrder.length, 1);
    assert.equal(forReassignOrder[0].endReason, "REASSIGNED");
    assert.equal(forReassignOrder[0].isCurrent, false);
  });

  test("pagination is real (limit=1 returns exactly one row, correct total/meta)", async () => {
    const res = await request(app)
      .get(`/api/v1/drivers/${driverX}/parcel-collection-history`)
      .query({ page: 1, limit: 1 })
      .set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.data.length, 1);
    assert.ok(res.body.meta.total >= 4);
    assert.equal(res.body.meta.limit, 1);
  });

  test("existing Delivery Driver Detail metrics are completely untouched by this new endpoint", async () => {
    const detail = await request(app).get(`/api/v1/drivers/${driverX}`).set(auth(tokens.admin));
    assert.equal(detail.status, 200);
    assert.deepEqual(Object.keys(detail.body.data.operationalSummary).sort(), ["activeOrders", "completedToday", "outForDelivery"]);
  });
});
