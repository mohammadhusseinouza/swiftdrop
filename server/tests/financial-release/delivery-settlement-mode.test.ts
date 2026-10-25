import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import pg from "pg";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { creditWalletForOrder } from "../../src/modules/wallets/wallet-ledger.service";
import {
  FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY,
  releaseOrder,
} from "../../src/modules/financial-release/financial-release.service";
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
// FR.3 — Settlement-Based Financial Release: delivery integration
//
// The activation setting is GLOBAL. Test files run one at a time
// (--test-concurrency=1); this suite enables it only inside individual tests
// and ALWAYS restores `false` (afterEach + after), so no other suite ever
// observes it enabled. Production / dev are never touched — the suite runs
// against whatever isolated DATABASE_URL the runner provides.
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;

describe("Settlement-Based Financial Release — delivery integration (FR.3)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let tokens: { admin: string; finance: string };
  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  let bypassMethodId: string;

  const createdOrderIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdMethodIds: string[] = [];
  const createdSettlementIds: string[] = [];
  // Snapshot of every order this suite did NOT create — must be untouched.
  let foreignOrdersBefore: string;

  const dec = (v: string) => new Prisma.Decimal(v);
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function setActivation(enabled: boolean) {
    await prisma.system_settings.update({ where: { key: KEY }, data: { value: enabled } });
  }

  async function foreignOrdersFingerprint(): Promise<string> {
    const rows = await prisma.orders.findMany({
      where: { id: { notIn: createdOrderIds.length ? createdOrderIds : ["00000000-0000-0000-0000-000000000000"] } },
      select: { id: true, status: true, financial_status: true, financial_release_mode: true, actual_amount_collected: true, updated_at: true },
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

    // The FR.2 migration seeds this row as false; the suite never creates it.
    const setting = await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
    assert.equal(setting.value, false, "activation must start disabled");

    customerId = await seedCustomerRecord(admin.id);
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    const created = await request(app)
      .post("/api/v1/settings/payment-methods")
      .set(auth(tokens.admin))
      .send({ code: `FR3-DIRECT-${Math.random().toString(36).slice(2, 10)}`, name: "FR3 Direct", bypassDriverCash: true });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    bypassMethodId = created.body.data.id;
    createdMethodIds.push(bypassMethodId);

    foreignOrdersBefore = await foreignOrdersFingerprint();
  });

  afterEach(async () => {
    await setActivation(false);
  });

  after(async () => {
    await setActivation(false);
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdSettlementIds) {
      await prisma.driver_cash_transactions.deleteMany({ where: { settlement_id: id } });
      await prisma.audit_logs.deleteMany({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: id } });
    }
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    for (const id of createdMethodIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "PAYMENT_METHOD", entity_id: id } });
      await cleanupTestPaymentMethod(id);
    }
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    await Promise.all([admin, finance].map((u) => cleanupTestUser(u.id)));
    const setting = await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
    assert.equal(setting.value, false, "activation must end disabled");
  });

  async function createDriver() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    const res = await request(app).post("/api/v1/drivers").set(auth(tokens.admin)).send({ userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }

  async function outForDeliveryOrder(driver: { driverId: string; token: string }, overrides: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR3 Receiver",
        receiverPhone: "+96170000033",
        receiverAreaId: area.id,
        receiverAddress: "3 FR3 St",
        description: "FR.3 settlement-mode order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const orderId = created.body.data.id as string;
    createdOrderIds.push(orderId);
    const assign = await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    for (const step of ["pickup", "start-delivery"]) {
      const r = await request(app).post(`/api/v1/driver/orders/${orderId}/${step}`).set(auth(driver.token)).send();
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    return orderId;
  }

  const deliver = (orderId: string, token: string, body: Record<string, unknown>) =>
    request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(token)).send(body);

  async function rows(orderId: string) {
    const [order, release, cash, direct, wallet, company, audits, attempts, history] = await Promise.all([
      prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
      prisma.order_financial_releases.findUnique({ where: { order_id: orderId } }),
      prisma.driver_cash_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_direct_collections.findMany({ where: { order_id: orderId } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId }, orderBy: { type: "asc" } }),
      prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId }, orderBy: { created_at: "asc" } }),
      prisma.delivery_attempts.findMany({ where: { order_id: orderId } }),
      prisma.order_status_history.findMany({ where: { order_id: orderId, to_status: "DELIVERED" } }),
    ]);
    return { order, release, cash, direct, wallet, company, audits, attempts, history };
  }

  const cashBalance = async (driverId: string) =>
    (await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } })).current_balance;
  const walletBalance = async () =>
    (await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } })).available_balance;

  // ============================================================
  // 1 / 11 — activation disabled: legacy behavior, byte-for-byte
  // ============================================================
  describe("activation disabled (legacy)", () => {
    test("1. exact DELIVERY_ONLY cash delivery posts immediately, mode NULL, no release row", async () => {
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const walletBefore = await walletBalance();
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.status, "DELIVERED");
      assert.equal(r.order.financial_status, "FINALIZED");
      assert.equal(r.order.financial_release_mode, null);
      assert.equal(r.release, null);
      assert.equal(r.cash.length, 1);
      assert.equal(r.cash[0].idempotency_key, `delivery:${orderId}:driver-collection`);
      assert.equal(r.wallet.length, 1);
      assert.equal(r.wallet[0].idempotency_key, `delivery:${orderId}:wallet-order-credit`);
      assert.ok((await walletBalance()).equals(walletBefore.plus(100)));
      assert.deepEqual(r.company.map((c) => [c.type, c.amount.toString()]), [["DELIVERY_FEE_REVENUE", "5"]]);
      const audit = r.audits.find((a) => a.action === "DELIVERY_ONLY_FINANCE_FINALIZED");
      assert.ok(audit);
      assert.equal("financialReleaseMode" in (audit.metadata as Record<string, unknown>), false, "legacy audit metadata unchanged");
    });

    test("1b. cash difference stays REVIEW_REQUIRED with zero ownership postings and no release; legacy resolution still works", async () => {
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "100.00", collectionDifferenceReason: "Short by 5" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let r = await rows(orderId);
      assert.equal(r.order.financial_status, "REVIEW_REQUIRED");
      assert.equal(r.order.financial_release_mode, null);
      assert.equal(r.release, null);
      assert.equal(r.wallet.length + r.company.length, 0);
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
        .set(auth(tokens.finance))
        .send({ customerWalletCredit: "95.00", companyProductRevenue: "0", companyDeliveryFeeRevenue: "5.00", resolutionNotes: "Agreed" });
      assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
      r = await rows(orderId);
      assert.equal(r.order.financial_status, "FINALIZED");
      assert.equal(r.wallet.length, 1);
    });
  });

  // ============================================================
  // 2 / 3 / 6 / 14 / 15 — ON_SETTLEMENT deliveries
  // ============================================================
  describe("activation enabled — Driver Cash collection (ON_SETTLEMENT)", () => {
    test("2. exact DELIVERY_ONLY: DELIVERED, cash += actual, one release with planned split, NO wallet / revenue", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const [cashBefore, walletBefore] = [await cashBalance(driver.driverId), await walletBalance()];
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");

      const r = await rows(orderId);
      assert.equal(r.order.status, "DELIVERED");
      assert.equal(r.order.financial_release_mode, "ON_SETTLEMENT");
      assert.equal(r.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(r.order.needs_financial_review, false);
      assert.ok(r.order.actual_amount_collected?.equals(105));
      assert.equal(r.attempts.length, 1);
      assert.equal(r.history.length, 1);

      assert.equal(r.cash.length, 1);
      assert.equal(r.cash[0].type, "COLLECTION");
      assert.equal(r.cash[0].idempotency_key, `delivery:${orderId}:driver-collection`);
      assert.ok((await cashBalance(driver.driverId)).equals(cashBefore.plus(105)));

      assert.ok(r.release);
      const rel = r.release;
      assert.equal(rel.release_status, "PENDING");
      assert.equal(rel.review_status, "NOT_REQUIRED");
      assert.equal(rel.order_type, "DELIVERY_ONLY");
      assert.equal(rel.customer_id, customerId);
      assert.equal(rel.driver_id, driver.driverId);
      assert.equal(rel.collection_transaction_id, r.cash[0].id);
      assert.ok(rel.collection_amount.equals(105));
      assert.ok(rel.allocated_amount.isZero());
      assert.ok(rel.planned_customer_wallet_amount?.equals(100));
      assert.ok(rel.planned_company_product_amount?.isZero());
      assert.ok(rel.planned_company_fee_amount?.equals(5));
      assert.equal(rel.delivered_at.toISOString(), r.order.delivered_at?.toISOString());
      assert.equal(rel.wallet_transaction_id, null);
      assert.equal(rel.released_at, null);

      // 15 — nothing posted before settlement
      assert.equal(r.wallet.length, 0);
      assert.equal(r.company.length, 0);
      assert.equal(r.direct.length, 0);
      assert.ok((await walletBalance()).equals(walletBefore));

      const audit = r.audits.filter((a) => a.action === "DELIVERY_FINANCE_AWAITING_SETTLEMENT");
      assert.equal(audit.length, 1);
      assert.equal((audit[0].metadata as Record<string, unknown>).releaseId, rel.id);
      assert.equal(r.audits.some((a) => /FINANCE_FINALIZED/.test(a.action)), false);
    });

    test("2b. partial prepayment: planned wallet = remaining order only (60), fee 5, collection 65", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, { paymentType: "PARTIALLY_PAID", prepaidOrderAmount: "40.00", prepaidPaymentMethodId: cashMethodId });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "65.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { release } = await rows(orderId);
      assert.ok(release?.collection_amount.equals(65));
      assert.ok(release?.planned_customer_wallet_amount?.equals(60));
      assert.ok(release?.planned_company_fee_amount?.equals(5));
    });

    test("3. exact COMPANY_ORDER: planned product + fee, wallet amount 0, no posting at all", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, { orderType: "COMPANY_ORDER", orderAmount: "40.00" });
      const walletBefore = await walletBalance();
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "45.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.financial_status, "AWAITING_SETTLEMENT");
      assert.ok(r.release?.planned_customer_wallet_amount?.isZero());
      assert.ok(r.release?.planned_company_product_amount?.equals(40));
      assert.ok(r.release?.planned_company_fee_amount?.equals(5));
      assert.equal(r.wallet.length + r.company.length, 0);
      assert.ok((await walletBalance()).equals(walletBefore));
    });

    test("6. collection difference: REVIEW_REQUIRED, cash += ACTUAL, release AWAITING_REVIEW with NO invented split", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const cashBefore = await cashBalance(driver.driverId);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "Receiver short" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.financial_status, "REVIEW_REQUIRED");
      assert.equal(r.order.needs_financial_review, true);
      assert.equal(r.order.collection_difference_reason, "Receiver short");
      assert.equal(r.order.financial_release_mode, "ON_SETTLEMENT");
      assert.ok((await cashBalance(driver.driverId)).equals(cashBefore.plus(95)));
      assert.equal(r.release?.review_status, "AWAITING_REVIEW");
      assert.ok(r.release?.collection_amount.equals(95));
      assert.equal(r.release?.planned_customer_wallet_amount, null);
      assert.equal(r.release?.planned_company_product_amount, null);
      assert.equal(r.release?.planned_company_fee_amount, null);
      assert.equal(r.wallet.length + r.company.length, 0);
      const audit = r.audits.find((a) => a.action === "COLLECTION_DIFFERENCE_RECORDED");
      assert.equal((audit?.metadata as Record<string, unknown>).releaseId, r.release?.id);
    });

    test("6b. resolving a settlement-mode difference records the split but posts nothing before settlement (FR.5)", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "Receiver short" });
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
        .set(auth(tokens.finance))
        .send({ customerWalletCredit: "90.00", companyProductRevenue: "0", companyDeliveryFeeRevenue: "5.00", resolutionNotes: "Split" });
      assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
      const r = await rows(orderId);
      assert.equal(r.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(r.release?.review_status, "RESOLVED");
      assert.equal(r.release?.release_status, "PENDING");
      assert.equal(r.wallet.length + r.company.length, 0);
    });
  });

  // ============================================================
  // 4 / 5 — immediate routes while activation is enabled
  // ============================================================
  describe("activation enabled — immediate routes", () => {
    test("4. bypass method: IMMEDIATE, direct collection, wallet + fee posted, no driver cash, no release", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, { collectionPaymentMethodId: bypassMethodId });
      const cashBefore = await cashBalance(driver.driverId);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.financial_release_mode, "IMMEDIATE");
      assert.equal(r.order.financial_status, "FINALIZED");
      assert.equal(r.release, null);
      assert.equal(r.cash.length, 0);
      assert.ok((await cashBalance(driver.driverId)).equals(cashBefore));
      assert.equal(r.direct.length, 1);
      assert.ok(r.direct[0].amount.equals(105));
      assert.equal(r.wallet.length, 1);
      assert.deepEqual(r.company.map((c) => c.type), ["DELIVERY_FEE_REVENUE"]);
      const audit = r.audits.find((a) => a.action === "DELIVERY_ONLY_FINANCE_FINALIZED");
      assert.equal((audit?.metadata as Record<string, unknown>).financialReleaseMode, "IMMEDIATE");
    });

    test("4b. bypass difference: IMMEDIATE, REVIEW_REQUIRED, direct collection = actual; resolution posts immediately (unchanged)", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, { collectionPaymentMethodId: bypassMethodId });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "100.00", collectionDifferenceReason: "Card short" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let r = await rows(orderId);
      assert.equal(r.order.financial_release_mode, "IMMEDIATE");
      assert.equal(r.order.financial_status, "REVIEW_REQUIRED");
      assert.equal(r.release, null);
      assert.ok(r.direct[0].amount.equals(100));
      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
        .set(auth(tokens.finance))
        .send({ customerWalletCredit: "95.00", companyProductRevenue: "0", companyDeliveryFeeRevenue: "5.00", resolutionNotes: "Agreed" });
      assert.equal(resolve.status, 200, JSON.stringify(resolve.body));
      r = await rows(orderId);
      assert.equal(r.order.financial_status, "FINALIZED");
    });

    test("5. zero collection (all prepaid): IMMEDIATE, FINALIZED, no driver cash row, no release", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
        // Nothing remains to collect, so no collection method is allowed.
        collectionPaymentMethodId: undefined,
      });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.financial_release_mode, "IMMEDIATE");
      assert.equal(r.order.financial_status, "FINALIZED");
      assert.equal(r.release, null);
      assert.equal(r.cash.length + r.direct.length + r.wallet.length + r.company.length, 0);
    });

    test("5b. zero collection with a difference: IMMEDIATE, REVIEW_REQUIRED, no artificial collection, no release", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0", collectionDifferenceReason: "Receiver paid nothing" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.financial_release_mode, "IMMEDIATE");
      assert.equal(r.order.financial_status, "REVIEW_REQUIRED");
      assert.equal(r.release, null);
      assert.equal(r.cash.length + r.direct.length, 0);
    });
  });

  // ============================================================
  // 7 / 8 — duplicate and concurrent delivery
  // ============================================================
  describe("duplicate and concurrent delivery", () => {
    test("7. a repeated /deliver is rejected and creates no second collection or release", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const again = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(again.status, 400, JSON.stringify(again.body));
      const r = await rows(orderId);
      assert.equal(r.cash.length, 1);
      assert.equal(await prisma.order_financial_releases.count({ where: { order_id: orderId } }), 1);
      assert.ok((await cashBalance(driver.driverId)).equals(105));
    });

    test("8. concurrent /deliver: exactly one wins; one collection, one release, cash += actual once", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const results = await Promise.all([1, 2, 3].map(() => deliver(orderId, driver.token, { actualAmountCollected: "105.00" })));
      assert.equal(results.filter((x) => x.status === 200).length, 1, JSON.stringify(results.map((x) => [x.status, x.body?.error?.code])));
      for (const loser of results.filter((x) => x.status !== 200)) assert.ok([400, 409].includes(loser.status));
      const r = await rows(orderId);
      assert.equal(r.cash.length, 1);
      assert.equal(await prisma.order_financial_releases.count({ where: { order_id: orderId } }), 1);
      assert.equal(r.attempts.length, 1);
      assert.ok((await cashBalance(driver.driverId)).equals(105));
    });
  });

  // ============================================================
  // 9 — payment method corrected at delivery confirmation
  // ============================================================
  describe("payment method corrected during delivery", () => {
    test("9a. Cash -> bypass method: IMMEDIATE / direct collection, no release", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00", paymentMethodId: bypassMethodId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.collection_payment_method_id, bypassMethodId);
      assert.equal(r.order.financial_release_mode, "IMMEDIATE");
      assert.equal(r.release, null);
      assert.equal(r.direct.length, 1);
    });

    test("9b. bypass method -> Cash: ON_SETTLEMENT with the corrected method; audit records the change", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, { collectionPaymentMethodId: bypassMethodId });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const r = await rows(orderId);
      assert.equal(r.order.collection_payment_method_id, cashMethodId);
      assert.equal(r.order.financial_release_mode, "ON_SETTLEMENT");
      assert.ok(r.release);
      assert.equal(r.direct.length, 0);
      const meta = r.audits.find((a) => a.action === "DELIVERY_FINANCE_AWAITING_SETTLEMENT")?.metadata as Record<string, unknown>;
      assert.equal(meta.collectionPaymentMethodChanged, true);
      assert.equal(meta.newCollectionPaymentMethodId, cashMethodId);
    });
  });

  // ============================================================
  // 10 — activation toggled around delivery
  // ============================================================
  describe("activation toggled around delivery", () => {
    test("10a. the mode is persisted at delivery: disabling later never changes it; the next delivery is legacy", async () => {
      const driver = await createDriver();
      await setActivation(true);
      const first = await outForDeliveryOrder(driver);
      assert.equal((await deliver(first, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      await setActivation(false);
      const second = await outForDeliveryOrder(driver);
      assert.equal((await deliver(second, driver.token, { actualAmountCollected: "105.00" })).status, 200);

      const a = await rows(first);
      assert.equal(a.order.financial_release_mode, "ON_SETTLEMENT");
      assert.equal(a.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(a.release?.release_status, "PENDING");
      assert.equal(a.wallet.length, 0);
      const b = await rows(second);
      assert.equal(b.order.financial_release_mode, null);
      assert.equal(b.order.financial_status, "FINALIZED");
      assert.equal(b.release, null);
      assert.equal(b.wallet.length, 1);
    });

    test("10b. a delivery waits for an in-flight activation change and applies the committed value (FOR SHARE)", async () => {
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT value FROM system_settings WHERE key = $1 FOR UPDATE", [KEY]);
        await client.query("UPDATE system_settings SET value = 'true'::jsonb WHERE key = $1", [KEY]);
        let settled = false;
        const pending = deliver(orderId, driver.token, { actualAmountCollected: "105.00" }).then((res) => {
          settled = true;
          return res;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        assert.equal(settled, false, "delivery must wait for the activation transaction");
        await client.query("COMMIT");
        const res = await pending;
        assert.equal(res.status, 200, JSON.stringify(res.body));
      } finally {
        await client.query("ROLLBACK").catch(() => undefined);
        await client.end();
      }
      const r = await rows(orderId);
      assert.equal(r.order.financial_release_mode, "ON_SETTLEMENT");
      assert.ok(r.release);
    });
  });

  // ============================================================
  // 13 — atomic rollback
  // ============================================================
  describe("atomicity", () => {
    test("13. a failure after the Driver Cash credit rolls back the whole delivery (no claim, no cash, no attempt, no audit)", async () => {
      const driver = await createDriver();
      // A legacy delivered order supplies a COLLECTION row with no release.
      const legacy = await outForDeliveryOrder(driver);
      assert.equal((await deliver(legacy, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const legacyCollection = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: legacy, type: "COLLECTION" } });

      await setActivation(true);
      const orderId = await outForDeliveryOrder(driver);
      // Pre-occupy the release slot for this order so the release insert
      // (the LAST write of the delivery) fails with UNIQUE(order_id).
      const blocker = await prisma.order_financial_releases.create({
        data: {
          order_id: orderId,
          customer_id: customerId,
          driver_id: driver.driverId,
          collection_transaction_id: legacyCollection.id,
          order_type: "DELIVERY_ONLY",
          delivered_at: new Date(),
          collection_amount: dec("105.00"),
          review_status: "AWAITING_REVIEW",
        },
      });
      const cashBefore = await cashBalance(driver.driverId);
      const auditBefore = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      let r = await rows(orderId);
      assert.equal(r.order.status, "OUT_FOR_DELIVERY");
      assert.equal(r.order.financial_release_mode, null);
      assert.equal(r.order.delivered_at, null);
      assert.equal(r.cash.length, 0);
      assert.equal(r.attempts.length, 0);
      assert.equal(r.history.length, 0);
      assert.ok((await cashBalance(driver.driverId)).equals(cashBefore));
      assert.equal(await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } }), auditBefore);

      // Recoverable: once the blocker is gone the same delivery succeeds.
      await prisma.order_financial_releases.delete({ where: { id: blocker.id } });
      assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      r = await rows(orderId);
      assert.equal(r.order.financial_release_mode, "ON_SETTLEMENT");
      assert.ok(r.release);
    });
  });

  // ============================================================
  // 12 / 14 — releaseOrder (FR.4 / FR.5 entry point, not exposed by FR.3)
  // Settlement allocation does not exist until FR.4, so these tests stand in
  // for it by setting allocated_amount directly on the test release.
  // ============================================================
  describe("releaseOrder (domain entry point for FR.4 / FR.5)", () => {
    async function settlementModeOrder(overrides: Record<string, unknown> = {}, actual = "105.00") {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver, overrides);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: actual });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      await setActivation(false);
      const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
      return { driver, orderId, release };
    }
    const markFullySettled = (releaseId: string, amount: Prisma.Decimal) =>
      prisma.order_financial_releases.update({ where: { id: releaseId }, data: { allocated_amount: amount } });
    const runRelease = (releaseId: string, trigger: Parameters<typeof releaseOrder>[1]["trigger"] = { type: "RESOLUTION" }) =>
      prisma.$transaction((tx) => releaseOrder(tx, { releaseId, actorUserId: finance.id, trigger }));

    test("12a. not fully settled -> 409, nothing posted", async () => {
      const { orderId, release } = await settlementModeOrder();
      await assert.rejects(runRelease(release.id), (e: { statusCode?: number }) => e.statusCode === 409);
      const r = await rows(orderId);
      assert.equal(r.wallet.length + r.company.length, 0);
      assert.equal(r.release?.release_status, "PENDING");
    });

    test("12b. DELIVERY_ONLY release posts wallet + fee with the existing keys; exactly once", async () => {
      const { driver, orderId, release } = await settlementModeOrder();
      const walletBefore = await walletBalance();
      // FR.4: the real allocation settlement fully settles the collection and
      // invokes releaseOrder (trigger SETTLEMENT) in the same transaction.
      // (FR.3 used a legacy-format settlement as a stand-in; FR.4 correctly
      // rejects that format while settlement-mode cash is outstanding.)
      const settle = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set("Idempotency-Key", `fr3-${orderId}`)
        .send({ driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId, allocations: [{ releaseId: release.id, amount: "105.00" }] });
      assert.equal(settle.status, 201, JSON.stringify(settle.body));
      createdSettlementIds.push(settle.body.data.id);

      const r = await rows(orderId);
      const out = { walletTransactionId: r.release?.wallet_transaction_id };
      assert.equal(r.order.financial_status, "FINALIZED");
      assert.equal(r.release?.release_status, "RELEASED");
      assert.equal(r.release?.released_by_settlement_id, settle.body.data.id);
      assert.equal(r.release?.released_by_id, finance.id);
      assert.equal(r.wallet.length, 1);
      assert.equal(r.wallet[0].idempotency_key, `delivery:${orderId}:wallet-order-credit`);
      assert.ok(r.wallet[0].credit.equals(100));
      assert.equal(out.walletTransactionId, r.wallet[0].id);
      assert.deepEqual(r.company.map((c) => [c.type, c.amount.toString(), c.idempotency_key]), [
        ["DELIVERY_FEE_REVENUE", "5", `delivery:${orderId}:delivery-fee-revenue`],
      ]);
      assert.equal(r.release?.company_fee_transaction_id, r.company[0].id);
      assert.equal(r.release?.company_product_transaction_id, null);
      assert.equal(r.company[0].payment_method_id, cashMethodId, "original collection payment method (A8)");
      assert.ok((await walletBalance()).equals(walletBefore.plus(100)));
      assert.equal(r.audits.filter((a) => a.action === "FINANCIAL_RELEASE_COMPLETED").length, 1);

      // Idempotency: a second release is refused and posts nothing more.
      await assert.rejects(runRelease(release.id), (e: { statusCode?: number }) => e.statusCode === 409);
      const again = await rows(orderId);
      assert.equal(again.wallet.length, 1);
      assert.equal(again.company.length, 1);
    });

    test("12c. COMPANY_ORDER release posts product + fee revenue and never touches the wallet", async () => {
      const { orderId, release } = await settlementModeOrder({ orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      await markFullySettled(release.id, release.collection_amount);
      const walletBefore = await walletBalance();
      await runRelease(release.id);
      const r = await rows(orderId);
      assert.equal(r.wallet.length, 0);
      assert.ok((await walletBalance()).equals(walletBefore));
      // orderBy type follows the enum declaration order.
      assert.deepEqual(r.company.map((c) => [c.type, c.amount.toString()]), [
        ["DELIVERY_FEE_REVENUE", "5"],
        ["COMPANY_ORDER_PRODUCT_REVENUE", "40"],
      ]);
      assert.equal(r.release?.wallet_transaction_id, null);
    });

    test("12d. zero-valued component (fee prepaid) is skipped, not posted as a zero row", async () => {
      const { orderId, release } = await settlementModeOrder(
        { paymentType: "PARTIALLY_PAID", prepaidDeliveryFee: "5.00", prepaidPaymentMethodId: cashMethodId },
        "100.00"
      );
      assert.ok(release.planned_company_fee_amount?.isZero());
      await markFullySettled(release.id, release.collection_amount);
      await runRelease(release.id);
      const r = await rows(orderId);
      assert.equal(r.wallet.length, 1);
      assert.equal(r.company.length, 0);
      assert.equal(r.release?.company_fee_transaction_id, null);
    });

    test("12e. an existing posting under the same deterministic key aborts the release and rolls everything back", async () => {
      const { orderId, release } = await settlementModeOrder();
      await markFullySettled(release.id, release.collection_amount);
      // Simulate a pre-existing (e.g. historical) posting for this order.
      await prisma.$transaction((tx) =>
        creditWalletForOrder(tx, { customerId, orderId, amount: dec("100.00"), idempotencyKey: `delivery:${orderId}:wallet-order-credit` })
      );
      await assert.rejects(runRelease(release.id), (e: { statusCode?: number }) => e.statusCode === 500);
      const r = await rows(orderId);
      assert.equal(r.release?.release_status, "PENDING");
      assert.equal(r.order.financial_status, "AWAITING_SETTLEMENT");
      assert.equal(r.wallet.length, 1, "only the pre-existing row");
      assert.equal(r.company.length, 0, "fee revenue rolled back");
      assert.equal(r.audits.some((a) => a.action === "FINANCIAL_RELEASE_COMPLETED"), false);
    });

    test("12f. a difference awaiting review cannot be released", async () => {
      await setActivation(true);
      const driver = await createDriver();
      const orderId = await outForDeliveryOrder(driver);
      await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "short" });
      await setActivation(false);
      const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
      await markFullySettled(release.id, release.collection_amount);
      await assert.rejects(runRelease(release.id), (e: { statusCode?: number }) => e.statusCode === 409);
      assert.equal((await rows(orderId)).wallet.length, 0);
    });
  });

  // ============================================================
  // Activation safety + 11 / 16 — nothing else changed
  // ============================================================
  describe("activation safety and isolation", () => {
    test("the generic settings PATCH cannot change the activation key (even for ADMIN)", async () => {
      const res = await request(app)
        .patch(`/api/v1/system-settings/${encodeURIComponent(KEY)}`)
        .set(auth(tokens.admin))
        .send({ value: true });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "SETTING_MANAGED_ELSEWHERE");
      const setting = await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } });
      assert.equal(setting.value, false);
      assert.equal(setting.updated_by_id, null);
    });

    test("11 / 16. orders this suite did not create are untouched; no release exists outside this suite", async () => {
      assert.equal(await foreignOrdersFingerprint(), foreignOrdersBefore);
      const foreignReleases = await prisma.order_financial_releases.count({ where: { order_id: { notIn: createdOrderIds } } });
      assert.equal(foreignReleases, 0);
    });
  });
});
