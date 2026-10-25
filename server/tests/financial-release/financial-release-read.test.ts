import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY } from "../../src/modules/financial-release/financial-release.service";
import { collectionSettlementState, outstandingAmount } from "../../src/modules/financial-release/financial-release-read.service";
import { totalPending } from "../../src/modules/wallets/wallet.service";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestDriverRecord,
  cleanupTestOrder,
  cleanupTestPaymentMethod,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  type TestUser,
  withShortfallPolicyApproved,
} from "../helpers/fixtures";

// ============================================================
// FR.7 — Financial release read APIs + pending balance integration
// Contract: docs/settlement-financial-release-contract.md §4.3, §7, §9
//
// Settlement-mode orders come from real deliveries with the GLOBAL
// activation flag on only for the delivery itself (always restored).
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const dec = (v: string | number) => new Prisma.Decimal(v);
const REASON = "Recorded against the wrong order";

describe("Financial release read APIs (FR.7)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let dispatcher: TestUser;
  let tokens: { admin: string; finance: string; dispatcher: string };
  let area: { id: string; name: string };
  let cashMethodId: string;
  let bypassMethodId: string;

  const createdOrderIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCustomerIds: string[] = [];
  let keySeq = 0;
  const nextKey = (p = "fr7") => `${p}-${Date.now()}-${++keySeq}`;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const setActivation = (enabled: boolean) => prisma.system_settings.update({ where: { key: KEY }, data: { value: enabled } });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    dispatcher = await createTestUser("DISPATCHER");
    const [a, f, d] = await Promise.all([admin, finance, dispatcher].map((u) => loginTestUser(app, u.email, u.password)));
    tokens = { admin: a.accessToken as string, finance: f.accessToken as string, dispatcher: d.accessToken as string };
    assert.equal((await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } })).value, false);
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    const created = await request(app)
      .post("/api/v1/settings/payment-methods")
      .set(auth(tokens.admin))
      .send({ code: `FR7-DIRECT-${Math.random().toString(36).slice(2, 10)}`, name: "FR7 Direct", bypassDriverCash: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bypassMethodId = created.body.data.id;
  });

  afterEach(async () => {
    await setActivation(false);
  });

  after(async () => {
    await setActivation(false);
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    await prisma.audit_logs.deleteMany({ where: { entity_type: "PAYMENT_METHOD", entity_id: bypassMethodId } });
    await cleanupTestPaymentMethod(bypassMethodId);
    await prisma.audit_logs.deleteMany({
      where: { actor_user_id: { in: [finance.id, admin.id] }, entity_type: { in: ["DRIVER_SETTLEMENT", "CUSTOMER_PAYOUT", "DRIVER_CASH_ACCOUNT"] } },
    });
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestArea(area.id);
    await Promise.all([admin, finance, dispatcher].map((u) => cleanupTestUser(u.id)));
    assert.equal((await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } })).value, false);
  });

  // ------------------------------------------------------------ fixtures
  async function createDriver() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    const res = await request(app).post("/api/v1/drivers").set(auth(tokens.admin)).send({ userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }
  type Driver = Awaited<ReturnType<typeof createDriver>>;

  // A customer with a portal login (for the self-service endpoints).
  async function newCustomer() {
    const user = await createTestUser("CUSTOMER");
    createdUserIds.push(user.id);
    const id = await seedCustomerRecord(admin.id, { portalUserId: user.id });
    createdCustomerIds.push(id);
    const login = await loginTestUser(app, user.email, user.password);
    const customerNumber = (await prisma.customers.findUniqueOrThrow({ where: { id } })).customer_number;
    return { id, customerNumber, token: login.accessToken as string };
  }
  type Customer = Awaited<ReturnType<typeof newCustomer>>;

  async function createOrder(customerId: string, overrides: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR7 Receiver",
        receiverPhone: "+96170000077",
        receiverAreaId: area.id,
        receiverAddress: "7 FR7 St",
        description: "FR.7 order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    createdOrderIds.push(created.body.data.id);
    return created.body.data.id as string;
  }

  async function outForDelivery(driver: Driver, customerId: string, overrides: Record<string, unknown> = {}) {
    const orderId = await createOrder(customerId, overrides);
    assert.equal((await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId })).status, 200);
    for (const step of ["pickup", "start-delivery"]) {
      assert.equal((await request(app).post(`/api/v1/driver/orders/${orderId}/${step}`).set(auth(driver.token)).send()).status, 200);
    }
    return orderId;
  }

  async function deliver(orderId: string, driver: Driver, actual: string, reason?: string, activation = true) {
    if (activation) await setActivation(true);
    try {
      const res = await request(app)
        .post(`/api/v1/driver/orders/${orderId}/deliver`)
        .set(auth(driver.token))
        .send({ actualAmountCollected: actual, ...(reason ? { collectionDifferenceReason: reason } : {}) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    } finally {
      if (activation) await setActivation(false);
    }
  }

  async function modeOrder(driver: Driver, customerId: string, overrides: Record<string, unknown> = {}, actual = "105.00", reason?: string) {
    const orderId = await outForDelivery(driver, customerId, overrides);
    await deliver(orderId, driver, actual, reason);
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
    return { orderId, release };
  }

  async function legacyOrder(driver: Driver, customerId: string) {
    const orderId = await outForDelivery(driver, customerId);
    await deliver(orderId, driver, "105.00", undefined, false);
    return orderId;
  }

  // ------------------------------------------------------------ API
  function settle(driverId: string, allocations: { releaseId: string; amount: string }[], unattributed?: { amount: string; reason: string }) {
    const total = allocations.reduce((s, a) => s.plus(a.amount), dec(unattributed?.amount ?? 0));
    return request(app)
      .post("/api/v1/driver-settlements")
      .set(auth(tokens.finance))
      .set("Idempotency-Key", nextKey("settle"))
      .send({
        driverId,
        amountReceived: total.toFixed(2),
        paymentMethodId: cashMethodId,
        allocations,
        ...(unattributed ? { unattributedAmount: unattributed.amount, unattributedReason: unattributed.reason } : {}),
      });
  }
  const settleLegacy = (driverId: string, amount: string) =>
    request(app).post("/api/v1/driver-settlements").set(auth(tokens.finance)).set("Idempotency-Key", nextKey()).send({ driverId, amountReceived: amount, paymentMethodId: cashMethodId });
  const resolve = (orderId: string, wallet: string, fee: string) =>
    request(app)
      .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
      .set(auth(tokens.finance))
      .send({ customerWalletCredit: wallet, companyProductRevenue: "0", companyDeliveryFeeRevenue: fee, resolutionNotes: "Agreed split" });
  const postCorrection = (path: string, body: Record<string, unknown>) =>
    request(app).post(path).set(auth(tokens.finance)).set("Idempotency-Key", nextKey()).send(body);
  const voidCollection = (releaseId: string) => postCorrection(`/api/v1/finance/order-releases/${releaseId}/void-collection`, { reason: REASON });
  const reverseRelease = (releaseId: string) => postCorrection(`/api/v1/finance/order-releases/${releaseId}/reverse-release`, { reason: REASON });
  const reverseSettlement = (id: string) => postCorrection(`/api/v1/driver-settlements/${id}/reverse`, { reason: REASON });
  const shortfall = (id: string, amount: string) =>
    withShortfallPolicyApproved(() => postCorrection(`/api/v1/driver-settlements/${id}/shortfall`, { amount, reason: "Driver handed over less cash" }));

  const get = (path: string, token = tokens.finance) => request(app).get(path).set(auth(token));
  const outstanding = (driverId: string, qs = "", token?: string) => get(`/api/v1/finance/driver-cash/${driverId}/outstanding-collections${qs}`, token);
  const settlementDetail = (id: string, token?: string) => get(`/api/v1/driver-settlements/${id}`, token);
  const orderRelease = (orderId: string, token?: string) => get(`/api/v1/orders/${orderId}/financial-release`, token);

  // ------------------------------------------------------------ assertions
  // Every Management / Customer pending surface agrees for one customer.
  async function pendingEverywhere(c: Customer) {
    const [detail, list, summaries, mine, dashboard] = await Promise.all([
      get(`/api/v1/wallets/${c.id}`),
      get(`/api/v1/wallets?search=${encodeURIComponent(c.customerNumber)}`),
      get(`/api/v1/wallets/customer-summaries?customerIds=${c.id}`),
      get("/api/v1/customer/me/wallet", c.token),
      get("/api/v1/customer/me/dashboard", c.token),
    ]);
    for (const r of [detail, list, summaries, mine, dashboard]) assert.equal(r.status, 200, JSON.stringify(r.body));
    const w = detail.body.data.wallet;
    const row = list.body.data.find((x: { customer: { id: string } }) => x.customer.id === c.id);
    const summary = summaries.body.data[0];
    for (const other of [row, summary]) {
      for (const k of ["availableBalance", "pendingAmount", "pendingDeliveryAmount", "pendingSettlementAmount", "underReviewOrderCount", "underReviewCollectionAmount"]) {
        assert.equal(other[k], w[k], `management ${k} agrees`);
      }
    }
    for (const k of ["availableBalance", "pendingAmount", "pendingDeliveryAmount", "pendingSettlementAmount", "underReviewOrderCount"]) {
      assert.equal(mine.body.data[k], w[k], `customer wallet ${k} agrees`);
    }
    assert.equal(dashboard.body.data.availableWalletBalance, w.availableBalance);
    assert.equal(dashboard.body.data.pendingAmount, w.pendingAmount);
    assert.equal(dashboard.body.data.pendingSettlementAmount, w.pendingSettlementAmount);
    assert.ok(dec(w.pendingAmount).equals(dec(w.pendingDeliveryAmount).plus(w.pendingSettlementAmount)), "pending = delivery + settlement");
    // Customer DTOs never carry the Management-only collected-cash amount.
    assert.equal("underReviewCollectionAmount" in mine.body.data, false);
    assert.equal("underReviewCollectionAmount" in dashboard.body.data, false);
    return w as Record<string, string | number>;
  }

  // Ledger / balance fingerprint used to prove the read endpoints write nothing.
  const fingerprint = async () =>
    JSON.stringify(
      await Promise.all([
        prisma.driver_cash_transactions.count(),
        prisma.wallet_transactions.count(),
        prisma.company_financial_transactions.count(),
        prisma.order_financial_releases.findMany({ where: { driver_id: { in: createdDriverIds } }, orderBy: { id: "asc" } }),
        prisma.driver_settlement_allocations.count(),
        prisma.driver_settlement_corrections.count(),
        prisma.order_financial_release_corrections.count(),
        prisma.driver_cash_accounts.findMany({ where: { driver_id: { in: createdDriverIds } }, orderBy: { id: "asc" } }),
        prisma.customer_wallets.findMany({ where: { customer_id: { in: createdCustomerIds } }, orderBy: { id: "asc" } }),
        prisma.orders.findMany({ where: { id: { in: createdOrderIds } }, select: { id: true, financial_status: true, updated_at: true }, orderBy: { id: "asc" } }),
        prisma.audit_logs.count(),
      ]),
      (_k, v) => (v instanceof Date ? v.toISOString() : v)
    );

  // ============================================================
  describe("unit: derived states", () => {
    test("settlement state, outstanding amount and total pending", () => {
      assert.equal(collectionSettlementState(dec(105), dec(0)), "UNSETTLED");
      assert.equal(collectionSettlementState(dec(105), dec("40.5")), "PARTIALLY_SETTLED");
      assert.equal(collectionSettlementState(dec(105), dec(105)), "FULLY_SETTLED");
      assert.equal(outstandingAmount("PENDING", dec(105), dec(40)).toString(), "65");
      for (const s of ["RELEASED", "VOIDED", "RELEASE_REVERSED"] as const) assert.ok(outstandingAmount(s, dec(105), dec(105)).isZero());
      assert.ok(outstandingAmount("VOIDED", dec(105), dec(0)).isZero(), "a voided collection owes nothing");
      const b = { pendingDelivery: dec("70.10"), pendingSettlement: dec("50.05"), underReviewOrderCount: 1, underReviewCollectionAmount: dec(65) };
      assert.equal(totalPending(b).toString(), "120.15", "under review never adds to pending");
    });
  });

  // ============================================================
  describe("outstanding collections", () => {
    test("1-6, 9. only unsettled / partial PENDING collections; exact position with partial, released, review, voided, reversed and legacy cash", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id); // 105 unattributed
      const unsettled = await modeOrder(driver, c.id);
      const partial = await modeOrder(driver, c.id);
      const released = await modeOrder(driver, c.id);
      const review = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      const voided = await modeOrder(driver, c.id);
      const reversedRelease = await modeOrder(driver, c.id);
      const companyOrder = await modeOrder(driver, c.id, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      assert.equal((await voidCollection(voided.release.id)).status, 201);
      assert.equal(
        (
          await settle(driver.driverId, [
            { releaseId: partial.release.id, amount: "40.00" },
            { releaseId: released.release.id, amount: "105.00" },
            { releaseId: review.release.id, amount: "95.00" },
            { releaseId: reversedRelease.release.id, amount: "105.00" },
          ])
        ).status,
        201
      );
      assert.equal((await reverseRelease(reversedRelease.release.id)).status, 201);

      const res = await outstanding(driver.driverId);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const d = res.body.data;
      const ids = d.items.map((i: { releaseId: string }) => i.releaseId);
      assert.deepEqual(ids, [unsettled.release.id, partial.release.id, companyOrder.release.id], "oldest first; only outstanding");
      const p = d.items.find((i: { releaseId: string }) => i.releaseId === partial.release.id);
      assert.deepEqual(
        [p.collectionAmount, p.allocatedAmount, p.outstandingAmount, p.settlementState, p.reviewStatus, p.releaseStatus],
        ["105", "40", "65", "PARTIALLY_SETTLED", "NOT_REQUIRED", "PENDING"]
      );
      // FR.9 — the approved planned split rides on each item (the settlement
      // preview reads it; no per-order fetch).
      assert.deepEqual([p.plannedCustomerWalletAmount, p.plannedCompanyProductAmount, p.plannedCompanyFeeAmount], ["100", "0", "5"]);
      for (const i of d.items) {
        if (i.reviewStatus === "AWAITING_REVIEW") {
          assert.equal(i.plannedCustomerWalletAmount, null, "no split before review");
          continue;
        }
        const sum = [i.plannedCustomerWalletAmount, i.plannedCompanyProductAmount, i.plannedCompanyFeeAmount].reduce((s: number, v: string) => s + Number(v), 0);
        assert.equal(sum, Number(i.collectionAmount), `planned split sums to the collection for ${i.releaseId}`);
      }
      assert.equal(d.items[2].plannedCustomerWalletAmount, "0", "a COMPANY_ORDER never plans a wallet credit");
      assert.equal(p.order.id, partial.orderId);
      assert.equal(p.customer.id, c.id);
      assert.equal(p.orderType, "DELIVERY_ONLY");
      assert.equal(d.items[2].orderType, "COMPANY_ORDER");
      // Cash: 105 legacy + 105 + 65 + 0(review, fully settled) + 45 = 320.
      const cash = (await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } })).current_balance;
      assert.equal(d.cashBalance, cash.toString());
      assert.equal(d.cashBalance, "320");
      assert.equal(d.attributedOutstanding, "215");
      assert.equal(d.unattributedBalance, "105");
      assert.equal(d.outstandingCollectionCount, 3);
      assert.deepEqual(res.body.meta, { page: 1, limit: 50, total: 3, totalPages: 1 });
      // The settlement validator sees the same unattributed cash.
      const tooMuch = await settle(driver.driverId, [], { amount: "105.01", reason: "Legacy cash handed over" });
      assert.equal(tooMuch.body.error.details.unattributedBalance, d.unattributedBalance);
    });

    test("18. pagination is stable (delivered_at, id) with no duplicates or gaps", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      for (let i = 0; i < 5; i++) await modeOrder(driver, c.id);
      const expected = (
        await prisma.order_financial_releases.findMany({ where: { driver_id: driver.driverId }, orderBy: [{ delivered_at: "asc" }, { id: "asc" }] })
      ).map((r) => r.id);
      const seen: string[] = [];
      for (let page = 1; page <= 3; page++) {
        const res = await outstanding(driver.driverId, `?page=${page}&limit=2`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body.meta, { page, limit: 2, total: 5, totalPages: 3 });
        assert.equal(res.body.data.attributedOutstanding, "525", "position is not paginated");
        seen.push(...res.body.data.items.map((i: { releaseId: string }) => i.releaseId));
      }
      assert.deepEqual(seen, expected);
      assert.equal((await outstanding(driver.driverId, "?limit=101")).status, 400);
    });

    test("16. cross-driver isolation and authorization", async () => {
      const a = await createDriver();
      const b = await createDriver();
      const c = await newCustomer();
      const ra = await modeOrder(a, c.id);
      await modeOrder(b, c.id);
      const resB = await outstanding(b.driverId);
      assert.ok(!resB.body.data.items.some((i: { releaseId: string }) => i.releaseId === ra.release.id));
      assert.equal(resB.body.data.items.length, 1);
      for (const token of [tokens.dispatcher, a.token, c.token]) assert.equal((await outstanding(a.driverId, "", token)).status, 403);
      assert.equal((await outstanding(randomUUID())).status, 404);
      // A driver's own cash view never carries customer or other-driver data.
      const own = await get("/api/v1/driver/me/cash", a.token);
      assert.equal(own.status, 200);
      const body = JSON.stringify(own.body);
      for (const forbidden of ["pendingSettlement", "customer", "allocat", "attributed", b.driverId]) assert.ok(!body.includes(forbidden), forbidden);
    });
  });

  // ============================================================
  describe("settlement detail", () => {
    test("3, 7. allocation settlement: allocations with current collection state, releases triggered, fully / partially settled", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id);
      const full = await modeOrder(driver, c.id);
      const part = await modeOrder(driver, c.id);
      const res = await settle(
        driver.driverId,
        [
          { releaseId: full.release.id, amount: "105.00" },
          { releaseId: part.release.id, amount: "30.00" },
        ],
        { amount: "20.00", reason: "Legacy cash handed over" }
      );
      assert.equal(res.status, 201);
      const d = (await settlementDetail(res.body.data.id)).body.data;
      assert.equal(d.format, "ALLOCATION");
      assert.equal(d.allocatedTotal, "135");
      assert.equal(d.unattributedAmount, "20");
      assert.equal(d.unattributedReason, "Legacy cash handed over");
      assert.equal(d.reversed, false);
      assert.equal(d.shortfallTotal, "0");
      assert.equal(d.allocations.length, 2);
      const f = d.allocations.find((a: { releaseId: string }) => a.releaseId === full.release.id);
      const p = d.allocations.find((a: { releaseId: string }) => a.releaseId === part.release.id);
      assert.equal(f.releasedByThisSettlement, true);
      assert.equal(f.collection.settlementState, "FULLY_SETTLED");
      assert.equal(f.collection.releaseStatus, "RELEASED");
      assert.equal(f.collection.outstandingAmount, "0");
      assert.equal(f.order.id, full.orderId);
      assert.equal(p.releasedByThisSettlement, false);
      assert.deepEqual([p.amount, p.status, p.collection.allocatedAmount, p.collection.outstandingAmount, p.collection.settlementState], ["30", "ACTIVE", "30", "75", "PARTIALLY_SETTLED"]);
      assert.deepEqual(d.releasedOrders.map((r: { releaseId: string }) => r.releaseId), [full.release.id]);
      assert.equal(d.collectionsFullySettled, 1);
      assert.equal(d.collectionsPartiallySettled, 1);
      assert.deepEqual(d.corrections, []);
      // The list item is the same summary.
      const list = await get(`/api/v1/driver-settlements?driverId=${driver.driverId}`);
      const item = list.body.data.find((s: { id: string }) => s.id === d.id);
      for (const k of Object.keys(item)) assert.deepEqual(item[k], d[k], k);
    });

    test("7. legacy settlement keeps its existing response; detail has no allocations", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id);
      const res = await settleLegacy(driver.driverId, "100.00");
      assert.equal(res.status, 201);
      for (const k of ["id", "settlementNumber", "driver", "balanceBefore", "amountReceived", "balanceAfter", "paymentMethod", "receivedBy", "notes", "createdAt"]) {
        assert.ok(k in res.body.data, k);
      }
      assert.equal(res.body.data.allocatedTotal, null);
      assert.equal(res.body.data.reversed, false);
      assert.equal(res.body.data.shortfallTotal, "0");
      const d = (await settlementDetail(res.body.data.id)).body.data;
      assert.equal(d.format, "LEGACY");
      assert.deepEqual([d.allocations, d.releasedOrders, d.collectionsFullySettled, d.collectionsPartiallySettled], [[], [], 0, 0]);
    });

    test("8. corrections: reversal and shortfall are visible in detail and list", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const a = await modeOrder(driver, c.id);
      const b = await modeOrder(driver, c.id);
      const toReverse = await settle(driver.driverId, [{ releaseId: a.release.id, amount: "50.00" }]);
      const withShortfall = await settle(driver.driverId, [{ releaseId: b.release.id, amount: "105.00" }]);
      assert.equal((await reverseSettlement(toReverse.body.data.id)).status, 201);
      assert.equal((await shortfall(withShortfall.body.data.id, "12.50")).status, 201);

      const r = (await settlementDetail(toReverse.body.data.id)).body.data;
      assert.equal(r.reversed, true);
      assert.equal(r.corrections.length, 1);
      assert.equal(r.corrections[0].correctionType, "SETTLEMENT_REVERSAL");
      assert.equal(r.corrections[0].reason, REASON);
      assert.equal(r.corrections[0].createdBy.id, finance.id);
      assert.equal(r.allocations[0].status, "REVERSED");
      assert.equal(r.allocations[0].reversedByCorrectionId, r.corrections[0].id);
      assert.equal(r.allocations[0].collection.settlementState, "UNSETTLED");
      assert.equal(r.collectionsFullySettled + r.collectionsPartiallySettled, 0);

      const s = (await settlementDetail(withShortfall.body.data.id)).body.data;
      assert.equal(s.reversed, false);
      assert.equal(s.shortfallTotal, "12.5");
      assert.equal(s.corrections[0].correctionType, "SETTLEMENT_SHORTFALL");

      const list = (await get(`/api/v1/driver-settlements?driverId=${driver.driverId}`)).body.data;
      assert.equal(list.find((x: { id: string }) => x.id === r.id).reversed, true);
      assert.equal(list.find((x: { id: string }) => x.id === s.id).shortfallTotal, "12.5");
    });

    test("settlement detail authorization", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id);
      const res = await settleLegacy(driver.driverId, "10.00");
      for (const token of [tokens.dispatcher, driver.token, c.token]) assert.equal((await settlementDetail(res.body.data.id, token)).status, 403);
      assert.equal((await settlementDetail(randomUUID())).status, 404);
      assert.equal((await settlementDetail(res.body.data.id, tokens.admin)).status, 200);
    });
  });

  // ============================================================
  describe("order financial release detail", () => {
    test("legacy and IMMEDIATE orders have no release; OrderDetail carries only the mode", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const legacy = await legacyOrder(driver, c.id);
      const immediate = await outForDelivery(driver, c.id, { collectionPaymentMethodId: bypassMethodId });
      await deliver(immediate, driver, "105.00");
      const l = await orderRelease(legacy);
      assert.equal(l.status, 200);
      assert.deepEqual(l.body.data, { orderId: legacy, financialReleaseMode: null, financialStatus: "FINALIZED", release: null });
      const i = await orderRelease(immediate);
      assert.deepEqual(i.body.data, { orderId: immediate, financialReleaseMode: "IMMEDIATE", financialStatus: "FINALIZED", release: null });
      assert.equal((await get(`/api/v1/orders/${legacy}`)).body.data.financialReleaseMode, null);
      assert.equal((await get(`/api/v1/orders/${immediate}`)).body.data.financialReleaseMode, "IMMEDIATE");
    });

    test("2, 4. partial and fully-settled-awaiting-review releases; resolution trigger", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const p = await modeOrder(driver, c.id);
      const r = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      // FR.9 — an outstanding difference carries no planned split yet.
      const pre = (await outstanding(driver.driverId)).body.data.items.find((i: { releaseId: string }) => i.releaseId === r.release.id);
      assert.deepEqual([pre.reviewStatus, pre.plannedCustomerWalletAmount, pre.plannedCompanyProductAmount, pre.plannedCompanyFeeAmount], ["AWAITING_REVIEW", null, null, null]);
      const s = await settle(driver.driverId, [
        { releaseId: p.release.id, amount: "40.00" },
        { releaseId: r.release.id, amount: "95.00" },
      ]);
      const pd = (await orderRelease(p.orderId)).body.data;
      assert.equal(pd.financialReleaseMode, "ON_SETTLEMENT");
      assert.equal(pd.financialStatus, "AWAITING_SETTLEMENT");
      assert.deepEqual(
        [pd.release.releaseStatus, pd.release.reviewStatus, pd.release.collectionAmount, pd.release.allocatedAmount, pd.release.outstandingAmount, pd.release.settlementState],
        ["PENDING", "NOT_REQUIRED", "105", "40", "65", "PARTIALLY_SETTLED"]
      );
      assert.deepEqual([pd.release.plannedCustomerWalletAmount, pd.release.plannedCompanyProductAmount, pd.release.plannedCompanyFeeAmount], ["100", "0", "5"]);
      assert.equal(pd.release.releasedAt, null);
      assert.equal(pd.release.releaseTrigger, null);
      assert.equal(pd.release.allocations.length, 1);
      assert.equal(pd.release.allocations[0].settlement.id, s.body.data.id);
      assert.equal(pd.release.allocations[0].settlement.settlementNumber, s.body.data.settlementNumber);
      assert.equal(pd.release.allocations[0].status, "ACTIVE");
      assert.equal(pd.release.correction, null);
      assert.equal(pd.release.collectionReversed, false);

      const rd = (await orderRelease(r.orderId)).body.data;
      assert.equal(rd.financialStatus, "REVIEW_REQUIRED");
      assert.deepEqual([rd.release.reviewStatus, rd.release.outstandingAmount, rd.release.settlementState], ["AWAITING_REVIEW", "0", "FULLY_SETTLED"]);
      assert.equal(rd.release.plannedCustomerWalletAmount, null, "no split before review");
      assert.equal((await resolve(r.orderId, "90.00", "5.00")).status, 200);
      const after = (await orderRelease(r.orderId)).body.data;
      assert.equal(after.release.releaseStatus, "RELEASED");
      assert.equal(after.release.releaseTrigger, "RESOLUTION");
      assert.equal(after.release.releasedBySettlement, null);
      assert.equal(after.release.releasedBy.id, finance.id);
      assert.equal(after.release.plannedCustomerWalletAmount, "90");
      assert.ok(after.release.postedTransactions.walletTransactionId);
    });

    test("3, 5, 6. released by settlement, voided, and release-reversed releases", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const rel = await modeOrder(driver, c.id);
      const vo = await modeOrder(driver, c.id);
      const s = await settle(driver.driverId, [{ releaseId: rel.release.id, amount: "105.00" }]);
      const released = (await orderRelease(rel.orderId)).body.data.release;
      assert.equal(released.releaseTrigger, "SETTLEMENT");
      assert.deepEqual(released.releasedBySettlement, { id: s.body.data.id, settlementNumber: s.body.data.settlementNumber });
      assert.equal(released.outstandingAmount, "0");

      assert.equal((await reverseRelease(rel.release.id)).status, 201);
      const rr = (await orderRelease(rel.orderId)).body.data;
      assert.equal(rr.financialStatus, "RELEASE_REVERSED");
      assert.equal(rr.release.releaseStatus, "RELEASE_REVERSED");
      assert.equal(rr.release.correction.correctionType, "RELEASE_REVERSAL");
      assert.ok(rr.release.correction.walletReversalTransactionId);
      assert.equal(rr.release.postedTransactions.walletTransactionId, released.postedTransactions.walletTransactionId, "history preserved");

      assert.equal((await voidCollection(vo.release.id)).status, 201);
      const v = (await orderRelease(vo.orderId)).body.data;
      assert.equal(v.financialStatus, "COLLECTION_VOIDED");
      assert.deepEqual([v.release.releaseStatus, v.release.outstandingAmount, v.release.settlementState], ["VOIDED", "0", "UNSETTLED"]);
      assert.equal(v.release.correction.correctionType, "COLLECTION_VOID");
      assert.equal(v.release.correction.reason, REASON);
    });

    test("order release detail authorization: finance.read only; Dispatcher keeps OrderDetail", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { orderId } = await modeOrder(driver, c.id);
      for (const token of [tokens.dispatcher, driver.token, c.token]) assert.equal((await orderRelease(orderId, token)).status, 403);
      assert.equal((await orderRelease(randomUUID())).status, 404);
      const asDispatcher = await get(`/api/v1/orders/${orderId}`, tokens.dispatcher);
      assert.equal(asDispatcher.status, 200);
      assert.equal(asDispatcher.body.data.financialReleaseMode, "ON_SETTLEMENT");
      assert.equal("financialRelease" in asDispatcher.body.data, false);
      // Customer portal and public tracking expose nothing release-related.
      const tracking = (await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).tracking_code;
      const pub = await request(app).get(`/api/v1/track/${tracking}`);
      assert.equal(pub.status, 200);
      const mine = await get(`/api/v1/customer/me/orders/${orderId}`, c.token);
      assert.equal(mine.status, 200, JSON.stringify(mine.body));
      for (const body of [JSON.stringify(pub.body), JSON.stringify(mine.body)]) {
        for (const forbidden of ["financialRelease", "allocat", "settlement", "Settlement", "correction", "planned", "releaseStatus"]) assert.ok(!body.includes(forbidden), forbidden);
      }
    });
  });

  // ============================================================
  describe("pending balances", () => {
    test("10, 11, 19. delivery moves money from pending delivery to pending settlement — never both", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const orderId = await outForDelivery(driver, c.id);
      let w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingDeliveryAmount, w.pendingSettlementAmount, w.pendingAmount, w.availableBalance], ["100", "0", "100", "0"]);
      await deliver(orderId, driver, "105.00");
      w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingDeliveryAmount, w.pendingSettlementAmount, w.pendingAmount, w.availableBalance], ["0", "100", "100", "0"], "fee never pending");
    });

    test("12, 13. partial settlement keeps it pending; full settlement moves exactly the same amount to available", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await outForDelivery(driver, c.id); // 100 pending delivery
      const { release } = await modeOrder(driver, c.id);
      let w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingDeliveryAmount, w.pendingSettlementAmount, w.pendingAmount, w.availableBalance], ["100", "100", "200", "0"]);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "60.00" }]);
      w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingSettlementAmount, w.availableBalance], ["100", "0"], "partial settlement never releases");
      await settle(driver.driverId, [{ releaseId: release.id, amount: "45.00" }]);
      w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingDeliveryAmount, w.pendingSettlementAmount, w.pendingAmount, w.availableBalance], ["100", "0", "100", "100"]);
    });

    test("14. an unresolved difference contributes no money — count (and Management cash) only — until resolved", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { orderId } = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      let w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingSettlementAmount, w.pendingAmount, w.underReviewOrderCount, w.underReviewCollectionAmount], ["0", "0", 1, "95"]);
      assert.equal((await resolve(orderId, "88.00", "7.00")).status, 200);
      w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingSettlementAmount, w.pendingAmount, w.underReviewOrderCount, w.underReviewCollectionAmount], ["88", "88", 0, "0"]);
    });

    test("15. Company Orders never create customer pending or under-review money", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await outForDelivery(driver, c.id, { orderType: "COMPANY_ORDER", orderAmount: "40.00" });
      await modeOrder(driver, c.id, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      await modeOrder(driver, c.id, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "30.00", "Receiver short");
      const w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingDeliveryAmount, w.pendingSettlementAmount, w.pendingAmount, w.underReviewOrderCount], ["0", "0", "0", 0]);
    });

    test("5, 6. voided and release-reversed collections leave pending; reversed release reduces available", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const vo = await modeOrder(driver, c.id);
      const rr = await modeOrder(driver, c.id);
      await settle(driver.driverId, [{ releaseId: rr.release.id, amount: "105.00" }]);
      let w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingSettlementAmount, w.availableBalance], ["100", "100"]);
      assert.equal((await voidCollection(vo.release.id)).status, 201);
      assert.equal((await reverseRelease(rr.release.id)).status, 201);
      w = await pendingEverywhere(c);
      assert.deepEqual([w.pendingDeliveryAmount, w.pendingSettlementAmount, w.pendingAmount, w.availableBalance, w.underReviewOrderCount], ["0", "0", "0", "0", 0]);
    });

    test("19. totals: the system-wide figures change by exactly this customer's change", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const totals = async () => (await get("/api/v1/wallets/totals")).body.data;
      const before = await totals();
      for (const k of ["pendingDeliveryAmount", "pendingSettlementAmount", "underReviewOrderCount", "underReviewCollectionAmount"]) assert.ok(k in before, k);
      await outForDelivery(driver, c.id);
      await modeOrder(driver, c.id);
      await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      const after = await totals();
      const delta = (k: string) => dec(after[k]).minus(before[k]).toString();
      assert.deepEqual(
        [delta("pendingDeliveryAmount"), delta("pendingSettlementAmount"), delta("pendingAmount"), delta("underReviewCollectionAmount"), after.underReviewOrderCount - before.underReviewOrderCount],
        ["100", "100", "200", "95", 1]
      );
    });

    test("17. cross-customer isolation and authorization", async () => {
      const driver = await createDriver();
      const a = await newCustomer();
      const b = await newCustomer();
      await modeOrder(driver, a.id);
      const mineA = (await get("/api/v1/customer/me/wallet", a.token)).body.data;
      const mineB = (await get("/api/v1/customer/me/wallet", b.token)).body.data;
      assert.equal(mineA.pendingSettlementAmount, "100");
      assert.equal(mineB.pendingSettlementAmount, "0");
      for (const path of [`/api/v1/wallets/${a.id}`, "/api/v1/wallets/totals", `/api/v1/wallets/customer-summaries?customerIds=${a.id}`]) {
        assert.equal((await get(path, b.token)).status, 403, path);
        assert.equal((await get(path, driver.token)).status, 403, path);
      }
      assert.equal((await get("/api/v1/customer/me/wallet", driver.token)).status, 403);
    });
  });

  // ============================================================
  describe("read-only behavior", () => {
    test("20. every FR.7 read leaves ledgers, balances, releases, orders and audit untouched", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id);
      const p = await modeOrder(driver, c.id);
      const s = await settle(driver.driverId, [{ releaseId: p.release.id, amount: "50.00" }]);
      const before = await fingerprint();
      const reads = [
        outstanding(driver.driverId),
        settlementDetail(s.body.data.id),
        get(`/api/v1/driver-settlements?driverId=${driver.driverId}`),
        orderRelease(p.orderId),
        get(`/api/v1/orders/${p.orderId}`),
        get(`/api/v1/wallets/${c.id}`),
        get(`/api/v1/wallets?search=${encodeURIComponent(c.customerNumber)}`),
        get(`/api/v1/wallets/customer-summaries?customerIds=${c.id}`),
        get("/api/v1/wallets/totals"),
        get("/api/v1/customer/me/wallet", c.token),
        get("/api/v1/customer/me/dashboard", c.token),
      ];
      for (const r of await Promise.all(reads)) assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await fingerprint(), before);
      assert.equal((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: p.release.id } })).release_status, "PENDING", "no implicit release");
    });
  });
});
