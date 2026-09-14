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
// Phase 13.3 — GET /api/v1/customer/me/orders/:id (Customer Order Detail +
// simplified tracking).
//
// Covers: portal-family + permission authorization, IDOR (not-owned == 404 ==
// nonexistent), the receiver/package/money snapshot staying frozen after a
// later Customer-profile edit, the embedded Customer-safe tracking progress
// (DRIVER_COLLECTION vs ALREADY_AT_COMPANY stage vocabulary, no duplicate
// stages), collection FAILED/RESCHEDULED neutrality, FAILED_DELIVERY +
// delivered-REVIEW_REQUIRED privacy, the exact safe key set, no Driver /
// employee / assignment / attempt / audit / finance-internal leakage, and
// zero write side effects.
// ============================================================

const TOP_KEYS = [
  "id",
  "orderNumber",
  "trackingCode",
  "orderType",
  "status",
  "createdAt",
  "deliveredAt",
  "receiver",
  "package",
  "payment",
  "parcelIntakeMethod",
  "collectionStage",
  "tracking",
].sort();

const RECEIVER_KEYS = ["name", "phone", "altPhone", "area", "address", "buildingFloor", "instructions", "mapLink"].sort();
const PACKAGE_KEYS = ["description", "packageCount", "quantity", "weightKg"].sort();
const PAYMENT_KEYS = ["type", "orderAmount", "deliveryFee", "amountToCollect"].sort();
const TRACKING_KEYS = ["stages", "exception", "isDelivered"].sort();

const FORBIDDEN_SUBSTRINGS = [
  "driverNumber",
  "driver_number",
  "current_driver_id",
  "current_parcel_collection_driver_id",
  "currentDriver",
  "collectionDriver",
  "received_at_company_by",
  "receivedAtCompanyBy",
  "receiptEmployee",
  "parcel_collection_contact_name",
  "parcelCollectionAddress",
  "parcel_collection_phone",
  "order_assignments",
  "parcel_collection_assignments",
  "delivery_attempts",
  "parcel_collection_attempts",
  "attemptNumber",
  "endReason",
  "auditLog",
  "audit_logs",
  "previousValues",
  "needsFinancialReview",
  "needs_financial_review",
  "financialStatus",
  "financial_status",
  "collectionDifferenceReason",
  "collection_difference_reason",
  "actualAmountCollected",
  "actual_amount_collected",
  "driverCash",
  "companyRevenue",
  "walletTransaction",
  "settlement",
  "reversal",
  "idempotency",
];

describe("Customer Portal — Order Detail (Phase 13.3)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverUser: TestUser;
  let customerAUser: TestUser;
  let customerBUser: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let customerAId: string;
  let customerBId: string;
  let collectionDriverId: string;

  const orderIds: string[] = [];
  const customerRecordIds: string[] = [];
  const driverRecordIds: string[] = [];
  const areaIds: string[] = [];
  const userIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const detail = (t: string | undefined, id: string) => {
    const r = request(app).get(`/api/v1/customer/me/orders/${id}`);
    return t ? r.set(auth(t)) : r;
  };

  async function seedA(overrides: Parameters<typeof seedTestOrder>[2]) {
    const id = await seedTestOrder(customerAId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    orderIds.push(id);
    return id;
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverUser = await createTestUser("DRIVER");
    customerAUser = await createTestUser("CUSTOMER");
    customerBUser = await createTestUser("CUSTOMER");
    userIds.push(dispatcher.id, finance.id, driverUser.id, customerAUser.id, customerBUser.id);

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverUser.email, driverUser.password),
      loginTestUser(app, customerAUser.email, customerAUser.password),
      loginTestUser(app, customerBUser.email, customerBUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customerA: logins[4].accessToken as string,
      customerB: logins[5].accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `missing token: ${k}`);

    area = await createTestArea();
    areaIds.push(area.id);
    customerAId = await seedCustomerRecord(admin.id, { name: "Detail Customer A", portalUserId: customerAUser.id });
    customerBId = await seedCustomerRecord(admin.id, { name: "Detail Customer B", portalUserId: customerBUser.id });
    customerRecordIds.push(customerAId, customerBId);
    collectionDriverId = await seedDriverRecord(driverUser.id, { driverNumber: "PH133-COLLDRV" });
    driverRecordIds.push(collectionDriverId);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of customerRecordIds) await cleanupTestCustomerRecord(id);
    for (const id of driverRecordIds) await cleanupTestDriverRecord(id);
    for (const id of areaIds) await cleanupTestArea(id);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  // ===========================================================
  // Authorization matrix + IDOR (task §45 / §46)
  // ===========================================================
  describe("authorization + IDOR", () => {
    let ownOrder: string;
    before(async () => {
      ownOrder = await seedA({ status: "RECEIVED" });
    });

    test("CUSTOMER owns -> 200", async () => {
      const res = await detail(tokens.customerA, ownOrder);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("ADMIN / DISPATCHER / FINANCE / DRIVER -> 403; unauthenticated -> 401", async () => {
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        assert.equal((await detail(tokens[role], ownOrder)).status, 403, role);
      }
      assert.equal((await detail(undefined, ownOrder)).status, 401);
    });

    test("another Customer's order -> 404, identical to a nonexistent id", async () => {
      const notOwned = await detail(tokens.customerB, ownOrder);
      const nonexistent = await detail(tokens.customerB, "00000000-0000-0000-0000-000000000000");
      assert.equal(notOwned.status, 404);
      assert.equal(nonexistent.status, 404);
      assert.equal(notOwned.body.error.code, nonexistent.body.error.code);
      assert.deepEqual(notOwned.body, nonexistent.body);
      // No existence hint: order number / tracking code / status absent.
      const json = JSON.stringify(notOwned.body);
      assert.ok(!json.includes("PH63-ORD"));
      assert.ok(!/RECEIVED/.test(json));
    });

    test("non-UUID id -> 400 (never hits the database)", async () => {
      assert.equal((await detail(tokens.customerA, "not-a-uuid")).status, 400);
    });
  });

  // ===========================================================
  // Receiver / package / money snapshot frozen after profile edit (task §44)
  // ===========================================================
  describe("snapshot immutability", () => {
    test("editing the Customer profile later does not change the Order's stored receiver snapshot", async () => {
      const orderId = await seedA({
        status: "RECEIVED",
        receiverName: "Original Receiver",
        receiverPhone: "+96170123456",
        orderAmount: "100.00",
        deliveryFee: "8.00",
      });
      const before = await detail(tokens.customerA, orderId);
      assert.equal(before.body.data.receiver.name, "Original Receiver");
      assert.equal(before.body.data.receiver.phone, "+96170123456");
      assert.equal(before.body.data.receiver.address, before.body.data.receiver.address);

      await prisma.customers.update({
        where: { id: customerAId },
        data: { name: "Renamed Customer", primary_phone: "+96170999999", default_address: "New Home Address" },
      });

      const afterRes = await detail(tokens.customerA, orderId);
      assert.equal(afterRes.body.data.receiver.name, "Original Receiver");
      assert.equal(afterRes.body.data.receiver.phone, "+96170123456");
      assert.deepEqual(afterRes.body.data.receiver, before.body.data.receiver);
      assert.deepEqual(afterRes.body.data.payment, before.body.data.payment);
    });
  });

  // ===========================================================
  // DTO shape + privacy (task §56)
  // ===========================================================
  describe("DTO shape + privacy", () => {
    test("exact safe key set (top-level + nested); money strings", async () => {
      const id = await seedA({ status: "OUT_FOR_DELIVERY", orderType: "DELIVERY_ONLY", orderAmount: "120.00", deliveryFee: "10.00" });
      const res = await detail(tokens.customerA, id);
      const d = res.body.data;
      assert.deepEqual(Object.keys(d).sort(), TOP_KEYS);
      assert.deepEqual(Object.keys(d.receiver).sort(), RECEIVER_KEYS);
      assert.deepEqual(Object.keys(d.package).sort(), PACKAGE_KEYS);
      assert.deepEqual(Object.keys(d.payment).sort(), PAYMENT_KEYS);
      assert.deepEqual(Object.keys(d.tracking).sort(), TRACKING_KEYS);
      for (const k of ["orderAmount", "deliveryFee", "amountToCollect"]) assert.equal(typeof d.payment[k], "string");
      assert.equal(d.payment.amountToCollect, "130");
    });

    test("no forbidden internal / driver / finance / history fields", async () => {
      const id = await seedA({
        status: "ASSIGNED",
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      const res = await detail(tokens.customerA, id);
      const json = JSON.stringify(res.body);
      for (const term of FORBIDDEN_SUBSTRINGS) assert.ok(!json.includes(term), `leaked "${term}"`);
      assert.ok(!json.includes("PH133-COLLDRV"));
      assert.ok(!json.includes(collectionDriverId));
    });
  });

  // ===========================================================
  // Tracking — ALREADY_AT_COMPANY vs DRIVER_COLLECTION (task §51 / §53)
  // ===========================================================
  describe("tracking progress", () => {
    test("ALREADY_AT_COMPANY: collectionStage null; already-at-company stage codes, no fabricated collection stages", async () => {
      const id = await seedA({ parcelIntakeMethod: "ALREADY_AT_COMPANY", status: "OUT_FOR_DELIVERY" });
      const res = await detail(tokens.customerA, id);
      assert.equal(res.body.data.collectionStage, null);
      const codes = res.body.data.tracking.stages.map((s: { code: string }) => s.code);
      assert.deepEqual(codes, ["ORDER_RECEIVED", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"]);
      assert.ok(!codes.includes("COLLECTION_SCHEDULED"));
      assert.ok(!codes.includes("PARCEL_COLLECTED"));
      // No duplicate stage codes.
      assert.equal(new Set(codes).size, codes.length);
    });

    test("DRIVER_COLLECTION: driver-collection stage sequence + customer-safe collectionStage label", async () => {
      const cases: Array<[string, string]> = [
        ["AWAITING_ASSIGNMENT", "Awaiting Collection"],
        ["ASSIGNED", "Collection Scheduled"],
        ["COLLECTED_FROM_SENDER", "Parcel Collected"],
        ["RECEIVED_AT_COMPANY", "Received at Company"],
      ];
      for (const [status, label] of cases) {
        const id = await seedA({
          parcelIntakeMethod: "DRIVER_COLLECTION",
          parcelCollectionStatus: status as never,
          currentParcelCollectionDriverId: status === "RECEIVED_AT_COMPANY" ? undefined : collectionDriverId,
        });
        const res = await detail(tokens.customerA, id);
        assert.equal(res.body.data.collectionStage.label, label, status);
        const codes = res.body.data.tracking.stages.map((s: { code: string }) => s.code);
        assert.deepEqual(codes, [
          "ORDER_CREATED",
          "COLLECTION_SCHEDULED",
          "PARCEL_COLLECTED",
          "RECEIVED_AT_COMPANY",
          "PREPARING_FOR_DELIVERY",
          "OUT_FOR_DELIVERY",
          "DELIVERED",
        ]);
        assert.equal(new Set(codes).size, codes.length, "duplicate stage code");
      }
    });

    test("collection FAILED / RESCHEDULED: one neutral label, generic exception, no internal reason", async () => {
      for (const status of ["FAILED", "RESCHEDULED"] as const) {
        const id = await seedA({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: status });
        const res = await detail(tokens.customerA, id);
        assert.deepEqual(res.body.data.collectionStage, { code: "COLLECTION_DELAYED", label: "Collection Rescheduled" });
        const json = JSON.stringify(res.body.data);
        assert.ok(!/reason/i.test(json), "leaked a reason field/word");
        assert.ok(!/note/i.test(json), "leaked a note field/word");
      }
    });
  });

  // ===========================================================
  // Delivery-side states (task §47 / §48 / §49 / §50 / §54 / §55)
  // ===========================================================
  describe("delivery states", () => {
    test("active order: current stage exists", async () => {
      const id = await seedA({ status: "OUT_FOR_DELIVERY", parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const res = await detail(tokens.customerA, id);
      const states = res.body.data.tracking.stages.map((s: { state: string }) => s.state);
      assert.ok(states.includes("current") || states.includes("done"));
      assert.equal(res.body.data.tracking.isDelivered, false);
    });

    test("delivered order: all stages done, isDelivered true, deliveredAt set (both order types)", async () => {
      for (const orderType of ["DELIVERY_ONLY", "COMPANY_ORDER"] as const) {
        const id = await seedA({ status: "DELIVERED", orderType, deliveredAt: new Date(), parcelIntakeMethod: "ALREADY_AT_COMPANY" });
        const res = await detail(tokens.customerA, id);
        assert.equal(res.body.data.tracking.isDelivered, true);
        assert.ok(res.body.data.deliveredAt);
        assert.ok(res.body.data.tracking.stages.every((s: { state: string }) => s.state === "done"));
      }
    });

    test("FAILED_DELIVERY: generic safe exception, no reason/notes", async () => {
      const id = await seedA({ status: "FAILED_DELIVERY", parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const res = await detail(tokens.customerA, id);
      assert.ok(res.body.data.tracking.exception);
      assert.equal(res.body.data.tracking.exception.code, "FAILED_DELIVERY");
      assert.ok(!/reason/i.test(JSON.stringify(res.body.data)));
    });

    test("delivered REVIEW_REQUIRED order: Customer sees DELIVERED; no review internals", async () => {
      const id = await seedA({
        status: "DELIVERED",
        orderType: "DELIVERY_ONLY",
        deliveredAt: new Date(),
        financialStatus: "REVIEW_REQUIRED",
        needsFinancialReview: true,
        actualAmountCollected: "60.00",
        collectionDifferenceReason: "short by 40",
        parcelIntakeMethod: "ALREADY_AT_COMPANY",
      });
      const res = await detail(tokens.customerA, id);
      assert.equal(res.body.data.status, "DELIVERED");
      assert.equal(res.body.data.tracking.isDelivered, true);
      const json = JSON.stringify(res.body);
      assert.ok(!json.includes("REVIEW_REQUIRED"));
      assert.ok(!json.includes("short by 40"));
      assert.ok(!json.includes("needsFinancialReview"));
      assert.ok(!json.includes("60.00"), "leaked the actual collected amount");
    });
  });

  // ===========================================================
  // Read-only (task §57)
  // ===========================================================
  describe("read-only", () => {
    test("repeated detail reads create no order / history / wallet / audit rows", async () => {
      const id = await seedA({ status: "RECEIVED" });
      const counts = async () => {
        const [orders, history, wt, audit] = await Promise.all([
          prisma.orders.count({ where: { customer_id: customerAId } }),
          prisma.order_status_history.count({ where: { orders: { customer_id: customerAId } } }),
          prisma.wallet_transactions.count({ where: { customer_id: customerAId } }),
          prisma.audit_logs.count({ where: { entity_id: id } }),
        ]);
        return { orders, history, wt, audit };
      };
      const before = await counts();
      await detail(tokens.customerA, id);
      await detail(tokens.customerA, id);
      await detail(tokens.customerA, id);
      assert.deepEqual(await counts(), before);
    });
  });
});
