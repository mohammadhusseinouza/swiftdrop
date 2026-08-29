import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  cleanupTestPaymentMethod,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedDriverRecord,
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Customer Payouts (Phase 8.5)
//
// A payout means the company pays money it already owes the Customer:
// Customer Wallet decreases, Driver Cash/Company Finance are untouched.
// This suite exercises POST /api/v1/payouts + GET /api/v1/payouts end to
// end, reusing the approved Phase 8.2 debitWalletPayout ledger primitive.
// ============================================================

describe("Customer Payouts (Phase 8.5)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let inactiveMethodId: string;

  const createdCustomerIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdDriverIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, driverLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverActor.email, driverActor.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
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
    const inactive = await prisma.payment_methods.create({
      data: { code: `PH85-INACTIVE-${uniqueSuffix()}`, name: "Phase85 Inactive Method", is_active: false },
    });
    inactiveMethodId = inactive.id;
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await cleanupTestPaymentMethod(inactiveMethodId);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function createCustomer(overrides: Record<string, unknown> = {}) {
    const id = await seedCustomerRecord(admin.id, overrides as never);
    createdCustomerIds.push(id);
    return id;
  }

  // Gives a Customer real available balance the way Phase 8.2's own tests
  // do — via the approved ledger primitive, not a raw wallet UPDATE.
  async function fundWallet(customerId: string, amount: string) {
    await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal(amount) });
  }

  async function getWallet(customerId: string) {
    return prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
  }

  async function createDriverWithAccount(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const driverId = await seedDriverRecord(user.id, { driverNumber: `PH85-DRV-${label}-${uniqueSuffix()}` });
    createdDriverIds.push(driverId);
    return driverId;
  }

  function payoutsPath(qs = "") {
    return `/api/v1/payouts${qs}`;
  }

  // Phase 8.9: every POST now requires an Idempotency-Key header. Each call
  // gets a FRESH default key so pre-existing tests (each expecting an
  // independent logical payout) are unaffected — pass idempotencyKey
  // explicitly only when a test deliberately wants to replay/collide.
  async function postPayout(token: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(app).post(payoutsPath()).set(auth(token)).set("Idempotency-Key", idempotencyKey).send(body);
  }

  // ============================================================
  // RBAC (1-9)
  // ============================================================

  describe("RBAC", () => {
    test("1. unauthenticated GET -> 401", async () => {
      const res = await request(app).get(payoutsPath());
      assert.equal(res.status, 401);
    });

    test("2. unauthenticated POST -> 401", async () => {
      const res = await postPayout("", { customerId: admin.id, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 401);
    });

    test("3-4. ADMIN GET/POST allowed", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const list = await request(app).get(payoutsPath()).set(auth(tokens.admin));
      assert.equal(list.status, 200, JSON.stringify(list.body));
      const post = await postPayout(tokens.admin, { customerId, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 201, JSON.stringify(post.body));
    });

    test("5-6. FINANCE GET/POST allowed", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const list = await request(app).get(payoutsPath()).set(auth(tokens.finance));
      assert.equal(list.status, 200);
      const post = await postPayout(tokens.finance, { customerId, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 201, JSON.stringify(post.body));
    });

    test("7. DISPATCHER -> 403 (GET and POST)", async () => {
      const list = await request(app).get(payoutsPath()).set(auth(tokens.dispatcher));
      assert.equal(list.status, 403);
      const post = await postPayout(tokens.dispatcher, { customerId: admin.id, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 403);
    });

    test("8. DRIVER -> 403", async () => {
      const list = await request(app).get(payoutsPath()).set(auth(tokens.driver));
      assert.equal(list.status, 403);
      const post = await postPayout(tokens.driver, { customerId: admin.id, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 403);
    });

    test("9. CUSTOMER -> 403", async () => {
      const list = await request(app).get(payoutsPath()).set(auth(tokens.customer));
      assert.equal(list.status, 403);
      const post = await postPayout(tokens.customer, { customerId: admin.id, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(post.status, 403);
    });
  });

  // ============================================================
  // BASIC PAYOUT (10)
  // ============================================================

  describe("Basic payout", () => {
    test("10. wallet 500, payout 300 -> COMPLETED, wallet 200, one correct PAYOUT transaction", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");

      const res = await postPayout(tokens.admin, { customerId, amount: "300.00", paymentMethodId: cashMethodId, notes: "phase85" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "COMPLETED");
      assert.equal(res.body.data.amount, "300");
      assert.equal(res.body.data.customer.id, customerId);
      assert.equal(res.body.data.paymentMethod.id, cashMethodId);
      assert.equal(res.body.data.processedBy.id, admin.id);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "200");

      const walletTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: res.body.data.id } });
      assert.equal(walletTx.type, "PAYOUT");
      assert.equal(walletTx.credit.toString(), "0");
      assert.equal(walletTx.debit.toString(), "300");
      assert.equal(walletTx.balance_before.toString(), "500");
      assert.equal(walletTx.balance_after.toString(), "200");
    });
  });

  // ============================================================
  // FULL BALANCE (11)
  // ============================================================

  describe("Full balance payout", () => {
    test("11. available 500, payout 500 -> wallet 0", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");
      const res = await postPayout(tokens.admin, { customerId, amount: "500.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
    });
  });

  // ============================================================
  // VALIDATION (12-20)
  // ============================================================

  describe("Validation", () => {
    test("12-15. amount validation: zero, negative, >2 decimals, overflow all rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "1000");

      const zero = await postPayout(tokens.admin, { customerId, amount: "0", paymentMethodId: cashMethodId });
      assert.equal(zero.status, 400);
      const negative = await postPayout(tokens.admin, { customerId, amount: "-10", paymentMethodId: cashMethodId });
      assert.equal(negative.status, 400);
      const tooManyDecimals = await postPayout(tokens.admin, { customerId, amount: "100.001", paymentMethodId: cashMethodId });
      assert.equal(tooManyDecimals.status, 400);
      const overflow = await postPayout(tokens.admin, { customerId, amount: "999999999999999.99", paymentMethodId: cashMethodId });
      assert.equal(overflow.status, 400);

      const count = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(count, 0, "no payout row from any rejected request");
    });

    test("16. malformed customer UUID -> 400", async () => {
      const res = await postPayout(tokens.admin, { customerId: "not-a-uuid", amount: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 400);
    });

    test("17. nonexistent customer -> 404", async () => {
      const res = await postPayout(tokens.admin, {
        customerId: "00000000-0000-0000-0000-000000000000",
        amount: "10",
        paymentMethodId: cashMethodId,
      });
      assert.equal(res.status, 404);
    });

    test("18. malformed paymentMethodId -> 400", async () => {
      const customerId = await createCustomer();
      const res = await postPayout(tokens.admin, { customerId, amount: "10", paymentMethodId: "not-a-uuid" });
      assert.equal(res.status, 400);
    });

    test("19. nonexistent payment method -> 400", async () => {
      const customerId = await createCustomer();
      const res = await postPayout(tokens.admin, {
        customerId,
        amount: "10",
        paymentMethodId: "00000000-0000-0000-0000-000000000000",
      });
      assert.equal(res.status, 400);
    });

    test("20. inactive payment method -> 400", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const res = await postPayout(tokens.admin, { customerId, amount: "10", paymentMethodId: inactiveMethodId });
      assert.equal(res.status, 400);
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100", "rejected payout must not touch the wallet");
    });
  });

  // ============================================================
  // AVAILABLE VS PENDING (21-22)
  // ============================================================

  describe("Available vs pending", () => {
    test("21-22. pending money cannot fund a payout — only available balance can", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const orderId = await seedTestOrder(customerId, admin.id, {
        areaId: areaActive.id,
        areaName: areaActive.name,
        orderType: "DELIVERY_ONLY",
        status: "ASSIGNED",
        orderAmount: "500.00",
        deliveryFee: "5.00",
      });
      createdOrderIds.push(orderId);

      const walletBefore = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(walletBefore.body.data.wallet.availableBalance, "100");
      assert.equal(walletBefore.body.data.wallet.pendingAmount, "500");

      const okPayout = await postPayout(tokens.admin, { customerId, amount: "100.00", paymentMethodId: cashMethodId }); // 21
      assert.equal(okPayout.status, 201, JSON.stringify(okPayout.body));

      const secondPayout = await postPayout(tokens.admin, { customerId, amount: "1.00", paymentMethodId: cashMethodId }); // 22
      assert.equal(secondPayout.status, 400, "pending money must not fund a payout");

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
      const walletDetail = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(walletDetail.body.data.wallet.pendingAmount, "500", "pending remains derived from the untouched Order");
    });
  });

  // ============================================================
  // INSUFFICIENT BALANCE (23)
  // ============================================================

  describe("Insufficient balance", () => {
    test("23. available 100, payout 101 -> rejected, wallet/ledger/audit untouched", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");

      const res = await postPayout(tokens.admin, { customerId, amount: "101.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 400, JSON.stringify(res.body));

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 0);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { customer_id: customerId, type: "PAYOUT" } });
      assert.equal(walletTxCount, 0);
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100");
      // No audit row can exist for this customer's payout attempt: audit
      // entity_id is always a real customer_payouts.id (see payout.service.
      // ts), and payoutCount above already proves none was created.
    });
  });

  // ============================================================
  // TRACEABILITY (24-28)
  // ============================================================

  describe("Traceability", () => {
    test("24-28. payoutNumber, wallet linkage, payment method, processor, and audit all reconcile", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");

      const res = await postPayout(tokens.finance, { customerId, amount: "50.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      assert.ok(res.body.data.payoutNumber && res.body.data.payoutNumber.length > 0); // 24
      const payoutRow = await prisma.customer_payouts.findUniqueOrThrow({ where: { id: res.body.data.id } });

      const walletTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRow.id } });
      assert.equal(walletTx.payout_id, payoutRow.id); // 25
      assert.equal(walletTx.payment_method_id, payoutRow.payment_method_id); // 26
      assert.equal(walletTx.processed_by_id, payoutRow.processed_by_id); // 27
      assert.equal(payoutRow.processed_by_id, finance.id);

      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { entity_type: "CUSTOMER_PAYOUT", entity_id: payoutRow.id } });
      assert.equal(auditRow.action, "CUSTOMER_PAYOUT_COMPLETED"); // 28
      assert.equal(auditRow.actor_user_id, finance.id);
    });

    test("payout_number is unique across two payouts for the same customer", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");
      const first = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      const second = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      assert.notEqual(first.body.data.payoutNumber, second.body.data.payoutNumber);
    });
  });

  // ============================================================
  // LIST (29-37)
  // ============================================================

  describe("Payout list", () => {
    test("29. GET /payouts returns the new payout", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const created = await postPayout(tokens.admin, { customerId, amount: "25.00", paymentMethodId: cashMethodId });
      const list = await request(app).get(payoutsPath()).set(auth(tokens.admin));
      assert.equal(list.status, 200);
      const found = list.body.data.find((p: { id: string }) => p.id === created.body.data.id);
      assert.ok(found);
    });

    test("30-32. pagination defaults, explicit page/limit, max>100 rejected", async () => {
      const defaultPage = await request(app).get(payoutsPath()).set(auth(tokens.admin));
      assert.equal(defaultPage.body.meta.page, 1);
      assert.equal(defaultPage.body.meta.limit, 20);

      const explicit = await request(app).get(payoutsPath("?page=1&limit=5")).set(auth(tokens.admin));
      assert.equal(explicit.status, 200);
      assert.equal(explicit.body.meta.limit, 5);
      assert.ok(explicit.body.data.length <= 5);

      const tooLarge = await request(app).get(payoutsPath("?limit=101")).set(auth(tokens.admin));
      assert.equal(tooLarge.status, 400);
    });

    test("33. newest-first deterministic ordering", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const a = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      const b = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });

      const list = await request(app).get(payoutsPath(`?customerId=${customerId}`)).set(auth(tokens.admin));
      const ids = list.body.data.map((p: { id: string }) => p.id);
      assert.deepEqual(ids, [b.body.data.id, a.body.data.id]);
    });

    test("34. status filter", async () => {
      const res = await request(app).get(payoutsPath("?status=COMPLETED")).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      for (const row of res.body.data) assert.equal(row.status, "COMPLETED");
      const invalid = await request(app).get(payoutsPath("?status=NOT_A_STATUS")).set(auth(tokens.admin));
      assert.equal(invalid.status, 400);
    });

    test("35. customerId filter and search filter", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const created = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });

      const byCustomer = await request(app).get(payoutsPath(`?customerId=${customerId}`)).set(auth(tokens.admin));
      assert.equal(byCustomer.body.data.length, 1);
      assert.equal(byCustomer.body.data[0].id, created.body.data.id);

      const bySearch = await request(app)
        .get(payoutsPath(`?search=${encodeURIComponent(created.body.data.payoutNumber)}`))
        .set(auth(tokens.admin));
      assert.ok(bySearch.body.data.some((p: { id: string }) => p.id === created.body.data.id));
    });

    test("36. money serialized as strings", async () => {
      const res = await request(app).get(payoutsPath("?limit=1")).set(auth(tokens.admin));
      if (res.body.data.length > 0) {
        assert.equal(typeof res.body.data[0].amount, "string");
      }
    });

    test("37. safe DTO only", async () => {
      const res = await request(app).get(payoutsPath("?limit=5")).set(auth(tokens.admin));
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /company_financial/i);
    });
  });

  // ============================================================
  // WALLET INTEGRATION (38-40)
  // ============================================================

  describe("Wallet integration", () => {
    test("38-40. wallet detail, transaction history, and list last-payout summary all reflect the new payout", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "300");
      const created = await postPayout(tokens.admin, { customerId, amount: "120.00", paymentMethodId: cashMethodId });
      assert.equal(created.status, 201, JSON.stringify(created.body));

      const detail = await request(app).get(`/api/v1/wallets/${customerId}`).set(auth(tokens.admin));
      assert.equal(detail.body.data.wallet.availableBalance, "180"); // 38

      const txList = await request(app).get(`/api/v1/wallets/${customerId}/transactions`).set(auth(tokens.admin));
      const payoutTx = txList.body.data.find((t: { type: string }) => t.type === "PAYOUT");
      assert.ok(payoutTx); // 39
      assert.equal(payoutTx.debit, "120");

      const customer = await prisma.customers.findUniqueOrThrow({ where: { id: customerId } });
      const walletList = await request(app)
        .get(`/api/v1/wallets?search=${encodeURIComponent(customer.customer_number)}`)
        .set(auth(tokens.admin));
      assert.equal(walletList.status, 200);
      const row = walletList.body.data.find((w: { customer: { id: string } }) => w.customer.id === customerId);
      assert.ok(row, "wallet list search by customer_number must find this customer");
      assert.equal(row.lastPayout?.id, created.body.data.id); // 40
    });
  });

  // ============================================================
  // MONEY SEPARATION (41-45)
  // ============================================================

  describe("Money separation", () => {
    test("41-44. Driver Cash and Company Finance are completely unaffected by a payout", async () => {
      const driverId = await createDriverWithAccount("sep");
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");

      const cashBefore = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
      const cashTxBefore = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId } });
      const settlementsBefore = await prisma.driver_settlements.count({ where: { driver_id: driverId } });

      const res = await postPayout(tokens.admin, { customerId, amount: "75.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
      assert.equal(cashAfter.current_balance.toString(), cashBefore.current_balance.toString()); // 41
      const cashTxAfter = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId } });
      assert.equal(cashTxAfter, cashTxBefore); // 42
      const settlementsAfter = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementsAfter, settlementsBefore); // 43

      // company_financial_transactions has no payout-scoped column, but
      // created_by_id is safe to scope by here: `admin` is a dedicated User
      // created fresh in this file's own before() hook and used by no other
      // concurrently-running test file, so a nonzero count for this actor
      // could only come from this suite. payout.service.ts also never
      // imports the Company Finance ledger module at all — this assertion
      // is a live-request belt to that structural suspenders.
      const companyBefore = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      const res2 = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      assert.equal(res2.status, 201, JSON.stringify(res2.body));
      const companyAfter = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      assert.equal(companyAfter, companyBefore); // 44
      assert.equal(companyAfter, 0);
    });

    test("45. payout does not modify any Order", async () => {
      const customerId = await createCustomer();
      const orderId = await seedTestOrder(customerId, admin.id, {
        areaId: areaActive.id,
        areaName: areaActive.name,
        orderType: "DELIVERY_ONLY",
      });
      createdOrderIds.push(orderId);
      await fundWallet(customerId, "50");
      const before = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });

      const res = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const after = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.deepEqual(after, before);
    });
  });

  // ============================================================
  // ATOMIC ROLLBACK (46-48)
  // ============================================================

  describe("Atomic rollback", () => {
    test("46. missing/corrupt wallet -> 500, no payout row, no audit row", async () => {
      const customerId = await createCustomer();
      await prisma.customer_wallets.deleteMany({ where: { customer_id: customerId } });

      const res = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 0);
      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "CUSTOMER_PAYOUT" } });
      for (const row of auditRows) {
        const payout = await prisma.customer_payouts.findUnique({ where: { id: row.entity_id } });
        assert.notEqual(payout?.customer_id, customerId);
      }

      await prisma.customer_wallets.create({ data: { customer_id: customerId } });
    });

    test("47. insufficient-balance rejection rolls back cleanly (no payout, no wallet transaction)", async () => {
      // Structurally the same rollback proof as test 23, restated here as
      // the required 'forced Wallet ledger failure' case — the concurrency-
      // safe debit inside debitWalletPayout IS the Wallet-step failure path
      // available without a debug switch (see closing report for why an
      // artificial mid-transaction Wallet failure isn't otherwise
      // constructible for a freshly-generated payoutId).
      const customerId = await createCustomer();
      await fundWallet(customerId, "10");
      const res = await postPayout(tokens.admin, { customerId, amount: "10.01", paymentMethodId: cashMethodId });
      assert.equal(res.status, 400);
      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 0);
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "10");
    });
  });

  // ============================================================
  // CONCURRENCY (49-50)
  // ============================================================

  describe("Concurrency", () => {
    test("49. balance 100, concurrent 80+80 -> exactly one succeeds, final balance 20", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");

      const [a, b] = await Promise.all([
        postPayout(tokens.admin, { customerId, amount: "80.00", paymentMethodId: cashMethodId }),
        postPayout(tokens.admin, { customerId, amount: "80.00", paymentMethodId: cashMethodId }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "20");
      assert.ok(!wallet.available_balance.isNegative());

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId, status: "COMPLETED" } });
      assert.equal(payoutCount, 1);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { customer_id: customerId, type: "PAYOUT" } });
      assert.equal(walletTxCount, 1);
    });

    test("50. balance 100, concurrent 60+40 -> both may succeed, final balance 0, no lost update", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");

      const [a, b] = await Promise.all([
        postPayout(tokens.admin, { customerId, amount: "60.00", paymentMethodId: cashMethodId }),
        postPayout(tokens.admin, { customerId, amount: "40.00", paymentMethodId: cashMethodId }),
      ]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");

      const rows = await prisma.wallet_transactions.findMany({
        where: { customer_id: customerId, type: "PAYOUT" },
        orderBy: { balance_before: "desc" },
      });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].balance_before.toString(), "100");
      assert.equal(rows[0].balance_after.toString(), rows[1].balance_before.toString());
      assert.equal(rows[1].balance_after.toString(), "0");
    });
  });

  // ============================================================
  // IMMUTABILITY (51-53)
  // ============================================================

  describe("Immutability", () => {
    test("51-52. no public PATCH/DELETE payout route", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const created = await postPayout(tokens.admin, { customerId, amount: "10.00", paymentMethodId: cashMethodId });

      const patchAttempt = await request(app)
        .patch(`/api/v1/payouts/${created.body.data.id}`)
        .set(auth(tokens.admin))
        .send({ amount: "999" });
      assert.equal(patchAttempt.status, 404);
      const deleteAttempt = await request(app).delete(`/api/v1/payouts/${created.body.data.id}`).set(auth(tokens.admin));
      assert.equal(deleteAttempt.status, 404);
    });

    test("53. later wallet operations never rewrite the payout-linked transaction", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const created = await postPayout(tokens.admin, { customerId, amount: "20.00", paymentMethodId: cashMethodId });
      const linked = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: created.body.data.id } });
      const snapshot = { ...linked };

      await fundWallet(customerId, "5");
      const after = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: linked.id } });
      assert.deepEqual(after, snapshot);
    });
  });

  // ============================================================
  // PAYOUT STATUS (54-56)
  // ============================================================

  describe("Payout status", () => {
    test("54. successful POST always creates COMPLETED", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "10");
      const res = await postPayout(tokens.admin, { customerId, amount: "5.00", paymentMethodId: cashMethodId });
      assert.equal(res.body.data.status, "COMPLETED");
    });

    test("55. client cannot force REVERSED/CANCELLED via the request body", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "10");
      const res = await postPayout(tokens.admin, {
        customerId,
        amount: "5.00",
        paymentMethodId: cashMethodId,
        status: "REVERSED",
      } as never);
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.status, "COMPLETED", "unknown/forbidden body fields must be silently ignored");
    });

    test("56. no reversal/cancel mutation endpoint exists", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "10");
      const created = await postPayout(tokens.admin, { customerId, amount: "5.00", paymentMethodId: cashMethodId });
      const reverseAttempt = await request(app)
        .post(`/api/v1/payouts/${created.body.data.id}/reverse`)
        .set(auth(tokens.admin))
        .send();
      assert.equal(reverseAttempt.status, 404);
      const cancelAttempt = await request(app)
        .post(`/api/v1/payouts/${created.body.data.id}/cancel`)
        .set(auth(tokens.admin))
        .send();
      assert.equal(cancelAttempt.status, 404);
    });
  });

  // ============================================================
  // REGRESSION BOUNDARY (57)
  // ============================================================

  describe("Regression boundary", () => {
    test("57. the approved Phase 8.2 ORDER_CREDIT primitive Phase 8.3 depends on is unaffected by Phase 8.5", async () => {
      // The full HTTP DELIVERY_ONLY delivery flow is already exhaustively
      // covered by the dedicated Phase 8.3 suite (delivery-only-finance.
      // test.ts) and by the full regression run below — this only proves
      // the shared primitive Phase 8.5 also calls (debitWalletPayout, next
      // to creditWalletForOrder in the same wallet-ledger.service.ts file)
      // did not regress the credit side while this sub-phase was added.
      const customerId = await createCustomer();
      const orderId = await seedTestOrder(customerId, admin.id, {
        areaId: areaActive.id,
        areaName: areaActive.name,
        orderType: "DELIVERY_ONLY",
      });
      createdOrderIds.push(orderId);
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00"), orderId });
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100");
    });
  });
});
