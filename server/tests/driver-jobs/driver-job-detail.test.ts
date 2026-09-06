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
  createTestDriver,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 12.2 — GET /api/v1/driver/jobs/:jobType/:orderId ("Job Detail").
//
// Covers: portal-family + permission authorization, own-Driver scoping
// (IDOR), explicit job-type validation (wrong type for an owned Order,
// invalid URL segment), current-job-only semantics reused verbatim from
// Phase 12.1 (Collection ASSIGNED/COLLECTED_FROM_SENDER kept, FAILED/
// RECEIVED_AT_COMPANY/cancelled-historical dropped; Delivery ASSIGNED/
// PICKED_UP/OUT_FOR_DELIVERY/RESCHEDULED kept, DELIVERED dropped), DTO
// privacy for both variants, Collection snapshot immutability, the stale
// deep-link transition (200 -> Management action -> 404), and the
// read-only guarantee.
// ============================================================

describe("Driver Portal — Job Detail (Phase 12.2)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  let senderUnavailableCollectionReasonId: string;
  let deliveryFailedReasonId: string;

  const orderIds: string[] = [];
  const driverIds: string[] = [];
  const userIds: string[] = [];
  const customerIds: string[] = [];

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

    customerId = await seedCustomerRecord(admin.id);
    customerIds.push(customerId);
    area = await createTestArea();
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const collectionReason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    senderUnavailableCollectionReasonId = collectionReason.id;
    const deliveryReason = await prisma.failed_delivery_reasons.findFirstOrThrow({ where: { requires_notes: false } });
    deliveryFailedReasonId = deliveryReason.id;
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    for (const id of customerIds) await cleanupTestCustomerRecord(id);
    await cleanupTestArea(area.id);
    for (const id of userIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    userIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const driverId = await createTestDriver(user.id);
    driverIds.push(driverId);
    await prisma.driver_cash_accounts.create({ data: { driver_id: driverId } });
    return { driverId, userId: user.id, token: login.accessToken as string };
  }

  async function createOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase122 Receiver",
        receiverPhone: "+96170000122",
        receiverAreaId: area.id,
        receiverAddress: "1 Phase122 St",
        description: "Phase122 job-detail order",
        orderAmount: "90.00",
        deliveryFee: "6.00",
        collectionPaymentMethodId: cashMethodId,
        parcelIntakeMethod: "ALREADY_AT_COMPANY",
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    orderIds.push(res.body.data.id);
    return res.body.data as { id: string; orderNumber: string };
  }

  async function createDeliveryOrderAssignedTo(driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createOrder(overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    return order;
  }

  async function createCollectionOrder(overrides: Record<string, unknown> = {}) {
    return createOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionAddress: "1 Phase122 Collection St",
      parcelCollectionAreaId: area.id,
      ...overrides,
    });
  }

  function assignCollection(orderId: string, driverId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId });
  }
  function markCollected(orderId: string, token: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(token)).send({});
  }
  function failCollection(orderId: string, token: string) {
    return request(app)
      .post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`)
      .set(auth(token))
      .send({ failedCollectionReasonId: senderUnavailableCollectionReasonId });
  }
  function receiveAtCompany(orderId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({});
  }
  function cancelOrder(orderId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/cancel`).set(auth(tokens.admin)).send({ reason: "phase 12.2 detail test" });
  }

  async function pickup(orderId: string, token: string) {
    const res = await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  async function startDelivery(orderId: string, token: string) {
    const res = await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(token));
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  async function failDelivery(orderId: string, token: string) {
    const res = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/fail`)
      .set(auth(token))
      .send({ failedReasonId: deliveryFailedReasonId });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  async function rescheduleDelivery(orderId: string) {
    const res = await request(app)
      .post(`/api/v1/orders/${orderId}/reschedule`)
      .set(auth(tokens.admin))
      .send({ reason: "phase 12.2 reschedule test" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }
  async function deliverExact(orderId: string, token: string, amount: string) {
    const res = await request(app)
      .post(`/api/v1/driver/orders/${orderId}/deliver`)
      .set(auth(token))
      .send({ actualAmountCollected: amount });
    assert.equal(res.status, 200, JSON.stringify(res.body));
  }

  function detailPath(jobType: "collection" | "delivery", orderId: string) {
    return `/api/v1/driver/jobs/${jobType}/${orderId}`;
  }

  // ============================================================
  // AUTHORIZATION MATRIX
  // ============================================================

  describe("Authorization", () => {
    test("unauthenticated -> 401", async () => {
      const res = await request(app).get(detailPath("collection", "00000000-0000-0000-0000-000000000000"));
      assert.equal(res.status, 401);
    });

    test("non-Driver roles -> 403 (portal-family denial before any lookup)", async () => {
      const anyId = "00000000-0000-0000-0000-000000000000";
      for (const role of ["admin", "dispatcher", "finance", "customer"] as const) {
        const res = await request(app).get(detailPath("collection", anyId)).set(auth(tokens[role]));
        assert.equal(res.status, 403, `${role} must get 403`);
      }
    });

    test("invalid jobType URL segment -> 400", async () => {
      const driver = await createDriverWithToken("detail-invalid-type");
      const res = await request(app)
        .get(`/api/v1/driver/jobs/returned/00000000-0000-0000-0000-000000000000`)
        .set(auth(driver.token));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("non-uuid orderId -> 400", async () => {
      const driver = await createDriverWithToken("detail-invalid-id");
      const res = await request(app).get(`/api/v1/driver/jobs/collection/not-a-uuid`).set(auth(driver.token));
      assert.equal(res.status, 400);
    });
  });

  // ============================================================
  // COLLECTION — current-job states
  // ============================================================

  describe("Collection detail — current-job states", () => {
    test("1. ASSIGNED -> 200 with the expected DTO", async () => {
      const driver = await createDriverWithToken("collect-detail-assigned");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);

      const res = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.jobType, "COLLECTION");
      assert.equal(res.body.data.orderId, order.id);
      assert.equal(res.body.data.status, "ASSIGNED");
      assert.equal(res.body.data.collectedFromSenderAt, null);
      assert.ok(res.body.data.assignedAt);
      assert.ok(res.body.data.assignmentId);
    });

    test("2. COLLECTED_FROM_SENDER -> 200, custody state populated", async () => {
      const driver = await createDriverWithToken("collect-detail-collected");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);
      const collected = await markCollected(order.id, driver.token);
      assert.equal(collected.status, 200, JSON.stringify(collected.body));

      const res = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "COLLECTED_FROM_SENDER");
      assert.ok(res.body.data.collectedFromSenderAt);
    });

    test("3. FAILED -> 404 (assignment closed)", async () => {
      const driver = await createDriverWithToken("collect-detail-failed");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);
      const failed = await failCollection(order.id, driver.token);
      assert.equal(failed.status, 200, JSON.stringify(failed.body));

      const res = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("4. RECEIVED_AT_COMPANY -> 404 (stale transition: 200 before, 404 after)", async () => {
      const driver = await createDriverWithToken("collect-detail-received");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);
      await markCollected(order.id, driver.token);

      const before = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(before.status, 200);

      const received = await receiveAtCompany(order.id);
      assert.equal(received.status, 200, JSON.stringify(received.body));

      const after = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(after.status, 404, "the job must no longer be available once Management confirms receipt");
      assert.equal(after.body.error.code, "NOT_FOUND");
    });

    test("5. cancelled historical ASSIGNED -> 404", async () => {
      const driver = await createDriverWithToken("collect-detail-cancelled");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);

      const before = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(before.status, 200);

      const cancel = await cancelOrder(order.id);
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

      const after = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(after.status, 404);
    });
  });

  // ============================================================
  // DELIVERY — current-job states
  // ============================================================

  describe("Delivery detail — current-job states", () => {
    test("6. ASSIGNED -> 200", async () => {
      const driver = await createDriverWithToken("deliver-detail-assigned");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.jobType, "DELIVERY");
      assert.equal(res.body.data.status, "ASSIGNED");
    });

    test("7. PICKED_UP -> 200", async () => {
      const driver = await createDriverWithToken("deliver-detail-pickedup");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);
      await pickup(order.id, driver.token);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "PICKED_UP");
    });

    test("8. OUT_FOR_DELIVERY -> 200, authoritative amountToCollect", async () => {
      const driver = await createDriverWithToken("deliver-detail-ofd");
      const order = await createDeliveryOrderAssignedTo(driver.driverId, { orderAmount: "40.00", deliveryFee: "6.00" });
      await pickup(order.id, driver.token);
      await startDelivery(order.id, driver.token);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200);
      assert.equal(res.body.data.status, "OUT_FOR_DELIVERY");
      assert.equal(res.body.data.collection.amountToCollect, "46");
    });

    test("9. RESCHEDULED -> 200 (Phase 7 retry semantics preserved)", async () => {
      const driver = await createDriverWithToken("deliver-detail-rescheduled");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);
      await pickup(order.id, driver.token);
      await startDelivery(order.id, driver.token);
      await failDelivery(order.id, driver.token);
      await rescheduleDelivery(order.id);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "RESCHEDULED");
    });

    test("10. DELIVERED (terminal) -> 404", async () => {
      const driver = await createDriverWithToken("deliver-detail-terminal");
      const order = await createDeliveryOrderAssignedTo(driver.driverId, { orderAmount: "0.00", deliveryFee: "5.00" });
      await pickup(order.id, driver.token);
      await startDelivery(order.id, driver.token);
      await deliverExact(order.id, driver.token, "5.00");

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 404);
    });

    test("11. CANCELLED -> 404", async () => {
      const driver = await createDriverWithToken("deliver-detail-cancelled");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);
      const cancel = await cancelOrder(order.id);
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 404);
    });
  });

  // ============================================================
  // IDOR + WRONG JOB TYPE
  // ============================================================

  describe("IDOR and wrong job type", () => {
    test("12. Driver B cannot see Driver A's Collection job detail", async () => {
      const driverA = await createDriverWithToken("idor-collect-a");
      const driverB = await createDriverWithToken("idor-collect-b");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driverA.driverId);

      const res = await request(app).get(detailPath("collection", order.id)).set(auth(driverB.token));
      assert.equal(res.status, 404);
      assert.equal(res.body.error.code, "NOT_FOUND");
    });

    test("13. Driver B cannot see Driver A's Delivery job detail", async () => {
      const driverA = await createDriverWithToken("idor-deliver-a");
      const driverB = await createDriverWithToken("idor-deliver-b");
      const order = await createDeliveryOrderAssignedTo(driverA.driverId);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driverB.token));
      assert.equal(res.status, 404);
    });

    test("14. nonexistent Order gets the identical 404 as a wrong-owned Order", async () => {
      const driverA = await createDriverWithToken("idor-identical-a");
      const driverB = await createDriverWithToken("idor-identical-b");
      const order = await createDeliveryOrderAssignedTo(driverA.driverId);

      const forOther = await request(app).get(detailPath("delivery", order.id)).set(auth(driverB.token));
      const forMissing = await request(app)
        .get(detailPath("delivery", "00000000-0000-0000-0000-000000000000"))
        .set(auth(driverB.token));
      assert.equal(forOther.status, forMissing.status);
      assert.equal(forOther.body.error.code, forMissing.body.error.code);
      assert.equal(forOther.status, 404);
    });

    test("15. own COLLECTION job requested as delivery type -> 404 (no auto-return of the other type)", async () => {
      const driver = await createDriverWithToken("wrongtype-collect-as-delivery");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 404);
    });

    test("16. own DELIVERY job requested as collection type -> 404", async () => {
      const driver = await createDriverWithToken("wrongtype-deliver-as-collect");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);

      const res = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(res.status, 404);
    });
  });

  // ============================================================
  // DTO PRIVACY
  // ============================================================

  describe("DTO privacy", () => {
    test("17. Collection detail exact safe field set — no money, no finance leak", async () => {
      const driver = await createDriverWithToken("dto-collect-detail");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);

      const res = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200);
      assert.deepEqual(
        Object.keys(res.body.data).sort(),
        ["assignedAt", "assignmentId", "collectedFromSenderAt", "contact", "jobType", "orderId", "orderNumber", "orderType", "package", "status", "trackingCode"].sort()
      );
      assert.deepEqual(Object.keys(res.body.data.contact).sort(), ["address", "altPhone", "area", "name", "notes", "phone"].sort());
      assert.deepEqual(
        Object.keys(res.body.data.package).sort(),
        ["description", "notes", "packageCount", "quantity", "weightKg"].sort()
      );

      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /amountToCollect|amount_to_collect|paymentMethod|paymentType/i);
      assert.doesNotMatch(serialized, /wallet|driver_cash|company_financial|payout|settlement/i);
      assert.doesNotMatch(serialized, /password_hash|refresh_token|auth_sessions/i);
      assert.doesNotMatch(serialized, /assignedBy|receivedAtCompanyBy|assignments":\[|attempts":\[/i);
    });

    test("18. Delivery detail exact safe field set — Payment Type/Method + authoritative amount, no Management-only fields", async () => {
      const driver = await createDriverWithToken("dto-deliver-detail");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);

      const res = await request(app).get(detailPath("delivery", order.id)).set(auth(driver.token));
      assert.equal(res.status, 200);
      assert.deepEqual(
        Object.keys(res.body.data).sort(),
        ["collection", "jobType", "orderId", "orderNumber", "orderType", "package", "paymentType", "receiver", "status", "timestamps", "trackingCode"].sort()
      );
      assert.equal(res.body.data.paymentType, "CASH_ON_DELIVERY");
      assert.deepEqual(Object.keys(res.body.data.collection).sort(), ["amountToCollect", "actualAmountCollected", "paymentMethod"].sort());
      assert.equal(typeof res.body.data.collection.amountToCollect, "string");

      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /wallet|driver_cash|company_financial|payout|settlement/i);
      assert.doesNotMatch(serialized, /financialStatus|needsFinancialReview|collectionDifferenceReason/i);
      assert.doesNotMatch(serialized, /password_hash|refresh_token|auth_sessions/i);
      assert.doesNotMatch(serialized, /statusHistory|assignmentHistory|deliveryAttempts|financialEvents/i);
    });
  });

  // ============================================================
  // SNAPSHOT IMMUTABILITY
  // ============================================================

  describe("Snapshot immutability", () => {
    test("19. Collection detail reflects the Order's snapshot, not a later Customer profile edit", async () => {
      const driver = await createDriverWithToken("snapshot-collect");
      const snapshotCustomerId = await seedCustomerRecord(admin.id, {
        name: "Snapshot Original Name",
        primaryPhone: "+96170009999",
        areaId: area.id,
        defaultAddress: "Original Address 1",
      });
      customerIds.push(snapshotCustomerId);

      const order = await createOrder({
        customerId: snapshotCustomerId,
        parcelIntakeMethod: "DRIVER_COLLECTION",
      });
      await assignCollection(order.id, driver.driverId);

      const before = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(before.status, 200, JSON.stringify(before.body));
      assert.equal(before.body.data.contact.name, "Snapshot Original Name");
      assert.equal(before.body.data.contact.address, "Original Address 1");

      await request(app)
        .patch(`/api/v1/customers/${snapshotCustomerId}`)
        .set(auth(tokens.admin))
        .send({ name: "Changed Name After Order", defaultAddress: "Changed Address 2" });

      const after = await request(app).get(detailPath("collection", order.id)).set(auth(driver.token));
      assert.equal(after.status, 200);
      assert.equal(after.body.data.contact.name, "Snapshot Original Name", "the Collection snapshot must not follow a later Customer edit");
      assert.equal(after.body.data.contact.address, "Original Address 1");
    });
  });

  // ============================================================
  // READ-ONLY GUARANTEE
  // ============================================================

  describe("Read-only guarantee", () => {
    test("20. GET Job Detail causes zero mutations", async () => {
      const driver = await createDriverWithToken("readonly-detail");
      const collectionOrder = await createCollectionOrder();
      await assignCollection(collectionOrder.id, driver.driverId);
      const deliveryOrder = await createDeliveryOrderAssignedTo(driver.driverId);

      const beforeCollection = await prisma.orders.findUniqueOrThrow({ where: { id: collectionOrder.id } });
      const beforeDelivery = await prisma.orders.findUniqueOrThrow({ where: { id: deliveryOrder.id } });
      const [assignmentsBefore, attemptsBefore, auditBefore] = await Promise.all([
        prisma.parcel_collection_assignments.count({ where: { order_id: collectionOrder.id } }),
        prisma.delivery_attempts.count({ where: { order_id: deliveryOrder.id } }),
        prisma.audit_logs.count(),
      ]);

      await request(app).get(detailPath("collection", collectionOrder.id)).set(auth(driver.token));
      await request(app).get(detailPath("collection", collectionOrder.id)).set(auth(driver.token));
      await request(app).get(detailPath("delivery", deliveryOrder.id)).set(auth(driver.token));
      await request(app).get(detailPath("delivery", deliveryOrder.id)).set(auth(driver.token));

      const afterCollection = await prisma.orders.findUniqueOrThrow({ where: { id: collectionOrder.id } });
      const afterDelivery = await prisma.orders.findUniqueOrThrow({ where: { id: deliveryOrder.id } });
      assert.equal(afterCollection.updated_at.getTime(), beforeCollection.updated_at.getTime());
      assert.equal(afterDelivery.updated_at.getTime(), beforeDelivery.updated_at.getTime());

      const [assignmentsAfter, attemptsAfter, auditAfter] = await Promise.all([
        prisma.parcel_collection_assignments.count({ where: { order_id: collectionOrder.id } }),
        prisma.delivery_attempts.count({ where: { order_id: deliveryOrder.id } }),
        prisma.audit_logs.count(),
      ]);
      assert.equal(assignmentsAfter, assignmentsBefore);
      assert.equal(attemptsAfter, attemptsBefore);
      assert.equal(auditAfter, auditBefore);
    });
  });
});
