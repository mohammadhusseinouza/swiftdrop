import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
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
// Phase 11.17.6 FINAL REVIEW CORRECTION — Dashboard attention semantics
// (task §1-§6). The pre-correction "UNASSIGNED" attention item/count used
// `status IN (RECEIVED, READY_FOR_PICKUP) AND current_driver_id IS NULL`
// WITHOUT the Parcel Intake gate, so a Collection-in-progress order (which
// also has no DELIVERY driver yet) was wrongly surfaced as a Delivery-
// unassigned problem. This suite is the representative A-G scenario matrix
// from the review brief, verifying the corrected `readyForDeliveryAssignment`
// attention semantics (shared workflowQueue predicate — never a second,
// independently-drifting definition) and Dashboard/Orders-List consistency.
// ============================================================

interface AttentionItem {
  type: string;
  order: { id: string };
}

describe("Dashboard attention — Ready for Delivery correction (Phase 11.17.6 final review)", () => {
  let app: Express;
  let admin: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;
  let driverId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    const adminLogin = await loginTestUser(app, admin.email, admin.password);
    tokens = { admin: adminLogin.accessToken as string };
    assert.ok(tokens.admin);

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
    await cleanupTestUser(admin.id);
  });

  async function seedOrder(overrides: Parameters<typeof seedTestOrder>[2]) {
    const id = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    createdOrderIds.push(id);
    return id;
  }

  async function getDashboard() {
    const res = await request(app).get("/api/v1/dashboard").set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as {
      attention: { counts: Record<string, number>; items: AttentionItem[] };
      parcelCollection: Record<string, number>;
    };
  }

  function isReadyForDelivery(items: AttentionItem[], orderId: string): boolean {
    return items.some((i) => i.order.id === orderId && i.type === "READY_FOR_DELIVERY_ASSIGNMENT");
  }
  function isCollectionAttention(items: AttentionItem[], orderId: string): boolean {
    return items.some((i) => i.order.id === orderId && i.type === "COLLECTION_ATTENTION");
  }
  function isAnyAttentionItem(items: AttentionItem[], orderId: string): boolean {
    return items.some((i) => i.order.id === orderId);
  }

  test("A-G scenario matrix", async () => {
    // A — DRIVER_COLLECTION / AWAITING_ASSIGNMENT / no delivery driver
    const orderA = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
    // B — DRIVER_COLLECTION / ASSIGNED / no delivery driver
    const orderB = await seedOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "ASSIGNED",
      currentParcelCollectionDriverId: driverId,
    });
    // C — DRIVER_COLLECTION / FAILED / no delivery driver
    const orderC = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });
    // D — DRIVER_COLLECTION / COLLECTED_FROM_SENDER / no delivery driver
    const orderD = await seedOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "COLLECTED_FROM_SENDER",
      currentParcelCollectionDriverId: driverId,
    });
    // E — RECEIVED_AT_COMPANY / no delivery driver / otherwise delivery eligible
    const orderE = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });
    // F — RECEIVED_AT_COMPANY / delivery driver assigned
    const orderF = await seedOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionStatus: "RECEIVED_AT_COMPANY",
      status: "ASSIGNED",
    });
    // G — CANCELLED with historical parcel status ASSIGNED
    const orderG = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "ASSIGNED", status: "CANCELLED" });

    const dashboard = await getDashboard();
    const items = dashboard.attention.items;

    // A: not Ready-for-Delivery attention
    assert.ok(!isReadyForDelivery(items, orderA), "A must not be Ready-for-Delivery attention");
    // B: not Ready-for-Delivery attention
    assert.ok(!isReadyForDelivery(items, orderB), "B must not be Ready-for-Delivery attention");
    // C: Collection Attention only as appropriate (also not Ready-for-Delivery)
    assert.ok(!isReadyForDelivery(items, orderC), "C must not be Ready-for-Delivery attention");
    // D: Awaiting Company Receipt, not Delivery-unassigned
    assert.ok(!isReadyForDelivery(items, orderD), "D must not be Ready-for-Delivery attention");
    assert.ok(!isCollectionAttention(items, orderD), "D is not a Collection Attention item (not FAILED)");
    // E: Ready for Delivery
    // (Confirmed via the dedicated Orders List / count assertions below —
    // the attention.items array is capped at 10 and shared across parallel
    // suites, so item-list presence alone is not a reliable positive
    // assertion; the workflowQueue-scoped Orders List check is authoritative.)
    // F: not Ready for Delivery (a delivery driver is already assigned)
    assert.ok(!isReadyForDelivery(items, orderF), "F must not be Ready-for-Delivery attention");
    // G: no active workflow attention at all
    assert.ok(!isAnyAttentionItem(items, orderG), "G (cancelled) must not appear in any attention item");

    // Authoritative positive check for E and negative re-check for A/B/D/F/G,
    // scoped and deterministic via the Orders List workflowQueue filter
    // (same shared predicate as the Dashboard attention/count).
    const readyList = await request(app)
      .get("/api/v1/orders")
      .query({ workflowQueue: "READY_FOR_DELIVERY_ASSIGNMENT", limit: 100 })
      .set(auth(tokens.admin));
    const readyIds = (readyList.body.data as Array<{ id: string }>).map((r) => r.id);
    assert.ok(readyIds.includes(orderE), "E must be in the Ready-for-Delivery queue");
    for (const excluded of [orderA, orderB, orderC, orderD, orderF, orderG]) {
      assert.ok(!readyIds.includes(excluded), `${excluded} must not be in the Ready-for-Delivery queue`);
    }
  });

  test("Dashboard readyForDeliveryAssignment count/attention agree with Orders List workflowQueue for a fresh fixture", async () => {
    const orderE2 = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });

    const dashboard = await getDashboard();
    assert.ok(dashboard.attention.counts.readyForDeliveryAssignment >= 1);
    assert.ok(dashboard.parcelCollection.readyForDeliveryAssignment >= 1);
    assert.equal(dashboard.attention.counts.readyForDeliveryAssignment, dashboard.parcelCollection.readyForDeliveryAssignment);

    const listRes = await request(app)
      .get("/api/v1/orders")
      .query({ workflowQueue: "READY_FOR_DELIVERY_ASSIGNMENT", limit: 1 })
      .set(auth(tokens.admin));
    assert.ok(listRes.body.meta.total >= 1);
    const ids = (
      await request(app)
        .get("/api/v1/orders")
        .query({ workflowQueue: "READY_FOR_DELIVERY_ASSIGNMENT", limit: 100 })
        .set(auth(tokens.admin))
    ).body.data.map((r: { id: string }) => r.id);
    assert.ok(ids.includes(orderE2));
  });

  test("the legacy orders.unassigned metric is unchanged/independent — it does NOT drive the attention presentation", async () => {
    const dashboard = await getDashboard();
    const raw = await request(app).get("/api/v1/dashboard").set(auth(tokens.admin));
    assert.equal(typeof raw.body.data.orders.unassigned, "number");
    // The attention block no longer has an `unassigned` key at all.
    assert.ok(!("unassigned" in dashboard.attention.counts));
    assert.ok("readyForDeliveryAssignment" in dashboard.attention.counts);
  });
});
