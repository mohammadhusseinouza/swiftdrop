import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { creditWalletForOrder } from "../../src/modules/wallets/wallet-ledger.service";
import { recordDeliveryFeeRevenue } from "../../src/modules/company-finance/company-finance-ledger.service";
import { applyDriverCashTransaction } from "../../src/modules/driver-cash/driver-cash-ledger.service";
import { FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY } from "../../src/modules/financial-release/financial-release.service";
import { MAX_ALLOCATIONS_PER_SETTLEMENT } from "../../src/modules/settlements/settlement.schema";
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
} from "../helpers/fixtures";

// ============================================================
// FR.4 — Driver settlement allocations + release on settlement
// Contract: docs/settlement-financial-release-contract.md §5.2 / §5.3 / §6 / §7
//
// Settlement-mode collections are produced by real deliveries with the
// GLOBAL activation flag switched on only for the duration of that delivery
// (always restored to false — test files run one at a time). Settlement
// processing itself never depends on the flag (persisted mode governs).
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const dec = (v: string | number) => new Prisma.Decimal(v);

describe("Driver settlement allocations (FR.4)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let tokens: { admin: string; finance: string };
  let customerA: string;
  let customerB: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  let bypassMethodId: string;

  const createdOrderIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdMethodIds: string[] = [];
  let foreignSettlementsBefore: string;
  let keySeq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const setActivation = (enabled: boolean) => prisma.system_settings.update({ where: { key: KEY }, data: { value: enabled } });

  async function foreignSettlementsFingerprint(): Promise<string> {
    const rows = await prisma.driver_settlements.findMany({
      where: { driver_id: { notIn: createdDriverIds.length ? createdDriverIds : ["00000000-0000-0000-0000-000000000000"] } },
      orderBy: { id: "asc" },
    });
    return JSON.stringify(rows);
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    const [a, f] = await Promise.all([loginTestUser(app, admin.email, admin.password), loginTestUser(app, finance.email, finance.password)]);
    tokens = { admin: a.accessToken as string, finance: f.accessToken as string };
    assert.equal((await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } })).value, false);

    customerA = await seedCustomerRecord(admin.id);
    customerB = await seedCustomerRecord(admin.id);
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    const created = await request(app)
      .post("/api/v1/settings/payment-methods")
      .set(auth(tokens.admin))
      .send({ code: `FR4-DIRECT-${Math.random().toString(36).slice(2, 10)}`, name: "FR4 Direct", bypassDriverCash: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bypassMethodId = created.body.data.id;
    createdMethodIds.push(bypassMethodId);
    foreignSettlementsBefore = await foreignSettlementsFingerprint();
  });

  afterEach(async () => {
    await setActivation(false);
  });

  after(async () => {
    await setActivation(false);
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    for (const id of createdMethodIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "PAYMENT_METHOD", entity_id: id } });
      await cleanupTestPaymentMethod(id);
    }
    await prisma.audit_logs.deleteMany({ where: { entity_type: "DRIVER_SETTLEMENT", actor_user_id: finance.id } });
    await cleanupTestCustomerRecord(customerA);
    await cleanupTestCustomerRecord(customerB);
    await cleanupTestArea(area.id);
    await Promise.all([admin, finance].map((u) => cleanupTestUser(u.id)));
    assert.equal((await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } })).value, false);
  });

  // ------------------------------------------------------------ helpers
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

  async function outForDelivery(driver: Driver, overrides: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerA,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR4 Receiver",
        receiverPhone: "+96170000044",
        receiverAreaId: area.id,
        receiverAddress: "4 FR4 St",
        description: "FR.4 order",
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

  const deliverRaw = (orderId: string, driver: Driver, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(driver.token)).send(body);

  // A delivered settlement-mode order + its release. Activation is on ONLY
  // for the delivery itself.
  async function settlementModeOrder(driver: Driver, overrides: Record<string, unknown> = {}, actual = "105.00", reason?: string) {
    const orderId = await outForDelivery(driver, overrides);
    await setActivation(true);
    try {
      const res = await deliverRaw(orderId, driver, { actualAmountCollected: actual, ...(reason ? { collectionDifferenceReason: reason } : {}) });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    } finally {
      await setActivation(false);
    }
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
    return { orderId, release };
  }

  // A delivered LEGACY order (activation off) — its cash is unattributed.
  async function legacyOrder(driver: Driver) {
    const orderId = await outForDelivery(driver);
    const res = await deliverRaw(orderId, driver, { actualAmountCollected: "105.00" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return orderId;
  }

  function settle(body: Record<string, unknown>, key = `fr4-${Date.now()}-${++keySeq}`) {
    return request(app)
      .post("/api/v1/driver-settlements")
      .set(auth(tokens.finance))
      .set("Idempotency-Key", key)
      .send({ paymentMethodId: cashMethodId, ...body });
  }

  async function state(orderId: string) {
    const [order, release, wallet, company] = await Promise.all([
      prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
      prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId }, orderBy: { type: "asc" } }),
    ]);
    return { order, release, wallet, company };
  }
  const cash = async (driverId: string) => (await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } })).current_balance;
  const wallet = async (customerId: string) => (await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } })).available_balance;
  const settlementCount = (driverId: string) => prisma.driver_settlements.count({ where: { driver_id: driverId } });

  // Reconciliation R2 / R3 / R4 (contract §11) for one driver.
  async function assertReconciled(driverId: string) {
    const balance = await cash(driverId);
    const releases = await prisma.order_financial_releases.findMany({ where: { driver_id: driverId }, include: { allocations: true } });
    let attributed = dec(0);
    for (const r of releases) {
      const active = r.allocations.filter((a) => a.reversed_by_correction_id === null).reduce((s, a) => s.plus(a.amount), dec(0));
      assert.ok(r.allocated_amount.equals(active), `R3 allocated_amount = Σ active allocations (${r.id})`);
      assert.ok(r.allocated_amount.lessThanOrEqualTo(r.collection_amount));
      if (r.release_status === "PENDING") attributed = attributed.plus(r.collection_amount.minus(r.allocated_amount));
    }
    assert.ok(balance.minus(attributed).greaterThanOrEqualTo(0), "R2 unattributed driver cash >= 0");
    const settlements = await prisma.driver_settlements.findMany({ where: { driver_id: driverId }, include: { allocations: true } });
    for (const s of settlements) {
      if (s.allocated_total === null) continue;
      const sum = s.allocations.reduce((acc, a) => acc.plus(a.amount), dec(0));
      assert.ok(s.allocated_total.equals(sum), "R4 allocated_total = Σ allocations");
      assert.ok(s.amount_received.equals(s.allocated_total.plus(s.unattributed_amount as Prisma.Decimal)), "R4 amount = allocated + unattributed");
    }
  }

  // ============================================================
  describe("full and partial settlement", () => {
    test("1 / 5 / 23. full settlement of one DELIVERY_ONLY collection releases wallet + fee with the existing keys", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver);
      const walletBefore = await wallet(customerA);
      const res = await settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: release.id, amount: "105.00" }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.allocatedTotal, "105");
      assert.equal(res.body.data.unattributedAmount, "0");
      assert.equal(res.body.data.unattributedReason, null);

      const s = await state(orderId);
      assert.equal(s.release.release_status, "RELEASED");
      assert.ok(s.release.allocated_amount.equals(105));
      assert.equal(s.release.released_by_settlement_id, res.body.data.id);
      assert.equal(s.order.financial_status, "FINALIZED");
      assert.equal(s.order.status, "DELIVERED");
      assert.equal(s.wallet.length, 1);
      assert.equal(s.wallet[0].idempotency_key, `delivery:${orderId}:wallet-order-credit`);
      assert.deepEqual(s.company.map((c) => [c.type, c.amount.toString(), c.idempotency_key]), [
        ["DELIVERY_FEE_REVENUE", "5", `delivery:${orderId}:delivery-fee-revenue`],
      ]);
      assert.ok((await wallet(customerA)).equals(walletBefore.plus(100)));
      assert.ok((await cash(driver.driverId)).isZero());
      const allocations = await prisma.driver_settlement_allocations.findMany({ where: { settlement_id: res.body.data.id } });
      assert.equal(allocations.length, 1);
      assert.ok(allocations[0].amount.equals(105));
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: res.body.data.id } });
      assert.deepEqual((audit.metadata as Record<string, unknown>).releasedReleaseIds, [release.id]);
      await assertReconciled(driver.driverId);
    });

    test("2 / 6. one settlement fully settles several collections (incl. a COMPANY_ORDER of another customer)", async () => {
      const driver = await createDriver();
      const a = await settlementModeOrder(driver);
      const b = await settlementModeOrder(driver, { customerId: customerB });
      const c = await settlementModeOrder(driver, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      const [wa, wb] = [await wallet(customerA), await wallet(customerB)];
      const res = await settle({
        driverId: driver.driverId,
        amountReceived: "255.00",
        allocations: [
          { releaseId: c.release.id, amount: "45.00" },
          { releaseId: a.release.id, amount: "105.00" },
          { releaseId: b.release.id, amount: "105.00" },
        ],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      for (const o of [a, b, c]) {
        const s = await state(o.orderId);
        assert.equal(s.release.release_status, "RELEASED");
        assert.equal(s.order.financial_status, "FINALIZED");
      }
      assert.ok((await wallet(customerA)).equals(wa.plus(100)), "COMPANY_ORDER never credits a wallet");
      assert.ok((await wallet(customerB)).equals(wb.plus(100)));
      const companyOrder = await state(c.orderId);
      assert.equal(companyOrder.wallet.length, 0);
      assert.deepEqual(companyOrder.company.map((x) => [x.type, x.amount.toString()]), [
        ["DELIVERY_FEE_REVENUE", "5"],
        ["COMPANY_ORDER_PRODUCT_REVENUE", "40"],
      ]);
      assert.ok((await cash(driver.driverId)).isZero());
      await assertReconciled(driver.driverId);
    });

    test("3. partial settlement of one collection posts nothing and leaves the remainder outstanding", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver);
      const res = await settle({ driverId: driver.driverId, amountReceived: "50.00", allocations: [{ releaseId: release.id, amount: "50.00" }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const s = await state(orderId);
      assert.equal(s.release.release_status, "PENDING");
      assert.ok(s.release.allocated_amount.equals(50));
      assert.equal(s.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(s.wallet.length + s.company.length, 0);
      assert.ok((await cash(driver.driverId)).equals(55));
      await assertReconciled(driver.driverId);
    });

    test("4. a collection completed across two settlements releases exactly once, on the completing settlement", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver);
      const first = await settle({ driverId: driver.driverId, amountReceived: "50.00", allocations: [{ releaseId: release.id, amount: "50.00" }] });
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await settle({ driverId: driver.driverId, amountReceived: "55.00", allocations: [{ releaseId: release.id, amount: "55.00" }] });
      assert.equal(second.status, 201, JSON.stringify(second.body));
      const s = await state(orderId);
      assert.equal(s.release.release_status, "RELEASED");
      assert.equal(s.release.released_by_settlement_id, second.body.data.id);
      assert.equal(s.wallet.length, 1);
      assert.equal(s.company.length, 1);
      assert.equal(await prisma.driver_settlement_allocations.count({ where: { release_id: release.id } }), 2);
      assert.ok((await cash(driver.driverId)).isZero());
      await assertReconciled(driver.driverId);
    });

    test("7. a fully settled collection awaiting difference review stays PENDING (FR.5) with zero postings", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver, {}, "95.00", "Receiver short");
      const res = await settle({ driverId: driver.driverId, amountReceived: "95.00", allocations: [{ releaseId: release.id, amount: "95.00" }] });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const s = await state(orderId);
      assert.equal(s.release.release_status, "PENDING");
      assert.equal(s.release.review_status, "AWAITING_REVIEW");
      assert.ok(s.release.allocated_amount.equals(95));
      assert.equal(s.order.financial_status, "REVIEW_REQUIRED");
      assert.equal(s.wallet.length + s.company.length, 0);
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: res.body.data.id } });
      assert.deepEqual((audit.metadata as Record<string, unknown>).awaitingReviewReleaseIds, [release.id]);
      // A fully allocated collection cannot be allocated again.
      const more = await settle({ driverId: driver.driverId, amountReceived: "1.00", allocations: [{ releaseId: release.id, amount: "1.00" }] });
      assert.equal(more.status, 400);
      await assertReconciled(driver.driverId);
    });

    test("8. mixed allocations: only the fully settled, review-cleared collection releases", async () => {
      const driver = await createDriver();
      const full = await settlementModeOrder(driver);
      const partial = await settlementModeOrder(driver);
      const review = await settlementModeOrder(driver, {}, "90.00", "Receiver short");
      const res = await settle({
        driverId: driver.driverId,
        amountReceived: "255.00",
        allocations: [
          { releaseId: full.release.id, amount: "105.00" },
          { releaseId: partial.release.id, amount: "60.00" },
          { releaseId: review.release.id, amount: "90.00" },
        ],
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal((await state(full.orderId)).release.release_status, "RELEASED");
      const p = await state(partial.orderId);
      assert.equal(p.release.release_status, "PENDING");
      assert.equal(p.wallet.length, 0);
      const r = await state(review.orderId);
      assert.equal(r.release.release_status, "PENDING");
      assert.equal(r.wallet.length + r.company.length, 0);
      assert.ok((await cash(driver.driverId)).equals(45));
      await assertReconciled(driver.driverId);
    });

    test(`limit: ${MAX_ALLOCATIONS_PER_SETTLEMENT} allocations are accepted in one settlement; ${MAX_ALLOCATIONS_PER_SETTLEMENT + 1} are rejected`, async () => {
      const driver = await createDriver();
      const releases = [];
      for (let i = 0; i < MAX_ALLOCATIONS_PER_SETTLEMENT; i++) releases.push((await settlementModeOrder(driver, { orderAmount: "10.00", deliveryFee: "1.00" }, "11.00")).release);
      const tooMany = await settle({
        driverId: driver.driverId,
        amountReceived: String(11 * (MAX_ALLOCATIONS_PER_SETTLEMENT + 1)),
        allocations: [...releases.map((r) => ({ releaseId: r.id, amount: "11.00" })), { releaseId: "00000000-0000-0000-0000-000000000001", amount: "11.00" }],
      });
      assert.equal(tooMany.status, 400);
      const started = Date.now();
      const res = await settle({ driverId: driver.driverId, amountReceived: String(11 * MAX_ALLOCATIONS_PER_SETTLEMENT), allocations: releases.map((r) => ({ releaseId: r.id, amount: "11.00" })) });
      const ms = Date.now() - started;
      assert.equal(res.status, 201, JSON.stringify(res.body));
      console.log(`[FR.4 perf] ${MAX_ALLOCATIONS_PER_SETTLEMENT}-allocation settlement with ${MAX_ALLOCATIONS_PER_SETTLEMENT} releases: ${ms} ms (HTTP round trip, local PostgreSQL)`);
      assert.equal(await prisma.order_financial_releases.count({ where: { driver_id: driver.driverId, release_status: "RELEASED" } }), MAX_ALLOCATIONS_PER_SETTLEMENT);
      assert.ok((await cash(driver.driverId)).isZero());
      await assertReconciled(driver.driverId);
    });
  });

  // ============================================================
  describe("unattributed cash and legacy compatibility", () => {
    test("9. valid unattributed cash (legacy collection) settles alongside an allocation; reason recorded", async () => {
      const driver = await createDriver();
      await legacyOrder(driver);
      const { release } = await settlementModeOrder(driver);
      const res = await settle({
        driverId: driver.driverId,
        amountReceived: "210.00",
        allocations: [{ releaseId: release.id, amount: "105.00" }],
        unattributedAmount: "105.00",
        unattributedReason: "Legacy cash from before activation",
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.unattributedAmount, "105");
      assert.equal(res.body.data.unattributedReason, "Legacy cash from before activation");
      assert.ok((await cash(driver.driverId)).isZero());
      await assertReconciled(driver.driverId);
    });

    test("10. unattributed amount above the unattributed balance is rejected — reserved cash is never consumed", async () => {
      const driver = await createDriver();
      const { release } = await settlementModeOrder(driver);
      const res = await settle({
        driverId: driver.driverId,
        amountReceived: "105.00",
        allocations: [],
        unattributedAmount: "105.00",
        unattributedReason: "Trying to take reserved money",
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "UNATTRIBUTED_EXCEEDS_BALANCE");
      assert.ok((await cash(driver.driverId)).equals(105));
      assert.equal(await settlementCount(driver.driverId), 0);
      assert.ok((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).allocated_amount.isZero());
    });

    test("9b. reason rules: a positive unattributed amount needs a meaningful reason; a reason needs a positive amount", async () => {
      const driver = await createDriver();
      await legacyOrder(driver);
      const noReason = await settle({ driverId: driver.driverId, amountReceived: "5.00", allocations: [], unattributedAmount: "5.00" });
      assert.equal(noReason.status, 400);
      const short = await settle({ driverId: driver.driverId, amountReceived: "5.00", allocations: [], unattributedAmount: "5.00", unattributedReason: "short" });
      assert.equal(short.status, 400);
      const orphanReason = await settle({ driverId: driver.driverId, amountReceived: "5.00", allocations: [], unattributedAmount: "0", unattributedReason: "a meaningful reason" });
      assert.equal(orphanReason.status, 400);
      const noAllocations = await settle({ driverId: driver.driverId, amountReceived: "5.00", unattributedAmount: "5.00", unattributedReason: "a meaningful reason" });
      assert.equal(noAllocations.status, 400, "unattributed fields require the allocation format");
      assert.equal(await settlementCount(driver.driverId), 0);
    });

    test("11. legacy compatibility: a request without allocations still works for legacy cash while activation is off", async () => {
      const driver = await createDriver();
      await legacyOrder(driver);
      const res = await settle({ driverId: driver.driverId, amountReceived: "100.00" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.allocatedTotal, null);
      assert.equal(res.body.data.unattributedAmount, null);
      const row = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(row.allocated_total, null);
      assert.ok((await cash(driver.driverId)).equals(5));
    });

    test("12. a request without allocations is rejected while settlement-mode cash is outstanding, or while activation is on", async () => {
      const driver = await createDriver();
      await legacyOrder(driver);
      await settlementModeOrder(driver);
      const blocked = await settle({ driverId: driver.driverId, amountReceived: "105.00" });
      assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
      assert.equal(blocked.body.error.details.reason, "ALLOCATION_CONTRACT_REQUIRED");

      const other = await createDriver();
      await legacyOrder(other);
      await setActivation(true);
      const whileActive = await settle({ driverId: other.driverId, amountReceived: "105.00" });
      await setActivation(false);
      assert.equal(whileActive.status, 400);
      assert.equal(whileActive.body.error.details.reason, "ALLOCATION_CONTRACT_REQUIRED");
      assert.ok((await cash(driver.driverId)).equals(210));
      assert.equal(await settlementCount(driver.driverId), 0);
    });
  });

  // ============================================================
  describe("allocation validation", () => {
    test("13. another driver's collection is rejected (same message as a missing one); nothing changes", async () => {
      const owner = await createDriver();
      const intruder = await createDriver();
      const { release } = await settlementModeOrder(owner);
      await settlementModeOrder(intruder);
      const res = await settle({ driverId: intruder.driverId, amountReceived: "105.00", allocations: [{ releaseId: release.id, amount: "105.00" }] });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "ALLOCATION_INVALID");
      assert.match(res.body.error.details.problem, /not found for this driver/);
      assert.ok((await cash(intruder.driverId)).equals(105));
      assert.ok((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).allocated_amount.isZero());
    });

    test("14. duplicate release ids in one request are rejected", async () => {
      const driver = await createDriver();
      const { release } = await settlementModeOrder(driver);
      const res = await settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: release.id, amount: "50.00" }, { releaseId: release.id, amount: "55.00" }] });
      assert.equal(res.status, 400);
      assert.equal(await settlementCount(driver.driverId), 0);
    });

    test("15. over-allocation, sum mismatch, zero and over-precise amounts are rejected", async () => {
      const driver = await createDriver();
      const { release } = await settlementModeOrder(driver);
      const over = await settle({ driverId: driver.driverId, amountReceived: "105.01", allocations: [{ releaseId: release.id, amount: "105.01" }] });
      assert.equal(over.status, 400, JSON.stringify(over.body));
      assert.match(over.body.error.details.problem, /exceeds the unsettled amount/);
      const mismatch = await settle({ driverId: driver.driverId, amountReceived: "100.00", allocations: [{ releaseId: release.id, amount: "50.00" }] });
      assert.equal(mismatch.status, 400);
      const zero = await settle({ driverId: driver.driverId, amountReceived: "1.00", allocations: [{ releaseId: release.id, amount: "0" }], unattributedAmount: "1.00", unattributedReason: "a meaningful reason" });
      assert.equal(zero.status, 400);
      const precise = await settle({ driverId: driver.driverId, amountReceived: "10.005", allocations: [{ releaseId: release.id, amount: "10.005" }] });
      assert.equal(precise.status, 400);
      assert.equal(await settlementCount(driver.driverId), 0);
      assert.ok((await cash(driver.driverId)).equals(105));
    });

    test("16. voided and reversed collections are not eligible", async () => {
      const driver = await createDriver();
      const voided = await settlementModeOrder(driver);
      // FR.6 owns the void workflow; the state is set directly here.
      await prisma.order_financial_releases.update({ where: { id: voided.release.id }, data: { release_status: "VOIDED" } });
      const resVoided = await settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: voided.release.id, amount: "105.00" }] });
      assert.equal(resVoided.status, 400, JSON.stringify(resVoided.body));
      assert.match(resVoided.body.error.details.problem, /not eligible/);

      const reversed = await settlementModeOrder(driver);
      // FR.6: the generic endpoint refuses a release-linked collection; a
      // reversal written before that guard (pre-FR.6 data) is built with the
      // ledger primitive exactly as the old endpoint did.
      const generic = await request(app)
        .post(`/api/v1/finance/driver-cash-transactions/${reversed.release.collection_transaction_id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "Collection recorded in error" });
      assert.equal(generic.status, 409, JSON.stringify(generic.body));
      await prisma.$transaction((tx) =>
        applyDriverCashTransaction(tx, {
          driverId: driver.driverId,
          type: "REVERSAL",
          direction: "DEBIT",
          amount: reversed.release.collection_amount,
          orderId: reversed.orderId,
          reversalOfId: reversed.release.collection_transaction_id,
          idempotencyKey: `reversal:driver-cash:${reversed.release.collection_transaction_id}`,
        })
      );
      const resReversed = await settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: reversed.release.id, amount: "105.00" }] });
      assert.equal(resReversed.status, 400, JSON.stringify(resReversed.body));
      assert.match(resReversed.body.error.details.problem, /reversed/);
      assert.equal(await settlementCount(driver.driverId), 0);
    });
  });

  // ============================================================
  describe("idempotency", () => {
    test("17. identical retry returns the original settlement — one debit, one allocation, one release", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver);
      const body = { driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: release.id, amount: "105.00" }] };
      const first = await settle(body, `fr4-retry-${release.id}`);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const again = await settle(body, `fr4-retry-${release.id}`);
      assert.equal(again.status, 201, JSON.stringify(again.body));
      assert.equal(again.body.data.id, first.body.data.id);
      assert.equal(await settlementCount(driver.driverId), 1);
      assert.equal(await prisma.driver_settlement_allocations.count({ where: { release_id: release.id } }), 1);
      assert.equal(await prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId, type: "SETTLEMENT" } }), 1);
      const s = await state(orderId);
      assert.equal(s.wallet.length, 1);
      assert.equal(s.company.length, 1);
    });

    test("18. same key with different allocations, unattributed amount or reason -> 409, nothing executed", async () => {
      const driver = await createDriver();
      await legacyOrder(driver);
      const { release } = await settlementModeOrder(driver);
      const key = `fr4-modified-${release.id}`;
      const original = {
        driverId: driver.driverId,
        amountReceived: "60.00",
        allocations: [{ releaseId: release.id, amount: "50.00" }],
        unattributedAmount: "10.00",
        unattributedReason: "Legacy cash portion",
      };
      assert.equal((await settle(original, key)).status, 201);
      const variants = [
        { ...original, allocations: [{ releaseId: release.id, amount: "40.00" }], unattributedAmount: "20.00" },
        { ...original, unattributedReason: "A different explanation" },
        { driverId: driver.driverId, amountReceived: "60.00" },
      ];
      for (const v of variants) {
        const res = await settle(v, key);
        assert.equal(res.status, 409, JSON.stringify(res.body));
      }
      assert.equal(await settlementCount(driver.driverId), 1);
      assert.ok((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).allocated_amount.equals(50));
      assert.ok((await cash(driver.driverId)).equals(150));
    });
  });

  // ============================================================
  describe("concurrency (real PostgreSQL)", () => {
    test("19. concurrent settlements targeting the same collection: exactly one succeeds, no over-allocation", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver);
      const results = await Promise.all(
        [1, 2, 3].map((i) => settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: release.id, amount: "105.00" }] }, `fr4-race-${release.id}-${i}`))
      );
      assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => [r.status, r.body?.error?.details?.problem])));
      for (const r of results.filter((x) => x.status !== 201)) assert.ok([400, 409].includes(r.status));
      assert.equal(await settlementCount(driver.driverId), 1);
      const s = await state(orderId);
      assert.ok(s.release.allocated_amount.equals(105));
      assert.equal(s.wallet.length, 1);
      assert.ok((await cash(driver.driverId)).isZero());

      // Concurrent partials that together exceed the collection.
      const second = await settlementModeOrder(driver);
      const partials = await Promise.all(
        [1, 2].map((i) => settle({ driverId: driver.driverId, amountReceived: "60.00", allocations: [{ releaseId: second.release.id, amount: "60.00" }] }, `fr4-partial-${second.release.id}-${i}`))
      );
      assert.equal(partials.filter((r) => r.status === 201).length, 1);
      assert.ok((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: second.release.id } })).allocated_amount.equals(60));
      await assertReconciled(driver.driverId);
    });

    test("20. settlement and a new delivery for the same driver run concurrently without deadlock or lost updates", async () => {
      const driver = await createDriver();
      const settled = await settlementModeOrder(driver);
      const nextOrder = await outForDelivery(driver);
      await setActivation(true);
      let results;
      try {
        results = await Promise.all([
          settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: settled.release.id, amount: "105.00" }] }),
          deliverRaw(nextOrder, driver, { actualAmountCollected: "105.00" }),
        ]);
      } finally {
        await setActivation(false);
      }
      assert.equal(results[0].status, 201, JSON.stringify(results[0].body));
      assert.equal(results[1].status, 200, JSON.stringify(results[1].body));
      assert.equal((await state(settled.orderId)).release.release_status, "RELEASED");
      const next = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: nextOrder } });
      assert.equal(next.release_status, "PENDING");
      assert.ok((await cash(driver.driverId)).equals(105), "debit and credit both applied");
      await assertReconciled(driver.driverId);
    });
  });

  // ============================================================
  describe("atomicity, history and bypass", () => {
    test("21. a posting failure during release rolls back the entire settlement", async () => {
      const driver = await createDriver();
      const { orderId, release } = await settlementModeOrder(driver);
      // Pre-existing posting under the release's deterministic key.
      await prisma.$transaction((tx) =>
        creditWalletForOrder(tx, { customerId: customerA, orderId, amount: dec("100.00"), idempotencyKey: `delivery:${orderId}:wallet-order-credit` })
      );
      const res = await settle({ driverId: driver.driverId, amountReceived: "105.00", allocations: [{ releaseId: release.id, amount: "105.00" }] });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(await settlementCount(driver.driverId), 0);
      assert.equal(await prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId, type: "SETTLEMENT" } }), 0);
      assert.ok((await cash(driver.driverId)).equals(105));
      const s = await state(orderId);
      assert.ok(s.release.allocated_amount.isZero());
      assert.equal(s.release.release_status, "PENDING");
      assert.equal(s.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(s.company.length, 0);
      assert.equal(await prisma.driver_settlement_allocations.count({ where: { release_id: release.id } }), 0);
    });

    test("21a. FR.11A batch release: an existing company posting key on ONE of several collections rolls back the whole settlement", async () => {
      const driver = await createDriver();
      const a = await settlementModeOrder(driver);
      const b = await settlementModeOrder(driver, { customerId: customerB });
      const c = await settlementModeOrder(driver);
      // Pre-existing fee posting for the middle order only.
      await prisma.$transaction((tx) =>
        recordDeliveryFeeRevenue(tx, { orderId: b.orderId, amount: dec("5.00"), idempotencyKey: `delivery:${b.orderId}:delivery-fee-revenue` })
      );
      const walletsBefore = [await wallet(customerA), await wallet(customerB)];
      const res = await settle({
        driverId: driver.driverId,
        amountReceived: "315.00",
        allocations: [a, b, c].map((o) => ({ releaseId: o.release.id, amount: "105.00" })),
      });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(await settlementCount(driver.driverId), 0);
      assert.ok((await cash(driver.driverId)).equals(315));
      for (const o of [a, b, c]) {
        const s = await state(o.orderId);
        assert.equal(s.release.release_status, "PENDING");
        assert.ok(s.release.allocated_amount.isZero());
        assert.equal(s.order.financial_status, "AWAITING_SETTLEMENT");
        assert.equal(s.wallet.length, 0, "wallet credits posted earlier in the batch rolled back");
      }
      assert.equal((await state(b.orderId)).company.length, 1, "only the pre-existing row");
      assert.equal((await state(a.orderId)).company.length, 0);
      assert.ok((await wallet(customerA)).equals(walletsBefore[0]));
      assert.ok((await wallet(customerB)).equals(walletsBefore[1]));
      assert.equal(await prisma.audit_logs.count({ where: { action: "FINANCIAL_RELEASE_COMPLETED", entity_id: { in: [a.orderId, b.orderId, c.orderId] } } }), 0);
    });

    test("21b. FR.11A batch release: every release links its own postings; same-customer wallet rows chain balances", async () => {
      const driver = await createDriver();
      const orders = [
        await settlementModeOrder(driver),
        await settlementModeOrder(driver, { customerId: customerB }),
        await settlementModeOrder(driver),
        await settlementModeOrder(driver, { orderType: "COMPANY_ORDER" }),
        await settlementModeOrder(driver),
      ];
      const balanceBefore = await wallet(customerA);
      const res = await settle({
        driverId: driver.driverId,
        amountReceived: "525.00",
        allocations: orders.map((o) => ({ releaseId: o.release.id, amount: "105.00" })),
      });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      for (const o of orders) {
        const s = await state(o.orderId);
        assert.equal(s.release.release_status, "RELEASED");
        assert.equal(s.release.released_by_settlement_id, res.body.data.id);
        assert.equal(s.order.financial_status, "FINALIZED");
        const fee = s.company.find((t) => t.type === "DELIVERY_FEE_REVENUE");
        assert.equal(fee?.id, s.release.company_fee_transaction_id);
        assert.equal(fee?.idempotency_key, `delivery:${o.orderId}:delivery-fee-revenue`);
        if (s.order.order_type === "COMPANY_ORDER") {
          assert.equal(s.wallet.length, 0);
          const product = s.company.find((t) => t.type === "COMPANY_ORDER_PRODUCT_REVENUE");
          assert.equal(product?.id, s.release.company_product_transaction_id);
        } else {
          assert.equal(s.wallet.length, 1);
          assert.equal(s.wallet[0].id, s.release.wallet_transaction_id);
          assert.equal(s.wallet[0].idempotency_key, `delivery:${o.orderId}:wallet-order-credit`);
        }
        const audit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "FINANCIAL_RELEASE_COMPLETED", entity_id: o.orderId } });
        assert.equal((audit.metadata as { releaseId: string }).releaseId, o.release.id);
      }
      // Customer A received three credits in one settlement: one running chain.
      const chain = await prisma.wallet_transactions.findMany({
        where: { order_id: { in: orders.map((o) => o.orderId) }, customer_id: customerA },
        orderBy: { balance_before: "asc" },
      });
      assert.equal(chain.length, 3);
      assert.ok(chain[0].balance_before.equals(balanceBefore));
      assert.ok(chain[1].balance_before.equals(chain[0].balance_after));
      assert.ok(chain[2].balance_before.equals(chain[1].balance_after));
      assert.ok((await wallet(customerA)).equals(chain[2].balance_after));
      assert.ok((await cash(driver.driverId)).isZero());
      await assertReconciled(driver.driverId);
    });

    test("24. settlements of drivers this suite did not create are unchanged", async () => {
      assert.equal(await foreignSettlementsFingerprint(), foreignSettlementsBefore);
    });

    test("25. bypass deliveries create no settlement obligation or release, and allocate nothing", async () => {
      const driver = await createDriver();
      const orderId = await outForDelivery(driver, { collectionPaymentMethodId: bypassMethodId });
      await setActivation(true);
      try {
        assert.equal((await deliverRaw(orderId, driver, { actualAmountCollected: "105.00" })).status, 200);
      } finally {
        await setActivation(false);
      }
      assert.equal(await prisma.order_financial_releases.count({ where: { order_id: orderId } }), 0);
      assert.ok((await cash(driver.driverId)).isZero());
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).financial_status, "FINALIZED");
      const res = await settle({ driverId: driver.driverId, amountReceived: "105.00" });
      assert.equal(res.status, 400, "nothing to settle");
    });
  });
});
