import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { applyDriverCashTransaction } from "../../src/modules/driver-cash/driver-cash-ledger.service";
import { FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY } from "../../src/modules/financial-release/financial-release.service";
import { RECONCILIATION_SAMPLE_LIMIT } from "../../src/modules/financial-release/financial-release-reconciliation.service";
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
// FR.8 — Financial reporting (released vs delivery-date), dashboard and
// R1–R13 reconciliation.
// Contract: docs/settlement-financial-release-contract.md §11, §12
//
// Summary figures are system-wide, so every assertion is a DELTA taken
// around the action under test (test files run one at a time). Reconciliation
// assertions only ever look at findings for entities this suite created.
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const dec = (v: string | number | Prisma.Decimal | null | undefined) => new Prisma.Decimal(v ?? 0);
const REASON = "Recorded against the wrong order";
const today = new Date().toISOString().slice(0, 10);
const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

type Json = Record<string, unknown>;

describe("Financial release reporting, dashboard and reconciliation (FR.8)", () => {
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
  const createdCompanyRowIds: string[] = [];
  let keySeq = 0;
  const nextKey = (p = "fr8") => `${p}-${Date.now()}-${++keySeq}`;

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
      .send({ code: `FR8-DIRECT-${Math.random().toString(36).slice(2, 10)}`, name: "FR8 Direct", bypassDriverCash: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bypassMethodId = created.body.data.id;
  });

  afterEach(async () => {
    await setActivation(false);
  });

  after(async () => {
    await setActivation(false);
    if (createdCompanyRowIds.length) await prisma.company_financial_transactions.deleteMany({ where: { id: { in: createdCompanyRowIds } } });
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    await prisma.audit_logs.deleteMany({ where: { entity_type: "PAYMENT_METHOD", entity_id: bypassMethodId } });
    await cleanupTestPaymentMethod(bypassMethodId);
    await prisma.audit_logs.deleteMany({
      where: {
        actor_user_id: { in: [finance.id, admin.id] },
        entity_type: { in: ["DRIVER_SETTLEMENT", "CUSTOMER_PAYOUT", "DRIVER_CASH_ACCOUNT", "DRIVER_CASH_TRANSACTION"] },
      },
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

  async function newCustomer() {
    const user = await createTestUser("CUSTOMER");
    createdUserIds.push(user.id);
    const id = await seedCustomerRecord(admin.id, { portalUserId: user.id });
    createdCustomerIds.push(id);
    const login = await loginTestUser(app, user.email, user.password);
    return { id, token: login.accessToken as string };
  }

  async function outForDelivery(driver: Driver, customerId: string, overrides: Json = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR8 Receiver",
        receiverPhone: "+96170000088",
        receiverAreaId: area.id,
        receiverAddress: "8 FR8 St",
        description: "FR.8 order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.data.id as string;
    createdOrderIds.push(orderId);
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

  async function modeOrder(driver: Driver, customerId: string, overrides: Json = {}, actual = "105.00", reason?: string) {
    const orderId = await outForDelivery(driver, customerId, overrides);
    await deliver(orderId, driver, actual, reason);
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
    return { orderId, release };
  }

  async function legacyOrder(driver: Driver, customerId: string, overrides: Json = {}, actual = "105.00") {
    const orderId = await outForDelivery(driver, customerId, overrides);
    await deliver(orderId, driver, actual, undefined, false);
    return orderId;
  }

  // ------------------------------------------------------------ API
  const post = (path: string, body: Json, key: string | null = nextKey()) => {
    const r = request(app).post(path).set(auth(tokens.finance));
    if (key) r.set("Idempotency-Key", key);
    return r.send(body);
  };
  function settle(driverId: string, allocations: { releaseId: string; amount: string }[], unattributed?: { amount: string; reason: string }) {
    const total = allocations.reduce((s, a) => s.plus(a.amount), dec(unattributed?.amount ?? 0));
    return post("/api/v1/driver-settlements", {
      driverId,
      amountReceived: total.toFixed(2),
      paymentMethodId: cashMethodId,
      allocations,
      ...(unattributed ? { unattributedAmount: unattributed.amount, unattributedReason: unattributed.reason } : {}),
    });
  }
  const resolve = (orderId: string, wallet: string, fee: string, product = "0") =>
    post(`/api/v1/orders/${orderId}/resolve-collection-difference`, { customerWalletCredit: wallet, companyProductRevenue: product, companyDeliveryFeeRevenue: fee, resolutionNotes: "Agreed split" }, null);
  const voidCollection = (releaseId: string) => post(`/api/v1/finance/order-releases/${releaseId}/void-collection`, { reason: REASON });
  const reverseRelease = (releaseId: string) => post(`/api/v1/finance/order-releases/${releaseId}/reverse-release`, { reason: REASON });
  const reverseSettlement = (id: string) => post(`/api/v1/driver-settlements/${id}/reverse`, { reason: REASON });
  const shortfall = (id: string, amount: string) =>
    withShortfallPolicyApproved(() => post(`/api/v1/driver-settlements/${id}/shortfall`, { amount, reason: "Driver handed over less cash" }));
  const adjustCash = (driverId: string, direction: string, amount: string) =>
    post(`/api/v1/finance/driver-cash/${driverId}/adjust`, { direction, amount, reason: "Cash count correction" }, null);
  const payout = (customerId: string, amount: string) => post("/api/v1/payouts", { customerId, amount, paymentMethodId: cashMethodId });

  const get = (path: string, token = tokens.finance) => request(app).get(path).set(auth(token));
  const reconcile = async () => {
    const res = await get("/api/v1/finance/reconciliation/financial-release");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as { summary: Json; checks: { id: string; status: string; kind: string; blocksActivation: boolean; affectedCount: number; financialReleaseViolationCount: number; historicalAnomalyCount: number; truncated: boolean; findings: { entityId: string; entityType: string; classification: string; detail: string }[] }[] };
  };
  const check = (r: Awaited<ReturnType<typeof reconcile>>, id: string) => r.checks.find((c) => c.id === id)!;
  const findingsFor = (r: Awaited<ReturnType<typeof reconcile>>, ids: string[]) =>
    r.checks.filter((c) => c.kind !== "INFORMATIONAL").flatMap((c) => c.findings.filter((f) => ids.includes(f.entityId)).map((f) => `${c.id}:${f.entityType}:${f.entityId}:${f.detail}`));

  // Today-scoped figures on both bases (deltas only are asserted).
  async function figures() {
    const [rel, del] = await Promise.all([
      get(`/api/v1/finance/summary?from=${today}&to=${today}`),
      get(`/api/v1/finance/summary?from=${today}&to=${today}&basis=delivered`),
    ]);
    assert.equal(rel.status, 200, JSON.stringify(rel.body));
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(rel.body.data.deliveryDate, null, "released basis carries no delivery-date block");
    const s = rel.body.data;
    const d = del.body.data.deliveryDate;
    return {
      released: {
        fee: s.deliveryFeeRevenue,
        product: s.companyOrderRevenue,
        walletLiability: s.customerWalletLiability,
        payouts: s.customerPayouts,
        driverCollected: s.driverCollected,
        directCollected: s.directCompanyCollected,
        companyRevenue: s.companyRevenue,
      },
      delivered: { ...d.figures, ...Object.fromEntries(Object.entries(d.orderlessCategoryPostings).map(([k, v]) => [`orderless_${k}`, v])) },
      current: { ...s.settlementRelease.current, ...Object.fromEntries(Object.entries(s.settlementRelease.current.underReview).map(([k, v]) => [`review_${k}`, v])) },
      activity: s.settlementRelease.activity,
    };
  }
  type Figures = Awaited<ReturnType<typeof figures>>;
  // Changed values only, as decimal strings (numbers for counts).
  function delta(before: Figures, after: Figures) {
    const out: Record<string, string | number> = {};
    for (const group of ["released", "delivered", "current", "activity"] as const) {
      for (const [k, v] of Object.entries(after[group] as Json)) {
        const b = (before[group] as Json)[k];
        if (typeof v === "number") {
          if (v !== b) out[`${group}.${k}`] = v - (b as number);
        } else if (typeof v === "string" && k !== "period") {
          const d = dec(v).minus(dec(b as string));
          if (!d.isZero()) out[`${group}.${k}`] = d.toString();
        }
      }
    }
    return out;
  }
  const expectDelta = async (before: Figures, expected: Record<string, string | number>, label: string) => {
    const actual = delta(before, await figures());
    assert.deepEqual(actual, expected, label);
  };

  // ============================================================
  describe("released vs delivery-date basis", () => {
    test("1, 2, 5, 7, 8, 9. exact Delivery Only: pending on delivery date, released only on full settlement", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      let f = await figures();
      const { orderId, release } = await modeOrder(driver, c.id);
      await expectDelta(
        f,
        {
          "released.driverCollected": "105",
          "delivered.deliveryFeeRevenue": "5",
          "delivered.pendingDeliveryFeeRevenue": "5",
          "delivered.customerWalletCredits": "100",
          "delivered.pendingCustomerWalletCredits": "100",
          "current.customerFundsAwaitingSettlement": "100",
          "current.companyDeliveryFeesAwaitingSettlement": "5",
          "current.awaitingSettlementOrderCount": 1,
          "current.driverCashHeld": "105",
          "current.attributedDriverCash": "105",
        },
        "delivery: nothing released, everything pending"
      );
      f = await figures();
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "40.00" }])).status, 201);
      await expectDelta(f, { "current.driverCashHeld": "-40", "current.attributedDriverCash": "-40" }, "partial settlement releases nothing");
      f = await figures();
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "65.00" }])).status, 201);
      await expectDelta(
        f,
        {
          "released.fee": "5",
          "released.walletLiability": "100",
          "released.companyRevenue": "5",
          "delivered.postedDeliveryFeeRevenue": "5",
          "delivered.pendingDeliveryFeeRevenue": "-5",
          "delivered.postedCustomerWalletCredits": "100",
          "delivered.pendingCustomerWalletCredits": "-100",
          "current.customerFundsAwaitingSettlement": "-100",
          "current.companyDeliveryFeesAwaitingSettlement": "-5",
          "current.awaitingSettlementOrderCount": -1,
          "current.driverCashHeld": "-65",
          "current.attributedDriverCash": "-65",
          "activity.releasesCompleted": 1,
          "activity.releasedCustomerWalletCredits": "100",
          "activity.releasedDeliveryFeeRevenue": "5",
          "activity.releasedCollectionAmount": "105",
        },
        "full settlement moves pending to released; delivery-date totals unchanged"
      );
      assert.ok(orderId);
    });

    test("6. exact Company Order: product + fee revenue, never a customer credit", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      let f = await figures();
      const { release } = await modeOrder(driver, c.id, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      await expectDelta(
        f,
        {
          "released.driverCollected": "45",
          "delivered.deliveryFeeRevenue": "5",
          "delivered.pendingDeliveryFeeRevenue": "5",
          "delivered.companyOrderRevenue": "40",
          "delivered.pendingCompanyOrderRevenue": "40",
          "current.companyDeliveryFeesAwaitingSettlement": "5",
          "current.companyProductRevenueAwaitingSettlement": "40",
          "current.awaitingSettlementOrderCount": 1,
          "current.driverCashHeld": "45",
          "current.attributedDriverCash": "45",
        },
        "company order pending"
      );
      f = await figures();
      await settle(driver.driverId, [{ releaseId: release.id, amount: "45.00" }]);
      const d = delta(f, await figures());
      assert.equal(d["released.product"], "40");
      assert.equal(d["released.fee"], "5");
      assert.equal(d["released.walletLiability"], undefined, "no wallet credit for a company order");
      assert.equal(d["activity.releasedCustomerWalletCredits"], undefined);
    });

    test("3. legacy order (activation off): immediate on both bases, no settlement-release figures", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const f = await figures();
      await legacyOrder(driver, c.id);
      await expectDelta(
        f,
        {
          "released.fee": "5",
          "released.walletLiability": "100",
          "released.companyRevenue": "5",
          "released.driverCollected": "105",
          "delivered.deliveryFeeRevenue": "5",
          "delivered.postedDeliveryFeeRevenue": "5",
          "delivered.customerWalletCredits": "100",
          "delivered.postedCustomerWalletCredits": "100",
          "current.driverCashHeld": "105",
          "current.unattributedDriverCash": "105",
        },
        "legacy behavior unchanged"
      );
    });

    test("4. direct (bypass) collection: company-held, never driver cash, revenue immediate", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const f = await figures();
      const orderId = await outForDelivery(driver, c.id, { collectionPaymentMethodId: bypassMethodId });
      await deliver(orderId, driver, "105.00");
      await expectDelta(
        f,
        {
          "released.fee": "5",
          "released.walletLiability": "100",
          "released.companyRevenue": "5",
          "released.directCollected": "105",
          "delivered.deliveryFeeRevenue": "5",
          "delivered.postedDeliveryFeeRevenue": "5",
          "delivered.customerWalletCredits": "100",
          "delivered.postedCustomerWalletCredits": "100",
        },
        "direct collection"
      );
    });

    test("10, 12. unresolved difference confirms nothing; resolution after settlement releases the approved split", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      let f = await figures();
      const { orderId, release } = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      await expectDelta(
        f,
        {
          "released.driverCollected": "95",
          "delivered.underReviewOrderCount": 1,
          "delivered.underReviewCollectionAmount": "95",
          "current.review_orderCount": 1,
          "current.review_collectionAmount": "95",
          "current.review_settlementModeOrderCount": 1,
          "current.review_settlementModeCollectionAmount": "95",
          "current.driverCashHeld": "95",
          "current.attributedDriverCash": "95",
        },
        "difference: only under-review cash, no confirmed amount"
      );
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      f = await figures();
      assert.equal((await resolve(orderId, "90.00", "5.00")).status, 200);
      await expectDelta(
        f,
        {
          "released.fee": "5",
          "released.walletLiability": "90",
          "released.companyRevenue": "5",
          "delivered.deliveryFeeRevenue": "5",
          "delivered.postedDeliveryFeeRevenue": "5",
          "delivered.customerWalletCredits": "90",
          "delivered.postedCustomerWalletCredits": "90",
          "delivered.underReviewOrderCount": -1,
          "delivered.underReviewCollectionAmount": "-95",
          "current.review_orderCount": -1,
          "current.review_collectionAmount": "-95",
          "current.review_settlementModeOrderCount": -1,
          "current.review_settlementModeCollectionAmount": "-95",
          "activity.releasesCompleted": 1,
          "activity.releasedCustomerWalletCredits": "90",
          "activity.releasedDeliveryFeeRevenue": "5",
          "activity.releasedCollectionAmount": "95",
        },
        "resolution after settlement releases"
      );
    });

    test("11. difference resolved before settlement: approved split is pending until settled", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { orderId, release } = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      let f = await figures();
      assert.equal((await resolve(orderId, "88.00", "7.00")).status, 200);
      await expectDelta(
        f,
        {
          "delivered.deliveryFeeRevenue": "7",
          "delivered.pendingDeliveryFeeRevenue": "7",
          "delivered.customerWalletCredits": "88",
          "delivered.pendingCustomerWalletCredits": "88",
          "delivered.underReviewOrderCount": -1,
          "delivered.underReviewCollectionAmount": "-95",
          "current.customerFundsAwaitingSettlement": "88",
          "current.companyDeliveryFeesAwaitingSettlement": "7",
          "current.awaitingSettlementOrderCount": 1,
          "current.review_orderCount": -1,
          "current.review_collectionAmount": "-95",
          "current.review_settlementModeOrderCount": -1,
          "current.review_settlementModeCollectionAmount": "-95",
        },
        "resolved, not settled"
      );
      f = await figures();
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      const d = delta(f, await figures());
      assert.deepEqual([d["released.fee"], d["released.walletLiability"], d["delivered.deliveryFeeRevenue"]], ["7", "88", undefined]);
    });

    test("13. collection void removes the pending amounts; nothing was ever revenue", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { release } = await modeOrder(driver, c.id);
      const f = await figures();
      assert.equal((await voidCollection(release.id)).status, 201);
      await expectDelta(
        f,
        {
          "released.driverCollected": "-105",
          "delivered.deliveryFeeRevenue": "-5",
          "delivered.pendingDeliveryFeeRevenue": "-5",
          "delivered.customerWalletCredits": "-100",
          "delivered.pendingCustomerWalletCredits": "-100",
          "current.customerFundsAwaitingSettlement": "-100",
          "current.companyDeliveryFeesAwaitingSettlement": "-5",
          "current.awaitingSettlementOrderCount": -1,
          "current.driverCashHeld": "-105",
          "current.attributedDriverCash": "-105",
          "activity.collectionVoids": 1,
        },
        "void"
      );
    });

    test("14. release reversal: released basis counts it in its own period; delivery-date basis nets it to the original delivery", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { orderId, release } = await modeOrder(driver, c.id);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }]);
      const f = await figures();
      assert.equal((await reverseRelease(release.id)).status, 201);
      await expectDelta(
        f,
        {
          "released.fee": "-5",
          "released.walletLiability": "-100",
          "released.companyRevenue": "-5",
          "delivered.deliveryFeeRevenue": "-5",
          "delivered.postedDeliveryFeeRevenue": "-5",
          "delivered.customerWalletCredits": "-100",
          "delivered.postedCustomerWalletCredits": "-100",
          "activity.releaseReversals": 1,
        },
        "reversal today"
      );
      // Move the reversal rows (this suite's own records) to tomorrow: the
      // released basis then shows it tomorrow, the delivery-date basis still
      // attributes it to today's delivery.
      const correction = await prisma.order_financial_release_corrections.findUniqueOrThrow({ where: { release_id: release.id } });
      const later = new Date(`${tomorrow}T12:00:00.000Z`);
      await prisma.wallet_transactions.update({ where: { id: correction.wallet_reversal_transaction_id as string }, data: { created_at: later } });
      await prisma.company_financial_transactions.update({ where: { id: correction.company_fee_reversal_transaction_id as string }, data: { created_at: later } });
      await expectDelta(
        f,
        {
          "delivered.deliveryFeeRevenue": "-5",
          "delivered.postedDeliveryFeeRevenue": "-5",
          "delivered.customerWalletCredits": "-100",
          "delivered.postedCustomerWalletCredits": "-100",
          "activity.releaseReversals": 1,
        },
        "reversal dated tomorrow: today's released basis is untouched, delivery-date basis still nets it to today's delivery"
      );
      const next = (await get(`/api/v1/finance/summary?from=${tomorrow}&to=${tomorrow}&basis=delivered`)).body.data;
      assert.equal(next.deliveryFeeRevenue, "-5", "tomorrow's released basis carries the reversal");
      assert.equal(next.deliveryDate.figures.postedDeliveryFeeRevenue, "0", "no delivery tomorrow to attribute it to");
      assert.ok(orderId);
    });

    test("15, 16, 17, 18. settlement reversal, shortfall, cash adjustment and payout never create or remove revenue", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const a = await modeOrder(driver, c.id);
      const b = await modeOrder(driver, c.id);
      const partial = await settle(driver.driverId, [{ releaseId: a.release.id, amount: "50.00" }]);
      let f = await figures();
      assert.equal((await reverseSettlement(partial.body.data.id)).status, 201);
      await expectDelta(f, { "current.driverCashHeld": "50", "current.attributedDriverCash": "50" }, "settlement reversal restores the reserved cash");

      const full = await settle(driver.driverId, [{ releaseId: b.release.id, amount: "105.00" }]);
      f = await figures();
      assert.equal((await shortfall(full.body.data.id, "20.00")).status, 201);
      await expectDelta(f, { "current.driverCashHeld": "20", "current.unattributedDriverCash": "20" }, "shortfall is a driver obligation, not revenue");

      f = await figures();
      assert.equal((await adjustCash(driver.driverId, "CREDIT", "15.00")).status, 201);
      await expectDelta(f, { "current.driverCashHeld": "15", "current.unattributedDriverCash": "15" }, "adjustment never counts as collection or revenue");

      f = await figures();
      assert.equal((await payout(c.id, "60.00")).status, 201);
      await expectDelta(f, { "released.payouts": "60", "released.walletLiability": "-60" }, "payout reduces the wallet only");
    });

    test("19. historical order-less negative fee rows: kept in released totals, reported separately on delivery date, never attached to an order", async () => {
      const f = await figures();
      const rows = await Promise.all(
        [1, 2, 3].map(() =>
          prisma.company_financial_transactions.create({ data: { type: "DELIVERY_FEE_REVENUE", amount: dec("-5.00"), notes: "FR.8 historical anomaly fixture" } })
        )
      );
      createdCompanyRowIds.push(...rows.map((r) => r.id));
      await expectDelta(
        f,
        {
          "released.fee": "-15",
          "released.companyRevenue": "-15",
          "delivered.orderless_rowCount": 3,
          "delivered.orderless_deliveryFeeRevenue": "-15",
        },
        "orphan rows"
      );
      const r = await reconcile();
      for (const id of ["H1", "H2"]) {
        const h = check(r, id);
        assert.equal(h.kind, "HISTORICAL");
        assert.equal(h.blocksActivation, false);
        const mine = h.findings.filter((x) => rows.some((row) => row.id === x.entityId));
        assert.equal(mine.length, 3, id);
        assert.ok(mine.every((x) => x.classification === "HISTORICAL_ANOMALY"));
      }
      assert.deepEqual(findingsFor({ ...r, checks: r.checks.filter((c) => c.kind === "INVARIANT") }, rows.map((x) => x.id)), [], "never an R1–R13 violation");
      await prisma.company_financial_transactions.deleteMany({ where: { id: { in: rows.map((x) => x.id) } } });
    });

    test("20. no double counting: delivery-date posted + order-less = released category totals (all time)", async () => {
      const [rel, del] = await Promise.all([get("/api/v1/finance/summary"), get("/api/v1/finance/summary?basis=delivered")]);
      const s = rel.body.data;
      const d = del.body.data.deliveryDate;
      assert.equal(dec(d.figures.postedDeliveryFeeRevenue).plus(d.orderlessCategoryPostings.deliveryFeeRevenue).toString(), dec(s.deliveryFeeRevenue).toString());
      assert.equal(dec(d.figures.postedCompanyOrderRevenue).plus(d.orderlessCategoryPostings.companyOrderRevenue).toString(), dec(s.companyOrderRevenue).toString());
      for (const k of ["deliveryFeeRevenue", "companyOrderRevenue", "customerWalletCredits"] as const) {
        const posted = `posted${k[0].toUpperCase()}${k.slice(1)}`;
        const pending = `pending${k[0].toUpperCase()}${k.slice(1)}`;
        assert.equal(dec(d.figures[posted]).plus(d.figures[pending]).toString(), dec(d.figures[k]).toString(), k);
      }
      assert.equal(dec(s.settlementRelease.current.attributedDriverCash).plus(s.settlementRelease.current.unattributedDriverCash).toString(), dec(s.settlementRelease.current.driverCashHeld).toString());
    });
  });

  // ============================================================
  describe("reports and dashboard", () => {
    test("finance report: basis param, delivery-date rows, unchanged released rows", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await modeOrder(driver, c.id);
      const released = await get(`/api/v1/reports/finance?from=${today}&to=${today}&groupBy=day`);
      const delivered = await get(`/api/v1/reports/finance?from=${today}&to=${today}&groupBy=day&basis=delivered`);
      assert.equal(released.status, 200);
      assert.equal(released.body.data.summary.basis, "RELEASED");
      assert.equal(released.body.data.summary.deliveryDate, null);
      assert.equal(released.body.data.deliveryDateRows, null);
      assert.deepEqual(delivered.body.data.rows, released.body.data.rows, "released rows unchanged by basis");
      // Period labels follow the existing finance-report convention (the
      // released rows' own labels) — see the session time-zone note in the
      // FR.8 report: labels may differ from the JS UTC date locally.
      const label = released.body.data.rows.at(-1).period;
      assert.equal(delivered.body.data.deliveryDateRows.length, 1);
      const row = delivered.body.data.deliveryDateRows.find((x: Json) => x.period === label);
      assert.ok(dec(row.pendingCustomerWalletCredits).greaterThanOrEqualTo(100));
      assert.deepEqual(delivered.body.data.summary.deliveryDate.figures.pendingCustomerWalletCredits, row.pendingCustomerWalletCredits);
      const category = await get(`/api/v1/reports/finance?groupBy=category&basis=delivered`);
      assert.equal(category.body.data.deliveryDateRows, null);
      assert.ok(category.body.data.summary.deliveryDate);
      // Dispatcher holds reports.read: aggregate-only figures, no reconciliation.
      assert.equal((await get(`/api/v1/reports/finance?basis=delivered`, tokens.dispatcher)).status, 200);
    });

    test("driver, customer and order reports carry the settlement-release split", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id);
      const p = await modeOrder(driver, c.id);
      await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      await settle(driver.driverId, [{ releaseId: p.release.id, amount: "40.00" }]);
      const dr = (await get(`/api/v1/reports/drivers?driverId=${driver.driverId}`)).body.data.rows[0];
      assert.deepEqual([dr.currentCashHeld, dr.attributedCashHeld, dr.unattributedCashHeld, dr.outstandingCollectionCount], ["265", "160", "105", 2]);
      const cr = (await get(`/api/v1/reports/customers?customerId=${c.id}`)).body.data.rows[0];
      assert.deepEqual([cr.pendingOrderValue, cr.pendingDeliveryAmount, cr.pendingSettlementAmount, cr.underReviewOrderCount], ["100", "0", "100", 1]);
      const or = (await get(`/api/v1/reports/orders?customerId=${c.id}`)).body.data.summary.financialRelease;
      assert.deepEqual(or, { legacyMode: 1, immediateMode: 0, onSettlementMode: 2, awaitingSettlement: 1, reviewRequired: 1, finalized: 1, collectionVoided: 0, releaseReversed: 0 });
    });

    test("dashboard: released basis label, settlement-release snapshot, new audit actions by permission", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { release } = await modeOrder(driver, c.id);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }]);
      assert.equal((await reverseRelease(release.id)).status, 201);
      const fin = (await get("/api/v1/dashboard")).body.data;
      assert.equal(fin.finance.revenueBasis, "RELEASED");
      for (const k of ["customerFundsAwaitingSettlement", "attributedDriverCash", "unattributedDriverCash", "releasesCompletedToday"]) assert.ok(k in fin.finance.settlementRelease, k);
      assert.ok(fin.finance.settlementRelease.releasesCompletedToday >= 1);
      const actions = fin.recentActivity.map((a: Json) => a.action);
      for (const a of ["FINANCIAL_RELEASE_REVERSED", "FINANCIAL_RELEASE_COMPLETED", "DELIVERY_FINANCE_AWAITING_SETTLEMENT"]) assert.ok(actions.includes(a), a);
      const dis = (await get("/api/v1/dashboard", tokens.dispatcher)).body.data;
      assert.equal(dis.finance, null);
      const disActions = dis.recentActivity.map((a: Json) => a.action);
      assert.ok(!disActions.includes("FINANCIAL_RELEASE_REVERSED"), "correction actions are finance-only");
      assert.ok(disActions.includes("FINANCIAL_RELEASE_COMPLETED"), "release completion is operational (amount-free)");
    });
  });

  // ============================================================
  describe("reconciliation", () => {
    test("21. every R1–R13 check passes for a full lifecycle of this suite's records", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      await legacyOrder(driver, c.id);
      const exact = await modeOrder(driver, c.id);
      const partial = await modeOrder(driver, c.id);
      const review = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      const voided = await modeOrder(driver, c.id);
      const reversed = await modeOrder(driver, c.id);
      const company = await modeOrder(driver, c.id, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      await voidCollection(voided.release.id);
      const s1 = await settle(driver.driverId, [
        { releaseId: exact.release.id, amount: "105.00" },
        { releaseId: reversed.release.id, amount: "105.00" },
        { releaseId: company.release.id, amount: "45.00" },
        { releaseId: review.release.id, amount: "95.00" },
      ]);
      await resolve(review.orderId, "90.00", "5.00");
      await reverseRelease(reversed.release.id);
      const s2 = await settle(driver.driverId, [{ releaseId: partial.release.id, amount: "10.00" }]);
      await reverseSettlement(s2.body.data.id);
      await shortfall(s1.body.data.id, "5.00");
      await payout(c.id, "50.00");
      const ids = [driver.driverId, c.id, s1.body.data.id, s2.body.data.id, ...[exact, partial, review, voided, reversed, company].flatMap((x) => [x.orderId, x.release.id])];
      const r = await reconcile();
      assert.deepEqual(findingsFor(r, ids), []);
      assert.equal(r.checks.filter((x) => x.id.startsWith("R")).length, 13);
      const i1 = check(r, "I1");
      assert.equal(i1.status, "INFO");
      assert.equal(i1.blocksActivation, false);
    });

    test("22. deliberately corrupted fixtures are detected by the right invariant, then restored", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const legacy = await legacyOrder(driver, c.id);
      const pending = await modeOrder(driver, c.id);
      const released = await modeOrder(driver, c.id);
      const review = await modeOrder(driver, c.id, {}, "95.00", "Receiver short");
      const s = await settle(driver.driverId, [{ releaseId: released.release.id, amount: "105.00" }], { amount: "10.00", reason: "Legacy cash handed over" });
      assert.equal(s.status, 201, JSON.stringify(s.body));
      const relRow = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: released.release.id } });
      const baseline = findingsFor(await reconcile(), [driver.driverId, c.id, legacy, s.body.data.id, ...[pending, released, review].flatMap((x) => [x.orderId, x.release.id])]);
      assert.deepEqual(baseline, [], "clean before corruption");

      async function expectDetected(checkId: string, entityId: string, corrupt: () => Promise<unknown>, restore: () => Promise<unknown>) {
        await corrupt();
        try {
          const r = await reconcile();
          const ch = check(r, checkId);
          assert.equal(ch.status, "FAIL", `${checkId} should fail`);
          assert.ok(ch.blocksActivation);
          assert.ok(ch.findings.some((f) => f.entityId === entityId), `${checkId} names ${entityId}: ${JSON.stringify(ch.findings.slice(0, 3))}`);
          assert.equal(r.summary.activationBlocked, true);
        } finally {
          await restore();
        }
        assert.deepEqual(findingsFor(await reconcile(), [entityId]).filter((x) => x.startsWith(`${checkId}:`)), [], `${checkId} clean after restore`);
      }
      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      const setBalance = (v: Prisma.Decimal) => prisma.driver_cash_accounts.update({ where: { id: account.id }, data: { current_balance: v } });

      await expectDetected("R1", driver.driverId, () => setBalance(account.current_balance.plus(1)), () => setBalance(account.current_balance));
      await expectDetected("R2", driver.driverId, () => setBalance(dec(1)), () => setBalance(account.current_balance));
      await expectDetected(
        "R3",
        pending.release.id,
        () => prisma.order_financial_releases.update({ where: { id: pending.release.id }, data: { allocated_amount: dec(1) } }),
        () => prisma.order_financial_releases.update({ where: { id: pending.release.id }, data: { allocated_amount: dec(0) } })
      );
      const settlementRow = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: s.body.data.id } });
      await expectDetected(
        "R4",
        settlementRow.id,
        () =>
          prisma.driver_settlements.update({
            where: { id: settlementRow.id },
            data: { allocated_total: dec(104), unattributed_amount: dec(11) },
          }),
        () =>
          prisma.driver_settlements.update({
            where: { id: settlementRow.id },
            data: { allocated_total: settlementRow.allocated_total, unattributed_amount: settlementRow.unattributed_amount },
          })
      );
      await expectDetected(
        "R5",
        released.release.id,
        () => prisma.company_financial_transactions.update({ where: { id: relRow.company_fee_transaction_id as string }, data: { amount: dec(6) } }),
        () => prisma.company_financial_transactions.update({ where: { id: relRow.company_fee_transaction_id as string }, data: { amount: dec(5) } })
      );
      let extra = "";
      await expectDetected(
        "R6",
        pending.release.id,
        async () => {
          extra = (await prisma.company_financial_transactions.create({ data: { type: "DELIVERY_FEE_REVENUE", amount: dec(5), order_id: pending.orderId } })).id;
        },
        () => prisma.company_financial_transactions.delete({ where: { id: extra } })
      );
      await expectDetected(
        "R7",
        legacy,
        async () => {
          extra = (await prisma.company_financial_transactions.create({ data: { type: "DELIVERY_FEE_REVENUE", amount: dec(5), order_id: legacy } })).id;
        },
        () => prisma.company_financial_transactions.delete({ where: { id: extra } })
      );
      // R8 names the offending posting row; on a legacy order it is a
      // historical anomaly that still blocks activation.
      {
        const row = await prisma.company_financial_transactions.create({ data: { type: "COMPANY_ORDER_PRODUCT_REVENUE", amount: dec(5), order_id: legacy } });
        try {
          const r8 = check(await reconcile(), "R8");
          assert.ok(r8.findings.some((f) => f.entityId === row.id && f.classification === "HISTORICAL_ANOMALY"), "legacy-order R8 finding is a historical anomaly that still blocks");
          assert.ok(r8.blocksActivation);
        } finally {
          await prisma.company_financial_transactions.delete({ where: { id: row.id } });
        }
      }
      await expectDetected(
        "R9",
        pending.release.id,
        () => prisma.orders.update({ where: { id: pending.orderId }, data: { financial_release_mode: null } }),
        () => prisma.orders.update({ where: { id: pending.orderId }, data: { financial_release_mode: "ON_SETTLEMENT" } })
      );
      await expectDetected(
        "R10",
        review.release.id,
        () => prisma.order_financial_releases.update({ where: { id: review.release.id }, data: { collection_amount: dec(96) } }),
        () => prisma.order_financial_releases.update({ where: { id: review.release.id }, data: { collection_amount: dec(95) } })
      );
      await expectDetected(
        "R11",
        pending.orderId,
        () => prisma.orders.update({ where: { id: pending.orderId }, data: { financial_status: "FINALIZED" } }),
        () => prisma.orders.update({ where: { id: pending.orderId }, data: { financial_status: "AWAITING_SETTLEMENT" } })
      );
      let reversalId = "";
      await expectDetected(
        "R12",
        pending.release.id,
        async () => {
          reversalId = (
            await prisma.$transaction((tx) =>
              applyDriverCashTransaction(tx, {
                driverId: driver.driverId,
                type: "REVERSAL",
                direction: "DEBIT",
                amount: dec(105),
                orderId: pending.orderId,
                reversalOfId: pending.release.collection_transaction_id,
                idempotencyKey: `reversal:driver-cash:${pending.release.collection_transaction_id}`,
              })
            )
          ).transaction.id;
        },
        async () => {
          await prisma.driver_cash_transactions.delete({ where: { id: reversalId } });
          await prisma.driver_cash_accounts.update({ where: { id: account.id }, data: { current_balance: { increment: 105 } } });
        }
      );
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: c.id } });
      await expectDetected(
        "R13",
        c.id,
        () => prisma.customer_wallets.update({ where: { id: wallet.id }, data: { available_balance: wallet.available_balance.plus(1) } }),
        () => prisma.customer_wallets.update({ where: { id: wallet.id }, data: { available_balance: wallet.available_balance } })
      );
    });

    test("23. authorization: finance.read only; dispatcher, driver and customer are refused", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      for (const token of [tokens.dispatcher, driver.token, c.token]) {
        assert.equal((await get("/api/v1/finance/reconciliation/financial-release", token)).status, 403);
        assert.equal((await get("/api/v1/finance/summary?basis=delivered", token)).status, 403);
      }
      for (const token of [driver.token, c.token]) {
        assert.equal((await get("/api/v1/reports/finance?basis=delivered", token)).status, 403);
        assert.equal((await get("/api/v1/dashboard", token)).status, 403);
      }
      assert.equal((await get("/api/v1/finance/reconciliation/financial-release", tokens.admin)).status, 200);
      assert.equal((await get("/api/v1/finance/summary?basis=bogus")).status, 400);
    });

    test("24. read-only: reports, dashboard and reconciliation write nothing", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const { release } = await modeOrder(driver, c.id);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      const fp = async () =>
        JSON.stringify(
          await Promise.all([
            prisma.driver_cash_transactions.count(),
            prisma.wallet_transactions.count(),
            prisma.company_financial_transactions.count(),
            prisma.order_financial_releases.findMany({ orderBy: { id: "asc" } }),
            prisma.driver_settlement_allocations.count(),
            prisma.driver_settlement_corrections.count(),
            prisma.order_financial_release_corrections.count(),
            prisma.driver_cash_accounts.findMany({ orderBy: { id: "asc" } }),
            prisma.customer_wallets.findMany({ orderBy: { id: "asc" } }),
            prisma.audit_logs.count(),
          ]),
          (_k, v) => (v instanceof Date ? v.toISOString() : v)
        );
      const before = await fp();
      const responses = await Promise.all([
        get("/api/v1/finance/reconciliation/financial-release"),
        get("/api/v1/finance/summary?basis=delivered"),
        get("/api/v1/reports/finance?groupBy=week&basis=delivered"),
        get("/api/v1/reports/drivers"),
        get("/api/v1/reports/customers"),
        get("/api/v1/reports/orders"),
        get("/api/v1/dashboard"),
      ]);
      for (const r of responses) assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await fp(), before);
    });

    test("25. consistent snapshot while settlements release concurrently", async () => {
      const driver = await createDriver();
      const c = await newCustomer();
      const orders = [];
      for (let i = 0; i < 4; i++) orders.push(await modeOrder(driver, c.id));
      const ids = [driver.driverId, c.id, ...orders.flatMap((o) => [o.orderId, o.release.id])];
      const work = orders.map((o) => () => settle(driver.driverId, [{ releaseId: o.release.id, amount: "105.00" }]));
      const results = await Promise.all([...work.map((w) => w()), reconcile(), reconcile(), reconcile(), reconcile()]);
      for (const r of results.slice(0, 4) as { status: number }[]) assert.equal(r.status, 201);
      for (const r of results.slice(4) as Awaited<ReturnType<typeof reconcile>>[]) assert.deepEqual(findingsFor(r, ids), [], "no torn reads");
      assert.deepEqual(findingsFor(await reconcile(), ids), []);
    });

    test("26. large anomaly sets stay bounded: exact count, capped sample, truncated flag", async () => {
      const before = check(await reconcile(), "H1").affectedCount;
      const n = 120;
      const created = await prisma.company_financial_transactions.createManyAndReturn({
        data: Array.from({ length: n }, () => ({ type: "DELIVERY_FEE_REVENUE" as const, amount: dec("-1.00"), notes: "FR.8 bounded-sample fixture" })),
        select: { id: true },
      });
      createdCompanyRowIds.push(...created.map((r) => r.id));
      try {
        const started = Date.now();
        const r = await reconcile();
        const ms = Date.now() - started;
        const h1 = check(r, "H1");
        assert.equal(h1.affectedCount, before + n);
        assert.equal(h1.findings.length, RECONCILIATION_SAMPLE_LIMIT);
        assert.equal(h1.truncated, true);
        console.log(`[FR.8 perf] reconciliation with ${before + n} H1 anomalies: ${ms} ms (HTTP, local PostgreSQL)`);
      } finally {
        await prisma.company_financial_transactions.deleteMany({ where: { id: { in: created.map((r) => r.id) } } });
      }
    });
  });
});
