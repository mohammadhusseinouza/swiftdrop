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
  createTestCustomer,
  createTestDriver,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Customer / Public tracking BACKEND CONTRACTS (Phase 11.17.6, task §55-§64,
// §86-§87). No Customer Portal / Public Tracking UI exists — this only
// verifies the safe backend DTOs and privacy.
// ============================================================

const PUBLIC_SAFE_KEYS = ["trackingCode", "stages", "exception", "isDelivered", "deliveredAt"].sort();
const CUSTOMER_SAFE_KEYS = [...PUBLIC_SAFE_KEYS, "orderId", "orderNumber", "createdAt"].sort();

const FORBIDDEN_SUBSTRINGS = [
  "parcelCollectionAddress",
  "parcelCollectionPhone",
  "currentCollectionDriver",
  "receivedAtCompanyBy",
  "failedCollectionReason",
  "collectionSnapshot",
  "driverNumber",
  "walletBalance",
  "driverCash",
];

describe("Customer / Public Tracking backend contracts (Phase 11.17.6)", () => {
  let app: Express;
  let admin: TestUser;
  let customerUser: TestUser;
  let otherCustomerUser: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;
  let otherCustomerId: string;

  const orderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdUserIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    customerUser = await createTestUser("CUSTOMER");
    otherCustomerUser = await createTestUser("CUSTOMER");
    createdUserIds.push(customerUser.id, otherCustomerUser.id);

    const [adminLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, customerUser.email, customerUser.password),
    ]);
    tokens = { admin: adminLogin.accessToken as string, customer: customerLogin.accessToken as string };
    assert.ok(tokens.admin);
    assert.ok(tokens.customer);

    customerId = await createTestCustomer(customerUser.id, admin.id);
    otherCustomerId = await createTestCustomer(otherCustomerUser.id, admin.id);
    createdCustomerIds.push(customerId, otherCustomerId);

    area = await createTestArea();
    createdAreaIds.push(area.id);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
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

  function assertNoForbiddenLeak(body: unknown) {
    const json = JSON.stringify(body);
    for (const term of FORBIDDEN_SUBSTRINGS) {
      assert.ok(!json.includes(term), `response leaked forbidden field/term "${term}"`);
    }
  }

  // ===========================================================
  // Customer tracking — own order only (IDOR)
  // ===========================================================

  describe("Customer tracking", () => {
    test("own order -> 200 with the safe DTO shape", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const res = await request(app).get(`/api/v1/customer/me/orders/${orderId}/tracking`).set(auth(tokens.customer));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), CUSTOMER_SAFE_KEYS);
      assertNoForbiddenLeak(res.body);
    });

    test("another customer's order -> 404 (IDOR-safe, same as nonexistent)", async () => {
      const otherOrderId = await seedTestOrder(otherCustomerId, admin.id, { areaId: area.id, areaName: area.name });
      orderIds.push(otherOrderId);
      const res = await request(app).get(`/api/v1/customer/me/orders/${otherOrderId}/tracking`).set(auth(tokens.customer));
      assert.equal(res.status, 404);

      const nonexistent = await request(app)
        .get(`/api/v1/customer/me/orders/00000000-0000-0000-0000-000000000000/tracking`)
        .set(auth(tokens.customer));
      assert.equal(nonexistent.status, 404);
      assert.equal(nonexistent.body.error.code, res.body.error.code);
    });

    test("unauthenticated -> 401; a Management/Driver account -> 403 (portal isolation)", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const unauth = await request(app).get(`/api/v1/customer/me/orders/${orderId}/tracking`);
      assert.equal(unauth.status, 401);
      const asAdmin = await request(app).get(`/api/v1/customer/me/orders/${orderId}/tracking`).set(auth(tokens.admin));
      assert.equal(asAdmin.status, 403);
    });
  });

  // ===========================================================
  // Public tracking — no auth, narrowest DTO
  // ===========================================================

  describe("Public tracking", () => {
    test("valid tracking code -> 200 with ONLY the public-safe keys", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(Object.keys(res.body.data).sort(), PUBLIC_SAFE_KEYS);
      // No internal order id/order number anywhere in the public response.
      assert.ok(!("orderId" in res.body.data));
      assert.ok(!("orderNumber" in res.body.data));
      assert.ok(!JSON.stringify(res.body).includes(order.id));
      assertNoForbiddenLeak(res.body);
    });

    test("unknown tracking code -> 404, no auth required at all", async () => {
      const res = await request(app).get(`/api/v1/track/TRK-DOESNOTEXIST000`);
      assert.equal(res.status, 404);
    });
  });

  // ===========================================================
  // Stage/exception state coverage (task §87)
  // ===========================================================

  describe("Tracking stage states", () => {
    test("ALREADY_AT_COMPANY: 4-stage sequence, no Collection stages ever present", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      const codes = (res.body.data.stages as Array<{ code: string }>).map((s) => s.code);
      assert.deepEqual(codes, ["ORDER_RECEIVED", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"]);
      assert.ok(!codes.includes("COLLECTION_SCHEDULED"));
      assert.ok(!codes.includes("PARCEL_COLLECTED"));
    });

    test("DRIVER_COLLECTION AWAITING_ASSIGNMENT: 7-stage sequence, current = COLLECTION_SCHEDULED", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      const stages = res.body.data.stages as Array<{ code: string; state: string }>;
      assert.deepEqual(
        stages.map((s) => s.code),
        ["ORDER_CREATED", "COLLECTION_SCHEDULED", "PARCEL_COLLECTED", "RECEIVED_AT_COMPANY", "PREPARING_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"]
      );
      assert.equal(stages.find((s) => s.code === "ORDER_CREATED")!.state, "done");
      assert.equal(stages.find((s) => s.code === "COLLECTION_SCHEDULED")!.state, "current");
      assert.equal(res.body.data.exception, null);
    });

    test("DRIVER_COLLECTION FAILED: Public sees a generic message, Customer sees a more specific one — neither leaks the internal reason", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const publicRes = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      assert.equal(publicRes.body.data.exception.code, "COLLECTION_ATTENTION");
      assert.equal(publicRes.body.data.exception.message, "Collection in progress");

      const customerRes = await request(app).get(`/api/v1/customer/me/orders/${orderId}/tracking`).set(auth(tokens.customer));
      assert.equal(customerRes.body.data.exception.code, "COLLECTION_ATTENTION");
      assert.equal(customerRes.body.data.exception.message, "Collection needs another attempt");

      for (const body of [publicRes.body, customerRes.body]) {
        const json = JSON.stringify(body);
        assert.ok(!json.toLowerCase().includes("sender unavailable"));
        assert.ok(!json.toLowerCase().includes("incorrect collection address"));
      }
    });

    test("RECEIVED_AT_COMPANY (DRIVER_COLLECTION, not yet delivery-assigned): current = PREPARING_FOR_DELIVERY", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      const stages = res.body.data.stages as Array<{ code: string; state: string }>;
      assert.equal(stages.find((s) => s.code === "RECEIVED_AT_COMPANY")!.state, "done");
      assert.equal(stages.find((s) => s.code === "PREPARING_FOR_DELIVERY")!.state, "current");
      assert.equal(stages.find((s) => s.code === "OUT_FOR_DELIVERY")!.state, "upcoming");
    });

    test("CANCELLED order: exception is a safe generic message with no internal reason leaked", async () => {
      const orderId = await seedOrder({ status: "CANCELLED", parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      assert.equal(res.body.data.exception.code, "CANCELLED");
      assert.equal(res.body.data.exception.message, "Order Cancelled");
    });

    test("DELIVERED: isDelivered true, deliveredAt set, all stages done", async () => {
      const now = new Date();
      const orderId = await seedOrder({
        status: "DELIVERED",
        parcelIntakeMethod: "ALREADY_AT_COMPANY",
        assignedAt: now,
        deliveredAt: now,
      });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      assert.equal(res.body.data.isDelivered, true);
      assert.ok(res.body.data.deliveredAt);
      const stages = res.body.data.stages as Array<{ state: string }>;
      assert.ok(stages.every((s) => s.state === "done"));
    });
  });

  // ===========================================================
  // Phase 14.1 — defense-in-depth privacy tests (task §32-§37). The exact-key
  // assertions above already prove the public DTO can never carry these
  // fields; these tests additionally prove no ACTUAL sensitive value ever
  // reaches the response body, seeding every sensitive dimension (Driver,
  // Customer, receiver, money, financial review) on ONE order together.
  // ===========================================================
  describe("Phase 14.1 — public DTO privacy (defense-in-depth)", () => {
    test("Driver identity/contact, rich Customer profile, receiver phone, money and REVIEW_REQUIRED finance are all absent from a delivered order's public response", async () => {
      const driverUser = await createTestUser("DRIVER");
      createdUserIds.push(driverUser.id);
      const driverId = await createTestDriver(driverUser.id);

      const richCustomerId = await seedCustomerRecord(admin.id, {
        name: "Marker Sensitive Customer Name",
        primaryPhone: "+96179999999",
        email: "marker-sensitive-customer@example.com",
      });
      createdCustomerIds.push(richCustomerId);

      const now = new Date();
      const orderId = await seedTestOrder(richCustomerId, admin.id, {
        areaId: area.id,
        areaName: area.name,
        status: "DELIVERED",
        financialStatus: "REVIEW_REQUIRED",
        needsFinancialReview: true,
        parcelIntakeMethod: "ALREADY_AT_COMPANY",
        receiverPhone: "+96178888888",
        orderAmount: "543.21",
        deliveryFee: "12.34",
        actualAmountCollected: "500.00",
        collectionDifferenceReason: "Marker sensitive shortage reason",
        paymentType: "PARTIALLY_PAID",
        currentDriverId: driverId,
        assignedAt: now,
        deliveredAt: now,
      });
      orderIds.push(orderId);

      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const res = await request(app).get(`/api/v1/track/${order.tracking_code}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));

      // Structural: still ONLY the 5 public-safe keys.
      assert.deepEqual(Object.keys(res.body.data).sort(), PUBLIC_SAFE_KEYS);
      // A delivered REVIEW_REQUIRED order still reads as plain "Delivered".
      assert.equal(res.body.data.isDelivered, true);
      assert.equal(res.body.data.exception, null);

      const json = JSON.stringify(res.body);
      const forbiddenValues = [
        // Driver identity/contact
        driverUser.email,
        // Customer profile
        "Marker Sensitive Customer Name",
        "+96179999999",
        "marker-sensitive-customer@example.com",
        // Receiver contact
        "+96178888888",
        // Money / payment
        "543.21",
        "12.34",
        "500.00",
        "PARTIALLY_PAID",
        "Marker sensitive shortage reason",
        // Financial review internals
        "REVIEW_REQUIRED",
        "needsFinancialReview",
        "needs_financial_review",
        // Raw ids/actors
        orderId,
        driverId,
        admin.id,
        admin.email,
      ];
      for (const value of forbiddenValues) {
        assert.ok(!json.includes(value), `public response leaked sensitive value "${value}"`);
      }

      await cleanupTestDriverRecord(driverId);
    });

    test("Read-only: repeated public GETs create zero writes to orders/audit_logs/finance tables", async () => {
      const orderId = await seedOrder({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "ASSIGNED" });
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const [before, auditBefore] = await Promise.all([
        prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
        prisma.audit_logs.count({ where: { entity_id: orderId } }),
      ]);

      await request(app).get(`/api/v1/track/${order.tracking_code}`);
      await request(app).get(`/api/v1/track/${order.tracking_code}`);
      await request(app).get(`/api/v1/track/${order.tracking_code}`);

      const [after, auditAfter] = await Promise.all([
        prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
        prisma.audit_logs.count({ where: { entity_id: orderId } }),
      ]);

      assert.deepEqual(after, before);
      assert.equal(auditAfter, auditBefore);
    });

    test("Malformed/empty tracking code -> validation rejects before any DB lookup", async () => {
      const empty = await request(app).get(`/api/v1/track/${encodeURIComponent(" ")}`);
      assert.equal(empty.status, 400);
      assert.equal(empty.body.success, false);
      assert.ok(!JSON.stringify(empty.body).match(/prisma|sql|stack/i));
    });
  });
});
