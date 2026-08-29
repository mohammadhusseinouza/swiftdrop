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
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 8.3 — Delivery Only Exact Successful Finance
//
// Dedicated finance-focused suite for the exact-collection DELIVERY_ONLY
// branch of POST /api/v1/driver/orders/:id/deliver. Operational workflow
// correctness (status machine, ownership, attempts, history) is already
// covered by Phase 7.5/7.6's own test files — this suite assumes that
// machinery works and focuses purely on the NEW financial posting this
// sub-phase adds: Driver Cash collection, Customer Wallet order credit,
// Company delivery-fee revenue, the audit record, atomicity/rollback, and
// idempotency/duplicate protection.
// ============================================================

describe("Delivery Only Exact Successful Finance (Phase 8.3)", () => {
  let app: Express;
  let admin: TestUser;
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
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
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
    await Promise.all([admin, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function freshCustomer(): Promise<string> {
    // Each finance-amount scenario gets its own customer so wallet
    // assertions can use absolute balances instead of deltas.
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
      .send({ driverNumber: `PH83-DRV-${uniqueSuffix()}`, userId: user.id });
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
        receiverName: "Phase83 Receiver",
        receiverPhone: "+96170000083",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase83 St",
        description: "Phase83 finance order",
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

  async function deliver(orderId: string, token: string, body: Record<string, unknown>) {
    return request(app).post(deliverPath(orderId)).set(auth(token)).send(body);
  }

  // expectedDriverCashCollections defaults to 0 (the all-prepaid exact case
  // this helper was first written for). Phase 8.7: a collection-difference
  // delivery DOES record its real actual amount in Driver Cash — pass 1
  // explicitly for those call sites.
  async function assertNoFinanceSideEffects(
    orderIds: string[],
    customerId: string,
    driverId: string,
    expectedDriverCashCollections = 0
  ) {
    const [walletTx, cashTx, companyTx, payouts, settlements, adjustments, reversalsWallet, reversalsCash] = await Promise.all([
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds } } }),
      prisma.company_financial_transactions.count({ where: { order_id: { in: orderIds } } }),
      // Scoped to this test's own Customer/Driver — Phase 8.5/8.6 now
      // legitimately write customer_payouts/driver_settlements rows from
      // concurrently-running test files, so an unscoped global count here
      // would be flaky the same way the wallet.test.ts money-separation
      // check already documented for company_financial_transactions.
      prisma.customer_payouts.count({ where: { customer_id: customerId } }),
      prisma.driver_settlements.count({ where: { driver_id: driverId } }),
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds }, type: "ADJUSTMENT" } }),
      prisma.wallet_transactions.count({ where: { order_id: { in: orderIds }, type: "REVERSAL" } }),
      prisma.driver_cash_transactions.count({ where: { order_id: { in: orderIds }, type: "REVERSAL" } }),
    ]);
    assert.equal(walletTx, 0);
    assert.equal(cashTx, expectedDriverCashCollections, "Phase 8.7: a difference delivery records actual physical cash in Driver Cash");
    assert.equal(companyTx, 0);
    assert.equal(payouts, 0);
    assert.equal(settlements, 0);
    assert.equal(adjustments, 0);
    assert.equal(reversalsWallet, 0);
    assert.equal(reversalsCash, 0);
  }

  // ============================================================
  // 1-9. CORE FINANCE SCENARIOS
  // ============================================================

  describe("Core finance scenarios", () => {
    test("1. full COD: driver cash += 105, wallet += 100, company += 5, FINALIZED", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-full-cod");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");
      // financialStatus is deliberately excluded from the Driver-facing DTO
      // (Phase 7.5 privacy design) — verify it via the DB row instead.
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100");
      const companyTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(companyTx.type, "DELIVERY_FEE_REVENUE");
      assert.equal(companyTx.amount.toString(), "5");
    });

    test("2. partial order prepayment: prepaid order 40, remaining order 60 + fee 5 due, actual 65", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-partial-order");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "40.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "65");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "65.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "65");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "60");
      const companyTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(companyTx.amount.toString(), "5");
    });

    test("3. order fully prepaid, fee due: driver cash += 5, wallet skipped (0), company += 5", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-order-prepaid");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "5");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "5.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "5");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0, "no wallet credit when remaining_order_amount is zero");
      const wallet = await prisma.customer_wallets.findUnique({ where: { customer_id: customerId } });
      assert.equal((wallet?.available_balance ?? new Prisma.Decimal(0)).toString(), "0");
      const companyTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(companyTx.amount.toString(), "5");
    });

    test("4. fee fully prepaid, order due: driver cash += 100, wallet += 100, company skipped (0)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-fee-prepaid");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "PARTIALLY_PAID",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "100");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "100.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "100");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100");
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 0, "no company revenue row when remaining_delivery_fee is zero");
    });

    test("5. all prepaid: amountToCollect=0, actual=0 -> DELIVERED, FINALIZED, zero ledger rows", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-all-prepaid");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        paymentType: "ALREADY_PAID",
        prepaidOrderAmount: "100.00",
        prepaidDeliveryFee: "5.00",
        prepaidPaymentMethodId: cashMethodId,
        collectionPaymentMethodId: undefined,
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "0");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");

      await assertNoFinanceSideEffects([orderId], customerId, driver.driverId);
    });

    test("6. Decimal exactness: order 0.10, fee 0.20, actual 0.30 -> exact split with no float drift", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-decimal");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, {
        orderAmount: "0.10",
        deliveryFee: "0.20",
      });
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(before.amount_to_collect.toString(), "0.3");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "0.30" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "0.3");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0.1");
      const companyTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(companyTx.amount.toString(), "0.2");
    });
  });

  // ============================================================
  // 10-12. ATOMICITY / ROLLBACK
  // ============================================================

  describe("Atomicity / rollback", () => {
    test("10. missing customer wallet -> 500, entire transaction rolls back (including driver cash)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-missing-wallet");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      // Simulate a data-integrity failure: the wallet row this customer
      // should always have is gone.
      await prisma.customer_wallets.deleteMany({ where: { customer_id: customerId } });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY", "the entire operational+financial transaction must roll back");
      assert.equal(row.financial_status, "PENDING");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);
      const history = await prisma.order_status_history.count({ where: { order_id: orderId, to_status: "DELIVERED" } });
      assert.equal(history, 0);

      // Driver Cash was credited BEFORE the wallet step failed — it must be
      // rolled back too, proving this is one atomic transaction.
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "0");
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 0);

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0, "no audit row should survive a rolled-back transaction");

      // Restore for cleanup ordering (cleanupTestCustomerRecord expects a wallet row is fine either way, but
      // recreate it so any later shared assertions on this customer stay well-formed).
      await prisma.customer_wallets.create({ data: { customer_id: customerId } });
    });

    test("11. missing driver cash account -> 500, entire transaction rolls back (no wallet/company posting)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-missing-cash-account");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driver.driverId } });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY");
      assert.equal(row.financial_status, "PENDING");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);

      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 0);

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0);

      await prisma.driver_cash_accounts.create({ data: { driver_id: driver.driverId } });
    });

    test("12. forced company-revenue idempotency-key collision -> 409/500, entire transaction rolls back", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-company-collision");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      // Pre-occupy the exact idempotency key this delivery will try to use
      // for its company delivery-fee revenue row.
      await prisma.company_financial_transactions.create({
        data: {
          type: "DELIVERY_FEE_REVENUE",
          amount: new Prisma.Decimal("1.00"),
          idempotency_key: `delivery:${orderId}:delivery-fee-revenue`,
        },
      });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.ok([409, 500].includes(res.status), JSON.stringify(res.body));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(row.status, "OUT_FOR_DELIVERY", "colliding on the company revenue key must roll back the whole transaction");
      assert.equal(row.financial_status, "PENDING");

      const attempts = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attempts, 0);

      // Driver Cash and Wallet steps ran before the company step — both
      // must be rolled back.
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "0");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");

      // Exactly the one pre-seeded collision row remains — the real
      // delivery-fee posting never committed.
      const companyRows = await prisma.company_financial_transactions.findMany({ where: { idempotency_key: `delivery:${orderId}:delivery-fee-revenue` } });
      assert.equal(companyRows.length, 1);
      assert.equal(companyRows[0].amount.toString(), "1");

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0);

      // Manually-seeded collision row has no order_id, so cleanupTestOrder's
      // order-scoped deleteMany won't reach it — remove it explicitly.
      await prisma.company_financial_transactions.deleteMany({
        where: { idempotency_key: `delivery:${orderId}:delivery-fee-revenue` },
      });
    });
  });

  // ============================================================
  // 13-15. DUPLICATE / CONCURRENCY
  // ============================================================

  describe("Duplicate / concurrency protection", () => {
    test("13. sequential duplicate deliver: second call rejected, ledger rows created exactly once", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-seq-dup");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const first = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const second = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(second.status, 400, JSON.stringify(second.body));

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 1);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 1);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 1);
    });

    test("14. concurrent deliver vs deliver: exactly one winner, ledger rows created exactly once", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-conc-dup");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const [a, b] = await Promise.all([
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      assert.equal(cashTxCount, 1);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 1);
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });
      assert.equal(companyTxCount, 1);

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "105");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "100");
    });

    test("15. concurrent deliver vs fail: finance rows exist iff DELIVERED won, never both", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-conc-fail-dup");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const [deliverRes, failRes] = await Promise.all([
        deliver(orderId, driver.token, { actualAmountCollected: "105.00" }),
        request(app).post(failPath(orderId)).set(auth(driver.token)).send({ failedReasonId: reasonId }),
      ]);
      const statuses = [deliverRes.status, failRes.status].sort();
      assert.equal(statuses[0], 200);
      assert.ok([400, 409].includes(statuses[1]));

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { order_id: orderId } });
      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      const companyTxCount = await prisma.company_financial_transactions.count({ where: { order_id: orderId } });

      if (row.status === "DELIVERED") {
        assert.equal(cashTxCount, 1);
        assert.equal(walletTxCount, 1);
        assert.equal(companyTxCount, 1);
      } else {
        assert.equal(row.status, "FAILED_DELIVERY");
        assert.equal(cashTxCount, 0);
        assert.equal(walletTxCount, 0);
        assert.equal(companyTxCount, 0);
      }
    });
  });

  // ============================================================
  // 16. WALLET PENDING -> AVAILABLE MIGRATION
  // ============================================================

  describe("Wallet pending -> available migration", () => {
    test("16. remaining_order_amount counts as pending while active, moves to available on exact delivery", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-pending-migration");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const before = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(before.status, 200, JSON.stringify(before.body));
      assert.equal(before.body.data.wallet.pendingAmount, "100");
      assert.equal(before.body.data.wallet.availableBalance, "0");

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const after = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(after.status, 200);
      assert.equal(after.body.data.wallet.pendingAmount, "0", "a DELIVERED order no longer counts toward pending");
      assert.equal(after.body.data.wallet.availableBalance, "100", "the qualifying order portion is now finalized and available");
    });
  });

  // ============================================================
  // 17. DRIVER CASH MULTI-ORDER CHAIN
  // ============================================================

  describe("Driver cash multi-order chain", () => {
    test("17. same Driver, two sequential exact deliveries: balances chain coherently", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-multi-order");

      const orderA = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      const resA = await deliver(orderA, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(resA.status, 200, JSON.stringify(resA.body));

      const txA = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderA } });
      assert.equal(txA.balance_before.toString(), "0");
      assert.equal(txA.balance_after.toString(), "105");

      const orderB = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderAmount: "50.00", deliveryFee: "3.00" });
      const resB = await deliver(orderB, driver.token, { actualAmountCollected: "53.00" });
      assert.equal(resB.status, 200, JSON.stringify(resB.body));

      const txB = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderB } });
      assert.equal(txB.balance_before.toString(), "105");
      assert.equal(txB.balance_after.toString(), "158");

      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "158");
    });
  });

  // ============================================================
  // 18-20. FINANCIAL TRANSACTION REFERENCES / ACTOR / PAYMENT METHOD
  // ============================================================

  describe("Financial transaction references", () => {
    test("18-20. driver cash / wallet / company rows carry correct order, actor and payment-method references", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-references");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(cashTx.driver_id, driver.driverId);
      assert.equal(cashTx.order_id, orderId);
      assert.equal(cashTx.created_by_id, driver.userId, "the actor is the authenticated Driver's USER id");
      assert.equal(cashTx.type, "COLLECTION");

      const walletTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(walletTx.customer_id, customerId);
      assert.equal(walletTx.order_id, orderId);
      assert.equal(walletTx.processed_by_id, driver.userId);
      assert.equal(walletTx.type, "ORDER_CREDIT");

      const companyTx = await prisma.company_financial_transactions.findFirstOrThrow({ where: { order_id: orderId } });
      assert.equal(companyTx.order_id, orderId);
      assert.equal(companyTx.created_by_id, driver.userId);
      assert.equal(companyTx.payment_method_id, cashMethodId);
      assert.equal(companyTx.type, "DELIVERY_FEE_REVENUE");
    });
  });

  // ============================================================
  // 21-23. AUDIT BEHAVIOR
  // ============================================================

  describe("Audit behavior", () => {
    test("21-22. a finalized exact delivery creates exactly one audit row referencing the Order and the Driver actor", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-audit");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0].action, "DELIVERY_ONLY_FINANCE_FINALIZED");
      assert.equal(auditRows[0].actor_user_id, driver.userId);
    });

    test("23. audit row is never created when the finance transaction rolls back", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-audit-rollback");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      await prisma.customer_wallets.deleteMany({ where: { customer_id: customerId } });
      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 500);

      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "ORDER", entity_id: orderId } });
      assert.equal(auditCount, 0);

      await prisma.customer_wallets.create({ data: { customer_id: customerId } });
    });
  });

  // ============================================================
  // 24-27. SCOPE BOUNDARY
  // ============================================================

  describe("Scope boundary", () => {
    // Phase 8.4 integrated exact COMPANY_ORDER finance (Driver Cash +
    // Company product/fee revenue) — see the dedicated Phase 8.4
    // company-order-finance.test.ts suite for full coverage of that. What
    // THIS suite (Phase 8.3, DELIVERY_ONLY-focused) must keep guarding
    // permanently is the cross-order-type boundary: a COMPANY_ORDER must
    // never credit the customer wallet, and never post the DELIVERY_ONLY
    // wallet-credit idempotency key.
    test("24. COMPANY_ORDER exact delivery finalizes via Phase 8.4 but still creates zero wallet transactions", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-boundary-company");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId, { orderType: "COMPANY_ORDER" });

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "DELIVERED");
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED");

      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } });
      assert.equal(walletTxCount, 0, "COMPANY_ORDER must never credit the customer wallet");
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
      assert.equal(wallet.available_balance.toString(), "0");
    });

    test("25. DELIVERY_ONLY collection difference remains REVIEW_REQUIRED with zero Wallet/Company allocation; Driver Cash now records actual (Phase 8.7)", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-boundary-diff");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);

      const res = await deliver(orderId, driver.token, { actualAmountCollected: "95.00", collectionDifferenceReason: "shortage" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "REVIEW_REQUIRED");

      await assertNoFinanceSideEffects([orderId], customerId, driver.driverId, 1);
      const cashAccount = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driver.driverId } });
      assert.equal(cashAccount.current_balance.toString(), "95", "Phase 8.7: Driver Cash records the actual amount collected");
    });

    test("26-27. no payout/settlement/adjustment/reversal row is ever created by /deliver", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-boundary-rows");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const payouts = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payouts, 0);
      const settlements = await prisma.driver_settlements.count({ where: { driver_id: driver.driverId } });
      assert.equal(settlements, 0);
      const walletAdjustmentsOrReversals = await prisma.wallet_transactions.count({
        where: { order_id: orderId, type: { in: ["ADJUSTMENT", "REVERSAL", "PAYOUT"] } },
      });
      assert.equal(walletAdjustmentsOrReversals, 0);
      const cashAdjustmentsOrReversals = await prisma.driver_cash_transactions.count({
        where: { order_id: orderId, type: { in: ["ADJUSTMENT", "REVERSAL", "SETTLEMENT"] } },
      });
      assert.equal(cashAdjustmentsOrReversals, 0);
    });
  });

  // ============================================================
  // 28-30. MANAGEMENT / DRIVER REPRESENTATION
  // ============================================================

  describe("Management / Driver representation", () => {
    test("28. Management order detail reflects FINALIZED financial status after exact delivery", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-mgmt-repr");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const detail = await request(app).get(`/api/v1/orders/${orderId}`).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.status, "DELIVERED");
      assert.equal(detail.body.data.financialStatus, "FINALIZED");
    });

    test("29. Finance-facing wallet transactions list shows the ORDER_CREDIT row for the delivered Order", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-wallet-repr");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const txList = await request(app).get(`/api/v1/wallets/${customerId}/transactions`).set(auth(tokens.admin));
      assert.equal(txList.status, 200, JSON.stringify(txList.body));
      const entry = txList.body.data.find((t: { order: { id: string } | null }) => t.order?.id === orderId);
      assert.ok(entry, "expected an ORDER_CREDIT transaction referencing this order");
      assert.equal(entry.type, "ORDER_CREDIT");
      assert.equal(entry.credit, "100");
      assert.equal(entry.debit, "0");
    });

    test("30. Driver's own cash page shows the COLLECTION row for the delivered Order, no Management/Wallet leakage", async () => {
      const customerId = await freshCustomer();
      const driver = await createDriverWithToken("driver-cash-repr");
      const orderId = await createOutForDeliveryOrder(customerId, driver.token, driver.driverId);
      await deliver(orderId, driver.token, { actualAmountCollected: "105.00" });

      const cashPage = await request(app).get("/api/v1/driver/me/cash").set(auth(driver.token));
      assert.equal(cashPage.status, 200, JSON.stringify(cashPage.body));
      assert.equal(cashPage.body.data.account.currentBalance, "105");
      const entry = cashPage.body.data.transactions.find((t: { order: { id: string } | null }) => t.order?.id === orderId);
      assert.ok(entry);
      assert.equal(entry.type, "COLLECTION");
      assert.equal(entry.amount, "105");
      assert.equal(JSON.stringify(cashPage.body).includes("wallet"), false, "Driver cash page must never leak wallet fields");
      assert.equal(JSON.stringify(cashPage.body).includes("company"), false, "Driver cash page must never leak company finance fields");
    });
  });
});
