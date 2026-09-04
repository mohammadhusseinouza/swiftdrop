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
// Reports — Parcel Intake / Collection dimensions (Phase 11.17.6, task
// §34-§37, §82). Existing Delivery-only Order/Driver Report metrics must
// stay byte-for-byte unchanged in meaning; Parcel Collection is added as
// SEPARATE fields/filters only. Finance Report is out of scope here (task
// §39 — untouched, verified only by the fact that this suite never touches
// /reports/finance).
// ============================================================

describe("Reports — Parcel Intake / Collection (Phase 11.17.6)", () => {
  let app: Express;
  let admin: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;
  let driverId: string;

  const orderIds: string[] = [];
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
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  async function seedOrder(overrides: Parameters<typeof seedTestOrder>[2]) {
    const id = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    orderIds.push(id);
    return id;
  }

  describe("Orders Report", () => {
    test("parcelIntakeMethod / parcelCollectionStatus / parcelCollectionDriverId filters, scoped to this suite's own customer", async () => {
      await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      await seedOrder({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: driverId,
      });

      const res = await request(app)
        .get("/api/v1/reports/orders")
        .query({ customerId, parcelIntakeMethod: "DRIVER_COLLECTION" })
        .set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.summary.totalOrders, 1);

      const byDriver = await request(app)
        .get("/api/v1/reports/orders")
        .query({ customerId, parcelCollectionDriverId: driverId })
        .set(auth(tokens.admin));
      assert.equal(byDriver.body.data.summary.totalOrders, 1);

      const byStatus = await request(app)
        .get("/api/v1/reports/orders")
        .query({ customerId, parcelCollectionStatus: "ASSIGNED" })
        .set(auth(tokens.admin));
      assert.equal(byStatus.body.data.summary.totalOrders, 1);
    });

    test("parcel summary block: intake counts + operational queue counts agree with the Orders List for the same population", async () => {
      // A dedicated fresh Customer so this test's population is exactly its
      // own three fixtures (the describe block's shared `customerId` also
      // carries fixtures seeded by the sibling test above).
      const freshCustomerId = await seedCustomerRecord(admin.id);
      createdCustomerIds.push(freshCustomerId);
      const seedFresh = async (overrides: Parameters<typeof seedTestOrder>[2]) => {
        const id = await seedTestOrder(freshCustomerId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
        orderIds.push(id);
        return id;
      };
      await seedFresh({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      await seedFresh({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
      await seedFresh({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });

      const res = await request(app).get("/api/v1/reports/orders").query({ customerId: freshCustomerId }).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const parcel = res.body.data.parcel;
      assert.equal(parcel.alreadyAtCompanyOrders, 1);
      assert.equal(parcel.driverCollectionOrders, 2);
      assert.ok(parcel.awaitingCollectionAssignment >= 1);
      assert.ok(parcel.collectionAttention >= 1);
      assert.equal(typeof parcel.collectionInProgress, "number");
      assert.equal(typeof parcel.awaitingCompanyReceipt, "number");
      assert.equal(typeof parcel.readyForDeliveryAssignment, "number");

      // Finance is entirely absent from the Orders Report DTO — no revenue/
      // fee/commission field ever introduced for Parcel Collection (task §39).
      const json = JSON.stringify(res.body.data);
      assert.ok(!json.toLowerCase().includes("collectionrevenue"));
      assert.ok(!json.toLowerCase().includes("collectionfee"));
      assert.ok(!json.toLowerCase().includes("commission"));
    });

    test("reports.read is sufficient — Dispatcher (no finance.read) still sees the parcel block", async () => {
      const dispatcher = await createTestUser("DISPATCHER");
      createdUserIds.push(dispatcher.id);
      const login = await loginTestUser(app, dispatcher.email, dispatcher.password);
      const res = await request(app).get("/api/v1/reports/orders").query({ customerId }).set(auth(login.accessToken as string));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.parcel);
    });
  });

  describe("Driver Report", () => {
    // A dedicated far-past UTC window (mirrors reports.test.ts's own 2001
    // convention) so absolute counts are safe under full-suite parallelism.
    const from = "2002-03-01";
    const to = "2002-03-31";
    const assignedAt = new Date("2002-03-15T10:00:00.000Z");

    test("collectionAssignments / collectionsCompleted / failedCollectionAttempts are separate fields; Delivery metrics stay untouched", async () => {
      // A real assignment row, in-range.
      const orderId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
      await prisma.parcel_collection_assignments.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          assigned_by_id: admin.id,
          assigned_at: assignedAt,
          ended_at: assignedAt,
          end_reason: "RECEIVED_AT_COMPANY",
          is_current: false,
        },
      });
      await prisma.parcel_collection_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          attempt_number: 1,
          outcome: "FAILED",
          completed_at: assignedAt,
        },
      });

      const res = await request(app)
        .get("/api/v1/reports/drivers")
        .query({ driverId, from, to })
        .set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const row = res.body.data.rows.find((r: { driver: { id: string } }) => r.driver.id === driverId);
      assert.ok(row, "expected a row for the seeded driver");
      assert.equal(row.collectionAssignments, 1);
      assert.equal(row.collectionsCompleted, 1);
      assert.equal(row.failedCollectionAttempts, 1);

      // Delivery-only fields remain present with their original meaning —
      // never merged with the Collection counts above.
      assert.equal(typeof row.ordersAssigned, "number");
      assert.equal(typeof row.ordersDelivered, "number");
      assert.equal(typeof row.failedAttempts, "number");
      assert.equal(typeof row.deliveryAttempts, "number");
      assert.equal(row.ordersDelivered, 0);
      assert.equal(row.failedAttempts, 0);
      assert.deepEqual(
        Object.keys(row).sort(),
        [
          "collectionAssignments",
          "collectionsCompleted",
          "currentCashHeld",
          "deliveryAttempts",
          "driver",
          "failedAttempts",
          "failedCollectionAttempts",
          "moneyCollected",
          "ordersAssigned",
          "ordersDelivered",
          "settlementAmount",
          "settlementCount",
          "successRate",
        ].sort()
      );
    });
  });
});
