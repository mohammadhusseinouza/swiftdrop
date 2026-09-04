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
// GET /api/v1/orders/:id/timeline (Phase 11.17.6, task §41-§49, §83-§84).
// ============================================================

interface TimelineEvent {
  id: string;
  type: string;
  occurredAt: string;
  driver: { id: string } | null;
  toDriver: { id: string } | null;
  endReason: string | null;
}

describe("Unified Order timeline (Phase 11.17.6)", () => {
  let app: Express;
  let admin: TestUser;
  let driverXUser: TestUser;
  let driverYUser: TestUser;
  let deliveryDriverUser: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;
  let driverX: string;
  let driverY: string;
  let deliveryDriver: string;

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
    deliveryDriverUser = await createTestUser("DRIVER");
    createdUserIds.push(driverXUser.id, driverYUser.id, deliveryDriverUser.id);

    const [adminLogin, xLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, driverXUser.email, driverXUser.password),
    ]);
    tokens = { admin: adminLogin.accessToken as string, driverX: xLogin.accessToken as string };
    assert.ok(tokens.admin);
    assert.ok(tokens.driverX);

    driverX = await seedDriverRecord(driverXUser.id);
    driverY = await seedDriverRecord(driverYUser.id);
    deliveryDriver = await seedDriverRecord(deliveryDriverUser.id);
    createdDriverIds.push(driverX, driverY, deliveryDriver);

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

  async function getTimeline(orderId: string): Promise<TimelineEvent[]> {
    const res = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as TimelineEvent[];
  }

  test("representative flow: assign -> reassign -> failed -> rescheduled -> re-assign -> collected -> received -> delivery assigned -> picked up -> out for delivery -> delivered", async () => {
    const orderId = await seedCollectionOrder();

    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId: driverY });
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    const yLogin = await loginTestUser(app, driverYUser.email, driverYUser.password);
    await request(app)
      .post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`)
      .set(auth(yLogin.accessToken as string))
      .send({ failedCollectionReasonId: reason.id });
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.admin)).send({});
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    await request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(tokens.driverX)).send({});
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({});

    const assignDelivery = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: deliveryDriver });
    assert.equal(assignDelivery.status, 200, JSON.stringify(assignDelivery.body));

    const deliveryLogin = await loginTestUser(app, deliveryDriverUser.email, deliveryDriverUser.password);
    const pickup = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/pickup`)
      .set(auth(deliveryLogin.accessToken as string));
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/start-delivery`)
      .set(auth(deliveryLogin.accessToken as string));
    assert.equal(start.status, 200, JSON.stringify(start.body));
    const deliver = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/deliver`)
      .set(auth(deliveryLogin.accessToken as string))
      .send({ actualAmountCollected: "105.00" });
    assert.equal(deliver.status, 200, JSON.stringify(deliver.body));

    const events = await getTimeline(orderId);
    const types = events.map((e) => e.type);

    // FAILED appears exactly once (task §44).
    assert.equal(types.filter((t) => t === "PARCEL_COLLECTION_FAILED").length, 1);
    // RECEIVED_AT_COMPANY appears exactly once (task §44) — never a
    // duplicate "assignment ended" line for the same fact.
    assert.equal(types.filter((t) => t === "PARCEL_RECEIVED_AT_COMPANY").length, 1);
    // Reassignment appears as ONE combined event, not two disconnected lines.
    assert.equal(types.filter((t) => t === "PARCEL_COLLECTION_DRIVER_REASSIGNED").length, 1);
    const reassignEvent = events.find((e) => e.type === "PARCEL_COLLECTION_DRIVER_REASSIGNED")!;
    assert.equal(reassignEvent.driver?.id, driverX);
    assert.equal(reassignEvent.toDriver?.id, driverY);
    // Reschedule appears.
    assert.equal(types.filter((t) => t === "PARCEL_COLLECTION_RESCHEDULED").length, 1);
    // Collected event appears.
    assert.equal(types.filter((t) => t === "PARCEL_COLLECTED_FROM_SENDER").length, 1);
    // Delivery-side events are present too (unified timeline).
    assert.ok(types.includes("DELIVERY_DRIVER_ASSIGNED"));
    assert.ok(types.includes("DELIVERY_ATTEMPT"));
    assert.ok(types.includes("FINANCIAL_EVENT"));
    // No raw duplicate "assignment ended: FAILED"/"assignment ended:
    // RECEIVED_AT_COMPANY" noise line for the collection domain.
    assert.equal(events.filter((e) => e.endReason === "FAILED").length, 0);
    assert.equal(events.filter((e) => e.endReason === "RECEIVED_AT_COMPANY").length, 0);

    // Chronological order (ascending occurredAt).
    for (let i = 1; i < events.length; i++) {
      assert.ok(new Date(events[i].occurredAt).getTime() >= new Date(events[i - 1].occurredAt).getTime());
    }
  });

  test("cancel while Parcel Collection ASSIGNED: assignment event + Order Cancelled + no current-driver leftover", async () => {
    const orderId = await seedCollectionOrder();
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });
    const cancel = await request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "Phase 11.17.6 timeline cancel test" });
    assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

    const events = await getTimeline(orderId);
    const types = events.map((e) => e.type);
    assert.ok(types.includes("PARCEL_COLLECTION_DRIVER_ASSIGNED"));
    assert.ok(types.includes("STATUS_CHANGED"));
    assert.ok(types.includes("PARCEL_COLLECTION_ENDED_ORDER_CANCELLED"));

    // The Order Detail / parcel-collection view must not show the driver as
    // still current after cancellation.
    const parcel = await request(app).get(`/api/v1/orders/${orderId}/parcel-collection`).set(auth(tokens.admin));
    assert.equal(parcel.body.data.currentCollectionDriver, null);
  });

  test("deterministic ordering across repeated requests", async () => {
    const orderId = await seedCollectionOrder();
    await request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId: driverX });

    const first = await getTimeline(orderId);
    const second = await getTimeline(orderId);
    assert.deepEqual(first, second);
  });

  test("orders.read is required; unauthenticated -> 401", async () => {
    const orderId = await seedCollectionOrder();
    const unauth = await request(app).get(`/api/v1/orders/${orderId}/timeline`);
    assert.equal(unauth.status, 401);
    const ok = await request(app).get(`/api/v1/orders/${orderId}/timeline`).set(auth(tokens.admin));
    assert.equal(ok.status, 200);
  });
});
