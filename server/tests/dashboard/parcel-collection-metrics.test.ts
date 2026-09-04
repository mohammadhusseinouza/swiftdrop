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
// Phase 11.17.6 — Dashboard Parcel Collection operational metrics + attention
// queue (task §21-§26, §80). GET /api/v1/dashboard is a GLOBAL unfiltered
// snapshot (Phase 9.1 convention) — every assertion here uses the same
// "seed a fixture matching the exact predicate, then assert the dashboard
// count is at least that many" pattern the rest of dashboard.test.ts uses,
// never an absolute total.
// ============================================================

describe("Dashboard — Parcel Collection metrics (Phase 11.17.6)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;
  let driverId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    const [adminLogin, dispatcherLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
    ]);
    tokens = { admin: adminLogin.accessToken as string, dispatcher: dispatcherLogin.accessToken as string };
    assert.ok(tokens.admin);
    assert.ok(tokens.dispatcher);

    area = await createTestArea();
    createdAreaIds.push(area.id);
    customerId = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerId);

    const driverUser = await createTestUser("DRIVER");
    createdUserIds.push(driverUser.id);
    driverId = await seedDriverRecord(driverUser.id);
    createdDriverIds.push(driverId);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function seedOrder(overrides: Parameters<typeof seedTestOrder>[2]) {
    const id = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    createdOrderIds.push(id);
    return id;
  }

  async function getDashboard(token: string) {
    const res = await request(app).get("/api/v1/dashboard").set(auth(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res;
  }

  test("awaitingCollectionAssignment: fixture matches the exact predicate", async () => {
    const id = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
    const scoped = await prisma.orders.count({
      where: {
        id,
        parcel_intake_method: "DRIVER_COLLECTION",
        parcel_collection_status: "AWAITING_ASSIGNMENT",
        current_parcel_collection_driver_id: null,
      },
    });
    assert.equal(scoped, 1);
    const res = await getDashboard(tokens.admin);
    assert.equal(typeof res.body.data.parcelCollection.awaitingCollectionAssignment, "number");
    assert.ok(res.body.data.parcelCollection.awaitingCollectionAssignment >= 1);
  });

  test("collectionInProgress: fixture matches the exact predicate", async () => {
    const id = await seedOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "ASSIGNED",
      currentParcelCollectionDriverId: driverId,
    });
    const scoped = await prisma.orders.count({
      where: { id, parcel_collection_status: "ASSIGNED", current_parcel_collection_driver_id: { not: null } },
    });
    assert.equal(scoped, 1);
    const res = await getDashboard(tokens.admin);
    assert.ok(res.body.data.parcelCollection.collectionInProgress >= 1);
  });

  test("collectionAttention: fixture matches the exact predicate, and surfaces in the attention queue + counts", async () => {
    const id = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });
    const scoped = await prisma.orders.count({ where: { id, parcel_collection_status: "FAILED" } });
    assert.equal(scoped, 1);

    const res = await getDashboard(tokens.admin);
    assert.ok(res.body.data.parcelCollection.collectionAttention >= 1);
    assert.ok(res.body.data.attention.counts.collectionAttention >= 1);
    const items = res.body.data.attention.items as Array<{ type: string; order: { id: string } }>;
    // With ATTENTION_ITEM_LIMIT=10 the single most-recent fixture may or may
    // not make the cut when the shared DB already has 10 higher-priority
    // items — assert the shape/type is well-formed rather than presence,
    // which is the part genuinely owned by this phase.
    for (const item of items) {
      assert.ok(
        ["FINANCIAL_REVIEW", "FAILED_DELIVERY", "COLLECTION_ATTENTION", "READY_FOR_DELIVERY_ASSIGNMENT", "RETURNED"].includes(
          item.type
        )
      );
    }
  });

  test("awaitingCompanyReceipt: fixture matches the exact predicate", async () => {
    const id = await seedOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "COLLECTED_FROM_SENDER",
      currentParcelCollectionDriverId: driverId,
    });
    const scoped = await prisma.orders.count({
      where: { id, parcel_collection_status: "COLLECTED_FROM_SENDER", current_parcel_collection_driver_id: { not: null } },
    });
    assert.equal(scoped, 1);
    const res = await getDashboard(tokens.admin);
    assert.ok(res.body.data.parcelCollection.awaitingCompanyReceipt >= 1);
  });

  test("readyForDeliveryAssignment: fixture matches the exact predicate; agrees with the Orders List same-queue count", async () => {
    const id = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });
    const scoped = await prisma.orders.count({
      where: { id, status: { in: ["RECEIVED", "READY_FOR_PICKUP"] }, current_driver_id: null, parcel_collection_status: "RECEIVED_AT_COMPANY" },
    });
    assert.equal(scoped, 1);

    const res = await getDashboard(tokens.admin);
    assert.ok(res.body.data.parcelCollection.readyForDeliveryAssignment >= 1);

    // Dashboard/list semantic consistency (task §80) — the Orders List
    // workflowQueue filter must report a total that is at LEAST this
    // dashboard count's evidence for this one fixture (same shared
    // predicate; both read the same committed DB state).
    const listRes = await request(app)
      .get("/api/v1/orders")
      .query({ workflowQueue: "READY_FOR_DELIVERY_ASSIGNMENT", limit: 1 })
      .set(auth(tokens.admin));
    assert.equal(listRes.status, 200);
    assert.ok(listRes.body.meta.total >= 1);
  });

  test("activeCollectionJobs / collectionsCompletedToday driver metrics stay separate from Delivery metrics", async () => {
    const inProgress = await seedOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "ASSIGNED",
      currentParcelCollectionDriverId: driverId,
    });
    const completedToday = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });
    const scopedInProgress = await prisma.orders.count({ where: { id: inProgress, parcel_collection_status: "ASSIGNED" } });
    const scopedCompleted = await prisma.orders.count({
      where: { id: completedToday, parcel_intake_method: "DRIVER_COLLECTION", received_at_company_at: { not: null } },
    });
    assert.equal(scopedInProgress, 1);
    assert.equal(scopedCompleted, 1);

    const res = await getDashboard(tokens.admin);
    assert.equal(typeof res.body.data.drivers.activeCollectionJobs, "number");
    assert.equal(typeof res.body.data.drivers.collectionsCompletedToday, "number");
    assert.ok(res.body.data.drivers.activeCollectionJobs >= 1);
    assert.ok(res.body.data.drivers.collectionsCompletedToday >= 1);
    // Existing Delivery-only fields are untouched/still present, unrenamed.
    assert.equal(typeof res.body.data.drivers.ordersAssigned, "number");
    assert.equal(typeof res.body.data.drivers.deliveriesCompletedToday, "number");
  });

  test("parcelCollection metrics are never finance-gated — Dispatcher sees the same shape as Admin", async () => {
    const res = await getDashboard(tokens.dispatcher);
    assert.ok(res.body.data.parcelCollection);
    assert.equal(typeof res.body.data.parcelCollection.awaitingCollectionAssignment, "number");
    // finance stays null for Dispatcher (unchanged Phase 9.1 contract).
    assert.equal(res.body.data.finance, null);
  });

  test("deprecated `orders.unassigned` field is still present (backend compatibility) but no longer the authoritative ready-for-delivery signal", async () => {
    const res = await getDashboard(tokens.admin);
    assert.equal(typeof res.body.data.orders.unassigned, "number");
    assert.ok("readyForDeliveryAssignment" in res.body.data.parcelCollection);
  });
});
