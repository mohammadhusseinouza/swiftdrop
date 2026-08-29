import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import {
  applyWalletAdjustment,
  applyWalletReversal,
  applyWalletTransaction,
  creditWalletForOrder,
  debitWalletPayout,
  runWalletTransaction,
} from "../../src/modules/wallets/wallet-ledger.service";
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
  seedTestOrder,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

describe("Customer Wallet Ledger Foundation (Phase 8.2)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
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
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
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

  async function getWallet(customerId: string) {
    return prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
  }

  async function seedOrder(customerId: string, overrides: Record<string, unknown> = {}) {
    const id = await seedTestOrder(customerId, admin.id, {
      areaId: areaActive.id,
      areaName: areaActive.name,
      ...overrides,
    } as never);
    createdOrderIds.push(id);
    return id;
  }

  function walletsPath(qs = "") {
    return `/api/v1/wallets${qs}`;
  }
  function walletDetailPath(customerId: string) {
    return `/api/v1/wallets/${customerId}`;
  }
  function walletTransactionsPath(customerId: string, qs = "") {
    return `/api/v1/wallets/${customerId}/transactions${qs}`;
  }

  // A customer whose wallet is deliberately deleted (never reachable via
  // any real API) — deliberately NOT tracked in createdCustomerIds. GET
  // /api/v1/wallets scans across ALL customers, so a leftover corrupted-
  // wallet fixture would fail every later unscoped list call in this file
  // until after() finally runs. Callers must clean it up immediately via
  // cleanupTestCustomerRecord once their assertions are done.
  async function createCustomerWithMissingWallet() {
    const id = await seedCustomerRecord(admin.id);
    await prisma.customer_wallets.deleteMany({ where: { customer_id: id } });
    return id;
  }

  // driver_cash_transactions is scoped to a specific driverId — Phase 8.1's
  // own test suite legitimately creates/deletes many such rows concurrently
  // (Node runs test files in parallel), so an unscoped global count here
  // would race against it. company_financial_transactions is now written by
  // Phase 8.3/8.4/8.7/8.8 (delivery revenue, difference resolution,
  // adjustments/reversals) from many concurrently-running test files, so an
  // unscoped global count here is stale test debt — scope it to this file's
  // own dedicated `admin` actor instead (Phase 8.10 test-isolation review),
  // the same precedent already used by payout.test.ts. Every company row
  // this file itself could create is either delivery-sourced (created_by_id
  // is the DRIVER's user id, never admin's) or would have to come from an
  // admin-driven adjustment/reversal this file never performs — so any
  // change in this count could only be caused by this test's own actions.
  async function countDriverAndCompanyTransactions(driverId: string) {
    const [cashTx, companyTx] = await Promise.all([
      prisma.driver_cash_transactions.count({ where: { driver_id: driverId } }),
      prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } }),
    ]);
    return { cashTx, companyTx };
  }

  // ============================================================
  // ACCOUNT CREATION / INTEGRITY (1-5)
  // ============================================================

  describe("Account creation / integrity", () => {
    test("1-2. newly-created Customer has exactly one wallet with availableBalance 0", async () => {
      const customerId = await createCustomer();
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
      const count = await prisma.customer_wallets.count({ where: { customer_id: customerId } });
      assert.equal(count, 1);
    });

    test("3-4. missing wallet for an existing Customer fails closed on detail read and on the mutation primitive", async () => {
      const customerId = await createCustomerWithMissingWallet();

      const res = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);

      await assert.rejects(() =>
        runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("10.00") })
      );

      await cleanupTestCustomerRecord(customerId);
    });

    test("5. no automatic repair — wallet stays missing after the failed attempts", async () => {
      const customerId = await createCustomerWithMissingWallet();
      await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      await assert.rejects(() => runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("10.00") }));

      const stillMissing = await prisma.customer_wallets.findUnique({ where: { customer_id: customerId } });
      assert.equal(stillMissing, null);

      await cleanupTestCustomerRecord(customerId);
    });
  });

  // ============================================================
  // MANAGEMENT RBAC (6-12)
  // ============================================================

  describe("Management RBAC", () => {
    test("6. unauthenticated list -> 401", async () => {
      const res = await request(app).get(walletsPath());
      assert.equal(res.status, 401);
    });

    test("7. ADMIN wallets.read -> allowed", async () => {
      const res = await request(app).get(walletsPath()).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("8. FINANCE wallets.read -> allowed", async () => {
      const res = await request(app).get(walletsPath()).set(auth(tokens.finance));
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("9. DISPATCHER -> 403", async () => {
      const res = await request(app).get(walletsPath()).set(auth(tokens.dispatcher));
      assert.equal(res.status, 403);
    });

    test("10. DRIVER -> 403", async () => {
      const res = await request(app).get(walletsPath()).set(auth(tokens.driver));
      assert.equal(res.status, 403);
    });

    test("11. CUSTOMER -> 403 on Management wallet APIs", async () => {
      const res = await request(app).get(walletsPath()).set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });

    test("12. customer.wallet.read_own alone does not authorize the Management endpoint", async () => {
      const customerId = await createCustomer();
      const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.customer));
      assert.equal(detail.status, 403);
      const transactions = await request(app).get(walletTransactionsPath(customerId)).set(auth(tokens.customer));
      assert.equal(transactions.status, 403);
    });
  });

  // ============================================================
  // ORDER CREDIT (13-15)
  // ============================================================

  describe("Order credit", () => {
    test("13-15. credit 100 via creditWalletForOrder: fields correct, order reference and processedBy saved", async () => {
      const customerId = await createCustomer();
      const orderId = await seedOrder(customerId);

      const result = await prisma.$transaction((tx) =>
        creditWalletForOrder(tx, { customerId, amount: decimal("100.00"), orderId, processedById: admin.id })
      );

      assert.equal(result.transaction.type, "ORDER_CREDIT");
      assert.equal(result.transaction.credit.toString(), "100");
      assert.equal(result.transaction.debit.toString(), "0");
      assert.equal(result.transaction.balance_before.toString(), "0");
      assert.equal(result.transaction.balance_after.toString(), "100");
      assert.equal(result.wallet.available_balance.toString(), "100");
      assert.equal(result.transaction.order_id, orderId); // 14
      assert.equal(result.transaction.processed_by_id, admin.id); // 15
    });
  });

  // ============================================================
  // MULTIPLE CREDITS (16-17)
  // ============================================================

  describe("Multiple credits", () => {
    test("16-17. credit 100 then credit 50: chained before/after, availableBalance 150", async () => {
      const customerId = await createCustomer();
      const first = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });
      const second = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("50.00") });

      assert.equal(first.transaction.balance_before.toString(), "0");
      assert.equal(first.transaction.balance_after.toString(), "100");
      assert.equal(second.transaction.balance_before.toString(), "100");
      assert.equal(second.transaction.balance_after.toString(), "150");

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "150");
    });
  });

  // ============================================================
  // PAYOUT PRIMITIVE (18-20)
  // ============================================================

  describe("Payout primitive", () => {
    test("18-20. starting wallet 150, internal PAYOUT debit 40 -> 110, no CustomerPayout row required", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("150.00") });

      // Deliberately not linking a real payoutId — Phase 8.5 owns
      // customer_payouts row creation; this only exercises the primitive.
      const result = await prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("40.00") }));

      assert.equal(result.transaction.type, "PAYOUT");
      assert.equal(result.transaction.credit.toString(), "0");
      assert.equal(result.transaction.debit.toString(), "40");
      assert.equal(result.transaction.balance_before.toString(), "150");
      assert.equal(result.transaction.balance_after.toString(), "110");
      assert.equal(result.wallet.available_balance.toString(), "110");
    });
  });

  // ============================================================
  // INSUFFICIENT BALANCE (21-24)
  // ============================================================

  describe("Insufficient balance", () => {
    test("21-24. wallet 100, PAYOUT debit 120 rejected, wallet/ledger untouched", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });

      await assert.rejects(() => prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("120.00") })));

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100"); // 23
      const count = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      assert.equal(count, 1, "only the original credit, no partial debit row"); // 24
    });
  });

  // ============================================================
  // ADJUSTMENT FOUNDATION (25-26)
  // ============================================================

  describe("Adjustment foundation", () => {
    test("25-26. internal ADJUSTMENT credit and debit both append correctly", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });

      const creditAdj = await prisma.$transaction((tx) =>
        applyWalletAdjustment(tx, { customerId, direction: "CREDIT", amount: decimal("10.00"), notes: "correction credit" })
      );
      assert.equal(creditAdj.transaction.credit.toString(), "10");
      assert.equal(creditAdj.transaction.balance_after.toString(), "110");

      const debitAdj = await prisma.$transaction((tx) =>
        applyWalletAdjustment(tx, { customerId, direction: "DEBIT", amount: decimal("5.00"), notes: "correction debit" })
      );
      assert.equal(debitAdj.transaction.debit.toString(), "5");
      assert.equal(debitAdj.transaction.balance_after.toString(), "105");

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "105");
    });
  });

  // ============================================================
  // REVERSAL FOUNDATION (27)
  // ============================================================

  describe("Reversal foundation", () => {
    test("27. technical REVERSAL record supports explicit direction + reversalOfId", async () => {
      const customerId = await createCustomer();
      const original = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });

      const reversal = await prisma.$transaction((tx) =>
        applyWalletReversal(tx, { customerId, direction: "DEBIT", amount: decimal("100.00"), reversalOfId: original.transaction.id })
      );
      assert.equal(reversal.transaction.type, "REVERSAL");
      assert.equal(reversal.transaction.reversal_of_id, original.transaction.id);
      assert.equal(reversal.transaction.balance_after.toString(), "0");

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
    });
  });

  // ============================================================
  // TYPE/DIRECTION (28-29)
  // ============================================================

  describe("Type/direction", () => {
    test("28. ORDER_CREDIT + DEBIT rejected, no mutation", async () => {
      const customerId = await createCustomer();
      await assert.rejects(() =>
        prisma.$transaction((tx) => applyWalletTransaction(tx, { customerId, type: "ORDER_CREDIT", direction: "DEBIT", amount: decimal("10.00") }))
      );
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
    });

    test("29. PAYOUT + CREDIT rejected, no mutation", async () => {
      const customerId = await createCustomer();
      await assert.rejects(() =>
        prisma.$transaction((tx) => applyWalletTransaction(tx, { customerId, type: "PAYOUT", direction: "CREDIT", amount: decimal("10.00") }))
      );
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
    });
  });

  // ============================================================
  // MONEY VALIDATION (30-34)
  // ============================================================

  describe("Money validation", () => {
    test("30. 0.10 + 0.20 -> exact 0.30, no float drift", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("0.10") });
      const second = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("0.20") });
      assert.equal(second.transaction.balance_after.toString(), "0.3");
    });

    test("31. >2 decimal places rejected", async () => {
      const customerId = await createCustomer();
      await assert.rejects(() => runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("10.001") }));
    });

    test("32. negative rejected", async () => {
      const customerId = await createCustomer();
      await assert.rejects(() => runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("-10.00") }));
    });

    test("33. zero rejected", async () => {
      const customerId = await createCustomer();
      await assert.rejects(() => runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("0") }));
    });

    test("34. NUMERIC(14,2) overflow rejected", async () => {
      const customerId = await createCustomer();
      await assert.rejects(() =>
        runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("9999999999999.99") })
      );
    });
  });

  // ============================================================
  // ATOMIC ROLLBACK (35-38)
  // ============================================================

  describe("Atomic rollback", () => {
    test("35-38. duplicate idempotencyKey rolls the second balance mutation back entirely", async () => {
      const customerId = await createCustomer();
      const key = `ph82-idem-${Math.random().toString(36).slice(2)}`;
      const first = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00"), idempotencyKey: key });
      assert.equal(first.wallet.available_balance.toString(), "100"); // 35

      await assert.rejects(() =>
        runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("50.00"), idempotencyKey: key })
      ); // 36

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100", "the rejected duplicate's balance mutation must roll back"); // 37
      const count = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      assert.equal(count, 1); // 38
    });
  });

  // ============================================================
  // CONCURRENT CREDITS (39)
  // ============================================================

  describe("Concurrent credits", () => {
    test("39. concurrent +100 and +50: final balance 150, coherent chain, no lost update", async () => {
      const customerId = await createCustomer();
      const [a, b] = await Promise.all([
        runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") }),
        runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("50.00") }),
      ]);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "150");

      const rows = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { balance_before: "asc" } });
      assert.equal(rows.length, 2);
      assert.equal(rows[0].balance_before.toString(), "0");
      assert.equal(rows[0].balance_after.toString(), rows[1].balance_before.toString());
      assert.equal(rows[1].balance_after.toString(), "150");
      assert.deepEqual([a.transaction.id, b.transaction.id].sort(), rows.map((r) => r.id).sort());
    });
  });

  // ============================================================
  // CONCURRENT DEBITS (40)
  // ============================================================

  describe("Concurrent debits", () => {
    test("40. balance 100, two concurrent debits of 80: at most one succeeds, balance never negative", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });

      const results = await Promise.allSettled([
        prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("80.00") })),
        prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("80.00") })),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, JSON.stringify(results));
      assert.equal(rejected.length, 1);

      const wallet = await getWallet(customerId);
      assert.ok(!wallet.available_balance.isNegative());
      assert.equal(wallet.available_balance.toString(), "20");

      const debitRows = await prisma.wallet_transactions.count({ where: { customer_id: customerId, type: "PAYOUT" } });
      assert.equal(debitRows, 1);
    });
  });

  // ============================================================
  // LEDGER CONSISTENCY (41-43)
  // ============================================================

  describe("Ledger consistency", () => {
    test("41-43. mixed sequence reconciles exactly, final row matches wallet, earlier rows immutable", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") });
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("50.00") });
      await prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("40.00") }));

      const rows = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });
      assert.equal(rows.length, 3);
      for (let i = 1; i < rows.length; i++) {
        assert.equal(rows[i - 1].balance_after.toString(), rows[i].balance_before.toString()); // 41
      }

      const wallet = await getWallet(customerId);
      assert.equal(rows[rows.length - 1].balance_after.toString(), wallet.available_balance.toString()); // 42

      const firstSnapshot = { ...rows[0] };
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("1.00") });
      const firstAfter = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: rows[0].id } });
      assert.deepEqual(firstAfter, firstSnapshot); // 43
    });
  });

  // ============================================================
  // PENDING CALCULATION (44-58)
  // ============================================================

  describe("Pending calculation", () => {
    test("44. DELIVERY_ONLY active Order: pending includes remainingOrderAmount only, not remainingDeliveryFee", async () => {
      const customerId = await createCustomer();
      await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status: "ASSIGNED", orderAmount: "100.00", deliveryFee: "5.00" });
      const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.wallet.pendingAmount, "100");
    });

    test("45. COMPANY_ORDER contributes zero to pending", async () => {
      const customerId = await createCustomer();
      await seedOrder(customerId, { orderType: "COMPANY_ORDER", status: "ASSIGNED", orderAmount: "100.00", deliveryFee: "5.00" });
      const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(detail.body.data.wallet.pendingAmount, "0");
    });

    test("46. two qualifying DELIVERY_ONLY active Orders sum exactly", async () => {
      const customerId = await createCustomer();
      await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status: "ASSIGNED", orderAmount: "100.00", deliveryFee: "5.00" });
      await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status: "PICKED_UP", orderAmount: "30.50", deliveryFee: "2.00" });
      const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(detail.body.data.wallet.pendingAmount, "130.5");
    });

    const INCLUDED_STATUSES = ["RECEIVED", "ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "FAILED_DELIVERY", "RESCHEDULED"];
    for (const status of INCLUDED_STATUSES) {
      test(`47-52. ${status} included in pending`, async () => {
        const customerId = await createCustomer();
        await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status, orderAmount: "77.00", deliveryFee: "3.00" });
        const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
        assert.equal(detail.body.data.wallet.pendingAmount, "77");
      });
    }

    const EXCLUDED_STATUSES = ["DELIVERED", "CANCELLED", "RETURNED_TO_COMPANY", "RETURNED_TO_CUSTOMER"];
    for (const status of EXCLUDED_STATUSES) {
      test(`53-56. ${status} excluded from pending`, async () => {
        const customerId = await createCustomer();
        await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status, orderAmount: "77.00", deliveryFee: "3.00" });
        const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
        assert.equal(detail.body.data.wallet.pendingAmount, "0");
      });
    }

    test("57-58. pending calculation creates zero wallet transactions and never changes availableBalance", async () => {
      const customerId = await createCustomer();
      await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status: "ASSIGNED", orderAmount: "50.00", deliveryFee: "5.00" });
      const before = await getWallet(customerId);

      await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));

      const txCount = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      assert.equal(txCount, 0); // 57

      const after = await getWallet(customerId);
      assert.equal(after.available_balance.toString(), before.available_balance.toString()); // 58
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime());
    });
  });

  // ============================================================
  // WALLET LIST (59-67)
  // ============================================================

  describe("Wallet list", () => {
    test("59-61. pagination default, explicit page/limit, limit>100 rejected", async () => {
      for (let i = 0; i < 3; i++) await createCustomer();

      const defaultRes = await request(app).get(walletsPath()).set(auth(tokens.admin));
      assert.equal(defaultRes.status, 200);
      assert.equal(defaultRes.body.meta.page, 1);
      assert.equal(defaultRes.body.meta.limit, 20);

      const paged = await request(app).get(walletsPath("?page=1&limit=2")).set(auth(tokens.admin));
      assert.equal(paged.status, 200);
      assert.equal(paged.body.data.length, 2);

      const overMax = await request(app).get(walletsPath("?limit=101")).set(auth(tokens.admin));
      assert.equal(overMax.status, 400);
    });

    test("62-64. search by customer number, name, primary phone", async () => {
      const suffix = uniqueSuffix();
      const customerId = await createCustomer({
        customerNumber: `PH82-SEARCH-${suffix}`,
        name: `Phase82 Searchable Customer ${suffix}`,
        primaryPhone: "+96170099887",
      });

      for (const term of [`PH82-SEARCH-${suffix}`, "Searchable Customer", "70099887"]) {
        const res = await request(app).get(walletsPath(`?search=${encodeURIComponent(term)}`)).set(auth(tokens.admin));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.ok(res.body.data.some((w: { customer: { id: string } }) => w.customer.id === customerId), `expected search "${term}" to find the wallet`);
      }
    });

    test("65-67. availableBalance/pendingAmount are strings, correctly associated per wallet", async () => {
      const customerA = await createCustomer();
      const customerB = await createCustomer();
      await runWalletTransaction({ customerId: customerA, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("42.00") });
      await seedOrder(customerA, { orderType: "DELIVERY_ONLY", status: "ASSIGNED", orderAmount: "10.00", deliveryFee: "1.00" });
      await seedOrder(customerB, { orderType: "DELIVERY_ONLY", status: "ASSIGNED", orderAmount: "20.00", deliveryFee: "1.00" });

      const res = await request(app).get(walletsPath(`?search=${encodeURIComponent("Phase51 Test Customer")}`)).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const walletA = res.body.data.find((w: { customer: { id: string } }) => w.customer.id === customerA);
      const walletB = res.body.data.find((w: { customer: { id: string } }) => w.customer.id === customerB);
      assert.ok(walletA);
      assert.ok(walletB);
      assert.equal(typeof walletA.availableBalance, "string"); // 65
      assert.equal(typeof walletA.pendingAmount, "string"); // 66
      assert.equal(walletA.availableBalance, "42");
      assert.equal(walletA.pendingAmount, "10"); // 67 — correctly associated, not swapped/summed with B
      assert.equal(walletB.availableBalance, "0");
      assert.equal(walletB.pendingAmount, "20");
    });
  });

  // ============================================================
  // WALLET DETAIL (68-73)
  // ============================================================

  describe("Wallet detail", () => {
    test("68. valid Customer -> 200", async () => {
      const customerId = await createCustomer();
      const res = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(res.status, 200);
    });

    test("69. malformed UUID -> 400", async () => {
      const res = await request(app).get(walletDetailPath("not-a-uuid")).set(auth(tokens.admin));
      assert.equal(res.status, 400);
    });

    test("70. missing Customer -> 404", async () => {
      const res = await request(app).get(walletDetailPath("00000000-0000-0000-0000-000000000000")).set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });

    test("71. inactive Customer still readable", async () => {
      const customerId = await createCustomer({ isActive: false });
      const res = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.customer.isActive, false);
    });

    test("72. missing Wallet for existing Customer -> sanitized 500", async () => {
      const customerId = await createCustomerWithMissingWallet();
      const res = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      await cleanupTestCustomerRecord(customerId);
    });

    test("73. available/pending both correct together", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("64.00") });
      await seedOrder(customerId, { orderType: "DELIVERY_ONLY", status: "OUT_FOR_DELIVERY", orderAmount: "88.00", deliveryFee: "4.00" });

      const res = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      assert.equal(res.body.data.wallet.availableBalance, "64");
      assert.equal(res.body.data.wallet.pendingAmount, "88");
    });
  });

  // ============================================================
  // TRANSACTION LIST (74-83)
  // ============================================================

  describe("Transaction list", () => {
    test("74-79. pagination, newest-first, type filters, invalid type rejected, money as strings", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("10.00") });
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("20.00") });
      await prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("5.00") }));

      const defaultRes = await request(app).get(walletTransactionsPath(customerId)).set(auth(tokens.admin));
      assert.equal(defaultRes.status, 200);
      assert.equal(defaultRes.body.data.length, 3); // 74
      const types = defaultRes.body.data.map((t: { type: string }) => t.type);
      assert.deepEqual(types, ["PAYOUT", "ORDER_CREDIT", "ORDER_CREDIT"]); // 75 — newest-first

      const creditsOnly = await request(app).get(walletTransactionsPath(customerId, "?type=ORDER_CREDIT")).set(auth(tokens.admin));
      assert.equal(creditsOnly.body.data.length, 2); // 76

      const payoutsOnly = await request(app).get(walletTransactionsPath(customerId, "?type=PAYOUT")).set(auth(tokens.admin));
      assert.equal(payoutsOnly.body.data.length, 1); // 77

      const invalidType = await request(app).get(walletTransactionsPath(customerId, "?type=NOT_A_TYPE")).set(auth(tokens.admin));
      assert.equal(invalidType.status, 400); // 78

      for (const tx of defaultRes.body.data) {
        assert.equal(typeof tx.credit, "string"); // 79
        assert.equal(typeof tx.debit, "string");
        assert.equal(typeof tx.balanceBefore, "string");
        assert.equal(typeof tx.balanceAfter, "string");
      }
    });

    test("80-83. related Order/Payment Method/Processed By safe summaries, notes visible", async () => {
      const customerId = await createCustomer();
      const orderId = await seedOrder(customerId);
      await prisma.$transaction((tx) =>
        creditWalletForOrder(tx, {
          customerId,
          amount: decimal("55.00"),
          orderId,
          processedById: admin.id,
          notes: "management-visible finance note",
        })
      );

      const res = await request(app).get(walletTransactionsPath(customerId)).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      const entry = res.body.data[0];
      assert.deepEqual(entry.order, { id: orderId, orderNumber: (await prisma.orders.findUniqueOrThrow({ where: { id: orderId } })).order_number }); // 80
      assert.deepEqual(Object.keys(entry.processedBy).sort(), ["firstName", "id", "lastName"].sort()); // 82
      assert.equal(entry.processedBy.id, admin.id);
      assert.equal(entry.notes, "management-visible finance note"); // 83

      // 81: payment method summary shape when present
      const payoutTx = await prisma.$transaction((tx) =>
        debitWalletPayout(tx, { customerId, amount: decimal("10.00"), paymentMethodId: cashMethodId })
      );
      const withMethod = await request(app).get(walletTransactionsPath(customerId, "?type=PAYOUT")).set(auth(tokens.admin));
      const methodEntry = withMethod.body.data.find((t: { id: string }) => t.id === payoutTx.transaction.id);
      assert.deepEqual(Object.keys(methodEntry.paymentMethod).sort(), ["code", "id", "name"].sort());
      assert.equal(methodEntry.paymentMethod.code, "CASH");
    });
  });

  // ============================================================
  // DTO SECURITY (84)
  // ============================================================

  describe("DTO security", () => {
    test("84. no idempotencyKey, auth internals, password hash, driver cash, or company finance leakage", async () => {
      const customerId = await createCustomer();
      await runWalletTransaction({
        customerId,
        type: "ORDER_CREDIT",
        direction: "CREDIT",
        amount: decimal("30.00"),
        processedById: admin.id,
        idempotencyKey: `ph82-dto-${Math.random().toString(36).slice(2)}`,
      });

      const list = await request(app).get(walletsPath()).set(auth(tokens.admin));
      const detail = await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      const transactions = await request(app).get(walletTransactionsPath(customerId)).set(auth(tokens.admin));

      const serialized = JSON.stringify(list.body) + JSON.stringify(detail.body) + JSON.stringify(transactions.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /driver_cash/i);
      assert.doesNotMatch(serialized, /company_financial/i);
      // Phase 8.8: a REVERSAL-type transaction is now a legitimate, safe,
      // Management-visible entry (type: "REVERSAL") — the actual guard is
      // the raw internal relation field name never being selected/exposed,
      // not the word "reversal" itself appearing anywhere in the response.
      assert.doesNotMatch(serialized, /reversal_of_id/i);
      assert.doesNotMatch(serialized, /reversalOfId/i);
    });
  });

  // ============================================================
  // READ-ONLY (85-87)
  // ============================================================

  describe("Read-only", () => {
    test("85-87. list/detail/transactions cause no wallet mutation and create no transaction rows", async () => {
      const customerId = await createCustomer();
      const before = await getWallet(customerId);

      await request(app).get(walletsPath()).set(auth(tokens.admin));
      await request(app).get(walletDetailPath(customerId)).set(auth(tokens.admin));
      await request(app).get(walletTransactionsPath(customerId)).set(auth(tokens.admin));

      const after = await getWallet(customerId);
      assert.equal(after.available_balance.toString(), before.available_balance.toString()); // 85
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime()); // 86

      const count = await prisma.wallet_transactions.count({ where: { customer_id: customerId } });
      assert.equal(count, 0); // 87
    });
  });

  // ============================================================
  // MONEY SEPARATION (88-91)
  // ============================================================

  describe("Money separation", () => {
    test("88-91. ORDER_CREDIT and PAYOUT change only wallet tables; Driver Cash/Company Finance unaffected", async () => {
      const customerId = await createCustomer();
      // A dedicated, unrelated driver — scoping the Driver Cash count to
      // its id keeps this check immune to Phase 8.1's own concurrently-
      // running test suite, which legitimately creates/deletes many
      // driver_cash_transactions rows for other drivers.
      const driverUser = await createTestUser("DRIVER");
      createdUserIds.push(driverUser.id);
      const driverRes = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH82-DRV-SEP-${Math.random().toString(36).slice(2)}`, userId: driverUser.id });
      assert.equal(driverRes.status, 201);
      const driverId = driverRes.body.data.id as string;
      createdDriverIds.push(driverId);

      const before = await countDriverAndCompanyTransactions(driverId);

      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("100.00") }); // 88
      await prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("40.00") })); // 89

      const after = await countDriverAndCompanyTransactions(driverId);
      assert.equal(after.cashTx, before.cashTx); // 90
      assert.equal(after.companyTx, before.companyTx); // 91

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "60");
    });
  });

  // ============================================================
  // COMPANY ORDER WALLET INVARIANT (92-94)
  //
  // Superseded by Phase 8.3: an exact DELIVERY_ONLY /deliver now correctly
  // DOES create a wallet ORDER_CREDIT (see driver-orders-deliver.test.ts
  // and the dedicated Phase 8.3 finance suite for that coverage). Phase 8.4
  // then integrated exact COMPANY_ORDER finance too (Driver Cash + Company
  // product/fee revenue, financial_status FINALIZED) — but the mandatory
  // invariant this file must keep guarding permanently is that a
  // COMPANY_ORDER NEVER credits the customer wallet, in any phase.
  // ============================================================

  describe("Company Order wallet invariant", () => {
    test("92-94. an exact COMPANY_ORDER /deliver is FINALIZED but still creates zero wallet_transactions", async () => {
      const customerId = await createCustomer();
      const driverUser = await createTestUser("DRIVER");
      createdUserIds.push(driverUser.id);
      const driverLogin = await loginTestUser(app, driverUser.email, driverUser.password);
      const driverToken = driverLogin.accessToken as string;
      assert.ok(driverToken);
      const driverRes = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH82-DRV-${Math.random().toString(36).slice(2)}`, userId: driverUser.id });
      assert.equal(driverRes.status, 201);
      const driverId = driverRes.body.data.id as string;
      createdDriverIds.push(driverId);

      const orderRes = await request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId,
          orderType: "COMPANY_ORDER",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Phase82 Receiver",
          receiverPhone: "+96170000016",
          receiverAreaId: areaActive.id,
          receiverAddress: "1 Phase82 St",
          description: "Phase82 boundary order",
          orderAmount: "100.00",
          deliveryFee: "5.00",
          collectionPaymentMethodId: cashMethodId,
        });
      assert.equal(orderRes.status, 201);
      const orderId = orderRes.body.data.id as string;
      createdOrderIds.push(orderId);

      await request(app).post(`/api/v1/orders/${orderId}/assign`).set(auth(tokens.admin)).send({ driverId });
      await request(app).post(`/api/v1/driver/orders/${orderId}/pickup`).set(auth(driverToken)).send();
      await request(app).post(`/api/v1/driver/orders/${orderId}/start-delivery`).set(auth(driverToken)).send();
      const deliverRes = await request(app)
        .post(`/api/v1/driver/orders/${orderId}/deliver`)
        .set(auth(driverToken))
        .send({ actualAmountCollected: "105.00" });
      assert.equal(deliverRes.status, 200, JSON.stringify(deliverRes.body));

      const walletTxCount = await prisma.wallet_transactions.count({ where: { order_id: orderId } }); // 92
      assert.equal(walletTxCount, 0);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0", "delivering a COMPANY_ORDER must not credit the wallet"); // 93

      const orderRow = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.equal(orderRow.financial_status, "FINALIZED"); // 94 — Phase 8.4: Driver Cash + Company revenue, never wallet
      assert.equal(orderRow.status, "DELIVERED");
    });
  });

  // ============================================================
  // APPEND-ONLY (95-96)
  // ============================================================

  describe("Append-only", () => {
    test("95. no public edit/delete wallet transaction routes exist", async () => {
      const customerId = await createCustomer();
      const result = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("10.00") });

      const patchAttempt = await request(app)
        .patch(`/api/v1/wallets/${customerId}/transactions/${result.transaction.id}`)
        .set(auth(tokens.admin))
        .send({ credit: "999" });
      assert.equal(patchAttempt.status, 404);
      const deleteAttempt = await request(app)
        .delete(`/api/v1/wallets/${customerId}/transactions/${result.transaction.id}`)
        .set(auth(tokens.admin));
      assert.equal(deleteAttempt.status, 404);
    });

    test("96. later operations never rewrite earlier ledger rows", async () => {
      const customerId = await createCustomer();
      const first = await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("10.00") });
      const firstSnapshot = { ...first.transaction };
      await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal("20.00") });
      await prisma.$transaction((tx) => debitWalletPayout(tx, { customerId, amount: decimal("5.00") }));

      const firstAfter = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: first.transaction.id } });
      assert.deepEqual(firstAfter, firstSnapshot);
    });
  });
});
