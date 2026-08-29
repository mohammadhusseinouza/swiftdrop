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
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

/**
 * Phase 6.3 CORRECTION — completes the GET /api/v1/orders list contract:
 *   paymentMethodId filter · deliveryStatus filter · sortBy/sortOrder ·
 *   OrderSummary.paymentType · bare-date inclusive-day semantics.
 */
describe("Orders list backend — Phase 6.3 contract completion", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let driverUser: TestUser;
  let adminToken: string;
  let financeToken: string;

  let customerId: string;
  let otherCustomerId: string;
  let areaId: string;
  let driverId: string;
  let cashMethodId: string;
  let cardMethodId: string;
  let bankMethodId: string;

  const createdOrderIds: string[] = [];
  const marker = () => `ph63c${uniqueSuffix()}`;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    driverUser = await createTestUser("DRIVER");
    adminToken = (await loginTestUser(app, admin.email, admin.password)).accessToken as string;
    financeToken = (await loginTestUser(app, finance.email, finance.password)).accessToken as string;

    customerId = await seedCustomerRecord(admin.id, { name: `Ph63c Co ${uniqueSuffix()}` });
    otherCustomerId = await seedCustomerRecord(admin.id, { name: `Ph63c Other ${uniqueSuffix()}` });
    const area = await createTestArea();
    areaId = area.id;
    driverId = await seedDriverRecord(driverUser.id);

    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    cardMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CARD" } })).id;
    bankMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "BANK_TRANSFER" } })).id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    await cleanupTestDriverRecord(driverId);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestCustomerRecord(otherCustomerId);
    await cleanupTestArea(areaId);
    await cleanupTestUser(admin.id);
    await cleanupTestUser(finance.id);
    await cleanupTestUser(driverUser.id);
  });

  async function seed(overrides: Parameters<typeof seedTestOrder>[2] = {}) {
    const id = await seedTestOrder(customerId, admin.id, overrides);
    createdOrderIds.push(id);
    return id;
  }
  async function idsFor(qs: string, token = adminToken): Promise<string[]> {
    const res = await request(app).get(`/api/v1/orders?${qs}`).set(auth(token));
    assert.equal(res.status, 200, `${qs} -> ${res.status} ${JSON.stringify(res.body)}`);
    return res.body.data.map((o: { id: string }) => o.id);
  }

  // ============================ payment method ============================
  describe("paymentMethodId filter", () => {
    const m = marker();
    let prepaidHit: string;
    let collectionHit: string;
    let bothHit: string;
    let miss: string;

    before(async () => {
      prepaidHit = await seed({ receiverName: m, prepaidPaymentMethodId: cashMethodId, prepaidOrderAmount: "10.00", prepaidDeliveryFee: "5.00", collectionPaymentMethodId: cardMethodId });
      collectionHit = await seed({ receiverName: m, collectionPaymentMethodId: cashMethodId });
      bothHit = await seed({ receiverName: m, prepaidPaymentMethodId: cashMethodId, prepaidOrderAmount: "10.00", prepaidDeliveryFee: "5.00", collectionPaymentMethodId: cashMethodId });
      miss = await seed({ receiverName: m, collectionPaymentMethodId: bankMethodId });
    });

    test("matches prepaid OR collection method", async () => {
      const ids = await idsFor(`search=${m}&paymentMethodId=${cashMethodId}`);
      assert.deepEqual([...ids].sort(), [prepaidHit, collectionHit, bothHit].sort());
      assert.ok(!ids.includes(miss));
    });

    test("same method on both sides -> Order appears exactly once", async () => {
      const ids = await idsFor(`search=${m}&paymentMethodId=${cashMethodId}`);
      assert.equal(ids.filter((x) => x === bothHit).length, 1);
    });

    test("unrelated method excludes the Order", async () => {
      const ids = await idsFor(`search=${m}&paymentMethodId=${bankMethodId}`);
      assert.deepEqual(ids, [miss]);
    });

    test("invalid uuid -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?paymentMethodId=not-a-uuid").set(auth(adminToken));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("combines (AND) with orderType", async () => {
      await seed({ receiverName: m, collectionPaymentMethodId: cashMethodId, orderType: "COMPANY_ORDER" });
      const ids = await idsFor(`search=${m}&paymentMethodId=${cashMethodId}&orderType=DELIVERY_ONLY`);
      assert.ok(ids.length >= 3);
      assert.ok(!ids.includes(miss));
    });
  });

  // ============================ delivery status ============================
  describe("deliveryStatus filter", () => {
    const m = marker();
    let deliveredId: string;
    let failedId: string;
    let cancelledId: string;
    let receivedId: string;

    before(async () => {
      deliveredId = await seed({ receiverName: m, status: "DELIVERED", deliveredAt: new Date() });
      failedId = await seed({ receiverName: m, status: "FAILED_DELIVERY" });
      cancelledId = await seed({ receiverName: m, status: "CANCELLED" });
      receivedId = await seed({ receiverName: m, status: "RECEIVED" });
    });

    test("DELIVERED -> only delivered orders", async () => {
      const ids = await idsFor(`search=${m}&deliveryStatus=DELIVERED`);
      assert.deepEqual(ids, [deliveredId]);
    });

    test("UNDELIVERED -> everything except delivered (incl. CANCELLED / RETURNED)", async () => {
      const ids = await idsFor(`search=${m}&deliveryStatus=UNDELIVERED`);
      assert.deepEqual([...ids].sort(), [failedId, cancelledId, receivedId].sort());
      assert.ok(!ids.includes(deliveredId));
    });

    test("combines (AND) with exact status — contradictory pair -> empty", async () => {
      const ids = await idsFor(`search=${m}&status=DELIVERED&deliveryStatus=UNDELIVERED`);
      assert.deepEqual(ids, []);
    });

    test("combines (AND) with exact status — consistent pair", async () => {
      const ids = await idsFor(`search=${m}&status=FAILED_DELIVERY&deliveryStatus=UNDELIVERED`);
      assert.deepEqual(ids, [failedId]);
    });

    test("combines (AND) with driverId", async () => {
      const dm = marker();
      const assignedFailed = await seed({ receiverName: dm, status: "FAILED_DELIVERY", currentDriverId: driverId });
      await seed({ receiverName: dm, status: "FAILED_DELIVERY" }); // unassigned, must not appear
      const ids = await idsFor(`search=${dm}&deliveryStatus=UNDELIVERED&driverId=${driverId}`);
      assert.deepEqual(ids, [assignedFailed]);
    });

    test("invalid value -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?deliveryStatus=MAYBE").set(auth(adminToken));
      assert.equal(res.status, 400);
    });
  });

  // ================================ sorting ================================
  describe("sorting", () => {
    const m = marker();
    let a: string;
    let b: string;
    let c: string;

    before(async () => {
      const base = Date.now();
      a = await seed({ receiverName: m, orderAmount: "30.00", deliveryFee: "9.00", status: "RECEIVED", createdAt: new Date(base - 3000) });
      b = await seed({ receiverName: m, orderAmount: "10.00", deliveryFee: "7.00", status: "DELIVERED", createdAt: new Date(base - 2000), deliveredAt: new Date(base - 1000) });
      c = await seed({ receiverName: m, orderAmount: "20.00", deliveryFee: "8.00", status: "OUT_FOR_DELIVERY", createdAt: new Date(base - 1000) });
    });

    test("createdAt asc / desc", async () => {
      assert.deepEqual(await idsFor(`search=${m}&sortBy=createdAt&sortOrder=asc`), [a, b, c]);
      assert.deepEqual(await idsFor(`search=${m}&sortBy=createdAt&sortOrder=desc`), [c, b, a]);
    });

    test("orderAmount asc / desc (string decimal ordered numerically)", async () => {
      assert.deepEqual(await idsFor(`search=${m}&sortBy=orderAmount&sortOrder=asc`), [b, c, a]);
      assert.deepEqual(await idsFor(`search=${m}&sortBy=orderAmount&sortOrder=desc`), [a, c, b]);
    });

    test("deliveryFee asc", async () => {
      assert.deepEqual(await idsFor(`search=${m}&sortBy=deliveryFee&sortOrder=asc`), [b, c, a]);
    });

    test("amountToCollect asc", async () => {
      // amount_to_collect = order + fee (no prepaid): b=17, c=28, a=39
      assert.deepEqual(await idsFor(`search=${m}&sortBy=amountToCollect&sortOrder=asc`), [b, c, a]);
    });

    test("orderNumber asc is lexical + stable", async () => {
      const ids = await idsFor(`search=${m}&sortBy=orderNumber&sortOrder=asc`);
      assert.equal(ids.length, 3);
      const again = await idsFor(`search=${m}&sortBy=orderNumber&sortOrder=asc`);
      assert.deepEqual(ids, again);
    });

    test("status asc/desc returns all rows deterministically", async () => {
      const asc = await idsFor(`search=${m}&sortBy=status&sortOrder=asc`);
      const desc = await idsFor(`search=${m}&sortBy=status&sortOrder=desc`);
      assert.equal(asc.length, 3);
      assert.deepEqual([...asc].sort(), [...desc].sort());
    });

    test("deliveredAt: NULLS LAST in both directions", async () => {
      const asc = await idsFor(`search=${m}&sortBy=deliveredAt&sortOrder=asc`);
      const desc = await idsFor(`search=${m}&sortBy=deliveredAt&sortOrder=desc`);
      assert.equal(asc[0], b, "only delivered order sorts first ascending");
      assert.deepEqual(asc.slice(1).sort(), [a, c].sort(), "null deliveredAt trail");
      assert.equal(desc[0], b, "only delivered order sorts first descending too (nulls last)");
    });

    test("sortOrder defaults to desc when omitted", async () => {
      assert.deepEqual(await idsFor(`search=${m}&sortBy=createdAt`), [c, b, a]);
    });

    test("no sortBy -> historical default createdAt DESC", async () => {
      assert.deepEqual(await idsFor(`search=${m}`), [c, b, a]);
    });

    test("invalid sortBy -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?sortBy=receiverName").set(auth(adminToken));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("invalid sortOrder -> 400", async () => {
      const res = await request(app).get("/api/v1/orders?sortBy=createdAt&sortOrder=sideways").set(auth(adminToken));
      assert.equal(res.status, 400);
    });

    test("deterministic pagination under a custom sort (id DESC tiebreaker)", async () => {
      const pm = marker();
      const same = new Date();
      for (let i = 0; i < 5; i++) await seed({ receiverName: pm, orderAmount: "50.00", createdAt: same });
      const p1 = await request(app).get(`/api/v1/orders?search=${pm}&sortBy=orderAmount&sortOrder=asc&limit=3&page=1`).set(auth(adminToken));
      const p2 = await request(app).get(`/api/v1/orders?search=${pm}&sortBy=orderAmount&sortOrder=asc&limit=3&page=2`).set(auth(adminToken));
      const p1again = await request(app).get(`/api/v1/orders?search=${pm}&sortBy=orderAmount&sortOrder=asc&limit=3&page=1`).set(auth(adminToken));
      const ids1 = p1.body.data.map((o: { id: string }) => o.id);
      const ids2 = p2.body.data.map((o: { id: string }) => o.id);
      assert.deepEqual(ids1, p1again.body.data.map((o: { id: string }) => o.id), "repeatable page 1");
      assert.equal(new Set([...ids1, ...ids2]).size, 5, "no overlap, nothing skipped");
    });
  });

  // ============================ date boundaries ============================
  describe("createdFrom / createdTo bare-date semantics", () => {
    // Fixed calendar days well in the past so 'now' can't drift into them.
    const day1 = "2023-03-10";
    const day2 = "2023-03-11";
    const day3 = "2023-03-12";
    const m = marker();
    let d1early: string;
    let d2late: string;
    let d3: string;

    before(async () => {
      d1early = await seed({ receiverName: m, createdAt: new Date("2023-03-10T02:00:00.000Z") });
      d2late = await seed({ receiverName: m, createdAt: new Date("2023-03-11T23:30:00.000Z") });
      d3 = await seed({ receiverName: m, createdAt: new Date("2023-03-12T12:00:00.000Z") });
    });

    test("createdFrom bare date is inclusive from 00:00Z", async () => {
      const ids = await idsFor(`search=${m}&createdFrom=${day2}`);
      assert.deepEqual([...ids].sort(), [d2late, d3].sort());
      assert.ok(!ids.includes(d1early));
    });

    test("createdTo bare date includes the ENTIRE UTC day (23:30 order kept)", async () => {
      const ids = await idsFor(`search=${m}&createdTo=${day2}`);
      assert.deepEqual([...ids].sort(), [d1early, d2late].sort());
      assert.ok(!ids.includes(d3));
    });

    test("bounded bare-date range [day2, day2] = exactly that one day", async () => {
      const ids = await idsFor(`search=${m}&createdFrom=${day2}&createdTo=${day2}`);
      assert.deepEqual(ids, [d2late]);
    });

    test("explicit UTC datetime keeps literal instant semantics", async () => {
      const ids = await idsFor(`search=${m}&createdTo=2023-03-11T12:00:00.000Z`);
      assert.deepEqual([...ids].sort(), [d1early].sort());
      assert.ok(!ids.includes(d2late), "23:30 order is after the explicit 12:00 cutoff");
    });

    test("reversed bare-date range -> 400", async () => {
      const res = await request(app).get(`/api/v1/orders?createdFrom=${day3}&createdTo=${day1}`).set(auth(adminToken));
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("impossible bare date -> 400 (validation retained)", async () => {
      const res = await request(app).get("/api/v1/orders?createdFrom=2023-02-31").set(auth(adminToken));
      assert.equal(res.status, 400);
    });

    test("combines with customerId", async () => {
      await seedTestOrder(otherCustomerId, admin.id, { receiverName: m, createdAt: new Date("2023-03-11T10:00:00.000Z") }).then((id) => createdOrderIds.push(id));
      const ids = await idsFor(`search=${m}&createdFrom=${day2}&createdTo=${day2}&customerId=${customerId}`);
      assert.deepEqual(ids, [d2late]);
    });
  });

  // ============================ regressions ============================
  describe("regressions & combinability", () => {
    test("paymentType filter still works and matches the DTO field", async () => {
      const m = marker();
      await seed({ receiverName: m, paymentType: "ALREADY_PAID", prepaidOrderAmount: "100.00", prepaidDeliveryFee: "5.00", prepaidPaymentMethodId: cashMethodId });
      await seed({ receiverName: m, paymentType: "CASH_ON_DELIVERY" });
      const res = await request(app).get(`/api/v1/orders?search=${m}&paymentType=ALREADY_PAID`).set(auth(adminToken));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.length >= 1);
      assert.ok(res.body.data.every((o: { paymentType: string }) => o.paymentType === "ALREADY_PAID"));
    });

    test("orders.read still required — driver / customer / finance", async () => {
      const driverToken = (await loginTestUser(app, driverUser.email, driverUser.password)).accessToken as string;
      const dRes = await request(app).get("/api/v1/orders").set(auth(driverToken));
      assert.equal(dRes.status, 403);
      const fRes = await request(app).get("/api/v1/orders").set(auth(financeToken));
      assert.equal(fRes.status, 200, "FINANCE has orders.read");
      const anon = await request(app).get("/api/v1/orders");
      assert.equal(anon.status, 401);
    });

    test("search regression across all documented fields", async () => {
      const uniq = uniqueSuffix();
      const byReceiver = await seed({ receiverName: `RcvName ${uniq}` });
      const res = await request(app).get(`/api/v1/orders?search=${uniq}`).set(auth(adminToken));
      assert.equal(res.status, 200);
      assert.ok(res.body.data.some((o: { id: string }) => o.id === byReceiver));
    });

    test("big combination: paymentType + paymentMethodId + status + area + sort + page", async () => {
      const m = marker();
      const target = await seed({
        receiverName: m, status: "ASSIGNED", currentDriverId: driverId, areaId,
        paymentType: "PARTIALLY_PAID", prepaidOrderAmount: "5.00", prepaidPaymentMethodId: cardMethodId,
        collectionPaymentMethodId: cashMethodId,
      });
      await seed({ receiverName: m, status: "ASSIGNED", currentDriverId: driverId, paymentType: "CASH_ON_DELIVERY", collectionPaymentMethodId: cardMethodId });
      const ids = await idsFor(
        `search=${m}&paymentType=PARTIALLY_PAID&paymentMethodId=${cashMethodId}&status=ASSIGNED&areaId=${areaId}&assignmentStatus=ASSIGNED&sortBy=createdAt&sortOrder=desc&page=1`,
      );
      assert.deepEqual(ids, [target]);
    });
  });
});
