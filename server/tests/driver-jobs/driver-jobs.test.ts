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
// Phase 12.1 — GET /api/v1/driver/jobs ("My Jobs").
//
// Covers: portal-family + permission authorization, own-Driver scoping
// (IDOR), Collection current-job semantics (ASSIGNED / COLLECTED_FROM_SENDER
// kept, FAILED / RECEIVED_AT_COMPANY dropped), Delivery current-job
// semantics (ASSIGNED / PICKED_UP / OUT_FOR_DELIVERY / RESCHEDULED kept,
// DELIVERED dropped), the cancelled-historical-Collection edge case, both
// job types for the same Driver on separate Orders, pagination/filtering,
// deterministic ordering, DTO privacy, and zero financial side effects.
// ============================================================

describe("Driver Portal — My Jobs (Phase 12.1)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  let senderUnavailableReasonId: string;

  const orderIds: string[] = [];
  const driverIds: string[] = [];
  const userIds: string[] = [];

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
    const reason = await prisma.failed_collection_reasons.findFirstOrThrow({ where: { name: "Sender unavailable" } });
    senderUnavailableReasonId = reason.id;
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    await cleanupTestCustomerRecord(customerId);
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
    // createTestDriver only creates the `drivers` row — a real driver always
    // has a paired zero-balance driver_cash_accounts row (drivers.service.ts
    // creates them together), and Phase 8.3's exact-DELIVERY_ONLY finance
    // path requires one to exist before crediting a collection.
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
        receiverName: "Phase121 Receiver",
        receiverPhone: "+96170000121",
        receiverAreaId: area.id,
        receiverAddress: "1 Phase121 St",
        description: "Phase121 driver-jobs order",
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

  async function createDeliveryOrderAssignedTo(driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createOrder(overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    return order;
  }

  async function createCollectionOrder(overrides: Record<string, unknown> = {}) {
    // The Customer fixture has no default_address/default_area_id, so a
    // DRIVER_COLLECTION order must supply the collection snapshot overrides
    // explicitly (order.service.ts's DRIVER_COLLECTION validation) — never
    // silently falls back to ALREADY_AT_COMPANY.
    return createOrder({
      parcelIntakeMethod: "DRIVER_COLLECTION",
      parcelCollectionAddress: "1 Phase121 Collection St",
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
      .send({ failedCollectionReasonId: senderUnavailableReasonId });
  }
  function receiveAtCompany(orderId: string) {
    return request(app).post(`/api/v1/orders/${orderId}/parcel-collection/receive-at-company`).set(auth(tokens.admin)).send({});
  }

  function jobsPath(qs = "") {
    return `/api/v1/driver/jobs${qs}`;
  }

  function findJob(body: { data: any[] }, jobType: string, orderId: string): any {
    return body.data.find((j: { jobType: string; orderId: string }) => j.jobType === jobType && j.orderId === orderId);
  }

  // ============================================================
  // AUTHORIZATION
  // ============================================================

  describe("Authorization", () => {
    test("unauthenticated -> 401", async () => {
      const res = await request(app).get(jobsPath());
      assert.equal(res.status, 401);
    });

    test("DRIVER with driver.orders.read_own + linked profile -> 200", async () => {
      const driver = await createDriverWithToken("auth-driver");
      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data, []);
    });

    test("ADMIN -> 403 (portal-family denial before profile lookup)", async () => {
      const res = await request(app).get(jobsPath()).set(auth(tokens.admin));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|relation|foreign key/i);
    });

    test("DISPATCHER -> 403", async () => {
      const res = await request(app).get(jobsPath()).set(auth(tokens.dispatcher));
      assert.equal(res.status, 403);
    });

    test("FINANCE -> 403", async () => {
      const res = await request(app).get(jobsPath()).set(auth(tokens.finance));
      assert.equal(res.status, 403);
    });

    test("CUSTOMER -> 403", async () => {
      const res = await request(app).get(jobsPath()).set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });
  });

  // ============================================================
  // A/B — Collection current-job semantics
  // ============================================================

  describe("Collection current-job semantics", () => {
    test("A. ASSIGNED collection job is current", async () => {
      const driver = await createDriverWithToken("collect-assigned");
      const order = await createCollectionOrder();
      const assign = await assignCollection(order.id, driver.driverId);
      assert.equal(assign.status, 200, JSON.stringify(assign.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.equal(res.status, 200);
      const job = findJob(res.body, "COLLECTION", order.id);
      assert.ok(job, "expected an ASSIGNED collection job");
      assert.equal(job.status, "ASSIGNED");
      assert.equal(job.collectedFromSenderAt, null);
      assert.ok(job.assignmentId);
      assert.ok(job.assignedAt);
    });

    test("B. COLLECTED_FROM_SENDER collection job stays current (custody kept)", async () => {
      const driver = await createDriverWithToken("collect-collected");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);
      const collected = await markCollected(order.id, driver.token);
      assert.equal(collected.status, 200, JSON.stringify(collected.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      const job = findJob(res.body, "COLLECTION", order.id);
      assert.ok(job, "COLLECTED_FROM_SENDER must remain a current job");
      assert.equal(job.status, "COLLECTED_FROM_SENDER");
      assert.ok(job.collectedFromSenderAt);
    });

    test("C. FAILED collection is not current once the assignment closes", async () => {
      const driver = await createDriverWithToken("collect-failed");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);
      const failed = await failCollection(order.id, driver.token);
      assert.equal(failed.status, 200, JSON.stringify(failed.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.ok(!findJob(res.body, "COLLECTION", order.id), "a FAILED collection must not appear in My Jobs");
    });

    test("D. RECEIVED_AT_COMPANY collection is not current", async () => {
      const driver = await createDriverWithToken("collect-received");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);
      await markCollected(order.id, driver.token);
      const received = await receiveAtCompany(order.id);
      assert.equal(received.status, 200, JSON.stringify(received.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.ok(!findJob(res.body, "COLLECTION", order.id), "RECEIVED_AT_COMPANY must not appear in My Jobs");
    });
  });

  // ============================================================
  // E/F/G/H — Delivery current-job semantics
  // ============================================================

  describe("Delivery current-job semantics", () => {
    test("E. ASSIGNED delivery job is current", async () => {
      const driver = await createDriverWithToken("deliver-assigned");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      const job = findJob(res.body, "DELIVERY", order.id);
      assert.ok(job, "expected an ASSIGNED delivery job");
      assert.equal(job.status, "ASSIGNED");
      assert.ok(job.timestamps.assignedAt);
    });

    test("F. PICKED_UP delivery job is current", async () => {
      const driver = await createDriverWithToken("deliver-pickedup");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);
      const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driver.token));
      assert.equal(pickup.status, 200, JSON.stringify(pickup.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      const job = findJob(res.body, "DELIVERY", order.id);
      assert.ok(job, "expected a PICKED_UP delivery job");
      assert.equal(job.status, "PICKED_UP");
    });

    test("G. OUT_FOR_DELIVERY delivery job is current", async () => {
      const driver = await createDriverWithToken("deliver-ofd");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);
      await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driver.token));
      const start = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driver.token));
      assert.equal(start.status, 200, JSON.stringify(start.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      const job = findJob(res.body, "DELIVERY", order.id);
      assert.ok(job, "expected an OUT_FOR_DELIVERY delivery job");
      assert.equal(job.status, "OUT_FOR_DELIVERY");
      assert.equal(typeof job.collection.amountToCollect, "string");
    });

    test("H. DELIVERED (terminal) delivery job is not current", async () => {
      const driver = await createDriverWithToken("deliver-terminal");
      const order = await createDeliveryOrderAssignedTo(driver.driverId, { orderAmount: "0.00", deliveryFee: "5.00" });
      await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driver.token));
      await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driver.token));
      const deliver = await request(app)
        .post(`/api/v1/driver/orders/${order.id}/deliver`)
        .set(auth(driver.token))
        .send({ actualAmountCollected: "5.00" });
      assert.equal(deliver.status, 200, JSON.stringify(deliver.body));

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.ok(!findJob(res.body, "DELIVERY", order.id), "a DELIVERED order must not appear in My Jobs");
    });
  });

  // ============================================================
  // I — cancelled historical Collection ASSIGNED must not be current
  // ============================================================

  describe("Cancelled historical Collection", () => {
    test("I. order cancelled while parcel_collection_status = ASSIGNED disappears from My Jobs", async () => {
      const driver = await createDriverWithToken("collect-cancelled");
      const order = await createCollectionOrder();
      const assign = await assignCollection(order.id, driver.driverId);
      assert.equal(assign.status, 200, JSON.stringify(assign.body));

      const before = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.ok(findJob(before.body, "COLLECTION", order.id), "sanity check: job must be current before cancel");

      const cancel = await request(app).post(`/api/v1/orders/${order.id}/cancel`).set(auth(tokens.admin)).send({ reason: "phase 12.1 cancel check" });
      assert.equal(cancel.status, 200, JSON.stringify(cancel.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.parcel_collection_status, "ASSIGNED", "parcel_collection_status stays ASSIGNED historically — there is no CANCELLED value");
      assert.equal(row.current_parcel_collection_driver_id, null, "the pointer must be cleared by the cancel transaction");

      const after = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.ok(!findJob(after.body, "COLLECTION", order.id), "a cancelled order must never appear as a current job, even with a historically-ASSIGNED parcel_collection_status");
    });
  });

  // ============================================================
  // J — same Driver, both job types, separate Orders
  // ============================================================

  describe("Same Driver, both job types", () => {
    test("J. one Driver sees both a current Collection job and a current Delivery job", async () => {
      const driver = await createDriverWithToken("both-jobs");
      const collectionOrder = await createCollectionOrder();
      await assignCollection(collectionOrder.id, driver.driverId);
      const deliveryOrder = await createDeliveryOrderAssignedTo(driver.driverId);

      const res = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.equal(res.status, 200);
      assert.ok(findJob(res.body, "COLLECTION", collectionOrder.id));
      assert.ok(findJob(res.body, "DELIVERY", deliveryOrder.id));
    });
  });

  // ============================================================
  // IDOR — another Driver's jobs never leak in
  // ============================================================

  describe("Ownership / IDOR", () => {
    test("Driver A never sees Driver B's collection or delivery job", async () => {
      const driverA = await createDriverWithToken("idor-a");
      const driverB = await createDriverWithToken("idor-b");
      const collectionOrderB = await createCollectionOrder();
      await assignCollection(collectionOrderB.id, driverB.driverId);
      const deliveryOrderB = await createDeliveryOrderAssignedTo(driverB.driverId);

      const res = await request(app).get(jobsPath()).set(auth(driverA.token));
      assert.equal(res.status, 200);
      assert.ok(!findJob(res.body, "COLLECTION", collectionOrderB.id));
      assert.ok(!findJob(res.body, "DELIVERY", deliveryOrderB.id));
    });
  });

  // ============================================================
  // K/L — pagination, filtering, deterministic ordering
  // ============================================================

  describe("Pagination, filtering, ordering", () => {
    test("K. jobType filter narrows to only Collection or only Delivery", async () => {
      const driver = await createDriverWithToken("filter-driver");
      const collectionOrder = await createCollectionOrder();
      await assignCollection(collectionOrder.id, driver.driverId);
      const deliveryOrder = await createDeliveryOrderAssignedTo(driver.driverId);

      const collectionOnly = await request(app).get(jobsPath("?jobType=COLLECTION")).set(auth(driver.token));
      assert.equal(collectionOnly.status, 200);
      assert.ok(collectionOnly.body.data.every((j: { jobType: string }) => j.jobType === "COLLECTION"));
      assert.ok(findJob(collectionOnly.body, "COLLECTION", collectionOrder.id));

      const deliveryOnly = await request(app).get(jobsPath("?jobType=DELIVERY")).set(auth(driver.token));
      assert.equal(deliveryOnly.status, 200);
      assert.ok(deliveryOnly.body.data.every((j: { jobType: string }) => j.jobType === "DELIVERY"));
      assert.ok(findJob(deliveryOnly.body, "DELIVERY", deliveryOrder.id));

      const invalid = await request(app).get(jobsPath("?jobType=BOGUS")).set(auth(driver.token));
      assert.equal(invalid.status, 400);
    });

    test("K. pagination: default/page/limit/over-max", async () => {
      const driver = await createDriverWithToken("paging-driver");
      for (let i = 0; i < 3; i++) {
        await createDeliveryOrderAssignedTo(driver.driverId);
      }

      const def = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.equal(def.status, 200);
      assert.equal(def.body.meta.page, 1);
      assert.equal(def.body.meta.limit, 20);
      assert.equal(def.body.meta.total, 3);

      const paged = await request(app).get(jobsPath("?page=1&limit=2")).set(auth(driver.token));
      assert.equal(paged.status, 200);
      assert.equal(paged.body.data.length, 2);
      assert.equal(paged.body.meta.totalPages, 2);

      const page2 = await request(app).get(jobsPath("?page=2&limit=2")).set(auth(driver.token));
      assert.equal(page2.body.data.length, 1);

      const overMax = await request(app).get(jobsPath("?limit=101")).set(auth(driver.token));
      assert.equal(overMax.status, 400);

      const badPage = await request(app).get(jobsPath("?page=0")).set(auth(driver.token));
      assert.equal(badPage.status, 400);
    });

    test("L. deterministic ordering: assignedAt DESC is stable across repeated calls", async () => {
      const driver = await createDriverWithToken("order-driver");
      const first = await createDeliveryOrderAssignedTo(driver.driverId);
      const second = await createDeliveryOrderAssignedTo(driver.driverId);
      const third = await createDeliveryOrderAssignedTo(driver.driverId);

      const call1 = await request(app).get(jobsPath()).set(auth(driver.token));
      const call2 = await request(app).get(jobsPath()).set(auth(driver.token));
      assert.equal(call1.status, 200);
      assert.deepEqual(
        call1.body.data.map((j: { orderId: string }) => j.orderId),
        call2.body.data.map((j: { orderId: string }) => j.orderId),
        "repeated calls must return an identical order"
      );
      // Most-recently-assigned first.
      const ids = call1.body.data.map((j: { orderId: string }) => j.orderId);
      assert.equal(ids[0], third.id);
      assert.equal(ids[1], second.id);
      assert.equal(ids[2], first.id);
    });
  });

  // ============================================================
  // GLOBAL PAGINATION CORRECTNESS (Phase 12.1 review correction)
  //
  // Regression coverage for the invalid pattern the review flagged:
  // independently applying the requested global skip/take to the
  // Collection and Delivery queries BEFORE merging can silently drop rows
  // that belong on the true combined page. These tests build a known,
  // fully-controlled global order (direct DB timestamp overrides — no
  // reliance on real-clock timing) and verify that concatenating every
  // page reproduces that exact sequence: no missing jobs, no duplicates,
  // correct cross-type chronological order.
  // ============================================================

  describe("Global pagination correctness", () => {
    // Deterministic, strictly-descending timestamps so no two jobs can ever
    // tie — offsetIndex 0 is newest.
    function tsAt(offsetIndex: number): Date {
      return new Date(Date.UTC(2030, 0, 1, 0, 0, 0, 0) - offsetIndex * 1000);
    }

    async function createCollectionJobAt(driverId: string, offsetIndex: number) {
      const order = await createCollectionOrder();
      const assign = await assignCollection(order.id, driverId);
      assert.equal(assign.status, 200, JSON.stringify(assign.body));
      await prisma.parcel_collection_assignments.updateMany({
        where: { order_id: order.id, is_current: true },
        data: { assigned_at: tsAt(offsetIndex) },
      });
      return order.id as string;
    }

    async function createDeliveryJobAt(driverId: string, offsetIndex: number) {
      const order = await createDeliveryOrderAssignedTo(driverId);
      await prisma.orders.update({ where: { id: order.id }, data: { assigned_at: tsAt(offsetIndex) } });
      return order.id as string;
    }

    async function fetchAllPages(token: string, limit: number, jobType?: "COLLECTION" | "DELIVERY") {
      const qs = jobType ? `?limit=${limit}&jobType=${jobType}` : `?limit=${limit}`;
      const first = await request(app).get(jobsPath(`${qs}&page=1`)).set(auth(token));
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const totalPages = first.body.meta.totalPages as number;
      const total = first.body.meta.total as number;

      const pages: Array<{ jobType: string; orderId: string }[]> = [first.body.data];
      for (let page = 2; page <= totalPages; page++) {
        const res = await request(app).get(jobsPath(`${qs}&page=${page}`)).set(auth(token));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        pages.push(res.body.data);
      }
      return { pages, total, totalPages };
    }

    test("interleaved multi-page: concatenated pages reproduce the exact expected global sequence", async () => {
      const driver = await createDriverWithToken("global-interleaved");

      // Global order (newest -> oldest), interleaved by construction:
      // D1, C1, D2, C2, D3, C3, D4, C4, D5, C5
      const expected: Array<{ jobType: "COLLECTION" | "DELIVERY"; orderId: string }> = [];
      for (let i = 0; i < 5; i++) {
        const dId = await createDeliveryJobAt(driver.driverId, i * 2);
        expected.push({ jobType: "DELIVERY", orderId: dId });
        const cId = await createCollectionJobAt(driver.driverId, i * 2 + 1);
        expected.push({ jobType: "COLLECTION", orderId: cId });
      }
      assert.equal(expected.length, 10);

      const { pages, total, totalPages } = await fetchAllPages(driver.token, 3);
      assert.equal(total, 10);
      assert.equal(totalPages, 4);
      assert.deepEqual(
        pages.map((p) => p.length),
        [3, 3, 3, 1],
        "page sizes must follow the ApiListResponse contract exactly"
      );

      const flattened = pages.flat().map((j) => ({ jobType: j.jobType, orderId: j.orderId }));
      assert.deepEqual(flattened, expected, "concatenating every page must reproduce the exact expected global order — no missing jobs, no duplicates, no misordering");

      // No duplicates as an independent, explicit check.
      const seen = new Set(flattened.map((j) => `${j.jobType}:${j.orderId}`));
      assert.equal(seen.size, flattened.length);
    });

    test("skewed distribution: newest page is dominated by one job type, later pages still complete correctly", async () => {
      const driver = await createDriverWithToken("global-skewed");

      // 5 newest Collection jobs, then 5 older Delivery jobs — the exact
      // shape that breaks an independent-per-source skip/take algorithm
      // (task §8): a naive implementation's page 2 would apply skip=3/take=3
      // to BOTH sources independently, silently dropping the 3 oldest
      // Delivery jobs (D3-D5, in this construction) from every page.
      const expected: Array<{ jobType: "COLLECTION" | "DELIVERY"; orderId: string }> = [];
      for (let i = 0; i < 5; i++) {
        const cId = await createCollectionJobAt(driver.driverId, i);
        expected.push({ jobType: "COLLECTION", orderId: cId });
      }
      for (let i = 0; i < 5; i++) {
        const dId = await createDeliveryJobAt(driver.driverId, 10 + i);
        expected.push({ jobType: "DELIVERY", orderId: dId });
      }
      assert.equal(expected.length, 10);

      const { pages, total, totalPages } = await fetchAllPages(driver.token, 3);
      assert.equal(total, 10);
      assert.equal(totalPages, 4);

      const flattened = pages.flat().map((j) => ({ jobType: j.jobType, orderId: j.orderId }));
      assert.deepEqual(flattened, expected, "the skewed (all-Collection-first) distribution must still page correctly across the type boundary");

      const seen = new Set(flattened.map((j) => `${j.jobType}:${j.orderId}`));
      assert.equal(seen.size, flattened.length, "no job may be dropped or duplicated across pages");
    });

    test("jobType-filtered pagination still returns correct totals/pages for a mixed dataset", async () => {
      const driver = await createDriverWithToken("global-filtered");
      const collectionIds: string[] = [];
      const deliveryIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        collectionIds.push(await createCollectionJobAt(driver.driverId, i * 2));
        deliveryIds.push(await createDeliveryJobAt(driver.driverId, i * 2 + 1));
      }

      const { pages: collectionPages, total: collectionTotal, totalPages: collectionTotalPages } = await fetchAllPages(
        driver.token,
        3,
        "COLLECTION"
      );
      assert.equal(collectionTotal, 4);
      assert.equal(collectionTotalPages, 2);
      const flattenedCollection = collectionPages.flat();
      assert.ok(flattenedCollection.every((j) => j.jobType === "COLLECTION"));
      assert.deepEqual(
        flattenedCollection.map((j) => j.orderId),
        collectionIds,
        "Collection-only pagination must reproduce the exact expected Collection-only order"
      );

      const { pages: deliveryPages, total: deliveryTotal, totalPages: deliveryTotalPages } = await fetchAllPages(
        driver.token,
        3,
        "DELIVERY"
      );
      assert.equal(deliveryTotal, 4);
      assert.equal(deliveryTotalPages, 2);
      const flattenedDelivery = deliveryPages.flat();
      assert.ok(flattenedDelivery.every((j) => j.jobType === "DELIVERY"));
      assert.deepEqual(
        flattenedDelivery.map((j) => j.orderId),
        deliveryIds,
        "Delivery-only pagination must reproduce the exact expected Delivery-only order"
      );
    });
  });

  // ============================================================
  // DTO privacy / no financial leak
  // ============================================================

  describe("DTO privacy", () => {
    test("Collection DTO exact safe field set — no amount-to-collect, no finance fields", async () => {
      const driver = await createDriverWithToken("dto-collection");
      const order = await createCollectionOrder();
      await assignCollection(order.id, driver.driverId);

      const res = await request(app).get(jobsPath("?jobType=COLLECTION")).set(auth(driver.token));
      const job = findJob(res.body, "COLLECTION", order.id);
      assert.ok(job);
      assert.deepEqual(
        Object.keys(job).sort(),
        ["assignedAt", "assignmentId", "collectedFromSenderAt", "contact", "jobType", "orderId", "orderNumber", "orderType", "status", "trackingCode"].sort()
      );
      assert.deepEqual(
        Object.keys(job.contact).sort(),
        ["address", "altPhone", "area", "name", "notes", "phone"].sort()
      );

      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /amountToCollect|amount_to_collect/i);
      assert.doesNotMatch(serialized, /wallet|driver_cash|company_financial|payout|settlement/i);
      assert.doesNotMatch(serialized, /password_hash|refresh_token|auth_sessions/i);
    });

    test("Delivery DTO exact safe field set — reuses the Phase 7.1 shape, no Management-only fields", async () => {
      const driver = await createDriverWithToken("dto-delivery");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);

      const res = await request(app).get(jobsPath("?jobType=DELIVERY")).set(auth(driver.token));
      const job = findJob(res.body, "DELIVERY", order.id);
      assert.ok(job);
      assert.deepEqual(
        Object.keys(job).sort(),
        ["collection", "jobType", "orderId", "orderNumber", "orderType", "package", "receiver", "status", "timestamps", "trackingCode"].sort()
      );
      assert.deepEqual(Object.keys(job.timestamps).sort(), ["assignedAt", "outForDeliveryAt", "pickedUpAt"].sort());

      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /wallet|driver_cash|company_financial|payout|settlement/i);
      assert.doesNotMatch(serialized, /financialStatus|needsFinancialReview|collectionDifferenceReason/i);
      assert.doesNotMatch(serialized, /password_hash|refresh_token|auth_sessions/i);
    });
  });

  // ============================================================
  // No financial side effects (read-only endpoint)
  // ============================================================

  describe("Read-only guarantee", () => {
    test("listing My Jobs creates zero wallet/driver-cash/company-finance/audit rows", async () => {
      const driver = await createDriverWithToken("readonly-driver");
      const collectionOrder = await createCollectionOrder();
      await assignCollection(collectionOrder.id, driver.driverId);
      const deliveryOrder = await createDeliveryOrderAssignedTo(driver.driverId);

      const [walletBefore, cashBefore, companyBefore, auditBefore] = await Promise.all([
        prisma.wallet_transactions.count(),
        prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } }),
        prisma.company_financial_transactions.count({ where: { order_id: { in: [collectionOrder.id, deliveryOrder.id] } } }),
        prisma.audit_logs.count(),
      ]);

      await request(app).get(jobsPath()).set(auth(driver.token));
      await request(app).get(jobsPath()).set(auth(driver.token));

      const [walletAfter, cashAfter, companyAfter, auditAfter] = await Promise.all([
        prisma.wallet_transactions.count(),
        prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } }),
        prisma.company_financial_transactions.count({ where: { order_id: { in: [collectionOrder.id, deliveryOrder.id] } } }),
        prisma.audit_logs.count(),
      ]);
      assert.equal(walletAfter, walletBefore);
      assert.equal(cashAfter, cashBefore);
      assert.equal(companyAfter, companyBefore);
      assert.equal(auditAfter, auditBefore);
    });
  });

  // ============================================================
  // Existing Driver route hardening (task §54) — spot check
  // ============================================================

  describe("Existing Driver route family hardening", () => {
    test("requirePortal now denies Management roles on the pre-existing Driver routes before any profile lookup, DRIVER behavior unchanged", async () => {
      const driver = await createDriverWithToken("hardening-driver");
      const order = await createDeliveryOrderAssignedTo(driver.driverId);

      const adminOrders = await request(app).get("/api/v1/driver/me/orders").set(auth(tokens.admin));
      assert.equal(adminOrders.status, 403);
      const adminCash = await request(app).get("/api/v1/driver/me/cash").set(auth(tokens.admin));
      assert.equal(adminCash.status, 403);
      const adminPickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(tokens.admin));
      assert.equal(adminPickup.status, 403);

      const driverOrders = await request(app).get("/api/v1/driver/me/orders").set(auth(driver.token));
      assert.equal(driverOrders.status, 200, JSON.stringify(driverOrders.body));
      const driverCash = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(driverCash.status, 200, JSON.stringify(driverCash.body));
    });
  });
});
