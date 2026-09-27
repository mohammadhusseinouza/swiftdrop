import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
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
// Configurable Direct Payment Settlement
//
// payment_methods.bypass_driver_cash decides, at delivery time, whether the
// money collected with the FINAL collection payment method enters the
// Driver's cash account (false — unchanged behavior) or is received directly
// by the company (true — company_direct_collections, never Driver Cash).
// Wallet / company-revenue ownership is identical on both routes.
//
// Every bypass-enabled method used here is created by this suite — the
// seeded CASH/WHISH rows are never mutated, so other suites are unaffected.
// ============================================================

describe("Direct Payment Settlement (bypass_driver_cash)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let tokens: Record<string, string>;

  let customerId: string;
  let area: { id: string; name: string };
  let cashMethodId: string;
  // Test-owned methods: DIRECT starts bypass-enabled, TOGGLE starts disabled.
  let directMethodId: string;
  let toggleMethodId: string;

  const createdOrderIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdMethodIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    const [a, d, f] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
    ]);
    tokens = { admin: a.accessToken as string, dispatcher: d.accessToken as string, finance: f.accessToken as string };

    customerId = await seedCustomerRecord(admin.id);
    area = await createTestArea();
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;
    // Sanity: the seeded CASH method keeps the standard driver-cash route.
    const cash = await prisma.payment_methods.findUniqueOrThrow({ where: { id: cashMethodId } });
    assert.equal(cash.bypass_driver_cash, false);

    directMethodId = await createMethodViaApi("DPS-WHISH", "DPS Whish", true);
    toggleMethodId = await createMethodViaApi("DPS-TOGGLE", "DPS Toggle", false);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    for (const id of createdMethodIds) {
      await prisma.audit_logs.deleteMany({ where: { entity_type: "PAYMENT_METHOD", entity_id: id } });
      await cleanupTestPaymentMethod(id);
    }
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    await Promise.all([admin, dispatcher, finance].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createMethodViaApi(codePrefix: string, name: string, bypassDriverCash?: boolean): Promise<string> {
    const res = await request(app)
      .post("/api/v1/settings/payment-methods")
      .set(auth(tokens.admin))
      .send({
        code: `${codePrefix}-${Math.random().toString(36).slice(2, 10)}`,
        name,
        ...(bypassDriverCash !== undefined ? { bypassDriverCash } : {}),
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdMethodIds.push(res.body.data.id);
    return res.body.data.id as string;
  }

  async function setBypass(methodId: string, bypassDriverCash: boolean) {
    const res = await request(app)
      .patch(`/api/v1/settings/payment-methods/${methodId}`)
      .set(auth(tokens.admin))
      .send({ bypassDriverCash });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.bypassDriverCash, bypassDriverCash);
  }

  async function createDriver() {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    const res = await request(app).post("/api/v1/drivers").set(auth(tokens.admin)).send({ userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, token: login.accessToken as string };
  }

  async function createOutForDeliveryOrder(
    driver: { driverId: string; token: string },
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const created = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "DPS Receiver",
        receiverPhone: "+96170000099",
        receiverAreaId: area.id,
        receiverAddress: "1 DPS St",
        description: "Direct payment settlement order",
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

  function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(token)).send(body);
  }

  async function ledgerRows(orderId: string) {
    const [cash, direct, wallet, company] = await Promise.all([
      prisma.driver_cash_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_direct_collections.findMany({ where: { order_id: orderId } }),
      prisma.wallet_transactions.findMany({ where: { order_id: orderId } }),
      prisma.company_financial_transactions.findMany({ where: { order_id: orderId }, orderBy: { type: "asc" } }),
    ]);
    return { cash, direct, wallet, company };
  }

  async function driverCashBalance(driverId: string): Promise<string> {
    const account = await prisma.driver_cash_accounts.findUnique({ where: { driver_id: driverId } });
    return (account?.current_balance ?? new Prisma.Decimal(0)).toString();
  }

  async function financeSummary() {
    const res = await request(app).get("/api/v1/finance/summary").set(auth(tokens.finance));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.data as { totalCollected: string; driverCollected: string; directCompanyCollected: string; driverCashOutstanding: string };
  }

  const dec = (v: string) => new Prisma.Decimal(v);

  // ============================================================
  // Settings configuration
  // ============================================================

  describe("Payment method configuration", () => {
    test("1. bypass_driver_cash is NOT NULL DEFAULT false; a method created without it defaults to false", async () => {
      const cols = await prisma.$queryRaw<{ is_nullable: string; column_default: string | null }[]>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'payment_methods' AND column_name = 'bypass_driver_cash'
      `;
      assert.equal(cols.length, 1);
      assert.equal(cols[0].is_nullable, "NO");
      assert.equal(cols[0].column_default, "false");

      const id = await createMethodViaApi("DPS-DEFAULT", "DPS Default");
      const row = await prisma.payment_methods.findUniqueOrThrow({ where: { id } });
      assert.equal(row.bypass_driver_cash, false);

      const list = await request(app).get("/api/v1/settings/payment-methods").set(auth(tokens.admin));
      assert.equal(list.status, 200);
      for (const m of list.body.data) assert.equal(typeof m.bypassDriverCash, "boolean");
    });

    test("2. an authorized user can enable/disable it on an existing method, and the change is audited", async () => {
      const id = await createMethodViaApi("DPS-EDIT", "DPS Edit");
      await setBypass(id, true);
      assert.equal((await prisma.payment_methods.findUniqueOrThrow({ where: { id } })).bypass_driver_cash, true);

      const audit = await prisma.audit_logs.findFirst({
        where: { entity_type: "PAYMENT_METHOD", entity_id: id, action: "PAYMENT_METHOD_UPDATED" },
      });
      assert.ok(audit, "toggling bypass must be audited");
      assert.deepEqual(audit!.previous_values, { bypassDriverCash: false });
      assert.deepEqual(audit!.new_values, { bypassDriverCash: true });

      await setBypass(id, false);
      assert.equal((await prisma.payment_methods.findUniqueOrThrow({ where: { id } })).bypass_driver_cash, false);
    });

    test("15. unauthorized roles cannot modify the setting", async () => {
      const driver = await createDriver();
      for (const token of [tokens.dispatcher, tokens.finance, driver.token]) {
        const res = await request(app)
          .patch(`/api/v1/settings/payment-methods/${toggleMethodId}`)
          .set(auth(token))
          .send({ bypassDriverCash: true });
        assert.equal(res.status, 403, JSON.stringify(res.body));
      }
      const noAuth = await request(app).patch(`/api/v1/settings/payment-methods/${toggleMethodId}`).send({ bypassDriverCash: true });
      assert.equal(noAuth.status, 401);
      assert.equal((await prisma.payment_methods.findUniqueOrThrow({ where: { id: toggleMethodId } })).bypass_driver_cash, false);
    });

    test("14a. a non-boolean bypassDriverCash is rejected", async () => {
      const res = await request(app)
        .patch(`/api/v1/settings/payment-methods/${toggleMethodId}`)
        .set(auth(tokens.admin))
        .send({ bypassDriverCash: "yes" });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
    });

    test("the Driver-safe payment-method list does not expose Management settings", async () => {
      const driver = await createDriver();
      const res = await request(app).get("/api/v1/driver/payment-methods").set(auth(driver.token));
      assert.equal(res.status, 200);
      for (const m of res.body.data) assert.deepEqual(Object.keys(m).sort(), ["code", "id", "name"]);
    });
  });

  // ============================================================
  // Delivery routing
  // ============================================================

  describe("Delivery routing", () => {
    test("3. Cash (bypass disabled) credits driver cash exactly as before", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const { cash, direct, wallet, company } = await ledgerRows(orderId);
      assert.equal(cash.length, 1);
      assert.equal(cash[0].type, "COLLECTION");
      assert.equal(cash[0].amount.toString(), "105");
      assert.equal(direct.length, 0);
      assert.equal(wallet.length, 1);
      assert.equal(wallet[0].credit.toString(), "100");
      assert.equal(company.length, 1);
      assert.equal(company[0].amount.toString(), "5");
      assert.equal(await driverCashBalance(driver.driverId), "105");

      const audit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_type: "ORDER", entity_id: orderId, action: "DELIVERY_ONLY_FINANCE_FINALIZED" },
      });
      const md = audit.metadata as Record<string, unknown>;
      assert.equal(md.collectionRoute, "DRIVER_CASH");
      assert.equal(md.directCompanyCollectionId, null);
    });

    test("4/5. DELIVERY_ONLY with a bypass method: wallet $100 + fee revenue $5, driver cash $0, direct collection $105", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");

      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.financial_status, "FINALIZED");
      assert.equal(order.actual_amount_collected?.toString(), "105");
      assert.equal(order.collection_payment_method_id, directMethodId);

      const { cash, direct, wallet, company } = await ledgerRows(orderId);
      assert.equal(cash.length, 0, "a bypass collection never touches Driver Cash");
      assert.equal(await driverCashBalance(driver.driverId), "0");
      assert.equal(direct.length, 1);
      assert.equal(direct[0].amount.toString(), "105");
      assert.equal(direct[0].payment_method_id, directMethodId);
      assert.equal(direct[0].driver_id, driver.driverId);
      assert.equal(direct[0].idempotency_key, `delivery:${orderId}:direct-company-collection`);
      assert.equal(wallet.length, 1);
      assert.equal(wallet[0].type, "ORDER_CREDIT");
      assert.equal(wallet[0].credit.toString(), "100");
      assert.equal(company.length, 1);
      assert.equal(company[0].type, "DELIVERY_FEE_REVENUE");
      assert.equal(company[0].amount.toString(), "5");
      assert.equal(company[0].payment_method_id, directMethodId);

      const audit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_type: "ORDER", entity_id: orderId, action: "DELIVERY_ONLY_FINANCE_FINALIZED" },
      });
      const md = audit.metadata as Record<string, unknown>;
      assert.equal(md.collectionRoute, "DIRECT_COMPANY");
      assert.equal(md.directCompanyCollectionId, direct[0].id);
      assert.equal(md.driverCashTransactionId, null);

      // Order Detail surfaces the direct collection as its own ledger event.
      const detail = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      const events = detail.body.data.financialEvents as { ledger: string; type: string; amount: string }[];
      assert.deepEqual(
        events.map((e) => e.ledger).sort(),
        ["COMPANY_FINANCE", "DIRECT_COMPANY_COLLECTION", "WALLET"]
      );
      assert.equal(events.find((e) => e.ledger === "DIRECT_COMPANY_COLLECTION")!.amount, "105");
      assert.equal(detail.body.data.financialAllocation.customerWalletAmount, "100");
      assert.equal(detail.body.data.financialAllocation.companyAmount, "5");
    });

    test("6. COMPANY_ORDER with a bypass method: product + fee revenue, no wallet, no driver cash, direct collection", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, {
        orderType: "COMPANY_ORDER",
        collectionPaymentMethodId: directMethodId,
      });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const { cash, direct, wallet, company } = await ledgerRows(orderId);
      assert.equal(cash.length, 0);
      assert.equal(await driverCashBalance(driver.driverId), "0");
      assert.equal(wallet.length, 0, "a Company Order never credits a customer wallet");
      assert.equal(direct.length, 1);
      assert.equal(direct[0].amount.toString(), "105");
      assert.deepEqual(
        company.map((c) => [c.type, c.amount.toString()]).sort(),
        [
          ["COMPANY_ORDER_PRODUCT_REVENUE", "100"],
          ["DELIVERY_FEE_REVENUE", "5"],
        ]
      );
      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.financial_status, "FINALIZED");
    });

    test("6b. COMPANY_ORDER with Cash keeps the historical driver-cash behavior", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { orderType: "COMPANY_ORDER" });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const { cash, direct, wallet, company } = await ledgerRows(orderId);
      assert.equal(cash.length, 1);
      assert.equal(direct.length, 0);
      assert.equal(wallet.length, 0);
      assert.equal(company.length, 2);
      assert.equal(await driverCashBalance(driver.driverId), "105");
    });

    test("7. driver changes Cash -> bypass method at confirmation: order method updated, collection bypasses driver cash", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: cashMethodId });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00", paymentMethodId: directMethodId });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.collection.paymentMethod.id, directMethodId);

      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.collection_payment_method_id, directMethodId);
      const { cash, direct, company } = await ledgerRows(orderId);
      assert.equal(cash.length, 0);
      assert.equal(direct.length, 1);
      assert.equal(direct[0].payment_method_id, directMethodId);
      // Revenue carries the FINAL (driver-corrected) method, not the original.
      assert.equal(company[0].payment_method_id, directMethodId);
      assert.equal(await driverCashBalance(driver.driverId), "0");

      const audit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_type: "ORDER", entity_id: orderId, action: "DELIVERY_ONLY_FINANCE_FINALIZED" },
      });
      const md = audit.metadata as Record<string, unknown>;
      assert.equal(md.collectionPaymentMethodChanged, true);
      assert.equal(md.previousCollectionPaymentMethodId, cashMethodId);
      assert.equal(md.newCollectionPaymentMethodId, directMethodId);
      assert.equal(md.collectionRoute, "DIRECT_COMPANY");
    });

    test("8. driver changes bypass method -> Cash at confirmation: standard driver-cash flow applies", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.collection_payment_method_id, cashMethodId);
      const { cash, direct } = await ledgerRows(orderId);
      assert.equal(cash.length, 1);
      assert.equal(cash[0].amount.toString(), "105");
      assert.equal(direct.length, 0);
      assert.equal(await driverCashBalance(driver.driverId), "105");
    });

    test("14b. an invalid payment method at confirmation is rejected and nothing is posted", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver);
      const res = await deliver(orderId, driver.token, {
        actualAmountCollected: "105.00",
        paymentMethodId: "00000000-0000-0000-0000-000000000000",
      });
      assert.equal(res.status, 400);
      const { cash, direct, wallet, company } = await ledgerRows(orderId);
      assert.equal(cash.length + direct.length + wallet.length + company.length, 0);
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).status, "OUT_FOR_DELIVERY");
    });
  });

  // ============================================================
  // Historical integrity
  // ============================================================

  describe("Historical integrity", () => {
    test("9. toggling the setting never rewrites completed deliveries — it only affects future ones", async () => {
      const driver = await createDriver();

      // (a) delivered while bypass is DISABLED -> driver cash
      const before = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: toggleMethodId });
      assert.equal((await deliver(before, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      assert.equal(await driverCashBalance(driver.driverId), "105");

      await setBypass(toggleMethodId, true);

      // The completed delivery is untouched: still driver cash, no direct row.
      let rows = await ledgerRows(before);
      assert.equal(rows.cash.length, 1);
      assert.equal(rows.direct.length, 0);
      assert.equal(await driverCashBalance(driver.driverId), "105");

      // (b) a NEW delivery with the same method now bypasses
      const afterEnable = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: toggleMethodId });
      assert.equal((await deliver(afterEnable, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      rows = await ledgerRows(afterEnable);
      assert.equal(rows.cash.length, 0);
      assert.equal(rows.direct.length, 1);
      assert.equal(await driverCashBalance(driver.driverId), "105");

      await setBypass(toggleMethodId, false);

      // (c) disabling again never converts the direct collection into driver cash
      rows = await ledgerRows(afterEnable);
      assert.equal(rows.cash.length, 0);
      assert.equal(rows.direct.length, 1);
      assert.equal(await driverCashBalance(driver.driverId), "105");
      rows = await ledgerRows(before);
      assert.equal(rows.cash.length, 1);
      assert.equal(rows.direct.length, 0);
    });
  });

  // ============================================================
  // Settlements + reporting
  // ============================================================

  describe("Settlements and reporting", () => {
    test("10. a direct collection creates no outstanding driver settlement obligation", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);

      assert.equal(await driverCashBalance(driver.driverId), "0");
      const cashRes = await request(app).get(`/api/v1/finance/driver-cash/${driver.driverId}`).set(auth(tokens.finance));
      assert.equal(cashRes.status, 200, JSON.stringify(cashRes.body));
      assert.equal(dec(cashRes.body.data.currentBalance).toString(), "0");

      const settle = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set("Idempotency-Key", `dps-settle-${driver.driverId}`)
        .send({ driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId });
      assert.equal(settle.status, 400, "the Driver never held the money — nothing to settle");
      assert.match(settle.body.error.message, /Insufficient driver cash balance/);
      assert.equal(await prisma.driver_settlements.count({ where: { driver_id: driver.driverId } }), 0);
    });

    test("11. direct collections are visible in finance summary, finance report and dashboard without inflating driver cash", async () => {
      const driver = await createDriver();
      const s0 = await financeSummary();

      const directOrder = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      assert.equal((await deliver(directOrder, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const cashOrder = await createOutForDeliveryOrder(driver);
      assert.equal((await deliver(cashOrder, driver.token, { actualAmountCollected: "105.00" })).status, 200);

      const s1 = await financeSummary();
      assert.equal(dec(s1.directCompanyCollected).minus(s0.directCompanyCollected).toString(), "105");
      assert.equal(dec(s1.driverCollected).minus(s0.driverCollected).toString(), "105");
      assert.equal(dec(s1.totalCollected).minus(s0.totalCollected).toString(), "210");
      assert.equal(dec(s1.totalCollected).toString(), dec(s1.driverCollected).plus(s1.directCompanyCollected).toString());
      assert.equal(dec(s1.driverCashOutstanding).minus(s0.driverCashOutstanding).toString(), "105", "only the driver-held collection is outstanding");

      const report = await request(app).get("/api/v1/reports/finance?groupBy=category").set(auth(tokens.admin));
      assert.equal(report.status, 200, JSON.stringify(report.body));
      assert.equal(report.body.data.summary.directCompanyCollected, s1.directCompanyCollected);
      assert.equal(report.body.data.summary.driverCollected, s1.driverCollected);
      assert.equal(report.body.data.summary.totalCollected, s1.totalCollected);
      const direct = report.body.data.rows.find((r: { category: string }) => r.category === "DIRECT_COMPANY_COLLECTED");
      assert.equal(direct.amount, s1.directCompanyCollected);

      const dash = await request(app).get("/api/v1/dashboard").set(auth(tokens.admin));
      assert.equal(dash.status, 200);
      assert.equal(dash.body.data.finance.directCompanyCollected, s1.directCompanyCollected);
      assert.equal(dash.body.data.finance.totalCollected, s1.totalCollected);
    });
  });

  // ============================================================
  // Collection difference + zero collection
  // ============================================================

  describe("Collection differences and zero collection", () => {
    test("12. a bypass difference records the actual amount as a direct collection, stays REVIEW_REQUIRED, and resolves without touching driver cash", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });

      const missingReason = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(missingReason.status, 400);

      const res = await deliver(orderId, driver.token, {
        actualAmountCollected: "100.00",
        collectionDifferenceReason: "Receiver transferred only $100",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const order = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(order.financial_status, "REVIEW_REQUIRED");
      assert.equal(order.needs_financial_review, true);
      let rows = await ledgerRows(orderId);
      assert.equal(rows.cash.length, 0);
      assert.equal(rows.direct.length, 1);
      assert.equal(rows.direct[0].amount.toString(), "100");
      assert.equal(rows.wallet.length, 0, "no split is guessed");
      assert.equal(rows.company.length, 0, "no split is guessed");

      const audit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_type: "ORDER", entity_id: orderId, action: "COLLECTION_DIFFERENCE_RECORDED" },
      });
      assert.equal((audit.metadata as Record<string, unknown>).collectionRoute, "DIRECT_COMPANY");

      const resolve = await request(app)
        .post(`/api/v1/orders/${orderId}/resolve-collection-difference`)
        .set(auth(tokens.finance))
        .send({
          customerWalletCredit: "95.00",
          companyProductRevenue: "0",
          companyDeliveryFeeRevenue: "5.00",
          resolutionNotes: "Agreed split",
        });
      assert.equal(resolve.status, 200, JSON.stringify(resolve.body));

      rows = await ledgerRows(orderId);
      assert.equal(rows.cash.length, 0, "resolution never creates a driver cash balance");
      assert.equal(rows.direct.length, 1, "resolution never re-posts the collection");
      assert.equal(rows.wallet[0].credit.toString(), "95");
      assert.equal(rows.company[0].amount.toString(), "5");
      assert.equal(await driverCashBalance(driver.driverId), "0");
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).financial_status, "FINALIZED");
    });

    test("12b. a Cash difference is unchanged: actual amount enters driver cash, REVIEW_REQUIRED", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver);
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "110.00", collectionDifferenceReason: "Tip included" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const rows = await ledgerRows(orderId);
      assert.equal(rows.cash.length, 1);
      assert.equal(rows.cash[0].amount.toString(), "110");
      assert.equal(rows.direct.length, 0);
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).financial_status, "REVIEW_REQUIRED");
    });

    test("13. zero collection posts neither a direct collection nor driver cash", async () => {
      const driver = await createDriver();
      // Nothing to collect -> Create Order forbids a collection method, so
      // the route is NONE regardless of any bypass configuration.
      const exactZero = await createOutForDeliveryOrder(driver, {
        orderAmount: "0",
        deliveryFee: "0",
        collectionPaymentMethodId: undefined,
      });
      const res = await deliver(exactZero, driver.token, { actualAmountCollected: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      let rows = await ledgerRows(exactZero);
      assert.equal(rows.cash.length + rows.direct.length + rows.wallet.length + rows.company.length, 0);
      assert.equal((await prisma.orders.findUniqueOrThrow({ where: { id: exactZero } })).financial_status, "FINALIZED");

      // Expected 105 but nothing collected: a difference with zero actual.
      const nothingCollected = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      const res2 = await deliver(nothingCollected, driver.token, {
        actualAmountCollected: "0",
        collectionDifferenceReason: "Receiver will transfer later",
      });
      assert.equal(res2.status, 200, JSON.stringify(res2.body));
      rows = await ledgerRows(nothingCollected);
      assert.equal(rows.cash.length + rows.direct.length, 0);
      const audit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_type: "ORDER", entity_id: nothingCollected, action: "COLLECTION_DIFFERENCE_RECORDED" },
      });
      assert.equal((audit.metadata as Record<string, unknown>).collectionRoute, "NONE");
      assert.equal(await driverCashBalance(driver.driverId), "0");
    });
  });

  // ============================================================
  // Idempotency / concurrency
  // ============================================================

  describe("Duplicate protection", () => {
    test("16. concurrent and repeated delivery completion cannot double-post a direct collection", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });

      const results = await Promise.all([
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
      ]);
      const statuses = results.map((r) => r.status);
      assert.equal(statuses.filter((s) => s === 200).length, 1, `exactly one completion wins: ${statuses.join(",")}`);
      for (const s of statuses.filter((s) => s !== 200)) assert.ok(s === 409 || s === 400, `loser status ${s}`);

      const replay = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(replay.status, 400);

      const rows = await ledgerRows(orderId);
      assert.equal(rows.direct.length, 1);
      assert.equal(rows.cash.length, 0);
      assert.equal(rows.wallet.length, 1);
      assert.equal(rows.company.length, 1);
      assert.equal(await prisma.delivery_attempts.count({ where: { order_id: orderId, outcome: "DELIVERED" } }), 1);
    });

    test("16b. the direct-collection idempotency key is enforced by the database", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      await assert.rejects(
        prisma.company_direct_collections.create({
          data: {
            order_id: orderId,
            payment_method_id: directMethodId,
            amount: new Prisma.Decimal("105"),
            idempotency_key: `delivery:${orderId}:direct-company-collection`,
          },
        })
      );
      await assert.rejects(
        prisma.company_direct_collections.create({
          data: { order_id: orderId, payment_method_id: directMethodId, amount: new Prisma.Decimal("0") },
        }),
        "CHECK (amount > 0) must reject a zero direct collection"
      );
    });
  });

  // ============================================================
  // Reporting integration — Drivers report + Finance transactions feed
  // ============================================================

  describe("Reporting integration", () => {
    const today = new Date().toISOString().slice(0, 10);
    const PAST = "from=2001-01-01&to=2001-01-02";

    async function driverReportRow(driverId: string, qs = "") {
      const res = await request(app)
        .get(`/api/v1/reports/drivers?driverId=${driverId}${qs ? `&${qs}` : ""}`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.rows.length, 1);
      return res.body.data.rows[0];
    }

    function feed(qs: string, token = tokens.finance) {
      return request(app).get(`/api/v1/finance/transactions?${qs}`).set(auth(token));
    }

    test("R1-R4. drivers report splits driver-cash vs direct collections per driver, totals without double counting, and never inflates cash held", async () => {
      const driverA = await createDriver();
      const driverB = await createDriver();

      const cashOrder = await createOutForDeliveryOrder(driverA);
      assert.equal((await deliver(cashOrder, driverA.token, { actualAmountCollected: "105.00" })).status, 200);
      const directA = await createOutForDeliveryOrder(driverA, { collectionPaymentMethodId: directMethodId });
      assert.equal((await deliver(directA, driverA.token, { actualAmountCollected: "105.00" })).status, 200);
      const directB = await createOutForDeliveryOrder(driverB, {
        collectionPaymentMethodId: directMethodId,
        orderAmount: "45.00",
      });
      assert.equal((await deliver(directB, driverB.token, { actualAmountCollected: "50.00" })).status, 200);

      const a = await driverReportRow(driverA.driverId);
      assert.equal(a.driverCashCollected, "105");
      assert.equal(a.directCompanyCollected, "105");
      assert.equal(a.totalCollected, "210");
      assert.equal(a.moneyCollected, "105", "deprecated alias keeps its driver-cash meaning");
      assert.equal(a.currentCashHeld, "105", "direct collections never increase cash held");
      assert.equal(a.ordersDelivered, 2);

      // Attributed to the driver who completed the delivery — B's direct
      // collection never lands on A, and vice versa.
      const b = await driverReportRow(driverB.driverId);
      assert.equal(b.driverCashCollected, "0");
      assert.equal(b.directCompanyCollected, "50");
      assert.equal(b.totalCollected, "50");
      assert.equal(b.currentCashHeld, "0");
      assert.equal(b.settlementAmount, "0");

      // Date filters still apply to both routes.
      const inRange = await driverReportRow(driverA.driverId, `from=${today}&to=${today}`);
      assert.equal(inRange.totalCollected, "210");
      const past = await driverReportRow(driverA.driverId, PAST);
      assert.equal(past.driverCashCollected, "0");
      assert.equal(past.directCompanyCollected, "0");
      assert.equal(past.totalCollected, "0");
    });

    test("R5. the finance feed lists direct collections as read-only DIRECT_COMPANY_COLLECTION entries with order, driver, amount, method and route", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const direct = await prisma.company_direct_collections.findFirstOrThrow({ where: { order_id: orderId } });

      const res = await feed(`ledger=DIRECT_COMPANY_COLLECTION&from=${today}&to=${today}&limit=100`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const entry = res.body.data.find((e: { id: string }) => e.id === direct.id);
      assert.ok(entry, "the direct collection must be in the feed");
      assert.equal(entry.ledger, "DIRECT_COMPANY_COLLECTION");
      assert.equal(entry.type, "DIRECT_COMPANY_COLLECTION");
      assert.equal(entry.direction, "CREDIT");
      assert.equal(entry.amount, "105");
      assert.equal(entry.collectionRoute, "DIRECT_COMPANY");
      assert.equal(entry.balanceBefore, null);
      assert.equal(entry.balanceAfter, null);
      assert.equal(entry.order.id, orderId);
      assert.equal(entry.driver.id, driver.driverId);
      assert.equal(entry.paymentMethod.id, directMethodId);
      assert.equal(entry.settlement, null);
      assert.equal(entry.reversalOf, null);
      for (const e of res.body.data) assert.equal(e.ledger, "DIRECT_COMPANY_COLLECTION");

      // A plain type filter (no ledger) returns only direct collections.
      const byType = await feed(`type=DIRECT_COMPANY_COLLECTION&from=${today}&to=${today}&limit=100`);
      assert.equal(byType.status, 200);
      assert.ok(byType.body.data.some((e: { id: string }) => e.id === direct.id));
      for (const e of byType.body.data) assert.equal(e.ledger, "DIRECT_COMPANY_COLLECTION");

      // A type that does not belong to the ledger is rejected, as for every ledger.
      const mismatch = await feed("ledger=DRIVER_CASH&type=DIRECT_COMPANY_COLLECTION");
      assert.equal(mismatch.status, 400);

      // Collection vs revenue: in the unfiltered feed this order carries the
      // $105 collection plus only its real revenue rows — never a second
      // $105 revenue entry.
      const all = await feed(`from=${today}&to=${today}&limit=100`);
      assert.equal(all.status, 200);
      const forOrder = all.body.data.filter((e: { order: { id: string } | null }) => e.order?.id === orderId);
      const byLedger = (l: string) => forOrder.filter((e: { ledger: string }) => e.ledger === l);
      assert.equal(byLedger("DIRECT_COMPANY_COLLECTION").length, 1);
      assert.equal(byLedger("DRIVER_CASH").length, 0);
      assert.deepEqual(byLedger("COMPANY_FINANCE").map((e: { type: string; amount: string }) => [e.type, e.amount]), [["DELIVERY_FEE_REVENUE", "5"]]);
      assert.deepEqual(byLedger("WALLET").map((e: { type: string; amount: string }) => [e.type, e.amount]), [["ORDER_CREDIT", "100"]]);

      // A driver-cash collection is labelled with the DRIVER_CASH route.
      const cashOrder = await createOutForDeliveryOrder(driver);
      assert.equal((await deliver(cashOrder, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const cashFeed = await feed(`ledger=DRIVER_CASH&type=COLLECTION&from=${today}&to=${today}&limit=100`);
      const cashEntry = cashFeed.body.data.find((e: { order: { id: string } | null }) => e.order?.id === cashOrder);
      assert.equal(cashEntry.collectionRoute, "DRIVER_CASH");
    });

    test("R6. date filters and pagination stay globally correct with direct collections in the feed", async () => {
      const driver = await createDriver();
      for (let i = 0; i < 3; i++) {
        const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
        assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      }
      const qs = `ledger=DIRECT_COMPANY_COLLECTION&from=${today}&to=${today}`;
      const expectedTotal = await prisma.company_direct_collections.count({
        where: { created_at: { gte: new Date(`${today}T00:00:00.000Z`) } },
      });

      const page1 = await feed(`${qs}&limit=2&page=1`);
      const page2 = await feed(`${qs}&limit=2&page=2`);
      assert.equal(page1.status, 200);
      assert.equal(page1.body.meta.total, expectedTotal);
      assert.equal(page1.body.meta.totalPages, Math.ceil(expectedTotal / 2));
      assert.equal(page1.body.data.length, 2);
      const ids1 = page1.body.data.map((e: { id: string }) => e.id);
      const ids2 = page2.body.data.map((e: { id: string }) => e.id);
      for (const id of ids2) assert.ok(!ids1.includes(id), "pages never overlap");
      const t = page1.body.data.map((e: { createdAt: string }) => e.createdAt);
      assert.ok(t[0] >= t[1], "newest first");

      const past = await feed(`ledger=DIRECT_COMPANY_COLLECTION&${PAST}`);
      assert.equal(past.status, 200);
      assert.equal(past.body.meta.total, 0);

      // The unfiltered total counts every source exactly once.
      const unfilteredTotal = (await feed(`from=${today}&to=${today}&limit=1`)).body.meta.total;
      const since = { gte: new Date(`${today}T00:00:00.000Z`) };
      const [w, c, f, d] = await Promise.all([
        prisma.wallet_transactions.count({ where: { created_at: since } }),
        prisma.driver_cash_transactions.count({ where: { created_at: since } }),
        prisma.company_financial_transactions.count({ where: { created_at: since } }),
        prisma.company_direct_collections.count({ where: { created_at: since } }),
      ]);
      assert.equal(unfilteredTotal, w + c + f + d);
    });

    test("R7. financial permissions remain enforced", async () => {
      const driver = await createDriver();
      assert.equal((await feed("ledger=DIRECT_COMPANY_COLLECTION", tokens.dispatcher)).status, 403);
      assert.equal((await feed("ledger=DIRECT_COMPANY_COLLECTION", driver.token)).status, 403);
      assert.equal((await request(app).get("/api/v1/finance/transactions?ledger=DIRECT_COMPANY_COLLECTION")).status, 401);
      assert.equal((await feed("ledger=DIRECT_COMPANY_COLLECTION", tokens.admin)).status, 200);
      assert.equal(
        (await request(app).get(`/api/v1/reports/drivers?driverId=${driver.driverId}`).set(auth(driver.token))).status,
        403
      );
    });

    test("R8. direct collections are not correctable as driver cash or company-finance rows, and settlement/revenue behavior is unchanged", async () => {
      const driver = await createDriver();
      const orderId = await createOutForDeliveryOrder(driver, { collectionPaymentMethodId: directMethodId });
      assert.equal((await deliver(orderId, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const direct = await prisma.company_direct_collections.findFirstOrThrow({ where: { order_id: orderId } });

      for (const path of [
        `/api/v1/finance/driver-cash-transactions/${direct.id}/reverse`,
        `/api/v1/finance/company-transactions/${direct.id}/reverse`,
      ]) {
        const res = await request(app).post(path).set(auth(tokens.admin)).send({ reason: "should not be possible" });
        assert.equal(res.status, 404, `${path}: ${JSON.stringify(res.body)}`);
      }
      assert.equal(await prisma.company_direct_collections.count({ where: { order_id: orderId } }), 1);

      // Revenue for the order is exactly the fee; driver cash untouched.
      const company = await prisma.company_financial_transactions.findMany({ where: { order_id: orderId } });
      assert.deepEqual(company.map((c) => [c.type, c.amount.toString()]), [["DELIVERY_FEE_REVENUE", "5"]]);
      assert.equal(await driverCashBalance(driver.driverId), "0");

      // A normal Cash delivery still settles exactly as before.
      const cashOrder = await createOutForDeliveryOrder(driver);
      assert.equal((await deliver(cashOrder, driver.token, { actualAmountCollected: "105.00" })).status, 200);
      const settle = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set("Idempotency-Key", `dps-settle-ok-${driver.driverId}`)
        .send({ driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId });
      assert.equal(settle.status, 201, JSON.stringify(settle.body));
      assert.equal(await driverCashBalance(driver.driverId), "0");
      const row = await driverReportRow(driver.driverId);
      assert.equal(row.settlementAmount, "105");
      assert.equal(row.totalCollected, "210");
      assert.equal(row.currentCashHeld, "0");
    });
  });
});
