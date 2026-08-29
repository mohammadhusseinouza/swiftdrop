import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 8.10 — Financial Integration Tests (final Phase 8 gate)
//
// This suite does NOT re-prove unit-level behavior already covered by
// 8.1-8.9 (driver-cash.test.ts, wallet.test.ts, delivery-only-finance.
// test.ts, company-order-finance.test.ts, payout.test.ts/-idempotency,
// settlement.test.ts/-idempotency, collection-difference-review.test.ts,
// wallet-correction.test.ts, finance-correction.test.ts). Its job is to
// drive COMPLETE cross-module business chains through the real HTTP API and
// verify the three ledgers (Customer Wallet = company liability, Driver
// Cash = physical custody, Company Finance = company-owned revenue) always
// reconcile correctly against each other — something no single unit suite
// can prove on its own.
//
// Flows A-W below map 1:1 to the Phase 8.10 instruction's Flow A-W list.
// Every assertion is scoped to this suite's own test-owned IDs — no global
// financial-table counts.
// ============================================================

describe("Financial Engine Integration (Phase 8.10)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let dispatcher: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let reasonId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
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
    const reason = await prisma.failed_delivery_reasons.findFirstOrThrow();
    reasonId = reason.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await Promise.all([admin, finance, dispatcher, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  // ------------------------------------------------------------
  // Shared helpers (mirroring the established Phase 8.3/8.4/8.7/8.9 test
  // conventions verbatim — no new style introduced).
  // ------------------------------------------------------------

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function freshCustomer(): Promise<string> {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH810-DRV-${uniqueSuffix()}`, userId: user.id });
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
        receiverName: "Phase810 Receiver",
        receiverPhone: "+96170000810",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase810 St",
        description: "Phase810 integration order",
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

  function deliverPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/deliver`;
  }
  function failPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/fail`;
  }
  function reschedulePath(orderId: string) {
    return `/api/v1/orders/${orderId}/reschedule`;
  }
  function resolvePath(orderId: string) {
    return `/api/v1/orders/${orderId}/resolve-collection-difference`;
  }
  function startPath(orderId: string) {
    return `/api/v1/driver/orders/${orderId}/start-delivery`;
  }

  async function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(deliverPath(orderId)).set(auth(token)).send(body);
  }
  async function failDelivery(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(failPath(orderId)).set(auth(token)).send(body);
  }
  async function reschedule(orderId: string, token: string, body: Record<string, unknown> = { reason: "retry" }) {
    return request(app).post(reschedulePath(orderId)).set(auth(token)).send(body);
  }
  async function resolveDifference(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(resolvePath(orderId)).set(auth(token)).send(body);
  }

  async function postPayout(token: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(app).post("/api/v1/payouts").set(auth(token)).set("Idempotency-Key", idempotencyKey).send(body);
  }
  async function postSettlement(token: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(app).post("/api/v1/driver-settlements").set(auth(token)).set("Idempotency-Key", idempotencyKey).send(body);
  }
  async function postReverseWallet(token: string, transactionId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/wallet-transactions/${transactionId}/reverse`).set(auth(token)).send(body);
  }
  async function postReverseDriverCash(token: string, transactionId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/finance/driver-cash-transactions/${transactionId}/reverse`).set(auth(token)).send(body);
  }
  async function postReverseCompany(token: string, transactionId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/finance/company-transactions/${transactionId}/reverse`).set(auth(token)).send(body);
  }
  async function postAdjustWallet(token: string, customerId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/wallets/${customerId}/adjust`).set(auth(token)).send(body);
  }
  async function postAdjustDriverCash(token: string, driverId: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/finance/driver-cash/${driverId}/adjust`).set(auth(token)).send(body);
  }
  async function postAdjustCompany(token: string, body: Record<string, unknown>) {
    return request(app).post(`/api/v1/finance/company/adjust`).set(auth(token)).send(body);
  }

  // Account-level reconciliation: starting balance (always 0 for a
  // freshly-seeded test Customer/Driver) + SUM(credit-like) - SUM(debit-like)
  // must equal the CURRENT cached balance. Uses each ledger's own
  // credit/debit convention (Wallet has separate credit/debit columns;
  // Driver Cash uses positive-magnitude + balance_before/after chaining).
  async function reconcileWalletBalance(customerId: string): Promise<void> {
    const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
    const rows = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });
    let running = new Prisma.Decimal(0);
    for (const row of rows) {
      running = running.plus(row.credit).minus(row.debit);
    }
    assert.equal(running.toString(), wallet.available_balance.toString(), `Wallet ${customerId} ledger sum must equal cached available_balance`);
    // balanceBefore/balanceAfter chaining invariant.
    let chained = new Prisma.Decimal(0);
    for (const row of rows) {
      assert.equal(row.balance_before.toString(), chained.toString(), `Wallet ${customerId} tx ${row.id} balance_before must chain`);
      chained = row.balance_after;
    }
    assert.equal(chained.toString(), wallet.available_balance.toString());
  }

  async function reconcileDriverCashBalance(driverId: string): Promise<void> {
    const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
    const rows = await prisma.driver_cash_transactions.findMany({ where: { driver_id: driverId }, orderBy: { created_at: "asc" } });
    let chained = new Prisma.Decimal(0);
    for (const row of rows) {
      assert.equal(row.balance_before.toString(), chained.toString(), `Driver Cash ${driverId} tx ${row.id} balance_before must chain`);
      chained = row.balance_after;
    }
    assert.equal(chained.toString(), account.current_balance.toString(), `Driver Cash ${driverId} ledger chain must equal cached current_balance`);
  }

  // Company Finance has no cached running balance (Phase 8.8: signed
  // amounts, ADJUSTMENT/REVERSAL may be negative) — reconciliation here
  // means "the signed sum of a specific scoped set of rows equals the
  // expected total", never a global running balance.
  async function companySignedSum(where: Prisma.company_financial_transactionsWhereInput): Promise<Prisma.Decimal> {
    const rows = await prisma.company_financial_transactions.findMany({ where });
    return rows.reduce((sum, row) => sum.plus(row.amount), new Prisma.Decimal(0));
  }

  // ============================================================
  // FLOW A — DELIVERY ONLY FULL COD
  // ============================================================

  describe("Flow A — Delivery Only full COD", () => {
    test("A. order 100 + fee 5, actual 105: Driver Cash/Wallet/Company reconcile, one finalized attempt, one audit", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowA");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.status, "DELIVERED");
      assert.equal(orderRow.financial_status, "FINALIZED");
      assert.equal(orderRow.needs_financial_review, false);

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");
      const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(cashTx.type, "COLLECTION");
      assert.equal(cashTx.amount.toString(), "105");

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId, type: "ORDER_CREDIT" } });
      assert.equal(walletTxCount, 1);

      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(feeTx.type, "DELIVERY_FEE_REVENUE");
      assert.equal(feeTx.amount.toString(), "5");
      const productTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" } });
      assert.equal(productTxCount, 0);

      // Reconciliation: 105 = 100 wallet liability + 5 company revenue.
      const walletCredit = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "ORDER_CREDIT" } });
      assert.equal(walletCredit.credit.plus(feeTx.amount).toString(), orderRow.actual_amount_collected?.toString());

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId } });
      assert.equal(attempts.length, 1);
      assert.equal(attempts[0].outcome, "DELIVERED");

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0].action, "DELIVERY_ONLY_FINANCE_FINALIZED");

      await reconcileWalletBalance(customerId);
      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW B — DELIVERY ONLY PARTIAL PREPAYMENT
  // ============================================================

  describe("Flow B — Delivery Only partial prepayment", () => {
    test("B. order 100 (prepaid 40) + fee 10 (prepaid 4): remaining 60+6=66, actual 66", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowB");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        orderAmount: "100.00",
        prepaidOrderAmount: "40.00",
        deliveryFee: "10.00",
        prepaidDeliveryFee: "4.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.remaining_order_amount.toString(), "60");
      assert.equal(before.remaining_delivery_fee.toString(), "6");
      assert.equal(before.amount_to_collect.toString(), "66");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "66.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "66");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "60", "must credit only the REMAINING order amount, never the full 100");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(feeTx.amount.toString(), "6", "must recognize only the REMAINING fee, never the full 10");

      await reconcileWalletBalance(customerId);
      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW C — DELIVERY ONLY ALL PREPAID
  // ============================================================

  describe("Flow C — Delivery Only all prepaid", () => {
    test("C. remaining 0, actual 0: FINALIZED with zero ledger rows, attempt/history/audit still correct", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowC");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
        collectionPaymentMethodId: undefined,
      });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.status, "DELIVERED");
      assert.equal(orderRow.financial_status, "FINALIZED");

      const [cashTx, walletTx, companyTx] = await Promise.all([
        prisma.driver_cash_transactions.count({ where: { order_id: orderId } }),
        prisma.wallet_transactions.count({ where: { order_id: orderId } }),
        prisma.company_financial_transactions.count({ where: { order_id: orderId } }),
      ]);
      assert.equal(cashTx, 0);
      assert.equal(walletTx, 0);
      assert.equal(companyTx, 0);

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 1);
      const history = await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "DELIVERED" } });
      assert.equal(history, 1);
      const audit = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(audit, 1);
    });
  });

  // ============================================================
  // FLOW D — COMPANY ORDER FULL COD
  // ============================================================

  describe("Flow D — Company Order full COD", () => {
    test("D. product 100 + fee 5, actual 105: product/fee revenue reconcile, wallet untouched", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowD");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "COMPANY_ORDER" });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");

      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" } });
      assert.equal(productTx.amount.toString(), "100");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      assert.equal(feeTx.amount.toString(), "5");
      assert.equal(productTx.amount.plus(feeTx.amount).toString(), "105", "reconciliation: 105 = 100 product + 5 fee");

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0, "COMPANY_ORDER must never credit the customer wallet");

      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW E — COMPANY ORDER PARTIAL PREPAYMENTS
  // ============================================================

  describe("Flow E — Company Order partial prepayments", () => {
    test("E. product 100 (prepaid 40) + fee 10 (prepaid 4): remaining 60+6=66, actual 66, wallet 0", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowE");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderType: "COMPANY_ORDER",
        paymentType: "PARTIALLY_PAID",
        orderAmount: "100.00",
        prepaidOrderAmount: "40.00",
        deliveryFee: "10.00",
        prepaidDeliveryFee: "4.00",
        prepaidPaymentMethodId: cashMethodId,
      });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "66.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "66");
      const productTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" } });
      assert.equal(productTx.amount.toString(), "60");
      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      assert.equal(feeTx.amount.toString(), "6");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");

      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW F — CUSTOMER PAYOUT AFTER DELIVERY
  // ============================================================

  describe("Flow F — Customer payout after a real delivery", () => {
    test("F. wallet 100 -> payout 40 -> 60; replay same key/payload -> unchanged, no duplicates", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowF");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletBefore.available_balance.toString(), "100");
      const cashBefore = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashBefore.current_balance.toString(), "105");
      const feeBefore = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(feeBefore.toString(), "5");

      const key = randomUUID();
      const payoutBody = { customerId, amount: "40.00", paymentMethodId: cashMethodId, notes: "flowF payout" };
      const payoutRes = await postPayout(tokens.finance, payoutBody, key);
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      assert.equal(payoutRes.body.data.status, "COMPLETED");
      assert.equal(payoutRes.body.data.amount, "40");

      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), "60");
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      assert.equal(payoutTx.type, "PAYOUT");
      assert.equal(payoutTx.debit.toString(), "40");

      // Order, Driver Cash, and Company revenue must be completely untouched.
      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderAfter.status, "DELIVERED");
      assert.equal(orderAfter.financial_status, "FINALIZED");
      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter.current_balance.toString(), "105");
      const feeAfter = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(feeAfter.toString(), "5");

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "CUSTOMER_PAYOUT", entity_id: payoutRes.body.data.id } });
      assert.equal(auditCount, 1);

      // Replay: same key + same normalized payload.
      const replay = await postPayout(tokens.finance, payoutBody, key);
      assert.equal(replay.status, 201, JSON.stringify(replay.body));
      assert.equal(replay.body.data.id, payoutRes.body.data.id);

      const walletReplay = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletReplay.available_balance.toString(), "60");
      const payoutTxCount = await prisma.wallet_transactions.count({ where: { payout_id: payoutRes.body.data.id } });
      assert.equal(payoutTxCount, 1, "no second PAYOUT transaction");
      const auditCountAfterReplay = await prisma.audit_logs.count({ where: { entity_type: "CUSTOMER_PAYOUT", entity_id: payoutRes.body.data.id } });
      assert.equal(auditCountAfterReplay, 1, "no second audit row");

      await reconcileWalletBalance(customerId);
      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW G — DRIVER SETTLEMENT AFTER DELIVERY
  // ============================================================

  describe("Flow G — Driver settlement after a real delivery", () => {
    test("G. cash 105 -> settle 65 -> 40; replay same key/payload -> unchanged, no duplicates", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowG");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const key = randomUUID();
      const settleBody = { driverId: driver.driverId, amountReceived: "65.00", paymentMethodId: cashMethodId, notes: "flowG settlement" };
      const settleRes = await postSettlement(tokens.finance, settleBody, key);
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      assert.equal(settleRes.body.data.amountReceived, "65");
      assert.equal(settleRes.body.data.balanceBefore, "105");
      assert.equal(settleRes.body.data.balanceAfter, "40");

      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter.current_balance.toString(), "40");
      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      assert.equal(settlementTx.type, "SETTLEMENT");
      assert.equal(settlementTx.balance_before.toString(), "105");
      assert.equal(settlementTx.balance_after.toString(), "40");

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100", "settlement must never touch the customer wallet");
      const feeSum = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(feeSum.toString(), "5", "settlement must never touch company revenue");
      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderAfter.status, "DELIVERED");

      const replay = await postSettlement(tokens.finance, settleBody, key);
      assert.equal(replay.status, 201, JSON.stringify(replay.body));
      assert.equal(replay.body.data.id, settleRes.body.data.id);
      const cashReplay = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashReplay.current_balance.toString(), "40");
      const settlementTxCount = await prisma.driver_cash_transactions.count({ where: { settlement_id: settleRes.body.data.id } });
      assert.equal(settlementTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: settleRes.body.data.id } });
      assert.equal(auditCount, 1);

      await reconcileWalletBalance(customerId);
      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW H — FULL CUSTODY + LIABILITY SEPARATION
  // ============================================================

  describe("Flow H — Full custody + liability separation", () => {
    test("H. deliver -> settle driver -> payout customer: each step touches only its own ledger", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowH");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      let cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      let wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      let fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(cash.current_balance.toString(), "105");
      assert.equal(wallet.available_balance.toString(), "100");
      assert.equal(fee.toString(), "5");

      const settleRes = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "105.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));

      cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(cash.current_balance.toString(), "0", "settlement did not reduce Wallet");
      assert.equal(wallet.available_balance.toString(), "100", "settlement did NOT reduce Wallet");
      assert.equal(fee.toString(), "5", "revenue recognized once at delivery, unchanged by settlement");

      const payoutRes = await postPayout(tokens.finance, { customerId, amount: "100.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));

      cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(cash.current_balance.toString(), "0", "payout did NOT alter Driver Cash");
      assert.equal(wallet.available_balance.toString(), "0");
      assert.equal(fee.toString(), "5", "revenue recognized exactly once at delivery, still unchanged after payout");

      await reconcileWalletBalance(customerId);
      await reconcileDriverCashBalance(driver.driverId);
    });
  });

  // ============================================================
  // FLOW I — COMPANY ORDER SETTLEMENT
  // ============================================================

  describe("Flow I — Company Order settlement", () => {
    test("I. product 40 + fee 5, deliver 45, settle 45: company revenue unaffected by settlement", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowI");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderType: "COMPANY_ORDER",
        orderAmount: "40.00",
        deliveryFee: "5.00",
      });
      await deliver(orderId, driver.token, { actualAmountCollected: "45.00" });

      let cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cash.current_balance.toString(), "45");
      const product = await companySignedSum({ order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" });
      const fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(product.toString(), "40");
      assert.equal(fee.toString(), "5");

      const settleRes = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "45.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));

      cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cash.current_balance.toString(), "0");
      const productAfter = await companySignedSum({ order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" });
      const feeAfter = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(productAfter.toString(), "40", "no new Company revenue from settlement");
      assert.equal(feeAfter.toString(), "5");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");
    });
  });

  // ============================================================
  // FLOW J — DELIVERY ONLY SHORTAGE / REVIEW
  // ============================================================

  describe("Flow J — Delivery Only shortage triggers review", () => {
    test("J. expected 105, actual 95: REVIEW_REQUIRED, Driver Cash +95, zero Wallet/Company allocation", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowJ");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "receiver shortage" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.status, "DELIVERED");
      assert.equal(orderRow.financial_status, "REVIEW_REQUIRED");
      assert.equal(orderRow.needs_financial_review, true);
      assert.equal(orderRow.actual_amount_collected?.toString(), "95");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95");
      const [walletTx, companyTx] = await Promise.all([
        prisma.wallet_transactions.count({ where: { order_id: orderId } }),
        prisma.company_financial_transactions.count({ where: { order_id: orderId } }),
      ]);
      assert.equal(walletTx, 0);
      assert.equal(companyTx, 0);

      const attempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(attempt.actual_collection?.toString(), "95");

      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(audit.action, "COLLECTION_DIFFERENCE_RECORDED");
    });
  });

  // ============================================================
  // FLOW K — DIFFERENCE RESOLUTION
  // ============================================================

  describe("Flow K — Difference resolution", () => {
    test("K. resolve 95 as wallet 90 + fee 5: Driver Cash unchanged, order FINALIZED, reason preserved", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowK");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "receiver shortage" });

      const res = await resolveDifference(orderId, tokens.finance, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "flowK resolution",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");
      assert.equal(orderRow.needs_financial_review, false);
      assert.equal(orderRow.collection_difference_reason, "receiver shortage", "original difference reason preserved");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95", "Driver Cash unchanged by resolution");

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "90");
      const fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(fee.toString(), "5");
      assert.equal(wallet.available_balance.plus(fee).toString(), "95", "reconciliation: actual 95 = wallet 90 + company fee 5");

      const resolutionAudit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_type: "ORDER", entity_id: orderId, action: { not: "COLLECTION_DIFFERENCE_RECORDED" } },
      });
      assert.ok(resolutionAudit, "resolution notes audited separately from the original difference-recorded event");
    });
  });

  // ============================================================
  // FLOW L — SETTLEMENT BEFORE DIFFERENCE RESOLUTION
  // ============================================================

  describe("Flow L — Settlement before difference resolution", () => {
    test("L. settle the 95 actual BEFORE resolving; resolution still succeeds; custody != ownership proven again", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowL");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "receiver shortage" });

      const settleRes = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "95.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      let cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cash.current_balance.toString(), "0");

      const resolveRes = await resolveDifference(orderId, tokens.finance, {
        customerWalletCredit: "90.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "flowL resolution after settlement",
      });
      assert.equal(resolveRes.status, 200, JSON.stringify(resolveRes.body));

      cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cash.current_balance.toString(), "0", "still 0 — resolution never touches Driver Cash");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "90");
      const fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(fee.toString(), "5");
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");
    });
  });

  // ============================================================
  // FLOW M — OVERCOLLECTION
  // ============================================================

  describe("Flow M — Overcollection", () => {
    test("M. expected 105, actual 110: Driver Cash +110, Finance resolves the FULL 110, not capped to 105", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowM");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "110.00", collectionDifferenceReason: "receiver overpaid" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "REVIEW_REQUIRED");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "110");

      const resolveRes = await resolveDifference(orderId, tokens.finance, {
        customerWalletCredit: "105.00",
        companyProductRevenue: "0.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "flowM full overcollection allocation",
      });
      assert.equal(resolveRes.status, 200, JSON.stringify(resolveRes.body));

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      const fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(wallet.available_balance.plus(fee).toString(), "110", "allocation total must be exactly 110, never capped to the expected 105");

      const finalOrder = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(finalOrder.financial_status, "FINALIZED");
    });
  });

  // ============================================================
  // FLOW N — COMPANY ORDER DIFFERENCE
  // ============================================================

  describe("Flow N — Company Order difference", () => {
    test("N. expected 105 (product 100+fee 5), actual 95: resolve product 90 + fee 5", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowN");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "COMPANY_ORDER" });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "product shortage" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "REVIEW_REQUIRED");
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95");
      const walletTxCountBefore = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCountBefore, 0);

      const resolveRes = await resolveDifference(orderId, tokens.finance, {
        customerWalletCredit: "0",
        companyProductRevenue: "90.00",
        companyDeliveryFeeRevenue: "5.00",
        resolutionNotes: "flowN company difference resolution",
      });
      assert.equal(resolveRes.status, 200, JSON.stringify(resolveRes.body));

      const product = await companySignedSum({ order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" });
      const fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(product.plus(fee).toString(), "95");
      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter.current_balance.toString(), "95", "unchanged by resolution");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0", "COMPANY_ORDER resolution must never touch the wallet");
      const finalOrder = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(finalOrder.financial_status, "FINALIZED");
    });
  });

  // ============================================================
  // FLOW O — PAYOUT REVERSAL
  // ============================================================

  describe("Flow O — Payout reversal", () => {
    test("O. reverse a real payout: wallet restored, payout REVERSED, original PAYOUT row byte-for-byte unchanged, second reversal rejected", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowO");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const payoutRes = await postPayout(tokens.finance, { customerId, amount: "40.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      const walletAfterPayout = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfterPayout.available_balance.toString(), "60");

      const originalTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      const originalSnapshot = { ...originalTx };
      const cashBefore = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      const feeBefore = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });

      const reverseRes = await postReverseWallet(tokens.admin, originalTx.id, { reason: "flowO reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      assert.equal(reverseRes.body.data.type, "REVERSAL");
      assert.equal(reverseRes.body.data.credit, "40");
      const reversalRow = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: reverseRes.body.data.id } });
      assert.equal(reversalRow.reversal_of_id, originalTx.id, "reversalOfId is intentionally not exposed in the safe DTO — verify via DB");

      const walletAfterReversal = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfterReversal.available_balance.toString(), "100", "wallet restored by 40");

      const payoutRow = await prisma.customer_payouts.findUniqueOrThrow({ where: { id: payoutRes.body.data.id } });
      assert.equal(payoutRow.status, "REVERSED");

      const originalAfter = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: originalTx.id } });
      assert.deepEqual(originalAfter, originalSnapshot, "the original PAYOUT ledger row must remain byte-for-byte unchanged");

      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter.current_balance.toString(), cashBefore.current_balance.toString(), "no Driver Cash effect");
      const feeAfter = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(feeAfter.toString(), feeBefore.toString(), "no Company Finance effect");

      const auditCount = await prisma.audit_logs.count({ where: { action: "CUSTOMER_PAYOUT_REVERSED", entity_id: payoutRow.id } });
      assert.equal(auditCount, 1);

      const secondAttempt = await postReverseWallet(tokens.admin, originalTx.id, { reason: "second attempt" });
      assert.equal(secondAttempt.status, 409, JSON.stringify(secondAttempt.body));
      const reversalCount = await prisma.wallet_transactions.count({ where: { reversal_of_id: originalTx.id } });
      assert.equal(reversalCount, 1, "no duplicate reversal effect");
    });
  });

  // ============================================================
  // FLOW P — DRIVER SETTLEMENT REVERSAL
  // ============================================================

  describe("Flow P — Driver settlement reversal", () => {
    test("P. reverse a real settlement: cash restored, DriverSettlement row unchanged, no Wallet/Company effect", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowP");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderAmount: "95.00", deliveryFee: "5.00" });
      await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });

      const settleRes = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "60.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201, JSON.stringify(settleRes.body));
      const cashAfterSettle = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfterSettle.current_balance.toString(), "40");

      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      const settlementSnapshot = { ...settlementTx };
      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });

      const reverseRes = await postReverseDriverCash(tokens.admin, settlementTx.id, { reason: "flowP reversal" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      assert.equal(reverseRes.body.data.type, "REVERSAL");
      assert.equal(reverseRes.body.data.amount, "60");

      const cashAfterReversal = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfterReversal.current_balance.toString(), "100", "cash restored to 100");

      const settlementRow = await prisma.driver_settlements.findUniqueOrThrow({ where: { id: settleRes.body.data.id } });
      assert.equal(settlementRow.amount_received.toString(), "60", "DriverSettlement historical row unchanged");

      const settlementTxAfter = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: settlementTx.id } });
      assert.deepEqual(settlementTxAfter, settlementSnapshot, "original SETTLEMENT cash tx unchanged");

      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), walletBefore.available_balance.toString(), "no Wallet effect");
      const feeSum = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(feeSum.toString(), "5", "no Company effect");
    });
  });

  // ============================================================
  // FLOW Q — REVENUE REVERSAL
  // ============================================================

  describe("Flow Q — Revenue reversal", () => {
    test("Q. reverse a real DELIVERY_FEE_REVENUE row: exact negative reversal, order stays DELIVERED/FINALIZED, no operational reopening", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowQ");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      const originalSnapshot = { ...feeTx };
      const cashBefore = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      const walletBefore = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });

      const reverseRes = await postReverseCompany(tokens.admin, feeTx.id, { reason: "flowQ revenue correction" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));
      assert.equal(reverseRes.body.data.type, "REVERSAL");
      assert.equal(reverseRes.body.data.amount, "-5");
      assert.equal(reverseRes.body.data.reversalOfId, feeTx.id);

      const originalAfter = await prisma.company_financial_transactions.findUniqueOrThrow({ where: { id: feeTx.id } });
      assert.deepEqual(originalAfter, originalSnapshot, "original revenue row unchanged");

      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderAfter.status, "DELIVERED");
      assert.equal(orderAfter.financial_status, "FINALIZED", "no operational workflow reopening");

      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter.current_balance.toString(), cashBefore.current_balance.toString());
      const walletAfter = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter.available_balance.toString(), walletBefore.available_balance.toString());

      const netSum = await companySignedSum({ order_id: orderId, type: { in: ["DELIVERY_FEE_REVENUE", "REVERSAL"] } });
      assert.equal(netSum.toString(), "0", "net company effect for this order's fee category is now zero");
    });
  });

  // ============================================================
  // FLOW R — MANUAL ADJUSTMENTS (ledger independence)
  // ============================================================

  describe("Flow R — Manual adjustments (ledger independence)", () => {
    test("R. Wallet ADJUSTMENT only changes Wallet; Driver Cash ADJUSTMENT only changes Driver Cash; Company ADJUSTMENT only changes Company", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowR");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const cashBefore = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      const feeBefore = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });

      const walletAdjust = await postAdjustWallet(tokens.admin, customerId, { direction: "CREDIT", amount: "10.00", reason: "flowR wallet correction" });
      assert.equal(walletAdjust.status, 201, JSON.stringify(walletAdjust.body));
      const walletAfter1 = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter1.available_balance.toString(), "110");
      const cashAfter1 = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter1.current_balance.toString(), cashBefore.current_balance.toString(), "wallet adjustment must not touch Driver Cash");
      const auditWalletCount = await prisma.audit_logs.count({
        where: { action: "WALLET_ADJUSTMENT_CREATED", actor_user_id: admin.id, created_at: { gte: new Date(Date.now() - 60_000) } },
      });
      assert.ok(auditWalletCount >= 1);

      const cashAdjust = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "DEBIT", amount: "5.00", reason: "flowR cash correction" });
      assert.equal(cashAdjust.status, 201, JSON.stringify(cashAdjust.body));
      const cashAfter2 = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter2.current_balance.toString(), cashBefore.current_balance.minus("5").toString());
      const walletAfter2 = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter2.available_balance.toString(), "110", "driver cash adjustment must not touch Wallet");

      const companyAdjust = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "20.00", reason: "flowR company correction" });
      assert.equal(companyAdjust.status, 201, JSON.stringify(companyAdjust.body));
      const cashAfter3 = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAfter3.current_balance.toString(), cashAfter2.current_balance.toString(), "company adjustment must not touch Driver Cash");
      const walletAfter3 = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(walletAfter3.available_balance.toString(), "110", "company adjustment must not touch Wallet");
      const feeAfter = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(feeAfter.toString(), feeBefore.toString(), "the company adjustment is its own row, not mixed into the order's revenue row");

      // Reason required.
      const missingReason = await postAdjustWallet(tokens.admin, customerId, { direction: "CREDIT", amount: "1.00", reason: "" });
      assert.equal(missingReason.status, 400);
    });
  });

  // ============================================================
  // FLOW S — DUPLICATE DELIVERY
  // ============================================================

  describe("Flow S — Duplicate delivery", () => {
    test("S. sequential duplicate then concurrent duplicate on a fresh order: exactly one finalization each time", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowS-seq");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const first = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const second = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(second.status, 400, JSON.stringify(second.body));

      assert.equal(await prisma.driver_cash_transactions.count({ where: { order_id: orderId } }), 1);
      assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId } }), 1);
      assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId } }), 1);
      assert.equal(await prisma.delivery_attempts.count({ where: { order_id: orderId } }), 1);
      assert.equal(await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "DELIVERED" } }), 1);
      assert.equal(await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } }), 1);

      const customerId2 = await freshCustomer();
      const driver2 = await createDriverWithToken("flowS-conc");
      const orderId2 = await createOutForDeliveryOrder(customerId2, driver2.token, driver2.driverId);
      const [a, b] = await Promise.all([
        deliver(orderId2, driver2.token, { actualAmountCollected: "105.00" }),
        deliver(orderId2, driver2.token, { actualAmountCollected: "105.00" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      assert.equal(await prisma.driver_cash_transactions.count({ where: { order_id: orderId2 } }), 1);
      assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId2 } }), 1);
      assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId2 } }), 1);
      assert.equal(await prisma.delivery_attempts.count({ where: { order_id: orderId2 } }), 1);
      assert.equal(await prisma.order_status_history.count({ where: { order_id: orderId2, to_status: "DELIVERED" } }), 1);
      assert.equal(await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId2 } }), 1);
    });
  });

  // ============================================================
  // FLOW T — PAYOUT IDEMPOTENCY
  // ============================================================

  describe("Flow T — Payout idempotency (true request identity, not payload-based)", () => {
    test("T. wallet 500: same key/same payload replays; same key/different amount 409; different key may succeed", async () => {
      const customerId = await freshCustomer();
      await request(app)
        .post(`/api/v1/wallets/${customerId}/adjust`)
        .set(auth(tokens.admin))
        .send({ direction: "CREDIT", amount: "500.00", reason: "flowT funding" });

      const keyK = randomUUID();
      const first = await postPayout(tokens.finance, { customerId, amount: "300.00", paymentMethodId: cashMethodId }, keyK);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const replay = await postPayout(tokens.finance, { customerId, amount: "300.00", paymentMethodId: cashMethodId }, keyK);
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.id, first.body.data.id, "same key/same payload must return the SAME payout");

      const conflicting = await postPayout(tokens.finance, { customerId, amount: "250.00", paymentMethodId: cashMethodId }, keyK);
      assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "200", "only the original 300 payout ever executed");

      const keyDifferent = randomUUID();
      const distinctKeySamePayload = await postPayout(tokens.finance, { customerId, amount: "300.00", paymentMethodId: cashMethodId }, keyDifferent);
      // Balance is 200, so a genuinely NEW 300 request must fail on balance —
      // proving dedup is key-based (it wasn't silently treated as the same
      // logical request) while still respecting the real balance rule.
      assert.equal(distinctKeySamePayload.status, 400, "a different key is a distinct request, correctly rejected for insufficient balance");

      const keyDifferent2 = randomUUID();
      const distinctKeySmallerAmount = await postPayout(tokens.finance, { customerId, amount: "150.00", paymentMethodId: cashMethodId }, keyDifferent2);
      assert.equal(distinctKeySmallerAmount.status, 201, "a different key with an amount the balance can cover succeeds independently");
    });
  });

  // ============================================================
  // FLOW U — SETTLEMENT IDEMPOTENCY
  // ============================================================

  describe("Flow U — Settlement idempotency", () => {
    test("U. same key/same request -> same settlement; same key/different request -> 409; different key -> distinct settlement if cash permits", async () => {
      const driver = await createDriverWithToken("flowU");
      await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "500.00", reason: "flowU funding" });

      const keyK = randomUUID();
      const first = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "300.00", paymentMethodId: cashMethodId }, keyK);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const replay = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "300.00", paymentMethodId: cashMethodId }, keyK);
      assert.equal(replay.status, 201);
      assert.equal(replay.body.data.id, first.body.data.id);

      const conflicting = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "250.00", paymentMethodId: cashMethodId }, keyK);
      assert.equal(conflicting.status, 409, JSON.stringify(conflicting.body));

      const cash = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cash.current_balance.toString(), "200");

      const keyDifferent = randomUUID();
      const distinct = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "150.00", paymentMethodId: cashMethodId }, keyDifferent);
      assert.equal(distinct.status, 201, "a different key is an independent settlement");
      assert.notEqual(distinct.body.data.id, first.body.data.id);
    });
  });

  // ============================================================
  // FLOW V — COMPETING BALANCE REQUESTS
  // ============================================================

  describe("Flow V — Competing balance requests", () => {
    test("V. wallet 100: concurrent payout 80+80 (different keys) -> at most one succeeds, never negative; 60+40 both fit", async () => {
      const customerId = await freshCustomer();
      await postAdjustWallet(tokens.admin, customerId, { direction: "CREDIT", amount: "100.00", reason: "flowV funding" });

      const [a, b] = await Promise.all([
        postPayout(tokens.finance, { customerId, amount: "80.00", paymentMethodId: cashMethodId }),
        postPayout(tokens.finance, { customerId, amount: "80.00", paymentMethodId: cashMethodId }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));
      const wallet1 = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet1.available_balance.toString(), "20");
      assert.ok(!wallet1.available_balance.isNegative());

      const customerId2 = await freshCustomer();
      await postAdjustWallet(tokens.admin, customerId2, { direction: "CREDIT", amount: "100.00", reason: "flowV funding 2" });
      const [c, e] = await Promise.all([
        postPayout(tokens.finance, { customerId: customerId2, amount: "60.00", paymentMethodId: cashMethodId }),
        postPayout(tokens.finance, { customerId: customerId2, amount: "40.00", paymentMethodId: cashMethodId }),
      ]);
      assert.equal(c.status, 201, JSON.stringify(c.body));
      assert.equal(e.status, 201, JSON.stringify(e.body));
      const wallet2 = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId2 } });
      assert.equal(wallet2.available_balance.toString(), "0");
      await reconcileWalletBalance(customerId2);

      const driver = await createDriverWithToken("flowV");
      await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "100.00", reason: "flowV cash funding" });
      const [f, g] = await Promise.all([
        postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "80.00", paymentMethodId: cashMethodId }),
        postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "80.00", paymentMethodId: cashMethodId }),
      ]);
      const settleStatuses = [f.status, g.status].sort();
      assert.deepEqual(settleStatuses, [201, 400], JSON.stringify([f.body, g.body]));
      const cash1 = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cash1.current_balance.toString(), "20");
      assert.ok(!cash1.current_balance.isNegative());

      const driver2 = await createDriverWithToken("flowV-both-fit");
      await postAdjustDriverCash(tokens.admin, driver2.driverId, { direction: "CREDIT", amount: "100.00", reason: "flowV cash funding 2" });
      const [h, i] = await Promise.all([
        postSettlement(tokens.finance, { driverId: driver2.driverId, amountReceived: "60.00", paymentMethodId: cashMethodId }),
        postSettlement(tokens.finance, { driverId: driver2.driverId, amountReceived: "40.00", paymentMethodId: cashMethodId }),
      ]);
      assert.equal(h.status, 201, JSON.stringify(h.body));
      assert.equal(i.status, 201, JSON.stringify(i.body));
      const cash2 = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver2.driverId } });
      assert.equal(cash2.current_balance.toString(), "0");
      await reconcileDriverCashBalance(driver2.driverId);
    });
  });

  // ============================================================
  // FLOW W — FAILED DELIVERY THEN RETRY
  // ============================================================

  describe("Flow W — Failed delivery then successful retry", () => {
    test("W1. DELIVERY_ONLY: fail -> zero finance -> reschedule -> retry -> succeeds once; original failed attempt immutable", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowW1");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const failRes = await failDelivery(orderId, driver.token, { failedReasonId: reasonId, notes: "flowW1 first attempt" });
      assert.equal(failRes.status, 200, JSON.stringify(failRes.body));

      assert.equal(await prisma.driver_cash_transactions.count({ where: { order_id: orderId } }), 0);
      assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId } }), 0);
      assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId } }), 0);
      const failedAttempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 1 } });
      assert.equal(failedAttempt.outcome, "FAILED");
      const failedSnapshot = { ...failedAttempt };

      const rescheduleRes = await reschedule(orderId, tokens.admin, { reason: "flowW1 retry setup" });
      assert.equal(rescheduleRes.status, 200, JSON.stringify(rescheduleRes.body));
      const startRes = await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      assert.equal(startRes.status, 200, JSON.stringify(startRes.body));

      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");
      assert.equal(await prisma.driver_cash_transactions.count({ where: { order_id: orderId } }), 1, "successful finance occurs exactly once, on the successful attempt");
      assert.equal(await prisma.wallet_transactions.count({ where: { order_id: orderId } }), 1);
      assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId } }), 1);

      const failedAttemptAfter = await prisma.delivery_attempts.findUniqueOrThrow({ where: { id: failedAttempt.id } });
      assert.deepEqual(failedAttemptAfter, failedSnapshot, "the prior failed attempt is immutable");
      const deliveredAttempt = await prisma.delivery_attempts.findFirstOrThrow({ where: { order_id: orderId, attempt_number: 2 } });
      assert.equal(deliveredAttempt.outcome, "DELIVERED");
    });

    test("W2. COMPANY_ORDER retry: fail -> reschedule -> retry -> succeeds once (closes the prior structural-only coverage gap)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("flowW2");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "COMPANY_ORDER" });

      const failRes = await failDelivery(orderId, driver.token, { failedReasonId: reasonId, notes: "flowW2 first attempt" });
      assert.equal(failRes.status, 200, JSON.stringify(failRes.body));
      assert.equal(await prisma.driver_cash_transactions.count({ where: { order_id: orderId } }), 0);
      assert.equal(await prisma.company_financial_transactions.count({ where: { order_id: orderId } }), 0);

      await reschedule(orderId, tokens.admin, { reason: "flowW2 retry setup" });
      await request(app).post(startPath(orderId)).set(auth(driver.token)).send();
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");
      const product = await companySignedSum({ order_id: orderId, type: "COMPANY_ORDER_PRODUCT_REVENUE" });
      const fee = await companySignedSum({ order_id: orderId, type: "DELIVERY_FEE_REVENUE" });
      assert.equal(product.toString(), "100");
      assert.equal(fee.toString(), "5");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0", "COMPANY_ORDER retry must still never credit the wallet");

      const attempts = await prisma.delivery_attempts.findMany({ where: { order_id: orderId }, orderBy: { attempt_number: "asc" } });
      assert.equal(attempts.length, 2);
      assert.equal(attempts[0].outcome, "FAILED");
      assert.equal(attempts[1].outcome, "DELIVERED");
    });
  });

  // ============================================================
  // MANDATORY REVIEW SUPPORT — Audit action matrix
  // ============================================================

  describe("Audit action matrix (Phase 8 review support)", () => {
    test("every significant Phase 8 business event produces exactly the expected audit action with the correct actor", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("audit-matrix");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const deliverRes = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200);

      const deliveryAudit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(deliveryAudit.action, "DELIVERY_ONLY_FINANCE_FINALIZED");
      assert.equal(deliveryAudit.actor_user_id, driver.userId);

      const payoutRes = await postPayout(tokens.finance, { customerId, amount: "20.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201);
      const payoutAudit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "CUSTOMER_PAYOUT", entity_id: payoutRes.body.data.id } });
      assert.equal(payoutAudit.action, "CUSTOMER_PAYOUT_COMPLETED");
      assert.equal(payoutAudit.actor_user_id, finance.id);

      const settleRes = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "50.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201);
      const settleAudit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: settleRes.body.data.id } });
      assert.equal(settleAudit.action, "DRIVER_SETTLEMENT_COMPLETED");
      assert.equal(settleAudit.actor_user_id, finance.id);

      const walletAdjust = await postAdjustWallet(tokens.admin, customerId, { direction: "CREDIT", amount: "1.00", reason: "audit matrix wallet adj" });
      assert.equal(walletAdjust.status, 201);
      const walletAdjustAudit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "WALLET_ADJUSTMENT_CREATED", actor_user_id: admin.id, created_at: { gte: new Date(Date.now() - 60_000) } } });
      assert.ok(walletAdjustAudit);

      const cashAdjust = await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "1.00", reason: "audit matrix cash adj" });
      assert.equal(cashAdjust.status, 201);
      const cashAdjustAudit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "DRIVER_CASH_ADJUSTMENT_CREATED", actor_user_id: admin.id, created_at: { gte: new Date(Date.now() - 60_000) } } });
      assert.ok(cashAdjustAudit);

      const companyAdjust = await postAdjustCompany(tokens.admin, { direction: "CREDIT", amount: "1.00", reason: "audit matrix company adj" });
      assert.equal(companyAdjust.status, 201);
      const companyAdjustAudit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "COMPANY_FINANCIAL_ADJUSTMENT_CREATED", actor_user_id: admin.id, created_at: { gte: new Date(Date.now() - 60_000) } } });
      assert.ok(companyAdjustAudit);

      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      const walletReversal = await postReverseWallet(tokens.admin, payoutTx.id, { reason: "audit matrix wallet reversal" });
      assert.equal(walletReversal.status, 201);
      const walletReversalAudit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "CUSTOMER_PAYOUT_REVERSED", entity_id: payoutRes.body.data.id } });
      assert.equal(walletReversalAudit.actor_user_id, admin.id);

      const settlementTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { settlement_id: settleRes.body.data.id } });
      const cashReversal = await postReverseDriverCash(tokens.admin, settlementTx.id, { reason: "audit matrix cash reversal" });
      assert.equal(cashReversal.status, 201);
      const cashReversalAudit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "DRIVER_SETTLEMENT_REVERSED", entity_id: settleRes.body.data.id } });
      assert.equal(cashReversalAudit.actor_user_id, admin.id);

      const feeTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId, type: "DELIVERY_FEE_REVENUE" } });
      const companyReversal = await postReverseCompany(tokens.admin, feeTx.id, { reason: "audit matrix company reversal" });
      assert.equal(companyReversal.status, 201);
      const companyReversalAudit = await prisma.audit_logs.findFirstOrThrow({ where: { action: "COMPANY_FINANCIAL_TRANSACTION_REVERSED", entity_id: feeTx.id } });
      assert.equal(companyReversalAudit.actor_user_id, admin.id);
    });
  });

  // ============================================================
  // MANDATORY REVIEW SUPPORT — RBAC / security spot check
  // ============================================================

  describe("RBAC / security spot check (Phase 8 review support)", () => {
    test("non-privileged roles are rejected on every Phase 8 financial mutation route", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("rbac-check");

      const payoutAsDispatcher = await postPayout(tokens.dispatcher, { customerId, amount: "1.00", paymentMethodId: cashMethodId });
      assert.equal(payoutAsDispatcher.status, 403);
      const payoutAsDriver = await postPayout(tokens.driver, { customerId, amount: "1.00", paymentMethodId: cashMethodId });
      assert.equal(payoutAsDriver.status, 403);
      const payoutAsCustomer = await postPayout(tokens.customer, { customerId, amount: "1.00", paymentMethodId: cashMethodId });
      assert.equal(payoutAsCustomer.status, 403);

      const settlementAsDispatcher = await postSettlement(tokens.dispatcher, { driverId: driver.driverId, amountReceived: "1.00", paymentMethodId: cashMethodId });
      assert.equal(settlementAsDispatcher.status, 403);
      const settlementAsDriver = await postSettlement(tokens.driver, { driverId: driver.driverId, amountReceived: "1.00", paymentMethodId: cashMethodId });
      assert.equal(settlementAsDriver.status, 403);

      const walletAdjustAsDispatcher = await postAdjustWallet(tokens.dispatcher, customerId, { direction: "CREDIT", amount: "1.00", reason: "x" });
      assert.equal(walletAdjustAsDispatcher.status, 403);
      const walletAdjustAsDriver = await postAdjustWallet(tokens.driver, customerId, { direction: "CREDIT", amount: "1.00", reason: "x" });
      assert.equal(walletAdjustAsDriver.status, 403);

      const cashAdjustAsDispatcher = await postAdjustDriverCash(tokens.dispatcher, driver.driverId, { direction: "CREDIT", amount: "1.00", reason: "x" });
      assert.equal(cashAdjustAsDispatcher.status, 403);
      const companyAdjustAsDriver = await postAdjustCompany(tokens.driver, { direction: "CREDIT", amount: "1.00", reason: "x" });
      assert.equal(companyAdjustAsDriver.status, 403);

      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const resolveAsDispatcher = await resolveDifference(orderId, tokens.dispatcher, {
        customerWalletCredit: "0",
        companyProductRevenue: "0",
        companyDeliveryFeeRevenue: "0",
        resolutionNotes: "x",
      });
      assert.equal(resolveAsDispatcher.status, 403, "finance.adjust required, not dispatcher-level operational access");

      // Admin (full access) and Finance (financial access) must both work —
      // no hard-coded Admin-only bypass excluding the Finance role.
      const asFinanceOk = await postAdjustWallet(tokens.finance, customerId, { direction: "CREDIT", amount: "1.00", reason: "finance role works too" });
      assert.equal(asFinanceOk.status, 201, JSON.stringify(asFinanceOk.body));
    });
  });

  // ============================================================
  // MANDATORY REVIEW SUPPORT — DTO / privacy
  // ============================================================

  describe("DTO / privacy review support", () => {
    test("payout, settlement, and wallet-adjustment responses never leak internal financial/security details", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("dto-privacy");
      await postAdjustWallet(tokens.admin, customerId, { direction: "CREDIT", amount: "50.00", reason: "dto privacy funding" });
      await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "50.00", reason: "dto privacy funding" });

      const payoutRes = await postPayout(tokens.finance, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      assert.equal(payoutRes.status, 201);
      const payoutSerialized = JSON.stringify(payoutRes.body);
      assert.doesNotMatch(payoutSerialized, /idempotency/i);
      assert.doesNotMatch(payoutSerialized, /password_hash/i);
      assert.doesNotMatch(payoutSerialized, /refresh_token/i);
      assert.doesNotMatch(payoutSerialized, /driver_cash/i);

      const settleRes = await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "10.00", paymentMethodId: cashMethodId });
      assert.equal(settleRes.status, 201);
      const settleSerialized = JSON.stringify(settleRes.body);
      assert.doesNotMatch(settleSerialized, /idempotency/i);
      assert.doesNotMatch(settleSerialized, /password_hash/i);
      assert.doesNotMatch(settleSerialized, /company_financial/i);

      // Driver's own cash page must never leak Wallet/Company fields.
      const cashPage = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(cashPage.status, 200);
      const cashPageSerialized = JSON.stringify(cashPage.body);
      assert.doesNotMatch(cashPageSerialized, /wallet/i);
      assert.doesNotMatch(cashPageSerialized, /idempotency/i);

      // Same-key-different-payload conflict response must not reveal the
      // derived internal key or raw hash.
      const key = randomUUID();
      await postPayout(tokens.finance, { customerId, amount: "5.00", paymentMethodId: cashMethodId }, key);
      const conflict = await postPayout(tokens.finance, { customerId, amount: "6.00", paymentMethodId: cashMethodId }, key);
      assert.equal(conflict.status, 409);
      const conflictSerialized = JSON.stringify(conflict.body);
      assert.doesNotMatch(conflictSerialized, /sha256|request:payout|request:settlement/i);
    });
  });

  // ============================================================
  // MANDATORY REVIEW SUPPORT — Append-only integrity
  // ============================================================

  describe("Append-only integrity review support", () => {
    test("no ledger row is ever mutated by a later operation; only CustomerPayout.status is allowed to change", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("append-only");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const deliveryWalletTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      const deliveryWalletSnapshot = { ...deliveryWalletTx };
      const deliveryCashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      const deliveryCashSnapshot = { ...deliveryCashTx };

      // Perform several later operations that touch the SAME accounts.
      await postPayout(tokens.finance, { customerId, amount: "20.00", paymentMethodId: cashMethodId });
      await postSettlement(tokens.finance, { driverId: driver.driverId, amountReceived: "20.00", paymentMethodId: cashMethodId });
      await postAdjustWallet(tokens.admin, customerId, { direction: "CREDIT", amount: "5.00", reason: "append-only check" });
      await postAdjustDriverCash(tokens.admin, driver.driverId, { direction: "CREDIT", amount: "5.00", reason: "append-only check" });

      const deliveryWalletAfter = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: deliveryWalletTx.id } });
      assert.deepEqual(deliveryWalletAfter, deliveryWalletSnapshot, "the original delivery ORDER_CREDIT row must never be rewritten");
      const deliveryCashAfter = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: deliveryCashTx.id } });
      assert.deepEqual(deliveryCashAfter, deliveryCashSnapshot, "the original delivery COLLECTION row must never be rewritten");

      // No public PATCH/DELETE on any ledger-backed resource.
      const patchAttempt = await request(app).patch(`/api/v1/payouts/${randomUUID()}`).set(auth(tokens.admin)).send({ amount: "1" });
      assert.equal(patchAttempt.status, 404);
      const deleteAttempt = await request(app).delete(`/api/v1/driver-settlements/${randomUUID()}`).set(auth(tokens.admin));
      assert.equal(deleteAttempt.status, 404);
    });
  });
});
