import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { creditWalletForOrder } from "../../src/modules/wallets/wallet-ledger.service";
import { applyDriverCashTransaction } from "../../src/modules/driver-cash/driver-cash-ledger.service";
import { FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY } from "../../src/modules/financial-release/financial-release.service";
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
// FR.5 — Settlement-aware collection-difference resolution
// Contract: docs/settlement-financial-release-contract.md §4.5 / §5.3 / §5.4 / §6
//
// An ON_SETTLEMENT difference is released only when BOTH the collection is
// fully allocated to settlements AND Finance resolved the split — whichever
// happens last releases, exactly once. NULL / IMMEDIATE orders keep the
// immediate resolution path.
//
// Settlement-mode orders come from real deliveries with the GLOBAL
// activation flag on only for the delivery itself (always restored).
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const dec = (v: string | number) => new Prisma.Decimal(v);

describe("Settlement-aware collection-difference resolution (FR.5)", () => {
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
  const createdCustomerIds: string[] = [];
  const createdMethodIds: string[] = [];
  let keySeq = 0;

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const setActivation = (enabled: boolean) => prisma.system_settings.update({ where: { key: KEY }, data: { value: enabled } });

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    const [a, f] = await Promise.all([loginTestUser(app, admin.email, admin.password), loginTestUser(app, finance.email, finance.password)]);
    tokens = { admin: a.accessToken as string, finance: f.accessToken as string };
    assert.equal((await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } })).value, false);

    customerA = await seedCustomerRecord(admin.id);
    customerB = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerA, customerB);
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    const created = await request(app)
      .post("/api/v1/settings/payment-methods")
      .set(auth(tokens.admin))
      .send({ code: `FR5-DIRECT-${Math.random().toString(36).slice(2, 10)}`, name: "FR5 Direct", bypassDriverCash: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bypassMethodId = created.body.data.id;
    createdMethodIds.push(bypassMethodId);
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
    await prisma.audit_logs.deleteMany({ where: { entity_type: { in: ["DRIVER_SETTLEMENT", "CUSTOMER_PAYOUT"] }, actor_user_id: finance.id } });
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
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

  async function newCustomer() {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function outForDelivery(driver: Driver, overrides: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerA,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR5 Receiver",
        receiverPhone: "+96170000055",
        receiverAreaId: area.id,
        receiverAddress: "5 FR5 St",
        description: "FR.5 order",
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

  // A delivered ON_SETTLEMENT order collected with a difference (expected 105).
  async function differenceOrder(driver: Driver, overrides: Record<string, unknown> = {}, actual = "95.00") {
    const orderId = await outForDelivery(driver, overrides);
    await deliver(orderId, driver, actual, "Receiver paid a different amount");
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
    assert.equal(release.review_status, "AWAITING_REVIEW");
    return { orderId, release };
  }

  function settle(driverId: string, allocations: { releaseId: string; amount: string }[], key = `fr5-${Date.now()}-${++keySeq}`) {
    const total = allocations.reduce((s, a) => s.plus(a.amount), dec(0));
    return request(app)
      .post("/api/v1/driver-settlements")
      .set(auth(tokens.finance))
      .set("Idempotency-Key", key)
      .send({ driverId, amountReceived: total.toFixed(2), paymentMethodId: cashMethodId, allocations });
  }

  const resolve = (orderId: string, split: { wallet?: string; product?: string; fee?: string }) =>
    request(app)
      .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
      .set(auth(tokens.finance))
      .send({
        customerWalletCredit: split.wallet ?? "0",
        companyProductRevenue: split.product ?? "0",
        companyDeliveryFeeRevenue: split.fee ?? "0",
        resolutionNotes: "Finance-approved split",
      });

  async function state(orderId: string) {
    const [order, release, wallet, company, audits] = await Promise.all([
      prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
      prisma.order_financial_releases.findUnique({ where: { order_id: orderId } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId }, orderBy: { type: "asc" } }),
      prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId }, orderBy: { created_at: "asc" } }),
    ]);
    return { order, release, wallet, company, audits };
  }
  const walletBalance = async (customerId: string) =>
    (await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } })).available_balance;
  const cash = async (driverId: string) => (await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } })).current_balance;
  const auditOf = (s: Awaited<ReturnType<typeof state>>, action: string) => s.audits.filter((a) => a.action === action);
  const meta = (a: { metadata: unknown }) => a.metadata as Record<string, unknown>;

  // A pending-review release is untouched: no split, no posting, still REVIEW_REQUIRED.
  async function assertUnresolved(orderId: string) {
    const s = await state(orderId);
    assert.equal(s.order.financial_status, "REVIEW_REQUIRED");
    assert.equal(s.order.needs_financial_review, true);
    assert.equal(s.release?.review_status, "AWAITING_REVIEW");
    assert.equal(s.release?.release_status, "PENDING");
    assert.equal(s.release?.planned_customer_wallet_amount, null);
    assert.equal(s.wallet.length + s.company.length, 0);
    assert.equal(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED").length, 0);
    return s;
  }

  // Released exactly once, with the approved split under the existing keys.
  async function assertReleasedOnce(orderId: string, expected: { wallet: string; product: string; fee: string }) {
    const s = await state(orderId);
    assert.equal(s.release?.release_status, "RELEASED");
    assert.equal(s.release?.review_status, "RESOLVED");
    assert.equal(s.order.financial_status, "FINALIZED");
    assert.equal(s.order.needs_financial_review, false);
    assert.equal(s.order.status, "DELIVERED");
    const wallets = s.wallet.filter((w) => w.type === "ORDER_CREDIT");
    if (dec(expected.wallet).isZero()) assert.equal(wallets.length, 0);
    else {
      assert.equal(wallets.length, 1);
      assert.ok(wallets[0].credit.equals(expected.wallet));
      assert.equal(wallets[0].idempotency_key, `delivery:${orderId}:wallet-order-credit`);
      assert.equal(s.release?.wallet_transaction_id, wallets[0].id);
    }
    const product = s.company.filter((c) => c.type === "COMPANY_ORDER_PRODUCT_REVENUE");
    const fee = s.company.filter((c) => c.type === "DELIVERY_FEE_REVENUE");
    assert.equal(product.length, dec(expected.product).isZero() ? 0 : 1);
    assert.equal(fee.length, dec(expected.fee).isZero() ? 0 : 1);
    if (product[0]) {
      assert.ok(product[0].amount.equals(expected.product));
      assert.equal(product[0].idempotency_key, `delivery:${orderId}:company-product-revenue`);
    }
    if (fee[0]) {
      assert.ok(fee[0].amount.equals(expected.fee));
      assert.equal(fee[0].idempotency_key, `delivery:${orderId}:delivery-fee-revenue`);
    }
    assert.equal(s.company.length, product.length + fee.length);
    assert.equal(auditOf(s, "FINANCIAL_RELEASE_COMPLETED").length, 1);
    assert.equal(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED").length, 1);
    return s;
  }

  // ============================================================
  describe("historical behavior preserved (NULL / IMMEDIATE)", () => {
    test("1. legacy (activation off) difference resolves immediately, creates no release", async () => {
      const driver = await createDriver();
      const orderId = await outForDelivery(driver);
      await deliver(orderId, driver, "95.00", "Receiver short", false);
      const before = await walletBalance(customerA);
      const res = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state(orderId);
      assert.equal(s.order.financial_release_mode, null);
      assert.equal(s.order.financial_status, "FINALIZED");
      assert.equal(s.release, null);
      assert.equal(s.wallet.length, 1);
      assert.ok((await walletBalance(customerA)).equals(before.plus(90)));
      const audit = auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED")[0];
      assert.equal("deferredRelease" in meta(audit), false, "legacy audit metadata unchanged");
      assert.equal(auditOf(s, "FINANCIAL_RELEASE_COMPLETED").length, 0);
    });

    test("2. IMMEDIATE direct-payment difference (activation on) resolves immediately, creates no release", async () => {
      const driver = await createDriver();
      const orderId = await outForDelivery(driver, { collectionPaymentMethodId: bypassMethodId });
      await deliver(orderId, driver, "95.00", "Card short");
      assert.equal((await state(orderId)).order.financial_release_mode, "IMMEDIATE");
      const res = await resolve(orderId, { wallet: "92.00", fee: "3.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await state(orderId);
      assert.equal(s.order.financial_status, "FINALIZED");
      assert.equal(s.release, null);
      assert.deepEqual(s.wallet.map((w) => w.credit.toString()), ["92"]);
      assert.deepEqual(s.company.map((c) => [c.type, c.amount.toString()]), [["DELIVERY_FEE_REVENUE", "3"]]);
      assert.ok((await cash(driver.driverId)).isZero(), "direct payment never enters driver cash");
    });
  });

  // ============================================================
  describe("ON_SETTLEMENT — both processing sequences", () => {
    test("3. resolution BEFORE any settlement records the split, posts nothing; the full settlement releases it", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      const before = await walletBalance(customerA);

      const res = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.financialStatus, "AWAITING_SETTLEMENT");
      let s = await state(orderId);
      assert.equal(s.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(s.order.needs_financial_review, false);
      assert.equal(s.release?.review_status, "RESOLVED");
      assert.equal(s.release?.release_status, "PENDING");
      assert.ok(s.release?.planned_customer_wallet_amount?.equals(90));
      assert.ok(s.release?.planned_company_product_amount?.isZero());
      assert.ok(s.release?.planned_company_fee_amount?.equals(5));
      assert.equal(s.wallet.length + s.company.length, 0, "no posting before full settlement");
      assert.ok((await walletBalance(customerA)).equals(before));
      const audit = auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED")[0];
      assert.equal(meta(audit).deferredRelease, true);
      assert.equal(meta(audit).releaseId, release.id);
      assert.equal(meta(audit).walletTransactionId, null);
      assert.equal((audit.new_values as Record<string, unknown>).financialStatus, "AWAITING_SETTLEMENT");

      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      assert.equal(settled.status, 201, JSON.stringify(settled.body));
      s = await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
      assert.equal(s.release?.released_by_settlement_id, settled.body.data.id);
      assert.equal(meta(auditOf(s, "FINANCIAL_RELEASE_COMPLETED")[0]).trigger, "SETTLEMENT");
      assert.ok((await walletBalance(customerA)).equals(before.plus(90)));
      assert.ok((await cash(driver.driverId)).isZero());
    });

    test("4. settlement BEFORE resolution: full settlement holds; resolution releases immediately (trigger RESOLUTION)", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      assert.equal(settled.status, 201, JSON.stringify(settled.body));
      await assertUnresolved(orderId);
      const before = await walletBalance(customerA);

      const res = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
      assert.equal(s.release?.released_by_settlement_id, null);
      assert.equal(s.release?.released_by_id, finance.id);
      assert.equal(meta(auditOf(s, "FINANCIAL_RELEASE_COMPLETED")[0]).trigger, "RESOLUTION");
      const audit = auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED")[0];
      assert.equal(meta(audit).deferredRelease, false);
      assert.equal(meta(audit).walletTransactionId, s.release?.wallet_transaction_id);
      assert.ok((await walletBalance(customerA)).equals(before.plus(90)));
      // Resolution never touches driver cash.
      assert.ok((await cash(driver.driverId)).isZero());
    });

    test("5. resolution after a PARTIAL settlement defers; the completing settlement releases exactly once", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "40.00" }])).status, 201);
      const res = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let s = await state(orderId);
      assert.equal(s.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(s.wallet.length + s.company.length, 0, "partial settlement never causes partial posting");
      assert.equal(meta(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED")[0]).allocatedAmount, "40");
      const completing = await settle(driver.driverId, [{ releaseId: release.id, amount: "55.00" }]);
      assert.equal(completing.status, 201, JSON.stringify(completing.body));
      s = await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
      assert.equal(s.release?.released_by_settlement_id, completing.body.data.id);
    });

    test("6. after resolution, several partial settlements complete the collection; only the last releases", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      assert.equal((await resolve(orderId, { wallet: "90.00", fee: "5.00" })).status, 200);
      for (const amount of ["30.00", "30.00"]) {
        assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount }])).status, 201);
        const s = await state(orderId);
        assert.equal(s.release?.release_status, "PENDING");
        assert.equal(s.wallet.length + s.company.length, 0);
      }
      const last = await settle(driver.driverId, [{ releaseId: release.id, amount: "35.00" }]);
      assert.equal(last.status, 201);
      const s = await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
      assert.equal(s.release?.released_by_settlement_id, last.body.data.id);
      assert.equal(await prisma.driver_settlement_allocations.count({ where: { release_id: release.id } }), 3);
    });

    test("7. full settlement without resolution never releases an unapproved difference", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver, {}, "110.00");
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "110.00" }])).status, 201);
      const s = await assertUnresolved(orderId);
      assert.ok(s.release?.allocated_amount.equals(110));
    });
  });

  // ============================================================
  describe("approved splits", () => {
    test("8. DELIVERY_ONLY excess split (wallet 103 + fee 7) releases both components", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver, {}, "110.00");
      assert.equal((await resolve(orderId, { wallet: "103.00", fee: "7.00" })).status, 200);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "110.00" }])).status, 201);
      await assertReleasedOnce(orderId, { wallet: "103", product: "0", fee: "7" });
    });

    test("9. COMPANY_ORDER split (product 37 + fee 3) never touches a wallet", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await differenceOrder(driver, { customerId: customer, orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "40.00");
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "40.00" }])).status, 201);
      const res = await resolve(orderId, { product: "37.00", fee: "3.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const s = await assertReleasedOnce(orderId, { wallet: "0", product: "37", fee: "3" });
      assert.equal(s.wallet.length, 0);
      assert.ok((await walletBalance(customer)).isZero());
    });

    test("10. zero-valued components: wallet-only, fee-only and product-only splits post only the non-zero rows", async () => {
      const driver = await createDriver();
      const walletOnly = await differenceOrder(driver);
      const feeOnly = await differenceOrder(driver, {}, "4.00");
      const productOnly = await differenceOrder(driver, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "30.00");
      assert.equal((await resolve(walletOnly.orderId, { wallet: "95.00" })).status, 200);
      assert.equal((await resolve(feeOnly.orderId, { fee: "4.00" })).status, 200);
      assert.equal((await resolve(productOnly.orderId, { product: "30.00" })).status, 200);
      const res = await settle(driver.driverId, [
        { releaseId: walletOnly.release.id, amount: "95.00" },
        { releaseId: feeOnly.release.id, amount: "4.00" },
        { releaseId: productOnly.release.id, amount: "30.00" },
      ]);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      await assertReleasedOnce(walletOnly.orderId, { wallet: "95", product: "0", fee: "0" });
      await assertReleasedOnce(feeOnly.orderId, { wallet: "0", product: "0", fee: "4" });
      await assertReleasedOnce(productOnly.orderId, { wallet: "0", product: "30", fee: "0" });
      const r = (await state(walletOnly.orderId)).release;
      assert.equal(r?.company_fee_transaction_id, null);
    });
  });

  // ============================================================
  describe("rejections — nothing changes", () => {
    test("11. invalid splits are rejected (sum, order-type buckets, negative, precision)", async () => {
      const driver = await createDriver();
      const deliveryOnly = await differenceOrder(driver);
      const companyOrder = await differenceOrder(driver, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "40.00");
      const invalid: [string, Record<string, string>][] = [
        [deliveryOnly.orderId, { wallet: "90.00", fee: "4.00" }],
        [deliveryOnly.orderId, { wallet: "100.00", fee: "0" }],
        [deliveryOnly.orderId, { wallet: "85.00", product: "5.00", fee: "5.00" }],
        [deliveryOnly.orderId, { wallet: "100.00", fee: "-5.00" }],
        [deliveryOnly.orderId, { wallet: "89.995", fee: "5.005" }],
        [companyOrder.orderId, { wallet: "5.00", product: "30.00", fee: "5.00" }],
        [companyOrder.orderId, { product: "41.00" }],
      ];
      for (const [orderId, split] of invalid) {
        const res = await resolve(orderId, split);
        assert.equal(res.status, 400, `${JSON.stringify(split)} -> ${JSON.stringify(res.body)}`);
      }
      await assertUnresolved(deliveryOnly.orderId);
      await assertUnresolved(companyOrder.orderId);
    });

    test("12. order / release / driver ownership mismatch fails closed (500) and changes nothing", async () => {
      const driver = await createDriver();
      const other = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);

      // Corrupt the order's delivery driver pointer (simulated data corruption).
      await prisma.orders.update({ where: { id: orderId }, data: { current_driver_id: other.driverId } });
      const driverMismatch = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      await prisma.orders.update({ where: { id: orderId }, data: { current_driver_id: driver.driverId } });
      assert.equal(driverMismatch.status, 500, JSON.stringify(driverMismatch.body));
      assert.equal(driverMismatch.body.error.code, "INTERNAL_ERROR");

      // Corrupt the release's customer snapshot.
      await prisma.order_financial_releases.update({ where: { id: release.id }, data: { customer_id: customerB } });
      const customerMismatch = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      await prisma.order_financial_releases.update({ where: { id: release.id }, data: { customer_id: customerA } });
      assert.equal(customerMismatch.status, 500, JSON.stringify(customerMismatch.body));

      // Corrupt the release's collection amount (no longer the actual collected).
      await prisma.order_financial_releases.update({ where: { id: release.id }, data: { collection_amount: dec("96.00") } });
      const amountMismatch = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      await prisma.order_financial_releases.update({ where: { id: release.id }, data: { collection_amount: dec("95.00") } });
      assert.equal(amountMismatch.status, 500, JSON.stringify(amountMismatch.body));

      await assertUnresolved(orderId);
      assert.ok((await walletBalance(customerB)).isZero());
    });

    test("13. a reversed collection cannot be resolved (409)", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      // FR.6: the generic endpoint refuses a release-linked collection.
      const generic = await request(app)
        .post(`/api/v1/finance/driver-cash-transactions/${release.collection_transaction_id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "Collection recorded in error" });
      assert.equal(generic.status, 409, JSON.stringify(generic.body));
      assert.equal(generic.body.error.details.reason, "USE_RELEASE_CORRECTION");
      // A reversal written before that guard existed (pre-FR.6 data), built
      // with the ledger primitive exactly as the old endpoint did.
      await prisma.$transaction((tx) =>
        applyDriverCashTransaction(tx, {
          driverId: driver.driverId,
          type: "REVERSAL",
          direction: "DEBIT",
          amount: release.collection_amount,
          orderId,
          reversalOfId: release.collection_transaction_id,
          idempotencyKey: `reversal:driver-cash:${release.collection_transaction_id}`,
        })
      );
      const res = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      await assertUnresolved(orderId);
    });

    test("14. terminal releases are never resolved as active obligations", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      // FR.6 owns the void workflow; the state is set directly here.
      await prisma.order_financial_releases.update({ where: { id: release.id }, data: { release_status: "VOIDED" } });
      const voidedOnly = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(voidedOnly.status, 409, JSON.stringify(voidedOnly.body));
      await prisma.orders.update({ where: { id: orderId }, data: { financial_status: "COLLECTION_VOIDED", needs_financial_review: false } });
      const voidedOrder = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(voidedOrder.status, 400, JSON.stringify(voidedOrder.body));
      const s = await state(orderId);
      assert.equal(s.release?.release_status, "VOIDED");
      assert.equal(s.release?.review_status, "AWAITING_REVIEW");
      assert.equal(s.wallet.length + s.company.length, 0);
      assert.equal(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED").length, 0);
    });

    test("15. duplicate (sequential) resolution is rejected — deferred and released cases", async () => {
      const driver = await createDriver();
      const deferred = await differenceOrder(driver);
      assert.equal((await resolve(deferred.orderId, { wallet: "90.00", fee: "5.00" })).status, 200);
      const again = await resolve(deferred.orderId, { wallet: "80.00", fee: "15.00" });
      assert.equal(again.status, 400, JSON.stringify(again.body));
      let s = await state(deferred.orderId);
      assert.ok(s.release?.planned_customer_wallet_amount?.equals(90), "approved split never overwritten");
      assert.equal(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED").length, 1);

      const released = await differenceOrder(driver);
      await settle(driver.driverId, [{ releaseId: released.release.id, amount: "95.00" }]);
      assert.equal((await resolve(released.orderId, { wallet: "90.00", fee: "5.00" })).status, 200);
      assert.equal((await resolve(released.orderId, { wallet: "90.00", fee: "5.00" })).status, 400);
      s = await assertReleasedOnce(released.orderId, { wallet: "90", product: "0", fee: "5" });
      // The deferred one still releases once with its first approved split.
      await settle(driver.driverId, [{ releaseId: deferred.release.id, amount: "95.00" }]);
      await assertReleasedOnce(deferred.orderId, { wallet: "90", product: "0", fee: "5" });
    });
  });

  // ============================================================
  describe("atomicity", () => {
    test("16. an induced posting failure during a resolution-triggered release rolls everything back", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await differenceOrder(driver, { customerId: customer });
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      // Pre-existing posting under the release's deterministic wallet key.
      await prisma.$transaction((tx) =>
        creditWalletForOrder(tx, { customerId: customer, orderId, amount: dec("1.00"), idempotencyKey: `delivery:${orderId}:wallet-order-credit` })
      );
      const res = await resolve(orderId, { wallet: "90.00", fee: "5.00" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      const s = await state(orderId);
      assert.equal(s.order.financial_status, "REVIEW_REQUIRED");
      assert.equal(s.order.needs_financial_review, true);
      assert.equal(s.release?.review_status, "AWAITING_REVIEW");
      assert.equal(s.release?.release_status, "PENDING");
      assert.equal(s.release?.planned_customer_wallet_amount, null);
      assert.equal(s.company.length, 0);
      assert.equal(s.wallet.length, 1, "only the planted row");
      assert.ok((await walletBalance(customer)).equals(1));
      assert.equal(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED").length + auditOf(s, "FINANCIAL_RELEASE_COMPLETED").length, 0);
    });
  });

  // ============================================================
  describe("concurrency (real PostgreSQL)", () => {
    test("17. concurrent resolutions of a fully settled difference: exactly one succeeds, one release, one posting set", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      const results = await Promise.all([1, 2, 3, 4].map(() => resolve(orderId, { wallet: "90.00", fee: "5.00" })));
      assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results.map((r) => [r.status, r.body?.error?.message])));
      for (const r of results.filter((x) => x.status !== 200)) assert.ok([400, 409].includes(r.status), String(r.status));
      await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
    });

    test("18. concurrent resolutions of an unsettled difference with different splits: exactly one split recorded", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      const results = await Promise.all([
        resolve(orderId, { wallet: "90.00", fee: "5.00" }),
        resolve(orderId, { wallet: "80.00", fee: "15.00" }),
        resolve(orderId, { wallet: "70.00", fee: "25.00" }),
      ]);
      const winners = results.map((r, i) => [r.status, i] as const).filter(([status]) => status === 200);
      assert.equal(winners.length, 1, JSON.stringify(results.map((r) => r.status)));
      const expectedWallet = ["90", "80", "70"][winners[0][1]];
      const s = await state(orderId);
      assert.ok(s.release?.planned_customer_wallet_amount?.equals(expectedWallet));
      assert.equal(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED").length, 1);
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      await assertReleasedOnce(orderId, { wallet: expectedWallet, product: "0", fee: dec(95).minus(expectedWallet).toString() });
    });

    test("19. completing settlement racing resolution: both succeed, exactly one release (repeated)", async () => {
      const driver = await createDriver();
      const triggers: string[] = [];
      for (let round = 0; round < 4; round++) {
        const { orderId, release } = await differenceOrder(driver);
        // Pre-allocate part so the racing settlement is the COMPLETING one.
        assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "45.00" }])).status, 201);
        // Alternate which request is dispatched first.
        const startSettle = () => settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
        const startResolve = () => resolve(orderId, { wallet: "90.00", fee: "5.00" });
        const [settled, resolved] =
          round % 2 === 0
            ? await Promise.all([startSettle(), startResolve()])
            : await Promise.all([startResolve(), startSettle()]).then(([r, s]) => [s, r] as const);
        assert.equal(settled.status, 201, JSON.stringify(settled.body));
        assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
        const s = await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
        const trigger = meta(auditOf(s, "FINANCIAL_RELEASE_COMPLETED")[0]).trigger;
        assert.ok(trigger === "SETTLEMENT" || trigger === "RESOLUTION");
        triggers.push(trigger as string);
        assert.equal(s.release?.released_by_settlement_id === settled.body.data.id, trigger === "SETTLEMENT");
        assert.equal(meta(auditOf(s, "COLLECTION_DIFFERENCE_RESOLVED")[0]).deferredRelease, trigger === "SETTLEMENT");
      }
      console.log(`[FR.5 race] release triggers observed per round: ${triggers.join(", ")}`);
      assert.ok((await cash(driver.driverId)).isZero());
    });

    test("19b. lock order: resolution waits on the release row lock BEFORE it locks the order row", async () => {
      const driver = await createDriver();
      const { orderId, release } = await differenceOrder(driver);
      let unblock!: () => void;
      const gate = new Promise<void>((r) => (unblock = r));
      let holderLocked!: () => void;
      const locked = new Promise<void>((r) => (holderLocked = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM order_financial_releases WHERE id = ${release.id}::uuid FOR NO KEY UPDATE`;
          holderLocked();
          await gate;
        },
        { timeout: 15000 }
      );
      await locked;
      let done = false;
      const pending = resolve(orderId, { wallet: "90.00", fee: "5.00" }).then((r) => {
        done = true;
        return r;
      });
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(done, false, "resolution must block on the release lock");
      // The order row is NOT locked yet: release (4) is taken before order (5).
      const orderLock = await prisma.$transaction((tx) => tx.$queryRaw<{ id: string }[]>`SELECT id FROM orders WHERE id = ${orderId}::uuid FOR NO KEY UPDATE NOWAIT`);
      assert.equal(orderLock.length, 1);
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).financial_status, "REVIEW_REQUIRED");
      unblock();
      await holder;
      const res = await pending;
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal((await state(orderId)).order.financial_status, "AWAITING_SETTLEMENT");
    });

    test("19c. both interleavings forced through the release lock: whichever commits last releases, exactly once", async () => {
      const driver = await createDriver();
      for (const first of ["SETTLEMENT", "RESOLUTION"] as const) {
        const { orderId, release } = await differenceOrder(driver);
        assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "45.00" }])).status, 201);
        let unblock!: () => void;
        const gate = new Promise<void>((r) => (unblock = r));
        let holderLocked!: () => void;
        const locked = new Promise<void>((r) => (holderLocked = r));
        const holder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT id FROM order_financial_releases WHERE id = ${release.id}::uuid FOR NO KEY UPDATE`;
            holderLocked();
            await gate;
          },
          { timeout: 15000 }
        );
        await locked;
        // supertest dispatches on .then() — call it now so each request is sent immediately.
        const startSettle = () => settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]).then((r) => r);
        const startResolve = () => resolve(orderId, { wallet: "90.00", fee: "5.00" }).then((r) => r);
        // PostgreSQL grants a row lock to waiters in arrival order.
        const a = first === "SETTLEMENT" ? startSettle() : startResolve();
        await new Promise((r) => setTimeout(r, 300));
        const b = first === "SETTLEMENT" ? startResolve() : startSettle();
        await new Promise((r) => setTimeout(r, 300));
        unblock();
        await holder;
        const [ra, rb] = await Promise.all([a, b]);
        const [settled, resolved] = first === "SETTLEMENT" ? [ra, rb] : [rb, ra];
        assert.equal(settled.status, 201, JSON.stringify(settled.body));
        assert.equal(resolved.status, 200, JSON.stringify(resolved.body));
        const s = await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
        // The request that ran SECOND saw both conditions satisfied and released.
        const expectedTrigger = first === "SETTLEMENT" ? "RESOLUTION" : "SETTLEMENT";
        assert.equal(meta(auditOf(s, "FINANCIAL_RELEASE_COMPLETED")[0]).trigger, expectedTrigger);
        assert.equal(s.release?.released_by_settlement_id, expectedTrigger === "SETTLEMENT" ? settled.body.data.id : null);
      }
      assert.ok((await cash(driver.driverId)).isZero());
    });

    test("20. resolution racing a payout and a delivery for the same customer / driver: no deadlock, balances exact", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      // Seed 100 available via a legacy delivery for this customer, then a settled difference.
      const legacy = await outForDelivery(driver, { customerId: customer });
      await deliver(legacy, driver, "105.00", undefined, false);
      const { orderId, release } = await differenceOrder(driver, { customerId: customer });
      await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
      const next = await outForDelivery(driver, { customerId: customer });
      const cashBefore = await cash(driver.driverId);
      assert.ok((await walletBalance(customer)).equals(100));

      await setActivation(true);
      let results;
      try {
        results = await Promise.all([
          resolve(orderId, { wallet: "90.00", fee: "5.00" }),
          request(app)
            .post("/api/v1/payouts")
            .set(auth(tokens.finance))
            .set("Idempotency-Key", `fr5-payout-${orderId}`)
            .send({ customerId: customer, amount: "100.00", paymentMethodId: cashMethodId }),
          request(app).post(`/api/v1/driver/orders/${next}/deliver`).set(auth(driver.token)).send({ actualAmountCollected: "105.00" }),
        ]);
      } finally {
        await setActivation(false);
      }
      assert.equal(results[0].status, 200, JSON.stringify(results[0].body));
      assert.equal(results[1].status, 201, JSON.stringify(results[1].body));
      assert.equal(results[2].status, 200, JSON.stringify(results[2].body));
      await assertReleasedOnce(orderId, { wallet: "90", product: "0", fee: "5" });
      assert.ok((await walletBalance(customer)).equals(90), "100 + 90 released − 100 paid out");
      assert.ok((await cash(driver.driverId)).equals(cashBefore.plus(105)), "resolution never touches driver cash");
      const nextRelease = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: next } });
      assert.equal(nextRelease.release_status, "PENDING");
      // Payout rows for this customer are removed by cleanupTestCustomerRecord.
    });
  });
});
