import "../helpers/setup";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { runWalletTransaction } from "../../src/modules/wallets/wallet-ledger.service";
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
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// GET /api/v1/finance/transactions (Phase 9.2)
//
// A unified, GLOBALLY paginated feed over the three ledgers. Global-
// pagination tests below use dedicated, test-owned historical UTC dates
// (year 2001, distinct months per test to avoid cross-test interleaving)
// so ordering/pagination assertions are deterministic under full-suite
// parallelism, per the same test strategy established in
// finance-summary.test.ts.
// ============================================================

describe("Finance Transactions (Phase 9.2)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let dispatcher: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdCompanyTransactionIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");
    dispatcher = await createTestUser("DISPATCHER");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, financeLogin, dispatcherLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, driverActor.email, driverActor.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      driver: driverLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await prisma.company_financial_transactions.deleteMany({ where: { reversal_of_id: { in: createdCompanyTransactionIds } } });
    await prisma.company_financial_transactions.deleteMany({ where: { id: { in: createdCompanyTransactionIds } } });
    await Promise.all([admin, finance, dispatcher, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function idemHeader() {
    return { "Idempotency-Key": randomUUID() };
  }

  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function freshCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function fundWallet(customerId: string, amount: string) {
    await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal(amount) });
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH92TX-DRV-${uniqueSuffix()}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  async function createBaseOrder(customerId: string, overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase92tx Receiver",
        receiverPhone: "+96170000093",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase92tx St",
        description: "Phase92 finance transactions order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  async function createOutForDeliveryOrder(customerId: string, driverToken: string, driverId: string, overrides: Record<string, unknown> = {}) {
    const order = await createBaseOrder(customerId, overrides);
    const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId });
    assert.equal(assign.status, 200, JSON.stringify(assign.body));
    const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driverToken)).send();
    assert.equal(pickup.status, 200, JSON.stringify(pickup.body));
    const start = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driverToken)).send();
    assert.equal(start.status, 200, JSON.stringify(start.body));
    return order.id as string;
  }

  async function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/driver/orders/${orderId}/deliver`).set(auth(token)).send(body);
  }

  function txPath(qs = "") {
    return `/api/v1/finance/transactions${qs}`;
  }

  async function getTx(token: string, qs = "") {
    return request(app).get(txPath(qs)).set(auth(token));
  }

  async function backdate(model: "wallet_transactions" | "driver_cash_transactions" | "company_financial_transactions", id: string, date: Date) {
    await (prisma[model] as { update: (args: unknown) => Promise<unknown> }).update({ where: { id }, data: { created_at: date } });
  }

  // ============================================================
  // RBAC (1-6)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated -> 401", async () => {
      const res = await request(app).get(txPath());
      assert.equal(res.status, 401);
    });

    test("2. ADMIN -> 200", async () => {
      const res = await getTx(tokens.admin, "?limit=1");
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. FINANCE -> 200", async () => {
      const res = await getTx(tokens.finance, "?limit=1");
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("4. DISPATCHER -> 403", async () => {
      const res = await getTx(tokens.dispatcher);
      assert.equal(res.status, 403);
    });

    test("5. DRIVER -> 403", async () => {
      const res = await getTx(tokens.driver);
      assert.equal(res.status, 403);
    });

    test("6. CUSTOMER -> 403", async () => {
      const res = await getTx(tokens.customer);
      assert.equal(res.status, 403);
    });
  });

  // ============================================================
  // VALIDATION (7-13)
  // ============================================================

  describe("Query validation", () => {
    test("7. limit > 100 -> 400", async () => {
      const res = await getTx(tokens.admin, "?limit=101");
      assert.equal(res.status, 400);
    });

    test("8. page < 1 -> 400", async () => {
      const res = await getTx(tokens.admin, "?page=0");
      assert.equal(res.status, 400);
    });

    test("9. malformed date -> 400", async () => {
      const res = await getTx(tokens.admin, "?from=not-a-date");
      assert.equal(res.status, 400);
    });

    test("10. from > to -> 400", async () => {
      const res = await getTx(tokens.admin, "?from=2026-08-31&to=2026-08-01");
      assert.equal(res.status, 400);
    });

    test("11. invalid type -> 400", async () => {
      const res = await getTx(tokens.admin, "?type=NOT_A_TYPE");
      assert.equal(res.status, 400);
    });

    test("12. invalid ledger -> 400", async () => {
      const res = await getTx(tokens.admin, "?ledger=NOT_A_LEDGER");
      assert.equal(res.status, 400);
    });

    test("13. ledger/type mismatch -> 400 (WALLET + COLLECTION)", async () => {
      const res = await getTx(tokens.admin, "?ledger=WALLET&type=COLLECTION");
      assert.equal(res.status, 400);
    });
  });

  // ============================================================
  // UNIFIED FEED (14-20)
  // ============================================================

  describe("Unified feed", () => {
    test("14-20. one real event per category appears exactly once, never duplicated as a business row", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "500");
      const driver = await createDriverWithToken("unified");

      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderAmount: "95.00", deliveryFee: "5.00" });
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));

      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driver.driverId, amountReceived: "50.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));

      const companyAdjustRes = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "7.00", reason: "phase92tx unified feed" });
      assert.equal(companyAdjustRes.status, 201, JSON.stringify(companyAdjustRes.body));
      createdCompanyTransactionIds.push(companyAdjustRes.body.data.id);

      const orderCreditTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "ORDER_CREDIT" } });
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });

      const reverseFee = await request(app)
        .post(`/api/v1/finance/company-transactions/${feeTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase92tx unified feed reversal" });
      assert.equal(reverseFee.status, 201, JSON.stringify(reverseFee.body));

      const res = await getTx(tokens.admin, `?limit=100`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const ids = new Set(res.body.data.map((t: { id: string }) => t.id));

      assert.ok(ids.has(orderCreditTx.id), "Wallet ORDER_CREDIT present"); // 14
      assert.ok(ids.has(payoutTx.id), "Wallet PAYOUT present"); // 15
      assert.ok(ids.has(collectionTx.id), "Driver COLLECTION present"); // 16
      assert.ok(ids.has(settlementTx.id), "Driver SETTLEMENT present"); // 17
      assert.ok(ids.has(feeTx.id), "Company DELIVERY_FEE_REVENUE present"); // 18
      assert.ok(ids.has(companyAdjustRes.body.data.id), "Company ADJUSTMENT present"); // 19

      // No duplicate business-event row: the payout/settlement themselves
      // never appear as a second feed entry alongside their linked ledger row.
      const payoutRowCount = res.body.data.filter((t: { payout?: { id: string } }) => t.payout?.id === payoutRes.body.data.id).length;
      assert.equal(payoutRowCount, 1); // 20
      const settlementRowCount = res.body.data.filter((t: { settlement?: { id: string } }) => t.settlement?.id === settleRes.body.data.id).length;
      assert.equal(settlementRowCount, 1);
    });
  });

  // ============================================================
  // GLOBAL PAGINATION (21-24)
  // ============================================================

  describe("Global pagination", () => {
    // Dedicated month (Jun 2001) — six interleaved rows across all three
    // ledgers, each with a distinct minute so ordering is unambiguous.
    test("21-24. pagination is GLOBAL across ledgers, never per-ledger concatenation", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "1000");
      const driver = await createDriverWithToken("pagination");

      const t = (minute: number) => new Date(Date.UTC(2001, 5, 15, 12, minute, 0));

      // t6 (newest) down to t1 (oldest), interleaved WALLET/COMPANY/DRIVER_CASH/WALLET/DRIVER_CASH/COMPANY
      const adjust1 = await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "1.00", reason: "t6" });
      assert.equal(adjust1.status, 201, JSON.stringify(adjust1.body));
      await backdate("wallet_transactions", adjust1.body.data.id, t(6));

      const companyAdjust1 = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "2.00", reason: "t5" });
      assert.equal(companyAdjust1.status, 201, JSON.stringify(companyAdjust1.body));
      createdCompanyTransactionIds.push(companyAdjust1.body.data.id);
      await backdate("company_financial_transactions", companyAdjust1.body.data.id, t(5));

      const driverAdjust1 = await request(app)
        .post(`/api/v1/finance/driver-cash/${driver.driverId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "3.00", reason: "t4" });
      assert.equal(driverAdjust1.status, 201, JSON.stringify(driverAdjust1.body));
      await backdate("driver_cash_transactions", driverAdjust1.body.data.id, t(4));

      const adjust2 = await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "4.00", reason: "t3" });
      assert.equal(adjust2.status, 201, JSON.stringify(adjust2.body));
      await backdate("wallet_transactions", adjust2.body.data.id, t(3));

      const driverAdjust2 = await request(app)
        .post(`/api/v1/finance/driver-cash/${driver.driverId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "5.00", reason: "t2" });
      assert.equal(driverAdjust2.status, 201, JSON.stringify(driverAdjust2.body));
      await backdate("driver_cash_transactions", driverAdjust2.body.data.id, t(2));

      const companyAdjust2 = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "6.00", reason: "t1" });
      assert.equal(companyAdjust2.status, 201, JSON.stringify(companyAdjust2.body));
      createdCompanyTransactionIds.push(companyAdjust2.body.data.id);
      await backdate("company_financial_transactions", companyAdjust2.body.data.id, t(1));

      const expectedOrder = [
        adjust1.body.data.id, // t6
        companyAdjust1.body.data.id, // t5
        driverAdjust1.body.data.id, // t4
        adjust2.body.data.id, // t3
        driverAdjust2.body.data.id, // t2
        companyAdjust2.body.data.id, // t1
      ];

      const qs = "?from=2001-06-15&to=2001-06-15&limit=2";
      const page1 = await getTx(tokens.admin, `${qs}&page=1`);
      const page2 = await getTx(tokens.admin, `${qs}&page=2`);
      const page3 = await getTx(tokens.admin, `${qs}&page=3`);

      assert.deepEqual(
        page1.body.data.map((r: { id: string }) => r.id),
        expectedOrder.slice(0, 2)
      ); // 21
      assert.deepEqual(
        page2.body.data.map((r: { id: string }) => r.id),
        expectedOrder.slice(2, 4)
      ); // 22
      assert.deepEqual(
        page3.body.data.map((r: { id: string }) => r.id),
        expectedOrder.slice(4, 6)
      ); // 23

      assert.equal(page1.body.meta.total, 6); // 24
      assert.equal(page1.body.meta.totalPages, 3);
      assert.equal(page1.body.meta.page, 1);
      assert.equal(page1.body.meta.limit, 2);
    });
  });

  // ============================================================
  // LEDGER / TYPE FILTERS (25-29)
  // ============================================================

  describe("Ledger and type filters", () => {
    test("25-29. ledger filter, type filter cross-ledger, and ledger+type combined all scope correctly", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "50");
      const driver = await createDriverWithToken("filters");

      const walletAdjust = await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "1.00", reason: "filter-wallet" });
      assert.equal(walletAdjust.status, 201, JSON.stringify(walletAdjust.body));

      const driverAdjust = await request(app)
        .post(`/api/v1/finance/driver-cash/${driver.driverId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "1.00", reason: "filter-driver" });
      assert.equal(driverAdjust.status, 201, JSON.stringify(driverAdjust.body));

      const companyAdjust = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "1.00", reason: "filter-company" });
      assert.equal(companyAdjust.status, 201, JSON.stringify(companyAdjust.body));
      createdCompanyTransactionIds.push(companyAdjust.body.data.id);

      const walletOnly = await getTx(tokens.admin, "?ledger=WALLET&limit=100");
      assert.ok(walletOnly.body.data.every((t: { ledger: string }) => t.ledger === "WALLET")); // 25
      assert.ok(walletOnly.body.data.some((t: { id: string }) => t.id === walletAdjust.body.data.id));

      const driverOnly = await getTx(tokens.admin, "?ledger=DRIVER_CASH&limit=100");
      assert.ok(driverOnly.body.data.every((t: { ledger: string }) => t.ledger === "DRIVER_CASH")); // 26
      assert.ok(driverOnly.body.data.some((t: { id: string }) => t.id === driverAdjust.body.data.id));

      const companyOnly = await getTx(tokens.admin, "?ledger=COMPANY_FINANCE&limit=100");
      assert.ok(companyOnly.body.data.every((t: { ledger: string }) => t.ledger === "COMPANY_FINANCE")); // 27
      assert.ok(companyOnly.body.data.some((t: { id: string }) => t.id === companyAdjust.body.data.id));

      const allAdjustments = await getTx(tokens.admin, "?type=ADJUSTMENT&limit=100");
      const adjustmentIds = new Set(allAdjustments.body.data.map((t: { id: string }) => t.id));
      assert.ok(adjustmentIds.has(walletAdjust.body.data.id) && adjustmentIds.has(driverAdjust.body.data.id) && adjustmentIds.has(companyAdjust.body.data.id)); // 28

      const walletAdjustmentsOnly = await getTx(tokens.admin, "?ledger=WALLET&type=ADJUSTMENT&limit=100");
      assert.ok(walletAdjustmentsOnly.body.data.every((t: { ledger: string; type: string }) => t.ledger === "WALLET" && t.type === "ADJUSTMENT")); // 29
      assert.ok(!walletAdjustmentsOnly.body.data.some((t: { id: string }) => t.id === driverAdjust.body.data.id));
    });
  });

  // ============================================================
  // DIRECTION NORMALIZATION (30-37)
  // ============================================================

  describe("Direction normalization", () => {
    test("30-31. Wallet credit/debit", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "100");
      const creditTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "20.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const debitTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });

      const res = await getTx(tokens.admin, "?ledger=WALLET&limit=100");
      const creditEntry = res.body.data.find((t: { id: string }) => t.id === creditTx.id);
      const debitEntry = res.body.data.find((t: { id: string }) => t.id === debitTx.id);
      assert.equal(creditEntry.direction, "CREDIT");
      assert.equal(creditEntry.signedAmount, "100");
      assert.equal(debitEntry.direction, "DEBIT");
      assert.equal(debitEntry.signedAmount, "-20");
    });

    test("32-34. Driver collection/settlement/negative-adjustment", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("direction-driver");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });

      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driver.driverId, amountReceived: "50.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });

      const negAdjustRes = await request(app)
        .post(`/api/v1/finance/driver-cash/${driver.driverId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "DEBIT", amount: "5.00", reason: "negative driver adjustment" });
      assert.equal(negAdjustRes.status, 201, JSON.stringify(negAdjustRes.body));

      const res = await getTx(tokens.admin, "?ledger=DRIVER_CASH&limit=100");
      const collectionEntry = res.body.data.find((t: { id: string }) => t.id === collectionTx.id);
      const settlementEntry = res.body.data.find((t: { id: string }) => t.id === settlementTx.id);
      const negAdjustEntry = res.body.data.find((t: { id: string }) => t.id === negAdjustRes.body.data.id);

      assert.equal(collectionEntry.direction, "CREDIT");
      assert.equal(collectionEntry.signedAmount, "105");
      assert.equal(settlementEntry.direction, "DEBIT");
      assert.equal(settlementEntry.signedAmount, "-50");
      assert.equal(negAdjustEntry.direction, "DEBIT");
      assert.equal(negAdjustEntry.signedAmount, "-5");
    });

    test("35-37. Company revenue/negative-adjustment/reversal-of-revenue", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("direction-company");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderAmount: "0.00", deliveryFee: "5.00" });
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "5.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });

      const negAdjustRes = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "DEBIT", amount: "3.00", reason: "negative company adjustment" });
      assert.equal(negAdjustRes.status, 201, JSON.stringify(negAdjustRes.body));
      createdCompanyTransactionIds.push(negAdjustRes.body.data.id);

      const reverseFee = await request(app)
        .post(`/api/v1/finance/company-transactions/${feeTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "direction reversal test" });
      assert.equal(reverseFee.status, 201, JSON.stringify(reverseFee.body));
      const reversalTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { reversal_of_id: feeTx.id } });

      const res = await getTx(tokens.admin, "?ledger=COMPANY_FINANCE&limit=100");
      const feeEntry = res.body.data.find((t: { id: string }) => t.id === feeTx.id);
      const negAdjustEntry = res.body.data.find((t: { id: string }) => t.id === negAdjustRes.body.data.id);
      const reversalEntry = res.body.data.find((t: { id: string }) => t.id === reversalTx.id);

      assert.equal(feeEntry.direction, "CREDIT");
      assert.equal(feeEntry.signedAmount, "5");
      assert.equal(negAdjustEntry.direction, "DEBIT");
      assert.equal(negAdjustEntry.signedAmount, "-3");
      assert.equal(reversalEntry.direction, "DEBIT");
      assert.equal(reversalEntry.signedAmount, "-5");
      assert.equal(reversalEntry.type, "REVERSAL", "a reversal keeps its own REVERSAL type, never its original's category");
      assert.equal(reversalEntry.reversalOf.id, feeTx.id);
      assert.equal(reversalEntry.reversalOf.type, "DELIVERY_FEE_REVENUE");
    });
  });

  // ============================================================
  // RELATIONS (38-44)
  // ============================================================

  describe("Relations", () => {
    test("38-44. safe Order/Customer/Driver/Payout/Settlement/PaymentMethod/Actor summaries resolve correctly", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("relations");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const orderCreditTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "ORDER_CREDIT" } });
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });

      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driver.driverId, amountReceived: "50.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });

      const res = await getTx(tokens.admin, "?limit=100");
      const orderCreditEntry = res.body.data.find((t: { id: string }) => t.id === orderCreditTx.id);
      const collectionEntry = res.body.data.find((t: { id: string }) => t.id === collectionTx.id);
      const payoutEntry = res.body.data.find((t: { id: string }) => t.id === payoutTx.id);
      const settlementEntry = res.body.data.find((t: { id: string }) => t.id === settlementTx.id);

      assert.equal(orderCreditEntry.order.id, orderId); // 38
      assert.equal(orderCreditEntry.customer.id, customerId); // 39
      assert.equal(collectionEntry.driver.id, driver.driverId); // 40
      assert.equal(payoutEntry.payout.id, payoutRes.body.data.id); // 41
      assert.equal(payoutEntry.payout.status, "COMPLETED");
      assert.equal(settlementEntry.settlement.id, settleRes.body.data.id); // 42
      assert.equal(settlementEntry.paymentMethod.id, cashMethodId); // 43 — resolved via the linked Settlement, never invented on the cash row
      assert.ok(payoutEntry.actor.id); // 44
      assert.equal(payoutEntry.actor.id, finance.id);

      // No cross-entity leakage: this customer's row must never carry a
      // different customer's/driver's identity.
      assert.notEqual(collectionEntry.driver.id, customerId);
    });
  });

  // ============================================================
  // DATE FILTER AGREEMENT WITH SUMMARY (45)
  // ============================================================

  describe("Date filter agreement", () => {
    test("45. transactions feed and summary use the identical UTC event window", async () => {
      const customerId = await freshCustomer();
      const walletAdjust = await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "1.00", reason: "date-window-agreement" });
      assert.equal(walletAdjust.status, 201, JSON.stringify(walletAdjust.body));
      const backdated = new Date(Date.UTC(2001, 6, 15, 23, 59, 59)); // 2001-07-15 23:59:59Z — last instant of that UTC day
      await backdate("wallet_transactions", walletAdjust.body.data.id, backdated);

      const inRange = await getTx(tokens.admin, "?from=2001-07-15&to=2001-07-15&limit=100");
      assert.ok(inRange.body.data.some((t: { id: string }) => t.id === walletAdjust.body.data.id), "included on its own UTC day");

      const outOfRange = await getTx(tokens.admin, "?from=2001-07-16&to=2001-07-16&limit=100");
      assert.ok(!outOfRange.body.data.some((t: { id: string }) => t.id === walletAdjust.body.data.id), "excluded from the next UTC day");
    });
  });

  // ============================================================
  // PRIVACY (46)
  // ============================================================

  describe("Privacy", () => {
    test("46. response never contains idempotency keys, password hashes, or raw internals", async () => {
      const res = await getTx(tokens.admin, "?limit=50");
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
    });
  });

  // ============================================================
  // READ-ONLY (47)
  // ============================================================

  describe("Read-only", () => {
    test("47. GET /finance/transactions creates zero ledger/audit/payout/settlement rows for a fresh actor", async () => {
      const freshUser = await createTestUser("FINANCE");
      createdUserIds.push(freshUser.id);
      const login = await loginTestUser(app, freshUser.email, freshUser.password);
      const token = login.accessToken as string;

      await getTx(token, "?limit=50");
      await getTx(token, "?ledger=WALLET&type=ADJUSTMENT");

      const [walletTx, cashTx, companyTx, payouts, settlements, audits] = await Promise.all([
        prisma.wallet_transactions.count({ where: { processed_by_id: freshUser.id } }),
        prisma.driver_cash_transactions.count({ where: { created_by_id: freshUser.id } }),
        prisma.company_financial_transactions.count({ where: { created_by_id: freshUser.id } }),
        prisma.customer_payouts.count({ where: { processed_by_id: freshUser.id } }),
        prisma.driver_settlements.count({ where: { received_by_id: freshUser.id } }),
        prisma.audit_logs.count({ where: { actor_user_id: freshUser.id } }),
      ]);
      assert.equal(walletTx, 0);
      assert.equal(cashTx, 0);
      assert.equal(companyTx, 0);
      assert.equal(payouts, 0);
      assert.equal(settlements, 0);
      assert.equal(audits, 0);
    });
  });
});
