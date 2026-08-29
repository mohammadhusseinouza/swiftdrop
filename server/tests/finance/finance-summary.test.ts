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
// GET /api/v1/finance/summary (Phase 9.2)
//
// Historical-date tests use dedicated, test-owned UTC dates in year 2001 —
// no production data or any other concurrently-running test file has any
// legitimate reason to ever create a financial ledger row dated in 2001, so
// absolute (not delta) assertions against that window are safe and
// deterministic under full-suite parallelism (see the module's own test-
// strategy note in the Phase 9.2 instruction). Rows are created through the
// REAL approved service/API flow, then only their created_at is backdated
// via a direct Prisma update — this guarantees financial coherence
// (balances, signed amounts, reversal links) by construction, never a
// hand-rolled ledger row.
// ============================================================

describe("Finance Summary (Phase 9.2)", () => {
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
  // Generic (order_id/driver_id/customer_id-less) company_financial_
  // transactions rows — e.g. from POST /finance/company/adjust — are not
  // covered by any of cleanupTestOrder/cleanupTestCustomerRecord/
  // cleanupTestDriverRecord (none of them scope to a company-level
  // adjustment with no linking foreign key), so this file must track and
  // remove them itself or they silently orphan across repeated test runs.
  const createdCompanyTransactionIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

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
    // Reversals reference the original via reversal_of_id (ON DELETE
    // RESTRICT) — delete in reverse-dependency order: any reversal row
    // first, then the generic adjustment/original it points at.
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
      .send({ driverNumber: `PH92-DRV-${uniqueSuffix()}`, userId: user.id });
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
        receiverName: "Phase92 Receiver",
        receiverPhone: "+96170000092",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase92 St",
        description: "Phase92 finance summary order",
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

  function summaryPath(qs = "") {
    return `/api/v1/finance/summary${qs}`;
  }

  async function getSummary(token: string, qs = "") {
    return request(app).get(summaryPath(qs)).set(auth(token));
  }

  async function backdate(model: "wallet_transactions" | "driver_cash_transactions" | "company_financial_transactions", id: string, date: Date) {
    await (prisma[model] as { update: (args: unknown) => Promise<unknown> }).update({ where: { id }, data: { created_at: date } });
  }

  // Each test block below that shares a ledger TABLE with another block uses
  // its own dedicated month in year 2001 — never the same calendar day two
  // blocks could both backdate into — so a partial failure/residue in one
  // block can never pollute a GLOBAL (non-customer/driver-scoped) sum
  // assertion in another block. Category-scoped assertions (e.g.
  // deliveryFeeRevenue/companyOrderRevenue) are safe to share a day since
  // they filter by type; the broad/snapshot assertions are not, hence the
  // separation.
  const D1 = new Date(Date.UTC(2001, 0, 10, 12, 0, 0)); // 2001-01-10
  const D2 = new Date(Date.UTC(2001, 0, 11, 12, 0, 0)); // 2001-01-11
  const D3 = new Date(Date.UTC(2001, 0, 12, 12, 0, 0)); // 2001-01-12

  // ============================================================
  // RBAC (1-10)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated -> 401", async () => {
      const res = await request(app).get(summaryPath());
      assert.equal(res.status, 401);
    });

    test("2. ADMIN -> 200", async () => {
      const res = await getSummary(tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. FINANCE -> 200", async () => {
      const res = await getSummary(tokens.finance);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("4. DISPATCHER -> 403", async () => {
      const res = await getSummary(tokens.dispatcher);
      assert.equal(res.status, 403);
    });

    test("5. DRIVER -> 403", async () => {
      const res = await getSummary(tokens.driver);
      assert.equal(res.status, 403);
    });

    test("6. CUSTOMER -> 403", async () => {
      const res = await getSummary(tokens.customer);
      assert.equal(res.status, 403);
    });

    test("7. dashboard.read alone (Dispatcher) does not grant /finance/summary", async () => {
      const dashboardRes = await request(app).get("/api/v1/dashboard").set(auth(tokens.dispatcher));
      assert.equal(dashboardRes.status, 200, "sanity: Dispatcher does have dashboard.read");
      const financeRes = await getSummary(tokens.dispatcher);
      assert.equal(financeRes.status, 403, "dashboard.read must not substitute for finance.read");
    });
  });

  // ============================================================
  // DATE VALIDATION (8-15)
  // ============================================================

  describe("Date validation", () => {
    test("8. malformed from -> 400", async () => {
      const res = await getSummary(tokens.admin, "?from=not-a-date");
      assert.equal(res.status, 400);
    });

    test("9. malformed to -> 400", async () => {
      const res = await getSummary(tokens.admin, "?to=2026/08/01");
      assert.equal(res.status, 400);
    });

    test("10. impossible date -> 400", async () => {
      const res = await getSummary(tokens.admin, "?to=2026-02-30");
      assert.equal(res.status, 400);
    });

    test("11. from > to -> 400", async () => {
      const res = await getSummary(tokens.admin, "?from=2026-08-31&to=2026-08-01");
      assert.equal(res.status, 400);
    });

    test("12. from only is valid", async () => {
      const res = await getSummary(tokens.admin, "?from=2001-01-01");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.range.from, "2001-01-01");
      assert.equal(res.body.data.range.to, null);
    });

    test("13. to only is valid", async () => {
      const res = await getSummary(tokens.admin, "?to=2001-01-01");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.range.to, "2001-01-01");
    });

    test("14. no date filter is valid (all-time)", async () => {
      const res = await getSummary(tokens.admin);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.range.from, null);
      assert.equal(res.body.data.range.to, null);
    });

    test("15. from == to is valid (single-day range)", async () => {
      const res = await getSummary(tokens.admin, "?from=2001-01-10&to=2001-01-10");
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });
  });

  // ============================================================
  // DELIVERY FEE REVENUE — reversal-aware (16-19)
  // ============================================================

  describe("Delivery fee revenue", () => {
    test("16-19. +5 fee, reverse -5: original-day +5, reversal-day -5, combined 0", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("fee-rev");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" },
      });
      await backdate("company_financial_transactions", feeTx.id, D1);

      const reverseRes = await request(app)
        .post(`/api/v1/finance/company-transactions/${feeTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase92 fee reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      const reversalTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { reversal_of_id: feeTx.id } });
      await backdate("company_financial_transactions", reversalTx.id, D2);

      const originalDay = await getSummary(tokens.admin, "?from=2001-01-10&to=2001-01-10");
      assert.equal(originalDay.body.data.deliveryFeeRevenue, "5"); // 16

      const reversalDay = await getSummary(tokens.admin, "?from=2001-01-11&to=2001-01-11");
      assert.equal(reversalDay.body.data.deliveryFeeRevenue, "-5"); // 17

      const combined = await getSummary(tokens.admin, "?from=2001-01-10&to=2001-01-11");
      assert.equal(combined.body.data.deliveryFeeRevenue, "0"); // 18-19
    });
  });

  // ============================================================
  // COMPANY ORDER REVENUE — reversal-aware (20-22)
  // ============================================================

  describe("Company Order revenue", () => {
    test("20-22. +100 product revenue, reverse -100: net correctly across periods", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("product-rev");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderType: "COMPANY_ORDER",
        orderAmount: "100.00",
        deliveryFee: "0.00",
      });
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      await backdate("company_financial_transactions", productTx.id, D1);
      const reverseRes = await request(app)
        .post(`/api/v1/finance/company-transactions/${productTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase92 product reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      const reversalTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { reversal_of_id: productTx.id } });
      await backdate("company_financial_transactions", reversalTx.id, D2);

      const full = await getSummary(tokens.admin, "?from=2001-01-10&to=2001-01-11");
      assert.equal(full.body.data.companyOrderRevenue, "0"); // 20

      const reversalOnly = await getSummary(tokens.admin, "?from=2001-01-11&to=2001-01-11");
      assert.equal(reversalOnly.body.data.companyOrderRevenue, "-100"); // 21-22
    });
  });

  // ============================================================
  // COMPANY REVENUE (broad, signed) (23)
  // ============================================================

  describe("Company Revenue (broad)", () => {
    test("23. fee +5, product +100, adjustment -10, fee reversal -5 -> companyRevenue = 90", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("broad-rev");

      const feeOrderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { deliveryFee: "5.00", orderAmount: "0.00" });
      const feeDeliver = await deliver(feeOrderId, driver.token, { actualAmountCollected: "5.00" });
      assert.equal(feeDeliver.status, 200, JSON.stringify(feeDeliver.body));
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: feeOrderId, type: "DELIVERY_FEE_REVENUE" } });
      await backdate("company_financial_transactions", feeTx.id, D3);

      const productOrderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderType: "COMPANY_ORDER",
        orderAmount: "100.00",
        deliveryFee: "0.00",
      });
      const productDeliver = await deliver(productOrderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(productDeliver.status, 200, JSON.stringify(productDeliver.body));
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({
        where: { order_id: productOrderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" },
      });
      await backdate("company_financial_transactions", productTx.id, D3);

      const adjustRes = await request(app)
        .post("/api/v1/finance/company/adjust")
        .set(auth(tokens.finance))
        .send({ direction: "DEBIT", amount: "10.00", reason: "phase92 broad adjustment" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      createdCompanyTransactionIds.push(adjustRes.body.data.id);
      await backdate("company_financial_transactions", adjustRes.body.data.id, D3);

      const reverseFee = await request(app)
        .post(`/api/v1/finance/company-transactions/${feeTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase92 broad fee reversal" });
      assert.equal(reverseFee.status, 201, JSON.stringify(reverseFee.body));
      const reversalTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { reversal_of_id: feeTx.id } });
      await backdate("company_financial_transactions", reversalTx.id, D3);

      const res = await getSummary(tokens.admin, "?from=2001-01-12&to=2001-01-12");
      assert.equal(res.body.data.companyRevenue, "90"); // 5 + 100 - 10 - 5
    });
  });

  // ============================================================
  // TOTAL COLLECTED (24-27)
  // ============================================================

  describe("Total Collected", () => {
    // Dedicated month (Feb 2001) — this block is the only one in the file
    // that backdates driver_cash_transactions rows into it, so the GLOBAL
    // totalCollected assertions below are safe as absolute values. Uses TWO
    // independent drivers: reversing a COLLECTION requires the CURRENT
    // balance to still cover it (the ledger's debit-conditional-decrement is
    // balance-safe, not "undo this specific historical row in isolation"),
    // so a collection that has already been partly settled/adjusted away
    // cannot later be reversed — that's correct production behavior, not a
    // test bug, and is why the settlement/adjustment proof (driver A) and
    // the reversal proof (driver B) use separate, never-settled collections.
    const FEB1 = new Date(Date.UTC(2001, 1, 10, 12, 0, 0));

    test("24-25. COLLECTION +100 survives an unrelated SETTLEMENT and ADJUSTMENT untouched", async () => {
      const customerId = await freshCustomer();
      const driverA = await createDriverWithToken("collected-a");
      const orderId = await createOutForDeliveryOrder(customerId, driverA.token, driverA.driverId, { orderAmount: "95.00", deliveryFee: "5.00" });
      const deliverRes = await deliver(orderId, driverA.token, { actualAmountCollected: "100.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", collectionTx.id, FEB1);

      const afterCollection = await getSummary(tokens.admin, "?from=2001-02-10&to=2001-02-10");
      assert.equal(afterCollection.body.data.totalCollected, "100"); // 24

      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driverA.driverId, amountReceived: "60.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      await backdate("driver_cash_transactions", settlementTx.id, FEB1);

      const adjustRes = await request(app)
        .post(`/api/v1/finance/driver-cash/${driverA.driverId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "10.00", reason: "phase92 unrelated adjustment" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      await backdate("driver_cash_transactions", adjustRes.body.data.id, FEB1);

      const afterBoth = await getSummary(tokens.admin, "?from=2001-02-10&to=2001-02-10");
      assert.equal(afterBoth.body.data.totalCollected, "100", "settlement/adjustment must not affect totalCollected"); // 25
    });

    test("26-27. an actual COLLECTION reversal reduces totalCollected", async () => {
      const customerId = await freshCustomer();
      const driverB = await createDriverWithToken("collected-b");
      const orderId = await createOutForDeliveryOrder(customerId, driverB.token, driverB.driverId, { orderAmount: "45.00", deliveryFee: "5.00" });
      const deliverRes = await deliver(orderId, driverB.token, { actualAmountCollected: "50.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", collectionTx.id, FEB1);

      const before = await getSummary(tokens.admin, "?from=2001-02-10&to=2001-02-10");
      assert.equal(before.body.data.totalCollected, "150", "100 from driver A's unreversed collection + 50 from driver B's"); // 26

      const reverseCollection = await request(app)
        .post(`/api/v1/finance/driver-cash-transactions/${collectionTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase92 collection reversal" });
      assert.equal(reverseCollection.status, 201, JSON.stringify(reverseCollection.body));
      const reversalTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { reversal_of_id: collectionTx.id } });
      await backdate("driver_cash_transactions", reversalTx.id, FEB1);

      const after = await getSummary(tokens.admin, "?from=2001-02-10&to=2001-02-10");
      assert.equal(after.body.data.totalCollected, "100", "driver B's reversed collection nets to 0, leaving only driver A's 100"); // 27
    });
  });

  // ============================================================
  // PAYOUT FLOW (28-30)
  // ============================================================

  describe("Customer Payouts (flow, ledger-derived)", () => {
    test("28-30. PAYOUT 40 on day1, reversed on day2: flow-scoped, current status change never rewrites history", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "100");

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      await backdate("wallet_transactions", payoutTx.id, D1);

      const day1 = await getSummary(tokens.admin, "?from=2001-01-10&to=2001-01-10");
      assert.equal(day1.body.data.customerPayouts, "40"); // 28

      const reverseRes = await request(app)
        .post(`/api/v1/wallet-transactions/${payoutTx.id}/reverse`)
        .set(auth(tokens.finance))
        .send({ reason: "phase92 payout reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      const reversalTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { reversal_of_id: payoutTx.id } });
      await backdate("wallet_transactions", reversalTx.id, D2);

      const day2 = await getSummary(tokens.admin, "?from=2001-01-11&to=2001-01-11");
      assert.equal(day2.body.data.customerPayouts, "-40"); // 29

      const combined = await getSummary(tokens.admin, "?from=2001-01-10&to=2001-01-11");
      assert.equal(combined.body.data.customerPayouts, "0", "the CURRENT REVERSED status must not rewrite day1's reported flow"); // 30

      const payoutRow = await prisma.customer_payouts.findUniqueOrThrow({ where: { id: payoutRes.body.data.id } });
      assert.equal(payoutRow.status, "REVERSED");
    });
  });

  // ============================================================
  // CURRENT (SNAPSHOT) LIABILITY / OUTSTANDING (31-32)
  // ============================================================

  describe("Current snapshot metrics", () => {
    // Two independent live reads (an HTTP call, then a separate DB
    // aggregate) of the same GLOBAL, non-transactional snapshot — under
    // full-suite parallelism a concurrently-running file's real payout/
    // settlement/collection event can legitimately land in the gap between
    // them, making the two reads momentarily disagree without either being
    // wrong (Phase 9.3 added a real financial-integration test file that
    // measurably increased concurrent ledger-write volume during the full
    // suite, surfacing this pre-existing race window in practice). Retrying
    // until two consecutive fetches agree applies the same "invariant over
    // a frozen snapshot" principle already established for this file's own
    // Dashboard-reconciliation test (test 40) and Phase 9.1's dashboard
    // tests, rather than asserting a single potentially-torn pair of reads.
    async function assertReconciles(field: "customerWalletLiability" | "driverCashOutstanding", recompute: () => Promise<string>) {
      const MAX_ATTEMPTS = 8;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const res = await getSummary(tokens.admin);
        const expected = await recompute();
        if (res.body.data[field] === expected) return;
        if (attempt === MAX_ATTEMPTS - 1) {
          assert.fail(`${field} did not reconcile after ${MAX_ATTEMPTS} attempts: got ${res.body.data[field]}, recomputed ${expected}`);
        }
      }
    }

    test("31. no `to`: customerWalletLiability equals independently-recomputed SUM(available_balance)", async () => {
      await assertReconciles("customerWalletLiability", async () => {
        const agg = await prisma.customer_wallets.aggregate({ _sum: { available_balance: true } });
        return (agg._sum.available_balance ?? new Prisma.Decimal(0)).toString();
      });
    });

    test("32. no `to`: driverCashOutstanding equals independently-recomputed SUM(current_balance)", async () => {
      await assertReconciles("driverCashOutstanding", async () => {
        const agg = await prisma.driver_cash_accounts.aggregate({ _sum: { current_balance: true } });
        return (agg._sum.current_balance ?? new Prisma.Decimal(0)).toString();
      });
    });
  });

  // ============================================================
  // HISTORICAL (SNAPSHOT) LIABILITY (33-36)
  // ============================================================

  describe("Historical Wallet liability", () => {
    // Dedicated month (Apr 2001) — this is the only block in the file that
    // backdates wallet_transactions into it, so this GLOBAL snapshot's
    // absolute values are deterministic (no other block's payout/reversal/
    // adjustment fixtures can land in April).
    const APR1 = new Date(Date.UTC(2001, 3, 10, 12, 0, 0));
    const APR2 = new Date(Date.UTC(2001, 3, 11, 12, 0, 0));
    const APR3 = new Date(Date.UTC(2001, 3, 12, 12, 0, 0));

    test("33-36. Apr1 +100, Apr2 -30, Apr3 +20: as-of snapshots reconstruct correctly; `from` never narrows a snapshot", async () => {
      const customerId = await freshCustomer();
      await fundWallet(customerId, "100");
      const creditTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      await backdate("wallet_transactions", creditTx.id, APR1);

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ customerId, amount: "30.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      await backdate("wallet_transactions", payoutTx.id, APR2);

      const adjustRes = await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "20.00", reason: "phase92 historical liability" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      await backdate("wallet_transactions", adjustRes.body.data.id, APR3);

      // Snapshot metrics accumulate ALL history up to `to` — an earlier
      // block's fixtures (e.g. the Payout-flow block's Jan PAYOUT+REVERSAL,
      // which happens to net to exactly 0) legitimately count toward any
      // later `to`. A baseline captured the instant before this block's own
      // first fixture date nets out every earlier block's contribution,
      // leaving a delta that is exactly this block's own three rows
      // regardless of file execution order.
      const baselineRes = await getSummary(tokens.admin, "?to=2001-04-09");
      const baseline = decimal(baselineRes.body.data.customerWalletLiability);

      const toApr1 = await getSummary(tokens.admin, "?to=2001-04-10");
      assert.equal(decimal(toApr1.body.data.customerWalletLiability).minus(baseline).toString(), "100"); // 33

      const toApr2 = await getSummary(tokens.admin, "?to=2001-04-11");
      assert.equal(decimal(toApr2.body.data.customerWalletLiability).minus(baseline).toString(), "70"); // 34

      const toApr3 = await getSummary(tokens.admin, "?to=2001-04-12");
      assert.equal(decimal(toApr3.body.data.customerWalletLiability).minus(baseline).toString(), "90"); // 35

      // from=Apr3&to=Apr3 must still report the FULL as-of-Apr3 snapshot
      // (all history through Apr3), not merely Apr3's own movement.
      const fromApr3ToApr3 = await getSummary(tokens.admin, "?from=2001-04-12&to=2001-04-12");
      assert.equal(decimal(fromApr3ToApr3.body.data.customerWalletLiability).minus(baseline).toString(), "90"); // 36
    });
  });

  // ============================================================
  // HISTORICAL (SNAPSHOT) DRIVER CASH (37-39)
  // ============================================================

  describe("Historical Driver Cash outstanding", () => {
    // Dedicated month (May 2001) — the only block backdating
    // driver_cash_transactions into it, so absolute values are deterministic.
    const MAY1 = new Date(Date.UTC(2001, 4, 10, 12, 0, 0));
    const MAY2 = new Date(Date.UTC(2001, 4, 11, 12, 0, 0));
    const MAY3 = new Date(Date.UTC(2001, 4, 12, 12, 0, 0));

    test("37-39. May1 COLLECTION+100, May2 SETTLEMENT-40, May3 ADJUSTMENT+10: as-of snapshots reconstruct correctly", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("hist-cash");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderAmount: "0.00", deliveryFee: "100.00" });
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));
      const collectionTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COLLECTION" } });
      await backdate("driver_cash_transactions", collectionTx.id, MAY1);

      const settleRes = await request(app)
        .post("/api/v1/driver-settlements")
        .set(auth(tokens.finance))
        .set(idemHeader())
        .send({ driverId: driver.driverId, amountReceived: "40.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      await backdate("driver_cash_transactions", settlementTx.id, MAY2);

      const adjustRes = await request(app)
        .post(`/api/v1/finance/driver-cash/${driver.driverId}/adjust`)
        .set(auth(tokens.finance))
        .send({ direction: "CREDIT", amount: "10.00", reason: "phase92 historical driver cash" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      await backdate("driver_cash_transactions", adjustRes.body.data.id, MAY3);

      // Snapshot metrics accumulate ALL history up to `to` — unlike the flow
      // metrics above, a distinct month does NOT isolate this block from an
      // EARLIER-dated block's fixtures (e.g. the "Total Collected" block's
      // February rows legitimately count toward any `to` on or after
      // February). A baseline captured the instant before this block's own
      // first fixture date correctly nets out every earlier block's
      // contribution (and any real, non-2001 production data has none in
      // this range at all), leaving a delta that is exactly this block's own
      // three rows regardless of what ran earlier in the file.
      const baselineRes = await getSummary(tokens.admin, "?to=2001-05-09");
      const baseline = decimal(baselineRes.body.data.driverCashOutstanding);

      const toMay1 = await getSummary(tokens.admin, "?to=2001-05-10");
      assert.equal(decimal(toMay1.body.data.driverCashOutstanding).minus(baseline).toString(), "100"); // 37

      const toMay2 = await getSummary(tokens.admin, "?to=2001-05-11");
      assert.equal(decimal(toMay2.body.data.driverCashOutstanding).minus(baseline).toString(), "60"); // 38

      const toMay3 = await getSummary(tokens.admin, "?to=2001-05-12");
      assert.equal(decimal(toMay3.body.data.driverCashOutstanding).minus(baseline).toString(), "70"); // 39
    });
  });

  // ============================================================
  // DASHBOARD RECONCILIATION (40)
  // ============================================================

  describe("Dashboard reconciliation", () => {
    // Both endpoints compute a GLOBAL, non-transactional snapshot from two
    // separate HTTP requests — under full-suite parallelism, a concurrently-
    // running file's real payout/revenue/collection event can legitimately
    // land in the gap between the two reads, making them momentarily
    // disagree without either one being wrong. Retrying until two
    // consecutive fetches agree (a quiet instant) proves the two formulas
    // are equivalent without assuming the rest of the suite is frozen —
    // the same "invariant over frozen snapshot" principle already
    // established for Phase 9.1's global dashboard tests.
    async function fetchBoth() {
      const summaryRes = await getSummary(tokens.admin);
      const dashboardRes = await request(app).get("/api/v1/dashboard").set(auth(tokens.admin));
      assert.equal(summaryRes.status, 200);
      assert.equal(dashboardRes.status, 200);
      const dashboardFinance = dashboardRes.body.data.finance;
      assert.ok(dashboardFinance, "ADMIN must receive a populated Dashboard finance section");
      return { summary: summaryRes.body.data, dashboardFinance };
    }

    const RECONCILED_FIELDS = [
      "deliveryFeeRevenue",
      "companyOrderRevenue",
      "totalCollected",
      "customerWalletLiability",
      "driverCashOutstanding",
      // customerPayouts: 9.1's dashboard uses SUM(status=COMPLETED); 9.2
      // derives the same figure from the Wallet PAYOUT/REVERSAL ledger event
      // history. Proven mathematically equivalent at all-time (no-date-
      // filter) scope: a reversed payout contributes +amount then -amount to
      // the ledger-derived sum (net 0, matching its exclusion from the
      // COMPLETED-status sum); a never-reversed payout contributes +amount
      // either way. This assertion is the live, empirical confirmation of
      // that equivalence.
      "customerPayouts",
    ] as const;

    test("40. no-date Finance Summary matches the authorized Dashboard finance section exactly", async () => {
      const MAX_ATTEMPTS = 8;
      let last: Awaited<ReturnType<typeof fetchBoth>> | undefined;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        last = await fetchBoth();
        const mismatched = RECONCILED_FIELDS.filter((field) => last!.summary[field] !== last!.dashboardFinance[field]);
        if (mismatched.length === 0) return;
        if (attempt === MAX_ATTEMPTS - 1) {
          assert.fail(
            `finance summary and dashboard disagree after ${MAX_ATTEMPTS} attempts on ${mismatched.join(", ")}: ` +
              JSON.stringify({ summary: last.summary, dashboardFinance: last.dashboardFinance })
          );
        }
      }
    });
  });

  // ============================================================
  // READ-ONLY (41)
  // ============================================================

  describe("Read-only", () => {
    test("41. GET /finance/summary creates zero ledger/audit/payout/settlement rows for a fresh actor", async () => {
      const freshUser = await createTestUser("FINANCE");
      createdUserIds.push(freshUser.id);
      const login = await loginTestUser(app, freshUser.email, freshUser.password);
      const token = login.accessToken as string;

      await getSummary(token, "?from=2001-01-01&to=2001-01-31");
      await getSummary(token);

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

  // ============================================================
  // PRIVACY (42)
  // ============================================================

  describe("Privacy", () => {
    test("42. response never contains idempotency keys, password hashes, or raw internals", async () => {
      const res = await getSummary(tokens.admin);
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
    });
  });
});
