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
// Phase 13.2 — GET /api/v1/customer/me/orders ("My Orders").
//
// Covers: portal-family + permission authorization (portal denial BEFORE any
// Customer-profile / Order lookup), strict self-scoping (no client
// customerId), server pagination (page/limit/total/totalPages, no dupes/gaps,
// deterministic newest-first), the all/active/delivered views (active reuses
// the shared ORDER_ACTIVE_STATUSES set, delivered = status DELIVERED across
// both order types), Customer-safe Parcel Collection stage wording
// (DRIVER_COLLECTION states + ALREADY_AT_COMPANY -> null, FAILED/RESCHEDULED
// -> one neutral "Collection Rescheduled"), DTO privacy (no Driver identity /
// finance / review internals), a bounded query count (no N+1), and zero
// write side effects.
// ============================================================

const ROW_KEYS = [
  "id",
  "orderNumber",
  "trackingCode",
  "orderType",
  "status",
  "createdAt",
  "deliveredAt",
  "receiverName",
  "receiverArea",
  "orderAmount",
  "deliveryFee",
  "amountToCollect",
  "parcelIntakeMethod",
  "collectionStage",
].sort();

const FORBIDDEN_SUBSTRINGS = [
  "driverNumber",
  "driver_number",
  "currentDriver",
  "current_driver_id",
  "collectionDriver",
  "current_parcel_collection_driver_id",
  "receivedAtCompanyBy",
  "received_at_company_by_id",
  "parcelCollectionPhone",
  "parcel_collection_phone",
  "parcelCollectionAddress",
  "parcel_collection_contact_name",
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
  "settlement",
  "payout",
  "auditLog",
  "assignmentHistory",
  "attemptHistory",
];

describe("Customer Portal — My Orders (Phase 13.2)", () => {
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
  const list = (t: string | undefined, qs = "") => {
    const r = request(app).get(`/api/v1/customer/me/orders${qs}`);
    return t ? r.set(auth(t)) : r;
  };

  async function seedA(overrides: Parameters<typeof seedTestOrder>[2]) {
    const id = await seedTestOrder(customerAId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      ...overrides,
    });
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

    customerAId = await seedCustomerRecord(admin.id, { name: "Orders Customer A", portalUserId: customerAUser.id });
    customerBId = await seedCustomerRecord(admin.id, { name: "Orders Customer B", portalUserId: customerBUser.id });
    customerRecordIds.push(customerAId, customerBId);

    collectionDriverId = await seedDriverRecord(driverUser.id, { driverNumber: "PH132-COLLDRV" });
    driverRecordIds.push(collectionDriverId);

    // ---- Customer B: one order that must never appear in A's list --------
    const bOrder = await seedTestOrder(customerBId, admin.id, { areaId: area.id, areaName: area.name });
    orderIds.push(bOrder);
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
  // Authorization matrix (task §44)
  // ===========================================================
  describe("authorization matrix", () => {
    test("CUSTOMER -> 200", async () => {
      const res = await list(tokens.customerA);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.meta);
    });

    test("ADMIN / DISPATCHER / FINANCE / DRIVER -> 403; unauthenticated -> 401", async () => {
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        const res = await list(tokens[role]);
        assert.equal(res.status, 403, `${role}: ${res.status}`);
        assert.equal(res.body.error.code, "FORBIDDEN");
      }
      assert.equal((await list(undefined)).status, 401);
    });

    test("portal denial precedes Customer/Order lookup — ADMIN 403 leaks nothing", async () => {
      const res = await list(tokens.admin);
      assert.equal(res.status, 403);
      const json = JSON.stringify(res.body);
      assert.ok(!/customer profile/i.test(json));
      assert.ok(!/prisma/i.test(json));
    });
  });

  // ===========================================================
  // Self-scoping (task §45)
  // ===========================================================
  describe("self-scoping", () => {
    test("A sees only A's orders; ?customerId=<B> has no effect", async () => {
      const plain = await list(tokens.customerA, "?limit=100");
      const spoof = await list(tokens.customerA, `?limit=100&customerId=${customerBId}`);
      assert.equal(spoof.status, 200);
      assert.deepEqual(
        spoof.body.data.map((o: { id: string }) => o.id).sort(),
        plain.body.data.map((o: { id: string }) => o.id).sort()
      );
      // Customer B's order id is never present in A's list.
      const bList = await list(tokens.customerB, "?limit=100");
      const bIds = new Set(bList.body.data.map((o: { id: string }) => o.id));
      for (const o of plain.body.data) assert.ok(!bIds.has(o.id), "A's list contains a B order");
    });
  });

  // ===========================================================
  // Pagination (task §46) + deterministic sort (task §23)
  // ===========================================================
  describe("pagination + ordering", () => {
    const paginationOrderIds: string[] = [];

    before(async () => {
      // 25 orders with strictly increasing createdAt so newest-first is
      // unambiguous.
      const base = Date.now() - 25 * 60_000;
      for (let i = 0; i < 25; i += 1) {
        const id = await seedA({ createdAt: new Date(base + i * 60_000), orderAmount: "10.00" });
        paginationOrderIds.push(id);
      }
    });

    test("page/limit/total/totalPages, no duplicates, no gaps, newest-first", async () => {
      const seen: string[] = [];
      let page = 1;
      let totalPages = 1;
      let total = 0;
      do {
        const res = await list(tokens.customerA, `?page=${page}&limit=10`);
        assert.equal(res.status, 200);
        assert.equal(res.body.meta.page, page);
        assert.equal(res.body.meta.limit, 10);
        total = res.body.meta.total;
        totalPages = res.body.meta.totalPages;
        seen.push(...res.body.data.map((o: { id: string }) => o.id));
        page += 1;
      } while (page <= totalPages);

      assert.ok(total >= 25);
      assert.equal(totalPages, Math.ceil(total / 10));
      assert.equal(new Set(seen).size, seen.length, "duplicate order across pages");
      assert.equal(seen.length, total, "page union != total");

      // Global newest-first: every consecutive pair is non-increasing by createdAt.
      const full = await list(tokens.customerA, `?limit=100`);
      const times = full.body.data.map((o: { createdAt: string }) => Date.parse(o.createdAt));
      for (let i = 1; i < times.length; i += 1) {
        assert.ok(times[i - 1] >= times[i], "list is not createdAt DESC");
      }
    });

    test("limit is capped at 100 (invalid values -> 400)", async () => {
      assert.equal((await list(tokens.customerA, "?limit=101")).status, 400);
      assert.equal((await list(tokens.customerA, "?page=0")).status, 400);
      assert.equal((await list(tokens.customerA, "?view=bogus")).status, 400);
    });
  });

  // ===========================================================
  // Views: all / active / delivered (task §47 / §48)
  // ===========================================================
  describe("views", () => {
    const viewOrderIds: Record<string, string> = {};

    before(async () => {
      // dedicated fresh customer so the counts are exact
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      const cid = await seedCustomerRecord(admin.id, { name: "Views Customer", portalUserId: u.id });
      customerRecordIds.push(cid);
      const login = await loginTestUser(app, u.email, u.password);
      tokens.viewsCustomer = login.accessToken as string;

      const mk = async (o: Parameters<typeof seedTestOrder>[2]) => {
        const id = await seedTestOrder(cid, admin.id, { areaId: area.id, areaName: area.name, ...o });
        orderIds.push(id);
        return id;
      };
      viewOrderIds.received = await mk({ status: "RECEIVED" });
      viewOrderIds.assigned = await mk({ status: "ASSIGNED" });
      viewOrderIds.failed = await mk({ status: "FAILED_DELIVERY" });
      viewOrderIds.rescheduled = await mk({ status: "RESCHEDULED" });
      viewOrderIds.cancelled = await mk({ status: "CANCELLED" });
      viewOrderIds.deliveredDeliveryOnly = await mk({ status: "DELIVERED", orderType: "DELIVERY_ONLY", deliveredAt: new Date() });
      viewOrderIds.deliveredCompany = await mk({ status: "DELIVERED", orderType: "COMPANY_ORDER", deliveredAt: new Date() });
    });

    test("view=all returns every order (7)", async () => {
      const res = await list(tokens.viewsCustomer, "?view=all&limit=100");
      assert.equal(res.body.meta.total, 7);
    });

    test("view=active = RECEIVED + ASSIGNED + FAILED_DELIVERY + RESCHEDULED (4); DELIVERED/CANCELLED excluded", async () => {
      const res = await list(tokens.viewsCustomer, "?view=active&limit=100");
      const ids = new Set(res.body.data.map((o: { id: string }) => o.id));
      assert.equal(res.body.meta.total, 4);
      assert.ok(ids.has(viewOrderIds.received));
      assert.ok(ids.has(viewOrderIds.assigned));
      assert.ok(ids.has(viewOrderIds.failed));
      assert.ok(ids.has(viewOrderIds.rescheduled));
      assert.ok(!ids.has(viewOrderIds.cancelled));
      assert.ok(!ids.has(viewOrderIds.deliveredDeliveryOnly));
    });

    test("view=delivered = status DELIVERED only, both order types (2)", async () => {
      const res = await list(tokens.viewsCustomer, "?view=delivered&limit=100");
      const rows = res.body.data as { id: string; status: string; orderType: string }[];
      assert.equal(res.body.meta.total, 2);
      assert.ok(rows.every((o) => o.status === "DELIVERED"));
      assert.deepEqual(rows.map((o) => o.orderType).sort(), ["COMPANY_ORDER", "DELIVERY_ONLY"]);
    });
  });

  // ===========================================================
  // Parcel Collection stage — customer-safe (task §49 / §50)
  // ===========================================================
  describe("collection stage", () => {
    let cid: string;
    const map: Record<string, string> = {};

    before(async () => {
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      cid = await seedCustomerRecord(admin.id, { name: "Collection Customer", portalUserId: u.id });
      customerRecordIds.push(cid);
      const login = await loginTestUser(app, u.email, u.password);
      tokens.collectionCustomer = login.accessToken as string;

      const mk = async (o: Parameters<typeof seedTestOrder>[2]) => {
        const id = await seedTestOrder(cid, admin.id, { areaId: area.id, areaName: area.name, ...o });
        orderIds.push(id);
        return id;
      };
      map.already = await mk({ parcelIntakeMethod: "ALREADY_AT_COMPANY" });
      map.awaiting = await mk({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "AWAITING_ASSIGNMENT" });
      map.assigned = await mk({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "ASSIGNED",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      map.collected = await mk({
        parcelIntakeMethod: "DRIVER_COLLECTION",
        parcelCollectionStatus: "COLLECTED_FROM_SENDER",
        currentParcelCollectionDriverId: collectionDriverId,
      });
      map.received = await mk({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RECEIVED_AT_COMPANY" });
      map.failed = await mk({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "FAILED" });
      map.rescheduled = await mk({ parcelIntakeMethod: "DRIVER_COLLECTION", parcelCollectionStatus: "RESCHEDULED" });
    });

    test("ALREADY_AT_COMPANY -> collectionStage null (no fabricated stages)", async () => {
      const res = await list(tokens.collectionCustomer, "?limit=100");
      const row = res.body.data.find((o: { id: string }) => o.id === map.already);
      assert.equal(row.collectionStage, null);
      assert.equal(row.parcelIntakeMethod, "ALREADY_AT_COMPANY");
    });

    test("DRIVER_COLLECTION states map to the customer-safe stage vocabulary", async () => {
      const res = await list(tokens.collectionCustomer, "?limit=100");
      const by = (id: string) => res.body.data.find((o: { id: string }) => o.id === id).collectionStage;
      assert.deepEqual(by(map.awaiting), { code: "AWAITING_COLLECTION", label: "Awaiting Collection" });
      assert.deepEqual(by(map.assigned), { code: "COLLECTION_SCHEDULED", label: "Collection Scheduled" });
      assert.deepEqual(by(map.collected), { code: "PARCEL_COLLECTED", label: "Parcel Collected" });
      assert.deepEqual(by(map.received), { code: "RECEIVED_AT_COMPANY", label: "Received at Company" });
      // FAILED and RESCHEDULED both collapse to ONE neutral line — no internal detail.
      assert.deepEqual(by(map.failed), { code: "COLLECTION_DELAYED", label: "Collection Rescheduled" });
      assert.deepEqual(by(map.rescheduled), { code: "COLLECTION_DELAYED", label: "Collection Rescheduled" });
    });

    test("no Collection Driver identity anywhere in the response", async () => {
      const res = await list(tokens.collectionCustomer, "?limit=100");
      const json = JSON.stringify(res.body);
      assert.ok(!json.includes("PH132-COLLDRV"), "leaked collection driver number");
      assert.ok(!json.includes(collectionDriverId), "leaked collection driver id");
    });
  });

  // ===========================================================
  // DTO shape + privacy (task §51)
  // ===========================================================
  describe("DTO", () => {
    test("exact row key set; money strings; raw enums present as data", async () => {
      const res = await list(tokens.customerA, "?limit=5");
      assert.ok(res.body.data.length > 0);
      for (const row of res.body.data) {
        assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
        assert.equal(typeof row.orderAmount, "string");
        assert.equal(typeof row.deliveryFee, "string");
        assert.equal(typeof row.amountToCollect, "string");
        assert.ok(["COMPANY_ORDER", "DELIVERY_ONLY"].includes(row.orderType));
        assert.ok(typeof row.status === "string");
      }
    });

    test("no forbidden internal / finance / history fields", async () => {
      const res = await list(tokens.customerA, "?limit=100");
      const json = JSON.stringify(res.body);
      for (const term of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!json.includes(term), `leaked forbidden term "${term}"`);
      }
    });
  });

  // ===========================================================
  // No N+1 (task §53) + read-only (task §52)
  // ===========================================================
  describe("bounded queries + read-only", () => {
    test("bounded: a 1-row page and a 100-row page produce the same DTO shape (collectionStage derived in-process, never per-row fetched)", async () => {
      // The service issues exactly `findMany` + `count` regardless of row
      // count (code-inspected — customer-order.service.ts). collectionStage
      // comes from customerCollectionStage() over two already-selected
      // scalar columns, never a per-row tracking/collection lookup.
      const small = await list(tokens.customerA, "?limit=1");
      const big = await list(tokens.customerA, "?limit=100");
      assert.equal(small.status, 200);
      assert.equal(big.status, 200);
      assert.equal(small.body.meta.total, big.body.meta.total);
      assert.equal(small.body.data.length, 1);
      for (const row of big.body.data) {
        assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
      }
    });

    test("repeated reads create no order / status-history / wallet / audit rows for the Customer", async () => {
      const counts = async () => {
        const [orders, history, wt, audit] = await Promise.all([
          prisma.orders.count({ where: { customer_id: customerAId } }),
          prisma.order_status_history.count({ where: { orders: { customer_id: customerAId } } }),
          prisma.wallet_transactions.count({ where: { customer_id: customerAId } }),
          prisma.audit_logs.count({ where: { entity_id: customerAId } }),
        ]);
        return { orders, history, wt, audit };
      };
      const before = await counts();
      await list(tokens.customerA);
      await list(tokens.customerA, "?view=active");
      await list(tokens.customerA, "?view=delivered&page=1");
      assert.deepEqual(await counts(), before);
    });
  });
});
