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
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 11.17.6 — Orders List Parcel Intake / Collection filters +
// operational `workflowQueue` (task §5-§8, §12-§19, §78-§80).
//
// Every fixture Order in this suite is uniquely markable (a `search`
// marker on receiver_name), so every assertion filters the list down to
// this suite's own rows rather than asserting a global count.
// ============================================================

describe("Orders List — Parcel Intake / Collection filters + workflow queues (Phase 11.17.6)", () => {
  let app: Express;
  let admin: TestUser;
  let tokens: Record<string, string>;

  let customerId: string;
  let area: { id: string; name: string };
  let collectionDriverId: string;
  let otherCollectionDriverId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  const marker = `ph1176wfq${uniqueSuffix()}`;

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    const adminLogin = await loginTestUser(app, admin.email, admin.password);
    tokens = { admin: adminLogin.accessToken as string };
    assert.ok(tokens.admin);

    customerId = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerId);
    area = await createTestArea();
    createdAreaIds.push(area.id);

    const driverUserA = await createTestUser("DRIVER");
    createdUserIds.push(driverUserA.id);
    collectionDriverId = await seedDriverRecord(driverUserA.id);
    createdDriverIds.push(collectionDriverId);

    const driverUserB = await createTestUser("DRIVER");
    createdUserIds.push(driverUserB.id);
    otherCollectionDriverId = await seedDriverRecord(driverUserB.id);
    createdDriverIds.push(otherCollectionDriverId);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function seedOrder(overrides: Parameters<typeof seedTestOrder>[2] = {}) {
    const id = await seedTestOrder(customerId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      receiverName: `${marker} ${uniqueSuffix()}`,
      ...overrides,
    });
    createdOrderIds.push(id);
    return id;
  }

  async function listMarked(query: Record<string, string>) {
    const res = await request(app)
      .get("/api/v1/orders")
      .query({ search: marker, limit: 100, ...query })
      .set(auth(tokens.admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as Array<{ id: string }>;
  }

  // ===========================================================
  // Filters (task §5-§9)
  // ===========================================================

  describe("filters", () => {
    test("parcelIntakeMethod filters independently of OrderType", async () => {
      await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const collectionId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION" });

      const rows = await listMarked({ parcelIntakeMethod: "DRIVER_COLLECTION" });
      assert.ok(rows.some((r) => r.id === collectionId));
      assert.ok(rows.every((r) => r.id !== undefined));
    });

    test("parcelCollectionStatus filters to the exact enum value", async () => {
      const failedId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });
      await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });

      const rows = await listMarked({ parcelCollectionStatus: "FAILED" });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(failedId));
    });

    test("parcelCollectionDriverId filters CURRENT collection work only", async () => {
      const assignedId = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      // Historical/ended assignment — no current pointer — must NOT match.
      const failedId = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "FAILED",
      });

      const rows = await listMarked({ parcelCollectionDriverId: collectionDriverId });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(assignedId));
      assert.ok(!ids.includes(failedId));
    });

    test("combined filters compose with AND", async () => {
      const match = await seedOrder({
        orderType: "COMPANY_ORDER",
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      const wrongDriver = await seedOrder({
        orderType: "COMPANY_ORDER",
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: otherCollectionDriverId,
      });

      const rows = await listMarked({
        orderType: "COMPANY_ORDER",
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        parcelCollectionDriverId: collectionDriverId,
      });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(match));
      assert.ok(!ids.includes(wrongDriver));
    });

    test("OrderSummary carries a safe currentCollectionDriver mini-object, null when absent", async () => {
      const assignedId = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      const noDriverId = await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });

      const rows = await listMarked({});
      const assignedRow = rows.find((r) => r.id === assignedId) as unknown as {
        currentCollectionDriver: { id: string; driverNumber: string; user: { firstName: string; lastName: string; phone: string | null } } | null;
      };
      const noDriverRow = rows.find((r) => r.id === noDriverId) as unknown as { currentCollectionDriver: unknown };

      assert.ok(assignedRow.currentCollectionDriver);
      assert.equal(assignedRow.currentCollectionDriver!.id, collectionDriverId);
      assert.ok("driverNumber" in assignedRow.currentCollectionDriver!);
      assert.ok("user" in assignedRow.currentCollectionDriver!);
      // No Driver Cash / unrelated profile fields leak through.
      assert.deepEqual(Object.keys(assignedRow.currentCollectionDriver!).sort(), ["driverNumber", "id", "user"]);
      assert.equal(noDriverRow.currentCollectionDriver, null);
    });
  });

  // ===========================================================
  // Workflow queues — the exact eight-order scenario matrix (task §79)
  // ===========================================================

  describe("workflow queues", () => {
    let orderA: string; // AWAITING_ASSIGNMENT
    let orderB: string; // RESCHEDULED
    let orderC: string; // ASSIGNED
    let orderD: string; // FAILED
    let orderE: string; // COLLECTED_FROM_SENDER
    let orderF: string; // RECEIVED_AT_COMPANY, no delivery driver
    let orderG: string; // RECEIVED_AT_COMPANY, delivery driver assigned
    let orderH: string; // CANCELLED with historical ASSIGNED collection status

    before(async () => {
      orderA = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
      orderB = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RESCHEDULED" });
      orderC = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      orderD = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });
      orderE = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "COLLECTED_FROM_SENDER",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      orderF = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });
      orderG = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "RECEIVED_AT_COMPANY",
        status: "ASSIGNED",
      });
      // H: a cancelled Order whose historical parcel_collection_status
      // remains ASSIGNED — must appear in NO queue (terminal wins). Direct
      // seed (no current driver / no live assignment row) mirrors the
      // documented post-cancellation invariant (contract §4.3/§8.2).
      orderH = await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        status: "CANCELLED",
      });
    });

    test("AWAITING_COLLECTION_ASSIGNMENT: A and B only", async () => {
      const rows = await listMarked({ workflowQueue: "AWAITING_COLLECTION_ASSIGNMENT" });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(orderA));
      assert.ok(ids.includes(orderB));
      for (const excluded of [orderC, orderD, orderE, orderF, orderG, orderH]) assert.ok(!ids.includes(excluded));
    });

    test("COLLECTION_IN_PROGRESS: C only", async () => {
      const rows = await listMarked({ workflowQueue: "COLLECTION_IN_PROGRESS" });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(orderC));
      for (const excluded of [orderA, orderB, orderD, orderE, orderF, orderG, orderH]) assert.ok(!ids.includes(excluded));
    });

    test("COLLECTION_ATTENTION: D only", async () => {
      const rows = await listMarked({ workflowQueue: "COLLECTION_ATTENTION" });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(orderD));
      for (const excluded of [orderA, orderB, orderC, orderE, orderF, orderG, orderH]) assert.ok(!ids.includes(excluded));
    });

    test("AWAITING_COMPANY_RECEIPT: E only", async () => {
      const rows = await listMarked({ workflowQueue: "AWAITING_COMPANY_RECEIPT" });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(orderE));
      for (const excluded of [orderA, orderB, orderC, orderD, orderF, orderG, orderH]) assert.ok(!ids.includes(excluded));
    });

    test("READY_FOR_DELIVERY_ASSIGNMENT: F only (reuses real Delivery-assignment eligibility)", async () => {
      const rows = await listMarked({ workflowQueue: "READY_FOR_DELIVERY_ASSIGNMENT" });
      const ids = rows.map((r) => r.id);
      assert.ok(ids.includes(orderF));
      for (const excluded of [orderA, orderB, orderC, orderD, orderE, orderG, orderH]) assert.ok(!ids.includes(excluded));
    });

    test("H (cancelled, historical ASSIGNED) appears in NO queue — terminal status always wins", async () => {
      for (const queue of [
        "AWAITING_COLLECTION_ASSIGNMENT",
        "COLLECTION_IN_PROGRESS",
        "COLLECTION_ATTENTION",
        "AWAITING_COMPANY_RECEIPT",
        "READY_FOR_DELIVERY_ASSIGNMENT",
      ]) {
        const rows = await listMarked({ workflowQueue: queue });
        assert.ok(!rows.map((r) => r.id).includes(orderH), `H must not appear in ${queue}`);
      }
    });

    test("pagination stays server-side and deterministic under a queue filter", async () => {
      const page1 = await request(app)
        .get("/api/v1/orders")
        .query({ search: marker, workflowQueue: "AWAITING_COLLECTION_ASSIGNMENT", page: 1, limit: 1 })
        .set(auth(tokens.admin));
      assert.equal(page1.status, 200);
      assert.equal(page1.body.data.length, 1);
      assert.ok(page1.body.meta.total >= 2);

      const again = await request(app)
        .get("/api/v1/orders")
        .query({ search: marker, workflowQueue: "AWAITING_COLLECTION_ASSIGNMENT", page: 1, limit: 1 })
        .set(auth(tokens.admin));
      assert.deepEqual(page1.body.data, again.body.data);
    });
  });
});
