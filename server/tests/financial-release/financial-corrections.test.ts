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
  type TestUser,
  withShortfallPolicyApproved,
} from "../helpers/fixtures";

// ============================================================
// FR.6 — Financial corrections, reversal guards, adjustment integrity
// Contract: docs/settlement-financial-release-contract.md §4, §6, §7, §8, §11
//
// Settlement-mode orders come from real deliveries with the GLOBAL
// activation flag on only for the delivery itself (always restored).
// Every scenario ends with the R1–R4 / R6 / R11 / R12 reconciliation checks
// for the drivers and customers it touched.
// ============================================================

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const dec = (v: string | number | Prisma.Decimal) => new Prisma.Decimal(v);
const REASON = "Recorded against the wrong order";

describe("Financial corrections and reversal guards (FR.6)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let dispatcher: TestUser;
  let tokens: { admin: string; finance: string; dispatcher: string };
  let area: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCustomerIds: string[] = [];
  let keySeq = 0;
  // Race outcomes per test, printed at the end (which interleavings ran).
  const raceOutcomes = new Map<string, string[]>();
  const observe = (label: string, outcome: string) => raceOutcomes.set(label, [...(raceOutcomes.get(label) ?? []), outcome]);
  const nextKey = (p = "fr6") => `${p}-${Date.now()}-${++keySeq}`;

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
  });

  afterEach(async () => {
    await setActivation(false);
  });

  after(async () => {
    for (const [label, outcomes] of raceOutcomes) console.log(`[FR.6 race] ${label}: ${outcomes.join(", ")}`);
    await setActivation(false);
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await prisma.audit_logs.deleteMany({
      where: {
        actor_user_id: { in: [finance.id, admin.id] },
        entity_type: { in: ["DRIVER_SETTLEMENT", "CUSTOMER_PAYOUT", "DRIVER_CASH_ACCOUNT", "DRIVER_CASH_TRANSACTION", "WALLET_TRANSACTION", "COMPANY_FINANCIAL_TRANSACTION"] },
      },
    });
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
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
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function outForDelivery(driver: Driver, customerId: string, overrides: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR6 Receiver",
        receiverPhone: "+96170000066",
        receiverAreaId: area.id,
        receiverAddress: "6 FR6 St",
        description: "FR.6 order",
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

  // Settlement-mode order (exact 105 by default) + its release.
  async function modeOrder(driver: Driver, customerId: string, overrides: Record<string, unknown> = {}, actual = "105.00", reason?: string) {
    const orderId = await outForDelivery(driver, customerId, overrides);
    await deliver(orderId, driver, actual, reason);
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
    return { orderId, release };
  }

  // Legacy (activation off) exact order — immediate postings, unattributed cash.
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
    request(app)
      .post("/api/v1/driver-settlements")
      .set(auth(tokens.finance))
      .set("Idempotency-Key", nextKey("settle"))
      .send({ driverId, amountReceived: amount, paymentMethodId: cashMethodId });
  const resolve = (orderId: string, wallet: string, fee: string) =>
    request(app)
      .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
      .set(auth(tokens.finance))
      .send({ customerWalletCredit: wallet, companyProductRevenue: "0", companyDeliveryFeeRevenue: fee, resolutionNotes: "Agreed split" });
  const post = (path: string, body: Record<string, unknown>, token = tokens.finance, key: string | null = nextKey()) => {
    const r = request(app).post(path).set(auth(token));
    if (key !== null) r.set("Idempotency-Key", key);
    return r.send(body);
  };
  const voidCollection = (releaseId: string, reason = REASON, token?: string) =>
    post(`/api/v1/finance/order-releases/${releaseId}/void-collection`, { reason }, token);
  const reverseRelease = (releaseId: string, reason = REASON, token?: string) =>
    post(`/api/v1/finance/order-releases/${releaseId}/reverse-release`, { reason }, token);
  const reverseSettlement = (settlementId: string, reason = REASON, token?: string) =>
    post(`/api/v1/driver-settlements/${settlementId}/reverse`, { reason }, token);
  const shortfall = (settlementId: string, amount: string, key = nextKey("shortfall"), reason = "Driver handed over less cash") =>
    withShortfallPolicyApproved(() => post(`/api/v1/driver-settlements/${settlementId}/shortfall`, { amount, reason }, tokens.finance, key));
  const genericCashReverse = (txId: string, reason = "Generic reversal") =>
    post(`/api/v1/finance/driver-cash-transactions/${txId}/reverse`, { reason }, tokens.finance, null);
  const genericWalletReverse = (txId: string) => post(`/api/v1/wallet-transactions/${txId}/reverse`, { reason: "Generic reversal" }, tokens.finance, null);
  const genericCompanyReverse = (txId: string) =>
    post(`/api/v1/finance/company-transactions/${txId}/reverse`, { reason: "Generic reversal" }, tokens.finance, null);
  const adjustCash = (driverId: string, direction: "CREDIT" | "DEBIT", amount: string) =>
    post(`/api/v1/finance/driver-cash/${driverId}/adjust`, { direction, amount, reason: "Cash count correction" }, tokens.finance, null);
  const payout = (customerId: string, amount: string) =>
    post("/api/v1/payouts", { customerId, amount, paymentMethodId: cashMethodId }, tokens.finance, nextKey("payout"));

  // ------------------------------------------------------------ reads
  const cash = async (driverId: string) => (await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } })).current_balance;
  const walletBalance = async (customerId: string) =>
    (await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } })).available_balance;
  async function orderState(orderId: string) {
    const [order, release, wallet, company] = await Promise.all([
      prisma.orders.findUniqueOrThrow({ where: { id: orderId } }),
      prisma.order_financial_releases.findUnique({ where: { order_id: orderId }, include: { correction: true } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId }, orderBy: { created_at: "asc" } }),
    ]);
    return { order, release, wallet, company };
  }
  const audits = (entityId: string, action: string) => prisma.audit_logs.findMany({ where: { entity_id: entityId, action } });
  const fingerprint = async (driverId: string, customerId: string) =>
    JSON.stringify(
      await Promise.all([
        prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } }),
        prisma.driver_cash_transactions.count({ where: { driver_id: driverId } }),
        prisma.order_financial_releases.findMany({ where: { driver_id: driverId }, orderBy: { id: "asc" } }),
        prisma.driver_settlement_allocations.findMany({ where: { driver_id: driverId }, orderBy: { id: "asc" } }),
        prisma.driver_settlement_corrections.count({ where: { driver_id: driverId } }),
        prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } }),
        prisma.wallet_transactions.count({ where: { customer_id: customerId } }),
        prisma.company_financial_transactions.count({ where: { orders: { customer_id: customerId } } }),
        prisma.order_financial_release_corrections.count({ where: { release: { customer_id: customerId } } }),
        prisma.orders.findMany({ where: { customer_id: customerId }, select: { id: true, status: true, financial_status: true }, orderBy: { id: "asc" } }),
      ]),
      (_k, v) => (v instanceof Date ? v.toISOString() : v)
    );

  // ------------------------------------------------------------ reconciliation (contract §11)
  async function assertDriverReconciled(driverId: string) {
    const balance = await cash(driverId);
    const rows = await prisma.driver_cash_transactions.findMany({ where: { driver_id: driverId }, orderBy: [{ created_at: "asc" }, { id: "asc" }] });
    const net = rows.reduce((s, r) => s.plus(r.balance_after.minus(r.balance_before)), dec(0));
    assert.ok(net.equals(balance), `R1 cached balance ${balance} = ledger net ${net}`);
    for (const r of rows) assert.ok(r.balance_after.minus(r.balance_before).abs().equals(r.amount), "R1 row delta = amount");
    const reversalTargets = rows.filter((r) => r.reversal_of_id).map((r) => r.reversal_of_id);
    assert.equal(new Set(reversalTargets).size, reversalTargets.length, "no cash row reversed twice");

    const releases = await prisma.order_financial_releases.findMany({ where: { driver_id: driverId }, include: { allocations: true, correction: true } });
    let attributed = dec(0);
    for (const r of releases) {
      const active = r.allocations.filter((a) => a.reversed_by_correction_id === null).reduce((s, a) => s.plus(a.amount), dec(0));
      assert.ok(r.allocated_amount.equals(active), `R3 allocated = Σ active allocations (${r.id})`);
      assert.ok(r.allocated_amount.greaterThanOrEqualTo(0) && r.allocated_amount.lessThanOrEqualTo(r.collection_amount));
      if (r.release_status === "PENDING") attributed = attributed.plus(r.collection_amount.minus(r.allocated_amount));
      // R12
      if (r.release_status === "VOIDED") {
        assert.equal(r.correction?.correction_type, "COLLECTION_VOID", "R12 VOIDED ⇔ COLLECTION_VOID");
        const reversal = rows.find((x) => x.id === r.correction?.driver_cash_reversal_transaction_id);
        assert.equal(reversal?.reversal_of_id, r.collection_transaction_id, "R12 void reverses the release's COLLECTION");
      } else if (r.release_status === "RELEASE_REVERSED") {
        assert.equal(r.correction?.correction_type, "RELEASE_REVERSAL", "R12 RELEASE_REVERSED ⇔ RELEASE_REVERSAL");
      } else {
        assert.equal(r.correction, null, "only terminal corrected releases carry a correction");
      }
      await assertOrderMatchesRelease(r.order_id);
    }
    assert.ok(balance.minus(attributed).greaterThanOrEqualTo(0), `R2 unattributed ${balance.minus(attributed)} >= 0`);

    const settlements = await prisma.driver_settlements.findMany({ where: { driver_id: driverId }, include: { allocations: true } });
    for (const s of settlements) {
      if (s.allocated_total === null) continue;
      assert.ok(s.allocated_total.equals(s.allocations.reduce((acc, a) => acc.plus(a.amount), dec(0))), "R4 allocated_total = Σ allocations");
      assert.ok(s.amount_received.equals(s.allocated_total.plus(s.unattributed_amount as Prisma.Decimal)), "R4 amount = allocated + unattributed");
    }
    const corrections = await prisma.driver_settlement_corrections.findMany({ where: { driver_id: driverId } });
    for (const c of corrections) {
      const row = rows.find((x) => x.id === c.cash_transaction_id);
      assert.ok(row, "settlement correction links its corrective cash row");
      assert.ok(row.amount.equals(c.amount));
      assert.equal(row.type, c.correction_type === "SETTLEMENT_REVERSAL" ? "REVERSAL" : "ADJUSTMENT");
    }
  }

  // §4.5 mapping (R11) + ownership postings (R6, R7, R8) for one order.
  async function assertOrderMatchesRelease(orderId: string) {
    const s = await orderState(orderId);
    const r = s.release;
    if (!r) return;
    assert.equal(s.order.status, "DELIVERED", "R11 operational status stays DELIVERED");
    const expected =
      r.release_status === "PENDING"
        ? r.review_status === "AWAITING_REVIEW"
          ? "REVIEW_REQUIRED"
          : "AWAITING_SETTLEMENT"
        : r.release_status === "RELEASED"
          ? "FINALIZED"
          : r.release_status === "VOIDED"
            ? "COLLECTION_VOIDED"
            : "RELEASE_REVERSED";
    assert.equal(s.order.financial_status, expected, `R11 order ${orderId}`);
    assert.equal(s.order.needs_financial_review, expected === "REVIEW_REQUIRED");
    const originals = [
      ...s.wallet.filter((w) => w.type === "ORDER_CREDIT"),
      ...s.company.filter((c) => c.type !== "REVERSAL" && c.type !== "ADJUSTMENT"),
    ];
    if (r.release_status === "PENDING" || r.release_status === "VOIDED") {
      assert.equal(originals.length + s.wallet.length + s.company.length, 0, "R6 no ownership postings");
      return;
    }
    const referenced = [r.wallet_transaction_id, r.company_product_transaction_id, r.company_fee_transaction_id].filter(Boolean).sort();
    assert.deepEqual(originals.map((o) => o.id).sort(), referenced, "R6 exactly the referenced postings");
    if (r.order_type === "COMPANY_ORDER") assert.equal(s.wallet.length, 0, "R8 no wallet posting for a COMPANY_ORDER");
    if (r.release_status === "RELEASE_REVERSED") {
      const walletNet = s.wallet.reduce((acc, w) => acc.plus(w.credit).minus(w.debit), dec(0));
      const companyNet = s.company.reduce((acc, c) => acc.plus(c.amount), dec(0));
      assert.ok(walletNet.isZero() && companyNet.isZero(), "R6 reversed release nets to zero");
      const ids = [r.correction?.wallet_reversal_transaction_id, r.correction?.company_product_reversal_transaction_id, r.correction?.company_fee_reversal_transaction_id];
      for (const o of originals) {
        const rev = [...s.wallet, ...s.company].filter((x) => x.reversal_of_id === o.id);
        assert.equal(rev.length, 1, "R6 each original reversed exactly once");
        assert.ok(ids.includes(rev[0].id), "R6 reversal referenced by the correction");
      }
    } else {
      assert.equal(s.wallet.length + s.company.length, originals.length, "released order has only its original postings");
    }
  }

  async function assertWalletReconciled(customerId: string) {
    const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
    const rows = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId } });
    const net = rows.reduce((s, w) => s.plus(w.credit).minus(w.debit), dec(0));
    assert.ok(wallet.available_balance.equals(net), "R13 wallet cached = ledger");
    assert.ok(wallet.available_balance.greaterThanOrEqualTo(0), "wallet never negative");
  }

  const reconciled = async (driverId: string, ...customers: string[]) => {
    await assertDriverReconciled(driverId);
    for (const c of customers) await assertWalletReconciled(c);
  };

  // ============================================================
  describe("collection void", () => {
    test("1. unallocated exact collection: driver cash reversed, release VOIDED, order COLLECTION_VOIDED, nothing posted", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer);
      const res = await voidCollection(release.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.correctionType, "COLLECTION_VOID");
      assert.equal(res.body.data.releaseStatus, "VOIDED");
      assert.equal(res.body.data.orderFinancialStatus, "COLLECTION_VOIDED");
      const s = await orderState(orderId);
      assert.equal(s.order.status, "DELIVERED");
      assert.equal(s.release?.release_status, "VOIDED");
      assert.equal(s.wallet.length + s.company.length, 0);
      const reversal = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: res.body.data.driverCashReversalTransactionId } });
      assert.equal(reversal.type, "REVERSAL");
      assert.equal(reversal.reversal_of_id, release.collection_transaction_id);
      assert.equal(reversal.idempotency_key, `reversal:driver-cash:${release.collection_transaction_id}`);
      assert.equal(reversal.order_id, orderId);
      assert.equal(s.release?.correction?.idempotency_key, `release-void:${release.id}`);
      assert.equal(s.release?.correction?.created_by_id, finance.id);
      assert.ok((await cash(driver.driverId)).isZero());
      const audit = await audits(orderId, "FINANCIAL_RELEASE_COLLECTION_VOIDED");
      assert.equal(audit.length, 1);
      assert.equal((audit[0].metadata as Record<string, unknown>).correctionId, res.body.data.id);
      await reconciled(driver.driverId, customer);
    });

    test("2. a difference awaiting review can be voided; review is cleared and cannot be resolved afterwards", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer, {}, "95.00", "Receiver short");
      const res = await voidCollection(release.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const s = await orderState(orderId);
      assert.equal(s.order.financial_status, "COLLECTION_VOIDED");
      assert.equal(s.order.needs_financial_review, false);
      assert.equal((await resolve(orderId, "90.00", "5.00")).status, 400);
      await reconciled(driver.driverId, customer);
    });

    test("3. blocked once allocated (partial or full) or released: 409 COLLECTION_HAS_ALLOCATIONS, nothing changes", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const partial = await modeOrder(driver, customer);
      const released = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: partial.release.id, amount: "10.00" }])).status, 201);
      assert.equal((await settle(driver.driverId, [{ releaseId: released.release.id, amount: "105.00" }])).status, 201);
      const before = await fingerprint(driver.driverId, customer);
      for (const id of [partial.release.id, released.release.id]) {
        const res = await voidCollection(id);
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(res.body.error.details.reason, "COLLECTION_HAS_ALLOCATIONS");
      }
      assert.equal(await fingerprint(driver.driverId, customer), before);
      await reconciled(driver.driverId, customer);
    });

    test("4. the generic driver-cash reverse endpoint refuses a release-linked collection (USE_RELEASE_CORRECTION)", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const before = await fingerprint(driver.driverId, customer);
      const res = await genericCashReverse(release.collection_transaction_id);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "USE_RELEASE_CORRECTION");
      assert.equal(await fingerprint(driver.driverId, customer), before);
    });

    test("5. retry, conflicting retry, validation and authorization", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      assert.equal((await voidCollection(release.id, "short")).status, 400, "reason >= 10 chars");
      assert.equal((await post(`/api/v1/finance/order-releases/${release.id}/void-collection`, { reason: REASON }, tokens.finance, null)).status, 400, "Idempotency-Key required");
      assert.equal((await voidCollection(release.id, REASON, tokens.dispatcher)).status, 403);
      assert.equal((await voidCollection(release.id, REASON, driver.token)).status, 403);
      assert.equal((await voidCollection(randomUUID())).status, 404);
      const first = await voidCollection(release.id);
      assert.equal(first.status, 201);
      const retry = await voidCollection(release.id);
      assert.equal(retry.status, 201, JSON.stringify(retry.body));
      assert.equal(retry.body.data.id, first.body.data.id, "same correction returned");
      const conflicting = await voidCollection(release.id, "A different explanation");
      assert.equal(conflicting.status, 409);
      assert.equal(await prisma.driver_cash_transactions.count({ where: { reversal_of_id: release.collection_transaction_id } }), 1);
      assert.equal((await reverseRelease(release.id)).status, 409, "a voided release cannot be release-reversed");
      await reconciled(driver.driverId, customer);
    });

    test("6. a voided collection is never allocated, resolved or released afterwards", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer);
      assert.equal((await voidCollection(release.id)).status, 201);
      const res = await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }]);
      assert.equal(res.status, 400);
      const s = await orderState(orderId);
      assert.equal(s.wallet.length + s.company.length, 0);
      await reconciled(driver.driverId, customer);
    });

    test("7. legacy collection reversal is unchanged but capped at unattributed cash", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const legacyA = await legacyOrder(driver, customer);
      const legacyB = await legacyOrder(driver, customer);
      const collectionA = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: legacyA, type: "COLLECTION" } });
      const ok = await genericCashReverse(collectionA.id);
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      // U = 105 legacy B; reserve it except 5 by settling 100 unattributed beside a pending release.
      const { release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [], { amount: "100.00", reason: "Legacy cash handed over" })).status, 201);
      const collectionB = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: legacyB, type: "COLLECTION" } });
      const blocked = await genericCashReverse(collectionB.id);
      assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
      assert.equal(blocked.body.error.details.reason, "ADJUSTMENT_EXCEEDS_UNATTRIBUTED");
      assert.ok((await cash(driver.driverId)).equals(110), "105 reserved + 5 unattributed");
      assert.equal((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).release_status, "PENDING");
      await reconciled(driver.driverId, customer);
    });
  });

  // ============================================================
  describe("settlement reversal", () => {
    test("8. reversing an allocation settlement credits the cash back, reverses allocations and restores unsettled amounts", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const a = await modeOrder(driver, customer);
      const b = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [
        { releaseId: a.release.id, amount: "60.00" },
        { releaseId: b.release.id, amount: "40.00" },
      ]);
      assert.equal(settled.status, 201);
      assert.ok((await cash(driver.driverId)).equals(110));
      const res = await reverseSettlement(settled.body.data.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.correctionType, "SETTLEMENT_REVERSAL");
      assert.equal(res.body.data.amount, "100");
      assert.equal(res.body.data.reversedAllocations.length, 2);
      assert.ok((await cash(driver.driverId)).equals(210));
      for (const r of [a, b]) {
        const s = await orderState(r.orderId);
        assert.ok(s.release?.allocated_amount.isZero());
        assert.equal(s.release?.release_status, "PENDING");
        assert.equal(s.order.financial_status, "AWAITING_SETTLEMENT");
      }
      const allocations = await prisma.driver_settlement_allocations.findMany({ where: { settlement_id: settled.body.data.id } });
      assert.equal(allocations.length, 2, "allocations are never deleted");
      assert.ok(allocations.every((x) => x.reversed_by_correction_id === res.body.data.id));
      const cashRow = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: res.body.data.cashTransactionId } });
      const original = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { settlement_id: settled.body.data.id } });
      assert.equal(cashRow.reversal_of_id, original.id);
      assert.equal(cashRow.idempotency_key, `reversal:driver-cash:${original.id}`);
      const correction = await prisma.driver_settlement_corrections.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(correction.idempotency_key, `settlement-reversal:${settled.body.data.id}`);
      assert.ok(await prisma.driver_settlements.findUnique({ where: { id: settled.body.data.id } }), "original settlement kept");
      assert.equal((await audits(settled.body.data.id, "DRIVER_SETTLEMENT_REVERSED")).length, 1);
      await reconciled(driver.driverId, customer);
      // The collections settle and release normally afterwards.
      assert.equal((await settle(driver.driverId, [{ releaseId: a.release.id, amount: "105.00" }])).status, 201);
      assert.equal((await orderState(a.orderId)).release?.release_status, "RELEASED");
      await reconciled(driver.driverId, customer);
    });

    test("9. blocked when an allocation led to released funds (RELEASED or RELEASE_REVERSED)", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }]);
      let before = await fingerprint(driver.driverId, customer);
      let res = await reverseSettlement(settled.body.data.id);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "SETTLEMENT_HAS_RELEASED_FUNDS");
      assert.equal(await fingerprint(driver.driverId, customer), before);
      assert.equal((await reverseRelease(release.id)).status, 201);
      before = await fingerprint(driver.driverId, customer);
      res = await reverseSettlement(settled.body.data.id);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "SETTLEMENT_HAS_RELEASED_FUNDS");
      assert.equal(await fingerprint(driver.driverId, customer), before);
      await reconciled(driver.driverId, customer);
    });

    test("10. an unattributed portion returns to unattributed cash on reversal", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      await legacyOrder(driver, customer);
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }], { amount: "105.00", reason: "Legacy cash handed over" });
      assert.equal(settled.status, 201, JSON.stringify(settled.body));
      assert.equal((await reverseSettlement(settled.body.data.id)).status, 201);
      assert.ok((await cash(driver.driverId)).equals(210));
      // U is back to 105: the full unattributed line can be settled again.
      assert.equal((await settle(driver.driverId, [], { amount: "105.00", reason: "Legacy cash handed over" })).status, 201);
      await reconciled(driver.driverId, customer);
    });

    test("11. legacy-format settlement: dedicated and generic reversal both write the linked correction; once only", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      await legacyOrder(driver, customer);
      await legacyOrder(driver, customer);
      const first = await settleLegacy(driver.driverId, "100.00");
      const second = await settleLegacy(driver.driverId, "100.00");
      assert.equal(first.status, 201);
      assert.equal(second.status, 201);

      const dedicated = await reverseSettlement(first.body.data.id);
      assert.equal(dedicated.status, 201, JSON.stringify(dedicated.body));
      assert.equal(dedicated.body.data.reversedAllocations.length, 0);

      const secondTx = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { settlement_id: second.body.data.id } });
      const generic = await genericCashReverse(secondTx.id, "Recorded twice by mistake");
      assert.equal(generic.status, 201, JSON.stringify(generic.body));
      assert.equal(generic.body.data.type, "REVERSAL", "existing response contract unchanged");
      const linked = await prisma.driver_settlement_corrections.findFirstOrThrow({ where: { settlement_id: second.body.data.id } });
      assert.equal(linked.correction_type, "SETTLEMENT_REVERSAL");
      assert.equal(linked.cash_transaction_id, generic.body.data.id);
      assert.equal(linked.reason, "Recorded twice by mistake");

      // Already reversed (by the generic path): same reason replays, another conflicts.
      const replay = await reverseSettlement(second.body.data.id, "Recorded twice by mistake");
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.id, linked.id);
      assert.equal((await reverseSettlement(second.body.data.id)).status, 409);
      assert.equal((await genericCashReverse(secondTx.id)).status, 409);
      assert.ok((await cash(driver.driverId)).equals(210));
      await reconciled(driver.driverId, customer);
    });

    test("12. the generic endpoint refuses an allocation-format settlement (USE_SETTLEMENT_CORRECTION)", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      const settlementTx = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { settlement_id: settled.body.data.id } });
      const before = await fingerprint(driver.driverId, customer);
      const res = await genericCashReverse(settlementTx.id);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "USE_SETTLEMENT_CORRECTION");
      assert.equal(await fingerprint(driver.driverId, customer), before);
    });

    test("13. duplicate and concurrent reversal requests create one correction and one cash row", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      const results = await Promise.all([1, 2, 3].map(() => reverseSettlement(settled.body.data.id)));
      assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
      assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
      assert.equal(await prisma.driver_settlement_corrections.count({ where: { settlement_id: settled.body.data.id } }), 1);
      const original = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { settlement_id: settled.body.data.id } });
      assert.equal(await prisma.driver_cash_transactions.count({ where: { reversal_of_id: original.id } }), 1);
      assert.ok((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).allocated_amount.isZero());
      assert.equal((await reverseSettlement(settled.body.data.id, "short")).status, 400);
      await reconciled(driver.driverId, customer);
    });

    test("14. reversal racing another settlement on the same collection: consistent either way", async () => {
      for (let round = 0; round < 3; round++) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { release } = await modeOrder(driver, customer);
        const first = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
        const [rev, other] = await Promise.all([reverseSettlement(first.body.data.id), settle(driver.driverId, [{ releaseId: release.id, amount: "55.00" }])]);
        assert.equal(other.status, 201, JSON.stringify(other.body));
        const r = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
        observe("14 reversal vs settlement", rev.status === 201 ? "reversal-first" : "settlement-first");
        if (rev.status === 201) {
          assert.equal(r.release_status, "PENDING");
          assert.ok(r.allocated_amount.equals(55));
        } else {
          assert.equal(rev.status, 409);
          assert.equal(rev.body.error.details.reason, "SETTLEMENT_HAS_RELEASED_FUNDS");
          assert.equal(r.release_status, "RELEASED");
        }
        await reconciled(driver.driverId, customer);
      }
    });

    test("15. reversal racing a resolution-triggered release: never reverses released funds", async () => {
      for (let round = 0; round < 3; round++) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { orderId, release } = await modeOrder(driver, customer, {}, "95.00", "Receiver short");
        const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
        const [rev, res] = await Promise.all([reverseSettlement(settled.body.data.id), resolve(orderId, "90.00", "5.00")]);
        assert.equal(res.status, 200, JSON.stringify(res.body));
        const r = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
        observe("15 reversal vs resolution", rev.status === 201 ? "reversal-first" : "resolution-first");
        if (rev.status === 201) {
          assert.equal(r.release_status, "PENDING", "resolution after reversal defers");
          assert.ok(r.allocated_amount.isZero());
        } else {
          assert.equal(rev.status, 409);
          assert.equal(r.release_status, "RELEASED");
        }
        await reconciled(driver.driverId, customer);
      }
    });
  });

  // ============================================================
  describe("settlement shortfall", () => {
    test("16. shortfall after release restores a genuine driver obligation as unattributed cash; customer credit stands", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }]);
      const walletBefore = await walletBalance(customer);
      const res = await shortfall(settled.body.data.id, "20.00");
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.correctionType, "SETTLEMENT_SHORTFALL");
      assert.ok((await cash(driver.driverId)).equals(20));
      const cashRow = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: res.body.data.cashTransactionId } });
      assert.equal(cashRow.type, "ADJUSTMENT");
      assert.equal(cashRow.idempotency_key, `settlement-shortfall:${res.body.data.id}`);
      assert.ok((await walletBalance(customer)).equals(walletBefore), "released customer credit stands");
      assert.equal((await orderState(orderId)).release?.release_status, "RELEASED");
      assert.equal((await audits(settled.body.data.id, "DRIVER_SETTLEMENT_SHORTFALL_RECORDED")).length, 1);
      // The obligation is unattributed: settled through the unattributed line.
      assert.equal((await settle(driver.driverId, [], { amount: "20.00", reason: "Shortfall handed over later" })).status, 201);
      assert.ok((await cash(driver.driverId)).isZero());
      await reconciled(driver.driverId, customer);
    });

    test("17. limits: Σ shortfalls ≤ amount received; none after reversal; reversal blocked after a shortfall; its cash row is not generically reversible", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      assert.equal((await shortfall(settled.body.data.id, "30.00")).status, 201);
      const over = await shortfall(settled.body.data.id, "20.01");
      assert.equal(over.status, 400);
      assert.equal(over.body.error.details.reason, "SHORTFALL_EXCEEDS_SETTLEMENT");
      const rest = await shortfall(settled.body.data.id, "20.00");
      assert.equal(rest.status, 201);
      const rev = await reverseSettlement(settled.body.data.id);
      assert.equal(rev.status, 409);
      assert.equal(rev.body.error.details.reason, "SETTLEMENT_HAS_SHORTFALL");
      const generic = await genericCashReverse(rest.body.data.cashTransactionId);
      assert.equal(generic.status, 409);
      assert.equal(generic.body.error.details.reason, "USE_SETTLEMENT_CORRECTION");

      const other = await settle(driver.driverId, [{ releaseId: release.id, amount: "10.00" }]);
      assert.equal((await reverseSettlement(other.body.data.id)).status, 201);
      const afterReversal = await shortfall(other.body.data.id, "1.00");
      assert.equal(afterReversal.status, 409);
      await reconciled(driver.driverId, customer);
    });

    test("18. shortfall idempotency: same key replays, different body conflicts, concurrent same key records once", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      const key = nextKey("sf");
      const results = await Promise.all([1, 2, 3].map(() => shortfall(settled.body.data.id, "5.00", key)));
      assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
      assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
      assert.equal((await shortfall(settled.body.data.id, "6.00", key)).status, 409);
      assert.equal((await post(`/api/v1/driver-settlements/${settled.body.data.id}/shortfall`, { amount: "1.00", reason: "Driver handed over less" }, tokens.finance, null)).status, 400);
      assert.equal(await prisma.driver_settlement_corrections.count({ where: { settlement_id: settled.body.data.id } }), 1);
      assert.ok((await cash(driver.driverId)).equals(60));
      await reconciled(driver.driverId, customer);
    });

    test("18a. FR.11A: without an approved shortfall policy a NEW shortfall is refused (403) and nothing is written", async () => {
      assert.notEqual(process.env.SETTLEMENT_SHORTFALL_POLICY_APPROVED, "true");
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      const cashBefore = await cash(driver.driverId);
      const res = await post(`/api/v1/driver-settlements/${settled.body.data.id}/shortfall`, { amount: "5.00", reason: "Driver handed over less cash" });
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "SHORTFALL_POLICY_NOT_APPROVED");
      assert.equal(await prisma.driver_settlement_corrections.count({ where: { settlement_id: settled.body.data.id } }), 0);
      assert.ok((await cash(driver.driverId)).equals(cashBefore));
      assert.equal((await audits(settled.body.data.id, "DRIVER_SETTLEMENT_SHORTFALL_RECORDED")).length, 0);
      // Other corrections are unaffected by the shortfall restriction.
      assert.equal((await reverseSettlement(settled.body.data.id)).status, 201);
      await reconciled(driver.driverId, customer);
    });

    test("18b. FR.11A: a shortfall recorded before the restriction still replays with its original key; a new key is refused", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
      const key = nextKey("sf-hist");
      const recorded = await shortfall(settled.body.data.id, "5.00", key);
      assert.equal(recorded.status, 201, JSON.stringify(recorded.body));
      const replay = await post(`/api/v1/driver-settlements/${settled.body.data.id}/shortfall`, { amount: "5.00", reason: "Driver handed over less cash" }, tokens.finance, key);
      assert.equal(replay.status, 201, JSON.stringify(replay.body));
      assert.equal(replay.body.data.id, recorded.body.data.id);
      const fresh = await post(`/api/v1/driver-settlements/${settled.body.data.id}/shortfall`, { amount: "5.00", reason: "Driver handed over less cash" });
      assert.equal(fresh.status, 403);
      assert.equal(await prisma.driver_settlement_corrections.count({ where: { settlement_id: settled.body.data.id } }), 1);
      const detail = await request(app).get(`/api/v1/driver-settlements/${settled.body.data.id}`).set(auth(tokens.finance));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.shortfallTotal, "5");
      await reconciled(driver.driverId, customer);
    });
  });

  // ============================================================
  describe("release reversal", () => {
    test("19. DELIVERY_ONLY: wallet credit and fee revenue reversed; release + order RELEASE_REVERSED; driver cash untouched", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
      const released = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
      assert.ok((await walletBalance(customer)).equals(100));
      const cashBefore = await cash(driver.driverId);
      const res = await reverseRelease(release.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.correctionType, "RELEASE_REVERSAL");
      assert.equal(res.body.data.companyProductReversalTransactionId, null);
      assert.ok((await walletBalance(customer)).isZero());
      assert.ok((await cash(driver.driverId)).equals(cashBefore));
      const s = await orderState(orderId);
      assert.equal(s.order.status, "DELIVERED");
      assert.equal(s.order.financial_status, "RELEASE_REVERSED");
      assert.equal(s.release?.release_status, "RELEASE_REVERSED");
      assert.equal(s.release?.wallet_transaction_id, released.wallet_transaction_id, "historical posting references preserved");
      assert.equal(s.release?.company_fee_transaction_id, released.company_fee_transaction_id);
      const walletRev = s.wallet.find((w) => w.id === res.body.data.walletReversalTransactionId);
      assert.equal(walletRev?.type, "REVERSAL");
      assert.equal(walletRev?.idempotency_key, `reversal:wallet:${released.wallet_transaction_id}`);
      const feeRev = s.company.find((c) => c.id === res.body.data.companyFeeReversalTransactionId);
      assert.ok(feeRev?.amount.equals(-5));
      assert.equal(feeRev?.idempotency_key, `reversal:company:${released.company_fee_transaction_id}`);
      assert.equal(s.release?.correction?.idempotency_key, `release-reversal:${release.id}`);
      assert.equal((await audits(orderId, "FINANCIAL_RELEASE_REVERSED")).length, 1);
      await reconciled(driver.driverId, customer);
    });

    test("20. COMPANY_ORDER: product and fee revenue reversed, no wallet touched", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer, { orderType: "COMPANY_ORDER", orderAmount: "40.00" }, "45.00");
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "45.00" }])).status, 201);
      const res = await reverseRelease(release.id);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.walletReversalTransactionId, null);
      const s = await orderState(orderId);
      assert.equal(s.wallet.length, 0);
      assert.deepEqual(s.company.map((c) => c.amount.toString()).sort(), ["-40", "-5", "40", "5"]);
      await reconciled(driver.driverId, customer);
    });

    test("21. paid-out funds: 409 RELEASED_FUNDS_PAID_OUT, wallet never negative, no partial writes", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
      assert.equal((await payout(customer, "30.00")).status, 201);
      const before = await fingerprint(driver.driverId, customer);
      const res = await reverseRelease(release.id);
      assert.equal(res.status, 409, JSON.stringify(res.body));
      assert.equal(res.body.error.details.reason, "RELEASED_FUNDS_PAID_OUT");
      assert.equal(await fingerprint(driver.driverId, customer), before);
      assert.ok((await walletBalance(customer)).equals(70));
      await reconciled(driver.driverId, customer);
    });

    test("22. invalid state: pending release cannot be reversed; a reversed release is never released again", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const pending = await modeOrder(driver, customer);
      const res = await reverseRelease(pending.release.id);
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "RELEASE_NOT_RELEASED");
      assert.equal((await reverseRelease(randomUUID())).status, 404);
      assert.equal((await reverseRelease(pending.release.id, REASON, tokens.dispatcher)).status, 403);

      const diff = await modeOrder(driver, customer, {}, "95.00", "Receiver short");
      assert.equal((await settle(driver.driverId, [{ releaseId: diff.release.id, amount: "95.00" }])).status, 201);
      assert.equal((await resolve(diff.orderId, "90.00", "5.00")).status, 200);
      assert.equal((await reverseRelease(diff.release.id)).status, 201);
      assert.equal((await resolve(diff.orderId, "90.00", "5.00")).status, 400, "no new release generation");
      assert.equal((await settle(driver.driverId, [{ releaseId: diff.release.id, amount: "1.00" }])).status, 400);
      const s = await orderState(diff.orderId);
      assert.equal(s.wallet.filter((w) => w.type === "ORDER_CREDIT").length, 1);
      await reconciled(driver.driverId, customer);
    });

    test("23. retry returns the same correction; conflicting and concurrent duplicates never reverse twice", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { orderId, release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
      const results = await Promise.all([1, 2, 3].map(() => reverseRelease(release.id)));
      assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
      assert.equal(new Set(results.map((r) => r.body.data.id)).size, 1);
      assert.equal((await reverseRelease(release.id, "Another explanation")).status, 409);
      const s = await orderState(orderId);
      assert.equal(s.wallet.filter((w) => w.type === "REVERSAL").length, 1);
      assert.equal(s.company.filter((c) => c.type === "REVERSAL").length, 1);
      await reconciled(driver.driverId, customer);
    });

    test("24. release reversal racing a payout of the same funds: exactly one succeeds", async () => {
      for (let round = 0; round < 3; round++) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { release } = await modeOrder(driver, customer);
        assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
        const [rev, pay] = await Promise.all([reverseRelease(release.id), payout(customer, "100.00")]);
        assert.equal([rev.status === 201, pay.status === 201].filter(Boolean).length, 1, JSON.stringify([rev.status, pay.status, rev.body, pay.body]));
        observe("24 release reversal vs payout", rev.status === 201 ? "reversal-won" : "payout-won");
        if (rev.status !== 201) assert.equal(rev.body.error.details.reason, "RELEASED_FUNDS_PAID_OUT");
        assert.ok((await walletBalance(customer)).isZero());
        await reconciled(driver.driverId, customer);
      }
    });

    test("25. release reversal racing a generic wallet reversal: generic is always refused, release reversal succeeds once", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
      const released = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
      const [rev, generic] = await Promise.all([reverseRelease(release.id), genericWalletReverse(released.wallet_transaction_id as string)]);
      assert.equal(rev.status, 201, JSON.stringify(rev.body));
      assert.equal(generic.status, 409, JSON.stringify(generic.body));
      assert.equal(await prisma.wallet_transactions.count({ where: { reversal_of_id: released.wallet_transaction_id } }), 1);
      await reconciled(driver.driverId, customer);
    });

    test("26. an induced posting failure mid-reversal rolls back every write", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
      const released = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
      // Occupy the fee reversal's deterministic key with an unrelated row, so
      // the company insert fails AFTER the wallet debit inside the transaction.
      const planted = await prisma.company_financial_transactions.create({
        data: { type: "ADJUSTMENT", amount: dec("1.00"), notes: "FR.6 induced failure", idempotency_key: `reversal:company:${released.company_fee_transaction_id}` },
      });
      try {
        const before = await fingerprint(driver.driverId, customer);
        const res = await reverseRelease(release.id);
        assert.equal(res.status, 409, JSON.stringify(res.body));
        assert.equal(await fingerprint(driver.driverId, customer), before);
        assert.ok((await walletBalance(customer)).equals(100));
        assert.equal((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).release_status, "RELEASED");
      } finally {
        await prisma.company_financial_transactions.delete({ where: { id: planted.id } });
      }
      assert.equal((await reverseRelease(release.id)).status, 201, "succeeds once the obstacle is gone");
      await reconciled(driver.driverId, customer);
    });
  });

  // ============================================================
  describe("generic wallet / company reversal guards", () => {
    test("27. release-linked wallet and company rows are refused; legacy rows still reverse", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
      const released = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
      const before = await fingerprint(driver.driverId, customer);
      const w = await genericWalletReverse(released.wallet_transaction_id as string);
      assert.equal(w.status, 409);
      assert.equal(w.body.error.details.reason, "USE_RELEASE_CORRECTION");
      const c = await genericCompanyReverse(released.company_fee_transaction_id as string);
      assert.equal(c.status, 409);
      assert.equal(c.body.error.details.reason, "USE_RELEASE_CORRECTION");
      assert.equal(await fingerprint(driver.driverId, customer), before);

      const legacy = await legacyOrder(driver, customer);
      const legacyCredit = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: legacy, type: "ORDER_CREDIT" } });
      const legacyFee = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: legacy, type: "DELIVERY_FEE_REVENUE" } });
      assert.equal((await genericWalletReverse(legacyCredit.id)).status, 201);
      assert.equal((await genericCompanyReverse(legacyFee.id)).status, 201);
      await reconciled(driver.driverId, customer);
    });
  });

  // ============================================================
  describe("driver cash adjustments", () => {
    test("28. debit adjustments may only consume unattributed cash; credits add unattributed cash", async () => {
      const driver = await createDriver();
      const customer = await newCustomer();
      const { release } = await modeOrder(driver, customer);
      const blocked = await adjustCash(driver.driverId, "DEBIT", "1.00");
      assert.equal(blocked.status, 400, JSON.stringify(blocked.body));
      assert.equal(blocked.body.error.details.reason, "ADJUSTMENT_EXCEEDS_UNATTRIBUTED");
      const credit = await adjustCash(driver.driverId, "CREDIT", "15.00");
      assert.equal(credit.status, 201);
      assert.equal((await adjustCash(driver.driverId, "DEBIT", "15.01")).status, 400);
      assert.equal((await adjustCash(driver.driverId, "DEBIT", "10.00")).status, 201);
      // Reversing the credit (a debit of 15) now exceeds U = 5.
      const reverseCredit = await genericCashReverse(credit.body.data.id);
      assert.equal(reverseCredit.status, 400);
      assert.equal(reverseCredit.body.error.details.reason, "ADJUSTMENT_EXCEEDS_UNATTRIBUTED");
      assert.ok((await cash(driver.driverId)).equals(110));
      assert.ok((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).allocated_amount.isZero());
      await reconciled(driver.driverId, customer);
    });

    test("29. debit adjustment racing an unattributed settlement line: never both, unattributed cash never negative", async () => {
      for (let round = 0; round < 3; round++) {
        const driver = await createDriver();
        const customer = await newCustomer();
        await legacyOrder(driver, customer);
        await modeOrder(driver, customer);
        const [adj, set] = await Promise.all([
          adjustCash(driver.driverId, "DEBIT", "105.00"),
          settle(driver.driverId, [], { amount: "105.00", reason: "Legacy cash handed over" }),
        ]);
        assert.equal([adj.status === 201, set.status === 201].filter(Boolean).length, 1, JSON.stringify([adj.status, set.status]));
        observe("29 adjustment vs settlement", adj.status === 201 ? "adjustment-won" : "settlement-won");
        assert.ok((await cash(driver.driverId)).equals(105), "the reserved collection is untouched");
        await reconciled(driver.driverId, customer);
      }
    });
  });

  // ============================================================
  // Forced interleavings: a separate transaction holds the row lock both
  // requests serialize on; PostgreSQL grants it to waiters in arrival order.
  // ============================================================
  type Res = Awaited<ReturnType<typeof voidCollection>>;
  type Dispatch = () => Promise<Res>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  // supertest only sends a request when .then() is called — do it now.
  const go = (f: () => PromiseLike<Res>): Dispatch => () => Promise.resolve(f().then((x) => x));
  async function forced(lock: (tx: Prisma.TransactionClient) => Promise<unknown>, first: Dispatch, second: Dispatch): Promise<[Res, Res]> {
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    let held!: () => void;
    const locked = new Promise<void>((r) => (held = r));
    const holder = prisma.$transaction(
      async (tx) => {
        await lock(tx);
        held();
        await gate;
      },
      { timeout: 20000 }
    );
    await locked;
    const a = first();
    await sleep(300);
    const b = second();
    await sleep(300);
    unblock();
    await holder;
    return Promise.all([a, b]);
  }
  const lockAccount = (driverId: string) => (tx: Prisma.TransactionClient) =>
    tx.$queryRaw`SELECT id FROM driver_cash_accounts WHERE driver_id = ${driverId}::uuid FOR NO KEY UPDATE`;
  const lockRelease = (releaseId: string) => (tx: Prisma.TransactionClient) =>
    tx.$queryRaw`SELECT id FROM order_financial_releases WHERE id = ${releaseId}::uuid FOR NO KEY UPDATE`;
  const lockWallet = (customerId: string) => (tx: Prisma.TransactionClient) =>
    tx.$queryRaw`SELECT id FROM customer_wallets WHERE customer_id = ${customerId}::uuid FOR NO KEY UPDATE`;

  describe("forced interleavings (both orders)", () => {
    test("32. void vs settlement allocation (account lock)", async () => {
      for (const voidFirst of [true, false]) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { release } = await modeOrder(driver, customer);
        const v = go(() => voidCollection(release.id));
        const st = go(() => settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }]));
        const [first, second] = await forced(lockAccount(driver.driverId), voidFirst ? v : st, voidFirst ? st : v);
        const [vr, sr] = voidFirst ? [first, second] : [second, first];
        assert.equal(vr.status, voidFirst ? 201 : 409, JSON.stringify(vr.body));
        assert.equal(sr.status, voidFirst ? 400 : 201, JSON.stringify(sr.body));
        assert.equal((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).release_status, voidFirst ? "VOIDED" : "RELEASED");
        await reconciled(driver.driverId, customer);
      }
    });

    test("33. settlement reversal vs a completing settlement (account lock)", async () => {
      for (const reversalFirst of [true, false]) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { release } = await modeOrder(driver, customer);
        const original = await settle(driver.driverId, [{ releaseId: release.id, amount: "50.00" }]);
        const rv = go(() => reverseSettlement(original.body.data.id));
        const st = go(() => settle(driver.driverId, [{ releaseId: release.id, amount: "55.00" }]));
        const [first, second] = await forced(lockAccount(driver.driverId), reversalFirst ? rv : st, reversalFirst ? st : rv);
        const [rr, sr] = reversalFirst ? [first, second] : [second, first];
        assert.equal(sr.status, 201, JSON.stringify(sr.body));
        assert.equal(rr.status, reversalFirst ? 201 : 409, JSON.stringify(rr.body));
        const r = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
        assert.equal(r.release_status, reversalFirst ? "PENDING" : "RELEASED");
        assert.ok(r.allocated_amount.equals(reversalFirst ? 55 : 105));
        await reconciled(driver.driverId, customer);
      }
    });

    test("34. debit adjustment vs unattributed settlement line (account lock)", async () => {
      for (const adjustmentFirst of [true, false]) {
        const driver = await createDriver();
        const customer = await newCustomer();
        await legacyOrder(driver, customer);
        await modeOrder(driver, customer);
        const adj = go(() => adjustCash(driver.driverId, "DEBIT", "105.00"));
        const st = go(() => settle(driver.driverId, [], { amount: "105.00", reason: "Legacy cash handed over" }));
        const [first, second] = await forced(lockAccount(driver.driverId), adjustmentFirst ? adj : st, adjustmentFirst ? st : adj);
        assert.equal(first.status, 201, JSON.stringify(first.body));
        assert.equal(second.status, 400, JSON.stringify(second.body));
        assert.ok((await cash(driver.driverId)).equals(105));
        await reconciled(driver.driverId, customer);
      }
    });

    test("35. settlement reversal vs resolution of a fully settled difference (release lock)", async () => {
      for (const reversalFirst of [true, false]) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { orderId, release } = await modeOrder(driver, customer, {}, "95.00", "Receiver short");
        const settled = await settle(driver.driverId, [{ releaseId: release.id, amount: "95.00" }]);
        const rv = go(() => reverseSettlement(settled.body.data.id));
        const rs = go(() => resolve(orderId, "90.00", "5.00"));
        const [first, second] = await forced(lockRelease(release.id), reversalFirst ? rv : rs, reversalFirst ? rs : rv);
        const [rr, res] = reversalFirst ? [first, second] : [second, first];
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(rr.status, reversalFirst ? 201 : 409, JSON.stringify(rr.body));
        assert.equal((await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } })).release_status, reversalFirst ? "PENDING" : "RELEASED");
        await reconciled(driver.driverId, customer);
      }
    });

    test("36. void vs difference resolution (release lock)", async () => {
      for (const voidFirst of [true, false]) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { orderId, release } = await modeOrder(driver, customer, {}, "95.00", "Receiver short");
        const v = go(() => voidCollection(release.id));
        const rs = go(() => resolve(orderId, "90.00", "5.00"));
        const [first, second] = await forced(lockRelease(release.id), voidFirst ? v : rs, voidFirst ? rs : v);
        const [vr, res] = voidFirst ? [first, second] : [second, first];
        assert.equal(vr.status, 201, JSON.stringify(vr.body));
        assert.equal(res.status, voidFirst ? 409 : 200, JSON.stringify(res.body));
        const s = await orderState(orderId);
        assert.equal(s.release?.release_status, "VOIDED");
        assert.equal(s.release?.review_status, voidFirst ? "AWAITING_REVIEW" : "RESOLVED");
        assert.equal(s.wallet.length + s.company.length, 0);
        await reconciled(driver.driverId, customer);
      }
    });

    test("37. release reversal vs payout of the same funds (wallet lock)", async () => {
      for (const reversalFirst of [true, false]) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { release } = await modeOrder(driver, customer);
        assert.equal((await settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])).status, 201);
        const rv = go(() => reverseRelease(release.id));
        const py = go(() => payout(customer, "100.00"));
        const [first, second] = await forced(lockWallet(customer), reversalFirst ? rv : py, reversalFirst ? py : rv);
        const [rr, pr] = reversalFirst ? [first, second] : [second, first];
        assert.equal(rr.status, reversalFirst ? 201 : 409, JSON.stringify(rr.body));
        assert.equal(pr.status, reversalFirst ? 400 : 201, JSON.stringify(pr.body));
        assert.ok((await walletBalance(customer)).isZero());
        await reconciled(driver.driverId, customer);
      }
    });
  });

  // ============================================================
  describe("collection void concurrency", () => {
    test("30. void racing a settlement allocation of the same collection: exactly one wins", async () => {
      for (let round = 0; round < 3; round++) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { release } = await modeOrder(driver, customer);
        const [v, s] = await Promise.all([voidCollection(release.id), settle(driver.driverId, [{ releaseId: release.id, amount: "105.00" }])]);
        assert.equal([v.status === 201, s.status === 201].filter(Boolean).length, 1, JSON.stringify([v.status, s.status]));
        observe("30 void vs settlement", v.status === 201 ? "void-won" : "settlement-won");
        const r = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });
        assert.equal(r.release_status, v.status === 201 ? "VOIDED" : "RELEASED");
        assert.ok((await cash(driver.driverId)).isZero());
        await reconciled(driver.driverId, customer);
      }
    });

    test("31. void racing a difference resolution: consistent terminal state, nothing posted", async () => {
      for (let round = 0; round < 3; round++) {
        const driver = await createDriver();
        const customer = await newCustomer();
        const { orderId, release } = await modeOrder(driver, customer, {}, "95.00", "Receiver short");
        const [v, res] = await Promise.all([voidCollection(release.id), resolve(orderId, "90.00", "5.00")]);
        assert.equal(v.status, 201, JSON.stringify(v.body));
        assert.ok([200, 400, 409].includes(res.status), String(res.status));
        observe("31 void vs resolution", res.status === 200 ? "resolution-first" : "void-first");
        const s = await orderState(orderId);
        assert.equal(s.release?.release_status, "VOIDED");
        assert.equal(s.order.financial_status, "COLLECTION_VOIDED");
        assert.equal(s.wallet.length + s.company.length, 0);
        await reconciled(driver.driverId, customer);
      }
    });
  });
});
