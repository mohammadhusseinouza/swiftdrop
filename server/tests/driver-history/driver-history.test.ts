import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 12.5 — GET /api/v1/driver/history ("Completed" + "Failed / Returned").
//
// Covers task §73: authorization, own-Driver scoping (IDOR), Delivery /
// Collection completed + failed attribution, retry / reschedule / reassign
// preserving the ORIGINAL Driver, same-Driver-both-job-types, no duplicate
// history rows, interleaved cross-type pagination, deterministic ordering,
// result + jobType filters, DTO privacy, and zero mutation side effects.
// Plus §75: the Driver Cash self-view across a real Finance settlement.
// ============================================================

describe("Driver Portal — Work History (Phase 12.5)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  let failedDeliveryReasonId: string;
  let failedCollectionReasonId: string;

  const orderIds: string[] = [];
  const driverIds: string[] = [];
  const userIds: string[] = [];
  const reasonIds: string[] = [];

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
    area = await createTestArea();
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const suffix = uniqueSuffix();
    const deliveryReason = await prisma.failed_delivery_reasons.create({
      data: { name: `Phase125 Delivery Reason ${suffix}`, requires_notes: false, is_active: true },
    });
    failedDeliveryReasonId = deliveryReason.id;
    reasonIds.push(deliveryReason.id);
    const collectionReason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    failedCollectionReasonId = collectionReason.id;
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    for (const id of reasonIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "FAILED_DELIVERY_REASON", entity_id: id } });
      await prisma.failed_delivery_reasons.deleteMany({ where: { id } });
    }
    for (const id of userIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }
  function historyPath(qs = "") {
    return `/api/v1/driver/history${qs}`;
  }

  async function createDriver(label: string) {
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
        receiverName: "Phase125 Receiver",
        receiverPhone: "+96170000125",
        receiverAreaId: area.id,
        receiverAddress: "1 Phase125 St",
        description: "Phase125 history order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        parcelIntakeMethod: "ALREADY_AT_COMPANY",
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    orderIds.push(res.body.data.id);
    return res.body.data as { id: string; orderNumber: string };
  }

  async function createCollectionOrder(overrides: Record<string, unknown> = {}) {
    return createOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionContactName: "Phase125 Sender",
      parcelCollectionPhone: "+96171000125",
      parcelCollectionAddress: "1 Phase125 Collection St",
      parcelCollectionAreaId: area.id,
      ...overrides,
    });
  }

  function assignCollection(orderId: string, driverId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/assign`).set(auth(tokens.admin)).send({ driverId });
  }
  function reassignCollection(orderId: string, driverId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reassign`).set(auth(tokens.admin)).send({ driverId });
  }
  function rescheduleCollection(orderId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/reschedule`).set(auth(tokens.admin)).send({});
  }
  function markCollected(orderId: string, token: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/parcel-collection/collected`).set(auth(token)).send({});
  }
  function failCollection(orderId: string, token: string) {
    return request(app)
      .post(`/api/v1/driver/orders/${orderId}/parcel-collection/failed`)
      .set(auth(token))
      .send({ failedCollectionReasonId });
  }
  function receiveAtCompany(orderId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({});
  }

  async function collectionCompletedBy(driverId: string, token: string, overrides: Record<string, unknown> = {}) {
    const order = await createCollectionOrder(overrides);
    assert.equal((await assignCollection(order.id, driverId)).status, 200);
    assert.equal((await markCollected(order.id, token)).status, 200);
    assert.equal((await receiveAtCompany(order.id)).status, 200);
    return order;
  }

  async function collectionFailedBy(driverId: string, token: string) {
    const order = await createCollectionOrder();
    assert.equal((await assignCollection(order.id, driverId)).status, 200);
    assert.equal((await failCollection(order.id, token)).status, 200);
    return order;
  }

  async function assignDelivery(orderId: string, driverId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
  }
  async function reassignDelivery(orderId: string, driverId: string) {
    return request(app)
      .post(`/api/v1/orders/${orderId}/reassign`)
      .set(auth(tokens.admin))
      .send({ driverId, reason: "phase 12.5 reassignment" });
  }
  async function pickup(orderId: string, token: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(token)).send();
  }
  async function startDelivery(orderId: string, token: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(token)).send();
  }
  async function deliver(orderId: string, token: string, actualAmountCollected = "105.00") {
    return request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(token)).send({ actualAmountCollected });
  }
  async function failDelivery(orderId: string, token: string) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/fail`).set(auth(token)).send({ failedReasonId: failedDeliveryReasonId });
  }

  async function deliveryCompletedBy(driverId: string, token: string) {
    const order = await createOrder();
    assert.equal((await assignDelivery(order.id, driverId)).status, 200);
    assert.equal((await pickup(order.id, token)).status, 200);
    assert.equal((await startDelivery(order.id, token)).status, 200);
    assert.equal((await deliver(order.id, token)).status, 200);
    return order;
  }

  async function deliveryFailedBy(driverId: string, token: string) {
    const order = await createOrder();
    assert.equal((await assignDelivery(order.id, driverId)).status, 200);
    assert.equal((await pickup(order.id, token)).status, 200);
    assert.equal((await startDelivery(order.id, token)).status, 200);
    assert.equal((await failDelivery(order.id, token)).status, 200);
    return order;
  }

  function items(body: { data: unknown[] }): any[] {
    return body.data as any[];
  }
  function find(body: { data: unknown[] }, jobType: string, result: string, orderId: string): any {
    return items(body).find((i) => i.jobType === jobType && i.result === result && i.orderId === orderId);
  }

  // ============================================================
  // 1-4. AUTHORIZATION
  // ============================================================

  describe("Authorization", () => {
    test("1. DRIVER with a linked profile -> 200", async () => {
      const driver = await createDriver("auth-driver");
      const res = await request(app).get(historyPath()).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data, []);
      assert.equal(res.body.meta.page, 1);
      assert.equal(res.body.meta.limit, 20);
      assert.equal(res.body.meta.total, 0);
    });

    test("2. ADMIN / DISPATCHER / FINANCE -> 403 (portal denial before profile lookup)", async () => {
      for (const role of ["admin", "dispatcher", "finance"] as const) {
        const res = await request(app).get(historyPath()).set(auth(tokens[role]));
        assert.equal(res.status, 403, `${role} must be 403`);
      }
      const adminRes = await request(app).get(historyPath()).set(auth(tokens.admin));
      assert.equal(adminRes.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(adminRes.body), /prisma|relation|foreign key/i);
    });

    test("3. CUSTOMER -> 403", async () => {
      const res = await request(app).get(historyPath()).set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });

    test("4. unauthenticated -> 401", async () => {
      const res = await request(app).get(historyPath());
      assert.equal(res.status, 401);
    });
  });

  // ============================================================
  // 5-6. DELIVERY completed + failed attribution
  // ============================================================

  describe("Delivery attribution", () => {
    test("5. a successful delivery appears as DELIVERY / COMPLETED with the Driver's own actual amount", async () => {
      const driver = await createDriver("del-completed");
      const order = await deliveryCompletedBy(driver.driverId, driver.token);

      const res = await request(app).get(historyPath()).set(auth(driver.token));
      assert.equal(res.status, 200);
      const row = find(res.body, "DELIVERY", "COMPLETED", order.id);
      assert.ok(row, "expected a completed delivery history row");
      assert.equal(row.actualAmountCollected, "105");
      assert.equal(row.attemptNumber, 1);
      assert.ok(row.completedAt);
      assert.equal(row.occurredAt, row.completedAt);
      assert.equal(row.resultingOrderStatus, "DELIVERED");
    });

    test("6. a failed delivery appears as DELIVERY / FAILED with the reason, no amount", async () => {
      const driver = await createDriver("del-failed");
      const order = await deliveryFailedBy(driver.driverId, driver.token);

      const res = await request(app).get(historyPath()).set(auth(driver.token));
      const row = find(res.body, "DELIVERY", "FAILED", order.id);
      assert.ok(row, "expected a failed delivery history row");
      assert.ok(row.failure.reasonName);
      assert.equal(row.resultingOrderStatus, "FAILED_DELIVERY");
      assert.equal(JSON.stringify(row).includes("actualAmountCollected"), false);
    });
  });

  // ============================================================
  // 7. failed -> reschedule -> reassignment preserves the ORIGINAL Driver
  // ============================================================

  describe("Delivery retry / reassignment history", () => {
    test("7. Driver A fails, Management reassigns to Driver B who delivers: A keeps FAILED only, B keeps COMPLETED only", async () => {
      const driverA = await createDriver("retry-a");
      const driverB = await createDriver("retry-b");

      const order = await createOrder();
      assert.equal((await assignDelivery(order.id, driverA.driverId)).status, 200);
      assert.equal((await pickup(order.id, driverA.token)).status, 200);
      assert.equal((await startDelivery(order.id, driverA.token)).status, 200);
      assert.equal((await failDelivery(order.id, driverA.token)).status, 200);

      // Management reschedules then reassigns to B.
      const reschedule = await request(app)
        .post(`/api/v1/orders/${order.id}/reschedule`)
        .set(auth(tokens.admin))
        .send({ reason: "retry" });
      assert.equal(reschedule.status, 200, JSON.stringify(reschedule.body));
      assert.equal((await reassignDelivery(order.id, driverB.driverId)).status, 200);
      assert.equal((await pickup(order.id, driverB.token)).status, 200);
      assert.equal((await startDelivery(order.id, driverB.token)).status, 200);
      assert.equal((await deliver(order.id, driverB.token)).status, 200);

      const aRes = await request(app).get(historyPath()).set(auth(driverA.token));
      const aRows = items(aRes.body).filter((i) => i.orderId === order.id);
      assert.equal(aRows.length, 1);
      assert.equal(aRows[0].jobType, "DELIVERY");
      assert.equal(aRows[0].result, "FAILED");
      assert.equal(aRows[0].resultingOrderStatus, "DELIVERED", "the resulting status follows the Order; the row's result stays FAILED");

      const bRes = await request(app).get(historyPath()).set(auth(driverB.token));
      const bRows = items(bRes.body).filter((i) => i.orderId === order.id);
      assert.equal(bRows.length, 1);
      assert.equal(bRows[0].result, "COMPLETED");
    });
  });

  // ============================================================
  // 8-10. COLLECTION completed / failed / retry attribution
  // ============================================================

  describe("Collection attribution", () => {
    test("8. a Collection appears as COMPLETED only after company receipt (assignment ended RECEIVED_AT_COMPANY)", async () => {
      const driver = await createDriver("col-completed");
      const order = await createCollectionOrder();
      assert.equal((await assignCollection(order.id, driver.driverId)).status, 200);
      assert.equal((await markCollected(order.id, driver.token)).status, 200);

      // After COLLECTED_FROM_SENDER but BEFORE company receipt: not yet history.
      const mid = await request(app).get(historyPath()).set(auth(driver.token));
      assert.ok(!find(mid.body, "COLLECTION", "COMPLETED", order.id), "custody kept — not completed history yet");

      assert.equal((await receiveAtCompany(order.id)).status, 200);
      const done = await request(app).get(historyPath()).set(auth(driver.token));
      const row = find(done.body, "COLLECTION", "COMPLETED", order.id);
      assert.ok(row, "completed after company receipt");
      assert.equal(JSON.stringify(row).includes("amountToCollect"), false, "Collection completed shows no money");
      assert.ok(row.completedAt);
      assert.equal(row.occurredAt, row.completedAt);
      assert.equal(row.resultingParcelCollectionStatus, "RECEIVED_AT_COMPANY");
    });

    test("9. a failed Collection appears as COLLECTION / FAILED with reason + resulting status", async () => {
      const driver = await createDriver("col-failed");
      const order = await collectionFailedBy(driver.driverId, driver.token);

      const res = await request(app).get(historyPath()).set(auth(driver.token));
      const row = find(res.body, "COLLECTION", "FAILED", order.id);
      assert.ok(row);
      assert.equal(row.attemptNumber, 1);
      assert.ok(row.failure.reasonName);
      assert.equal(row.resultingParcelCollectionStatus, "FAILED");
    });

    test("10. Driver A fails Collection, Management reschedules + assigns B who collects: A keeps FAILED, B keeps COMPLETED", async () => {
      const driverA = await createDriver("col-retry-a");
      const driverB = await createDriver("col-retry-b");

      const order = await createCollectionOrder();
      assert.equal((await assignCollection(order.id, driverA.driverId)).status, 200);
      assert.equal((await failCollection(order.id, driverA.token)).status, 200);
      assert.equal((await rescheduleCollection(order.id)).status, 200);
      assert.equal((await assignCollection(order.id, driverB.driverId)).status, 200);
      assert.equal((await markCollected(order.id, driverB.token)).status, 200);
      assert.equal((await receiveAtCompany(order.id)).status, 200);

      const aRes = await request(app).get(historyPath()).set(auth(driverA.token));
      const aRows = items(aRes.body).filter((i) => i.orderId === order.id);
      assert.equal(aRows.length, 1);
      assert.equal(aRows[0].result, "FAILED");

      const bRes = await request(app).get(historyPath()).set(auth(driverB.token));
      const bRows = items(bRes.body).filter((i) => i.orderId === order.id);
      assert.equal(bRows.length, 1);
      assert.equal(bRows[0].result, "COMPLETED");
    });

    test("reassignment before collection preserves the first Driver's absence of history (no attempt made)", async () => {
      const driverA = await createDriver("col-reassign-a");
      const driverB = await createDriver("col-reassign-b");
      const order = await createCollectionOrder();
      assert.equal((await assignCollection(order.id, driverA.driverId)).status, 200);
      assert.equal((await reassignCollection(order.id, driverB.driverId)).status, 200);
      assert.equal((await markCollected(order.id, driverB.token)).status, 200);
      assert.equal((await receiveAtCompany(order.id)).status, 200);

      const aRes = await request(app).get(historyPath()).set(auth(driverA.token));
      assert.equal(items(aRes.body).filter((i) => i.orderId === order.id).length, 0, "A made no attempt and never received the parcel");
      const bRes = await request(app).get(historyPath()).set(auth(driverB.token));
      assert.equal(find(bRes.body, "COLLECTION", "COMPLETED", order.id) != null, true);
    });
  });

  // ============================================================
  // 11. same Driver, Collection + Delivery, same Order -> two records
  // ============================================================

  describe("Same Driver, two job types, one Order", () => {
    test("11. one Driver collects then later delivers the same Order — Completed history has TWO rows, never merged", async () => {
      const driver = await createDriver("both-jobs");
      const order = await createCollectionOrder();
      assert.equal((await assignCollection(order.id, driver.driverId)).status, 200);
      assert.equal((await markCollected(order.id, driver.token)).status, 200);
      assert.equal((await receiveAtCompany(order.id)).status, 200);
      // Now the same physical Driver takes the delivery job.
      assert.equal((await assignDelivery(order.id, driver.driverId)).status, 200);
      assert.equal((await pickup(order.id, driver.token)).status, 200);
      assert.equal((await startDelivery(order.id, driver.token)).status, 200);
      assert.equal((await deliver(order.id, driver.token)).status, 200);

      const res = await request(app).get(historyPath("?result=COMPLETED")).set(auth(driver.token));
      const rows = items(res.body).filter((i) => i.orderId === order.id);
      assert.equal(rows.length, 2);
      assert.ok(rows.some((r) => r.jobType === "COLLECTION"));
      assert.ok(rows.some((r) => r.jobType === "DELIVERY"));
    });
  });

  // ============================================================
  // 12-13. no duplicate history rows
  // ============================================================

  describe("Duplicate prevention", () => {
    test("12. a completed Collection produces exactly ONE row — the COLLECTED attempt does not add a second", async () => {
      const driver = await createDriver("col-dup");
      const order = await collectionCompletedBy(driver.driverId, driver.token);
      const res = await request(app).get(historyPath()).set(auth(driver.token));
      assert.equal(items(res.body).filter((i) => i.orderId === order.id).length, 1);
    });

    test("13. a failed Collection produces exactly ONE row — the assignment's end_reason=FAILED does not add a second", async () => {
      const driver = await createDriver("col-fail-dup");
      const order = await collectionFailedBy(driver.driverId, driver.token);
      const res = await request(app).get(historyPath()).set(auth(driver.token));
      const rows = items(res.body).filter((i) => i.orderId === order.id);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].result, "FAILED");
    });

    test("a delivered Order produces exactly ONE row — status history is not merged into attempts", async () => {
      const driver = await createDriver("del-dup");
      const order = await deliveryCompletedBy(driver.driverId, driver.token);
      const res = await request(app).get(historyPath()).set(auth(driver.token));
      assert.equal(items(res.body).filter((i) => i.orderId === order.id).length, 1);
    });
  });

  // ============================================================
  // 14-15. interleaved cross-type pagination + deterministic ordering
  // ============================================================

  describe("Global pagination + ordering", () => {
    test("14-15. concatenated pages reproduce the exact global chronological sequence — no gaps, no duplicates, stable", async () => {
      const driver = await createDriver("paging");

      // Build 8 history events in a known order. Real workflow creates them;
      // we then stamp deterministic strictly-decreasing timestamps directly
      // so no two can tie (offsetIndex 0 = newest).
      const events: Array<{ jobType: string; result: string; orderId: string; id: string }> = [];

      const dc1 = await deliveryCompletedBy(driver.driverId, driver.token);
      events.push({ jobType: "DELIVERY", result: "COMPLETED", orderId: dc1.id, id: "" });
      const cf1 = await collectionFailedBy(driver.driverId, driver.token);
      events.push({ jobType: "COLLECTION", result: "FAILED", orderId: cf1.id, id: "" });
      const df1 = await deliveryFailedBy(driver.driverId, driver.token);
      events.push({ jobType: "DELIVERY", result: "FAILED", orderId: df1.id, id: "" });
      const cc1 = await collectionCompletedBy(driver.driverId, driver.token);
      events.push({ jobType: "COLLECTION", result: "COMPLETED", orderId: cc1.id, id: "" });
      const dc2 = await deliveryCompletedBy(driver.driverId, driver.token);
      events.push({ jobType: "DELIVERY", result: "COMPLETED", orderId: dc2.id, id: "" });
      const cf2 = await collectionFailedBy(driver.driverId, driver.token);
      events.push({ jobType: "COLLECTION", result: "FAILED", orderId: cf2.id, id: "" });
      const cc2 = await collectionCompletedBy(driver.driverId, driver.token);
      events.push({ jobType: "COLLECTION", result: "COMPLETED", orderId: cc2.id, id: "" });
      const df2 = await deliveryFailedBy(driver.driverId, driver.token);
      events.push({ jobType: "DELIVERY", result: "FAILED", orderId: df2.id, id: "" });

      function tsAt(offsetIndex: number): Date {
        return new Date(Date.UTC(2031, 0, 1, 0, 0, 0, 0) - offsetIndex * 60_000);
      }

      // Stamp: events[0] newest. For each event, set its canonical timestamp.
      for (let i = 0; i < events.length; i++) {
        const e = events[i];
        const when = tsAt(i);
        if (e.jobType === "DELIVERY") {
          await prisma.delivery_attempts.updateMany({
            where: { order_id: e.orderId, driver_id: driver.driverId },
            data: { completed_at: when },
          });
        } else if (e.result === "FAILED") {
          await prisma.parcel_collection_attempts.updateMany({
            where: { order_id: e.orderId, driver_id: driver.driverId, outcome: "FAILED" },
            data: { completed_at: when },
          });
        } else {
          await prisma.parcel_collection_assignments.updateMany({
            where: { order_id: e.orderId, driver_id: driver.driverId, end_reason: "RECEIVED_AT_COMPANY" },
            data: { ended_at: when },
          });
        }
      }

      // Fetch every page at limit=3 and concatenate.
      const first = await request(app).get(historyPath("?limit=3&page=1")).set(auth(driver.token));
      assert.equal(first.status, 200);
      assert.equal(first.body.meta.total, 8);
      assert.equal(first.body.meta.totalPages, 3);
      const pages = [first.body.data];
      for (let p = 2; p <= first.body.meta.totalPages; p++) {
        const res = await request(app).get(historyPath(`?limit=3&page=${p}`)).set(auth(driver.token));
        pages.push(res.body.data);
      }
      assert.deepEqual(pages.map((p) => p.length), [3, 3, 2]);

      const flat = pages.flat() as any[];
      assert.deepEqual(
        flat.map((i) => ({ jobType: i.jobType, result: i.result, orderId: i.orderId })),
        events.map((e) => ({ jobType: e.jobType, result: e.result, orderId: e.orderId })),
        "concatenated pages must equal the true global chronological sequence",
      );
      const seen = new Set(flat.map((i) => i.id));
      assert.equal(seen.size, flat.length, "no duplicate rows across pages");

      // Deterministic: identical repeated call.
      const again = await request(app).get(historyPath("?limit=3&page=1")).set(auth(driver.token));
      assert.deepEqual(
        again.body.data.map((i: any) => i.id),
        first.body.data.map((i: any) => i.id),
      );
    });

    test("over-max limit / bad page -> 400", async () => {
      const driver = await createDriver("paging-bounds");
      assert.equal((await request(app).get(historyPath("?limit=101")).set(auth(driver.token))).status, 400);
      assert.equal((await request(app).get(historyPath("?page=0")).set(auth(driver.token))).status, 400);
    });
  });

  // ============================================================
  // 16-17. result + jobType filters
  // ============================================================

  describe("Filters", () => {
    test("16-17. result and jobType filters narrow the set; an invalid value -> 400", async () => {
      const driver = await createDriver("filters");
      const dc = await deliveryCompletedBy(driver.driverId, driver.token);
      const df = await deliveryFailedBy(driver.driverId, driver.token);
      const cc = await collectionCompletedBy(driver.driverId, driver.token);
      const cf = await collectionFailedBy(driver.driverId, driver.token);

      const completed = await request(app).get(historyPath("?result=COMPLETED")).set(auth(driver.token));
      assert.ok(items(completed.body).every((i) => i.result === "COMPLETED"));
      assert.ok(find(completed.body, "DELIVERY", "COMPLETED", dc.id));
      assert.ok(find(completed.body, "COLLECTION", "COMPLETED", cc.id));
      assert.ok(!items(completed.body).some((i) => i.orderId === df.id));

      const failed = await request(app).get(historyPath("?result=FAILED")).set(auth(driver.token));
      assert.ok(items(failed.body).every((i) => i.result === "FAILED"));
      assert.ok(find(failed.body, "COLLECTION", "FAILED", cf.id));

      const delivery = await request(app).get(historyPath("?jobType=DELIVERY")).set(auth(driver.token));
      assert.ok(items(delivery.body).every((i) => i.jobType === "DELIVERY"));

      const collection = await request(app).get(historyPath("?jobType=COLLECTION")).set(auth(driver.token));
      assert.ok(items(collection.body).every((i) => i.jobType === "COLLECTION"));

      const both = await request(app).get(historyPath("?jobType=COLLECTION&result=FAILED")).set(auth(driver.token));
      assert.ok(items(both.body).every((i) => i.jobType === "COLLECTION" && i.result === "FAILED"));
      assert.ok(find(both.body, "COLLECTION", "FAILED", cf.id));

      assert.equal((await request(app).get(historyPath("?result=BOGUS")).set(auth(driver.token))).status, 400);
      assert.equal((await request(app).get(historyPath("?jobType=BOGUS")).set(auth(driver.token))).status, 400);
    });
  });

  // ============================================================
  // IDOR (task §56)
  // ============================================================

  describe("Ownership / IDOR", () => {
    test("Driver A never sees Driver B's Delivery or Collection history, even on a shared Order", async () => {
      const driverA = await createDriver("idor-a");
      const driverB = await createDriver("idor-b");

      // Shared Order: B collects, A delivers.
      const shared = await createCollectionOrder();
      assert.equal((await assignCollection(shared.id, driverB.driverId)).status, 200);
      assert.equal((await markCollected(shared.id, driverB.token)).status, 200);
      assert.equal((await receiveAtCompany(shared.id)).status, 200);
      assert.equal((await assignDelivery(shared.id, driverA.driverId)).status, 200);
      assert.equal((await pickup(shared.id, driverA.token)).status, 200);
      assert.equal((await startDelivery(shared.id, driverA.token)).status, 200);
      assert.equal((await deliver(shared.id, driverA.token)).status, 200);

      const bFailed = await deliveryFailedBy(driverB.driverId, driverB.token);

      const aRes = await request(app).get(historyPath()).set(auth(driverA.token));
      const aForShared = items(aRes.body).filter((i) => i.orderId === shared.id);
      assert.equal(aForShared.length, 1);
      assert.equal(aForShared[0].jobType, "DELIVERY");
      assert.ok(!items(aRes.body).some((i) => i.orderId === bFailed.id), "A must not see B's failed delivery");

      const bRes = await request(app).get(historyPath()).set(auth(driverB.token));
      const bForShared = items(bRes.body).filter((i) => i.orderId === shared.id);
      assert.equal(bForShared.length, 1);
      assert.equal(bForShared[0].jobType, "COLLECTION");
    });

    test("no client-supplied driverId query param can widen scope", async () => {
      const driverA = await createDriver("idor-scope-a");
      const driverB = await createDriver("idor-scope-b");
      await deliveryCompletedBy(driverB.driverId, driverB.token);

      const res = await request(app).get(historyPath(`?driverId=${driverB.driverId}`)).set(auth(driverA.token));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, []);
    });
  });

  // ============================================================
  // 18. DTO privacy
  // ============================================================

  describe("DTO privacy", () => {
    test("18. no wallet / company-finance / driver-cash / financial-review / settlement / receipt-employee / audit leak", async () => {
      const driver = await createDriver("dto");
      await deliveryCompletedBy(driver.driverId, driver.token);
      await deliveryFailedBy(driver.driverId, driver.token);
      await collectionCompletedBy(driver.driverId, driver.token);
      await collectionFailedBy(driver.driverId, driver.token);

      const res = await request(app).get(historyPath("?limit=100")).set(auth(driver.token));
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /wallet|driver_cash|driverCash|company_financial|companyRevenue|payout|settlement/i);
      assert.doesNotMatch(serialized, /financialStatus|needsFinancialReview|collectionDifferenceReason/i);
      assert.doesNotMatch(serialized, /receivedAtCompanyBy|assignedBy|received_at_company_by/i);
      assert.doesNotMatch(serialized, /password_hash|refresh_token|auth_sessions/i);
      assert.doesNotMatch(serialized, /idempotency/i);

      const completedDelivery = items(res.body).find((i) => i.jobType === "DELIVERY" && i.result === "COMPLETED");
      assert.deepEqual(
        Object.keys(completedDelivery).sort(),
        [
          "actualAmountCollected", "attemptId", "attemptNumber", "completedAt", "id", "jobType",
          "occurredAt", "orderId", "orderNumber", "orderType", "paymentMethod", "receiver",
          "result", "resultingOrderStatus", "trackingCode",
        ].sort(),
      );

      const completedCollection = items(res.body).find((i) => i.jobType === "COLLECTION" && i.result === "COMPLETED");
      assert.deepEqual(
        Object.keys(completedCollection).sort(),
        [
          "assignmentId", "collectedFromSenderAt", "completedAt", "contact", "id", "jobType",
          "occurredAt", "orderId", "orderNumber", "orderType", "result", "resultingOrderStatus",
          "resultingParcelCollectionStatus", "trackingCode",
        ].sort(),
      );
      assert.deepEqual(Object.keys(completedCollection.contact).sort(), ["address", "area", "name"].sort());
    });
  });

  // ============================================================
  // 19. no mutation side effects
  // ============================================================

  describe("Read-only guarantee", () => {
    test("19. fetching history creates zero wallet / driver-cash / company-finance / audit / attempt rows", async () => {
      const driver = await createDriver("readonly");
      const order = await deliveryCompletedBy(driver.driverId, driver.token);

      const before = await Promise.all([
        prisma.wallet_transactions.count(),
        prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } }),
        prisma.company_financial_transactions.count(),
        prisma.audit_logs.count(),
        prisma.delivery_attempts.count({ where: { order_id: order.id } }),
      ]);

      await request(app).get(historyPath()).set(auth(driver.token));
      await request(app).get(historyPath("?result=FAILED")).set(auth(driver.token));
      await request(app).get(historyPath("?jobType=COLLECTION")).set(auth(driver.token));

      const afterCounts = await Promise.all([
        prisma.wallet_transactions.count(),
        prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } }),
        prisma.company_financial_transactions.count(),
        prisma.audit_logs.count(),
        prisma.delivery_attempts.count({ where: { order_id: order.id } }),
      ]);
      assert.deepEqual(afterCounts, before);
    });
  });

  // ============================================================
  // §75 — Driver Cash self-view across a real Finance settlement
  // ============================================================

  describe("Driver Cash self-view across a real settlement (task §75)", () => {
    test("deliver 105 -> currentBalance 105 with a COLLECTION row; Finance settles 70 -> 35 with a SETTLEMENT row; no wallet/company leak", async () => {
      const driver = await createDriver("cash-integration");

      const zero = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(zero.body.data.account.currentBalance, "0");

      const order = await createOrder({ orderType: "COMPANY_ORDER" });
      assert.equal((await assignDelivery(order.id, driver.driverId)).status, 200);
      assert.equal((await pickup(order.id, driver.token)).status, 200);
      assert.equal((await startDelivery(order.id, driver.token)).status, 200);
      assert.equal((await deliver(order.id, driver.token, "105.00")).status, 200);

      const afterDeliver = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(afterDeliver.body.data.account.currentBalance, "105");
      const collectionRow = afterDeliver.body.data.transactions.find((t: any) => t.type === "COLLECTION");
      assert.ok(collectionRow, "expected a Delivery COLLECTION cash row");
      assert.equal(collectionRow.amount, "105");
      assert.equal(collectionRow.order.id, order.id);

      const settlement = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ driverId: driver.driverId, amountReceived: "70.00", paymentMethodId: cashMethodId });
      assert.equal(settlement.status, 201, JSON.stringify(settlement.body));

      const afterSettle = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(afterSettle.body.data.account.currentBalance, "35");
      const settlementRow = afterSettle.body.data.transactions.find((t: any) => t.type === "SETTLEMENT");
      assert.ok(settlementRow, "expected a SETTLEMENT cash row visible to the Driver");
      assert.equal(settlementRow.amount, "70");
      assert.ok(settlementRow.settlement?.settlementNumber, "settlement number is a safe reference");

      const serialized = JSON.stringify(afterSettle.body);
      assert.doesNotMatch(serialized, /wallet|company_financial|receivedBy|payment_processing/i);
    });
  });
});
