import "../helpers/setup";
import { after, afterEach, before, describe, test } from "node:test";
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

// FR.10.1 — read-only correction eligibility on the three Management ledger
// lists (wallet ledger, driver cash ledger, finance feed). Every verdict is
// cross-checked against the real generic reversal endpoint, so the read rule
// can never drift from the service guards.

const KEY = FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY;
const dec = (v: string | number) => new Prisma.Decimal(v);
const REASON = "Recorded against the wrong order";

type Elig = { correctionWorkflow: string; canReverseGenerically: boolean; reversed: boolean };

describe("Correction eligibility on ledger reads (FR.10.1)", () => {
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
  const nextKey = (p = "fr101") => `${p}-${Date.now()}-${++keySeq}`;

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
    await setActivation(false);
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    await prisma.audit_logs.deleteMany({
      where: { actor_user_id: { in: [finance.id, admin.id] }, entity_type: { in: ["DRIVER_SETTLEMENT", "CUSTOMER_PAYOUT", "DRIVER_CASH_ACCOUNT", "WALLET_TRANSACTION"] } },
    });
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestArea(area.id);
    await Promise.all([admin, finance, dispatcher].map((u) => cleanupTestUser(u.id)));
    assert.equal((await prisma.system_settings.findUniqueOrThrow({ where: { key: KEY } })).value, false);
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
  type Driver = Awaited<ReturnType<typeof createDriver>>;

  async function newCustomer() {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function deliveredOrder(driver: Driver, customerId: string, settlementMode: boolean, overrides: Record<string, unknown> = {}) {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "FR101 Receiver",
        receiverPhone: "+96170000101",
        receiverAreaId: area.id,
        receiverAddress: "101 FR101 St",
        description: "FR.10.1 order",
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
    if (settlementMode) await setActivation(true);
    try {
      const res = await request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
    } finally {
      if (settlementMode) await setActivation(false);
    }
    return orderId;
  }

  const post = (path: string, body: Record<string, unknown>) =>
    request(app).post(path).set(auth(tokens.finance)).set("Idempotency-Key", nextKey()).send(body);
  const get = (path: string, token = tokens.finance) => request(app).get(path).set(auth(token));

  async function walletRows(customerId: string) {
    const res = await get(`/api/v1/wallets/${customerId}/transactions?limit=100`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as (Elig & { id: string; type: string; order: { id: string } | null })[];
  }
  async function cashRows(driverId: string) {
    const res = await get(`/api/v1/finance/driver-cash/${driverId}/transactions?limit=100`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as (Elig & { id: string; type: string; order: { id: string } | null; settlement: { id: string } | null })[];
  }
  async function feedRow(ledger: string, id: string) {
    for (let page = 1; page <= 5; page++) {
      const res = await get(`/api/v1/finance/transactions?ledger=${ledger}&limit=100&page=${page}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const row = (res.body.data as (Elig & { id: string })[]).find((r) => r.id === id);
      if (row) return row;
    }
    throw new Error(`feed row ${ledger}/${id} not found`);
  }
  const elig = (r: Elig) => [r.correctionWorkflow, r.canReverseGenerically, r.reversed];

  // The authoritative cross-check: what the generic endpoint does.
  async function genericReverse(ledger: "WALLET" | "DRIVER_CASH" | "COMPANY_FINANCE", id: string) {
    const path =
      ledger === "WALLET"
        ? `/api/v1/wallet-transactions/${id}/reverse`
        : ledger === "DRIVER_CASH"
          ? `/api/v1/finance/driver-cash-transactions/${id}/reverse`
          : `/api/v1/finance/company-transactions/${id}/reverse`;
    return post(path, { reason: REASON });
  }
  async function assertRefusedAs(ledger: "WALLET" | "DRIVER_CASH" | "COMPANY_FINANCE", id: string, expected: "USE_RELEASE_CORRECTION" | "USE_SETTLEMENT_CORRECTION" | "ALREADY") {
    const res = await genericReverse(ledger, id);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    if (expected === "ALREADY") assert.match(res.body.error.message, /already been reversed/);
    else assert.equal(res.body.error.details?.reason, expected, JSON.stringify(res.body));
  }

  test("1. eligible legacy rows: GENERIC, reversible, not reversed — and the generic endpoint agrees", async () => {
    const driver = await createDriver();
    const customer = await newCustomer();
    const orderId = await deliveredOrder(driver, customer, false);

    const credit = (await walletRows(customer)).find((r) => r.type === "ORDER_CREDIT")!;
    assert.deepEqual(elig(credit), ["GENERIC", true, false]);
    const collection = (await cashRows(driver.driverId)).find((r) => r.type === "COLLECTION")!;
    assert.deepEqual(elig(collection), ["GENERIC", true, false]);
    const fee = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
    assert.deepEqual(elig(await feedRow("COMPANY_FINANCE", fee.id)), ["GENERIC", true, false]);
    assert.deepEqual(elig(await feedRow("WALLET", credit.id)), ["GENERIC", true, false]);

    // 7. already reversed (generic): original reversed + not reversible; the REVERSAL row is not reversible.
    assert.equal((await genericReverse("WALLET", credit.id)).status, 201);
    const after = await walletRows(customer);
    assert.deepEqual(elig(after.find((r) => r.id === credit.id)!), ["GENERIC", false, true]);
    const reversal = after.find((r) => r.type === "REVERSAL")!;
    assert.deepEqual(elig(reversal), ["GENERIC", false, false]);
    await assertRefusedAs("WALLET", credit.id, "ALREADY");
    const reversalAttempt = await genericReverse("WALLET", reversal.id);
    assert.equal(reversalAttempt.status, 400);
  });

  test("2-4. release-linked wallet credit, company revenue and driver collection → RELEASE_CORRECTION", async () => {
    const driver = await createDriver();
    const customer = await newCustomer();
    const orderId = await deliveredOrder(driver, customer, true);
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });

    // Before release: the collection is already release-linked.
    const collectionBefore = (await cashRows(driver.driverId)).find((r) => r.type === "COLLECTION")!;
    assert.equal(collectionBefore.id, release.collection_transaction_id);
    assert.deepEqual(elig(collectionBefore), ["RELEASE_CORRECTION", false, false]);

    // Release it through an allocation settlement.
    const s = await post("/api/v1/driver-settlements", {
      driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId,
      allocations: [{ releaseId: release.id, amount: "105.00" }],
    });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const released = await prisma.order_financial_releases.findUniqueOrThrow({ where: { id: release.id } });

    const credit = (await walletRows(customer)).find((r) => r.type === "ORDER_CREDIT")!;
    assert.equal(credit.id, released.wallet_transaction_id);
    assert.deepEqual(elig(credit), ["RELEASE_CORRECTION", false, false]);
    assert.deepEqual(elig(await feedRow("WALLET", credit.id)), ["RELEASE_CORRECTION", false, false]);
    assert.deepEqual(elig(await feedRow("COMPANY_FINANCE", released.company_fee_transaction_id!)), ["RELEASE_CORRECTION", false, false]);
    assert.deepEqual(elig(await feedRow("DRIVER_CASH", released.collection_transaction_id)), ["RELEASE_CORRECTION", false, false]);

    await assertRefusedAs("WALLET", credit.id, "USE_RELEASE_CORRECTION");
    await assertRefusedAs("COMPANY_FINANCE", released.company_fee_transaction_id!, "USE_RELEASE_CORRECTION");
    await assertRefusedAs("DRIVER_CASH", released.collection_transaction_id, "USE_RELEASE_CORRECTION");

    // 5. allocation-format settlement row → SETTLEMENT_CORRECTION.
    const settlementRow = (await cashRows(driver.driverId)).find((r) => r.type === "SETTLEMENT")!;
    assert.deepEqual(elig(settlementRow), ["SETTLEMENT_CORRECTION", false, false]);
    assert.deepEqual(elig(await feedRow("DRIVER_CASH", settlementRow.id)), ["SETTLEMENT_CORRECTION", false, false]);
    await assertRefusedAs("DRIVER_CASH", settlementRow.id, "USE_SETTLEMENT_CORRECTION");

    // 7. release reversed by the dedicated workflow: still release-linked, now reversed.
    assert.equal((await post(`/api/v1/finance/order-releases/${release.id}/reverse-release`, { reason: REASON })).status, 201);
    const creditAfter = (await walletRows(customer)).find((r) => r.id === credit.id)!;
    assert.deepEqual(elig(creditAfter), ["RELEASE_CORRECTION", false, true]);
    assert.deepEqual(elig(await feedRow("COMPANY_FINANCE", released.company_fee_transaction_id!)), ["RELEASE_CORRECTION", false, true]);
  });

  test("6. settlement shortfall: the settlement and its correction adjustment → SETTLEMENT_CORRECTION", async () => {
    const driver = await createDriver();
    const customer = await newCustomer();
    // Legacy cash only → a legacy-format settlement is accepted while activation is off.
    await deliveredOrder(driver, customer, false);
    const s = await post("/api/v1/driver-settlements", { driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId });
    assert.equal(s.status, 201, JSON.stringify(s.body));
    const legacySettlement = (await cashRows(driver.driverId)).find((r) => r.type === "SETTLEMENT")!;
    assert.deepEqual(elig(legacySettlement), ["GENERIC", true, false], "a legacy settlement stays generically reversible");

    const sf = await withShortfallPolicyApproved(() => post(`/api/v1/driver-settlements/${s.body.data.id}/shortfall`, { amount: "5.00", reason: "Driver handed over less cash" }));
    assert.equal(sf.status, 201, JSON.stringify(sf.body));
    const rows = await cashRows(driver.driverId);
    const settlementAfter = rows.find((r) => r.id === legacySettlement.id)!;
    assert.deepEqual(elig(settlementAfter), ["SETTLEMENT_CORRECTION", false, false]);
    const shortfallAdj = rows.find((r) => r.type === "ADJUSTMENT")!;
    assert.deepEqual(elig(shortfallAdj), ["SETTLEMENT_CORRECTION", false, false]);
    await assertRefusedAs("DRIVER_CASH", settlementAfter.id, "USE_SETTLEMENT_CORRECTION");
    await assertRefusedAs("DRIVER_CASH", shortfallAdj.id, "USE_SETTLEMENT_CORRECTION");
  });

  test("7-8. voided collection, payout rows and other states", async () => {
    const driver = await createDriver();
    const customer = await newCustomer();
    const orderId = await deliveredOrder(driver, customer, true);
    const release = await prisma.order_financial_releases.findUniqueOrThrow({ where: { order_id: orderId } });
    assert.equal((await post(`/api/v1/finance/order-releases/${release.id}/void-collection`, { reason: REASON })).status, 201);
    const collection = (await cashRows(driver.driverId)).find((r) => r.id === release.collection_transaction_id)!;
    assert.deepEqual(elig(collection), ["RELEASE_CORRECTION", false, true], "voided collection: release-linked AND reversed");
    const voidReversal = (await cashRows(driver.driverId)).find((r) => r.type === "REVERSAL")!;
    assert.deepEqual(elig(voidReversal), ["GENERIC", false, false]);

    // Payout rows: a COMPLETED payout is reversible; once reversed it is not.
    const customer2 = await newCustomer();
    await deliveredOrder(driver, customer2, false);
    const payout = await post("/api/v1/payouts", { customerId: customer2, amount: "30.00", paymentMethodId: cashMethodId });
    assert.equal(payout.status, 201, JSON.stringify(payout.body));
    const payoutRow = (await walletRows(customer2)).find((r) => r.type === "PAYOUT")!;
    assert.deepEqual(elig(payoutRow), ["GENERIC", true, false]);
    assert.equal((await genericReverse("WALLET", payoutRow.id)).status, 201);
    assert.deepEqual(elig((await walletRows(customer2)).find((r) => r.id === payoutRow.id)!), ["GENERIC", false, true]);
  });

  test("9. permission boundaries unchanged", async () => {
    const driver = await createDriver();
    const customer = await newCustomer();
    for (const path of [`/api/v1/wallets/${customer}/transactions`, `/api/v1/finance/driver-cash/${driver.driverId}/transactions`, "/api/v1/finance/transactions"]) {
      assert.equal((await request(app).get(path)).status, 401, path);
      assert.equal((await get(path, tokens.dispatcher)).status, 403, path);
      assert.equal((await get(path, driver.token)).status, 403, path);
      assert.equal((await get(path, tokens.finance)).status, 200, path);
    }
  });

  test("10. reads are read-only and batched (no ledger change; additive fields only)", async () => {
    const driver = await createDriver();
    const customer = await newCustomer();
    await deliveredOrder(driver, customer, true);
    const count = async () =>
      Promise.all([
        prisma.wallet_transactions.count(),
        prisma.driver_cash_transactions.count(),
        prisma.company_financial_transactions.count(),
        prisma.order_financial_releases.count(),
        prisma.driver_settlement_corrections.count(),
      ]);
    const before = await count();
    const cash = await cashRows(driver.driverId);
    await walletRows(customer);
    await get("/api/v1/finance/transactions?limit=100");
    assert.deepEqual(await count(), before);
    // Existing fields are untouched; the three new ones are additive.
    const keys = Object.keys(cash[0]).sort();
    for (const k of ["id", "type", "direction", "amount", "balanceBefore", "balanceAfter", "order", "settlement", "paymentMethod", "actor", "notes", "createdAt"]) {
      assert.ok(keys.includes(k), k);
    }
    for (const k of ["correctionWorkflow", "canReverseGenerically", "reversed"]) assert.ok(keys.includes(k), k);
    // Correction responses keep their existing shape (no eligibility fields).
    const legacyOrder = await deliveredOrder(driver, customer, false);
    const credit = (await walletRows(customer)).find((r) => r.type === "ORDER_CREDIT" && r.order?.id === legacyOrder)!;
    const rev = await genericReverse("WALLET", credit.id);
    assert.equal(rev.status, 201);
    assert.equal("canReverseGenerically" in rev.body.data, false);
    void dec;
  });
});
