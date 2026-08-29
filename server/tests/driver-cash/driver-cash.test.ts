import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import {
  applyDriverCashAdjustment,
  applyDriverCashReversal,
  applyDriverCashTransaction,
  creditDriverCollection,
  debitDriverSettlement,
  runDriverCashTransaction,
} from "../../src/modules/driver-cash/driver-cash-ledger.service";
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
} from "../helpers/fixtures";

describe("Driver Cash Ledger Foundation (Phase 8.1)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;

  let customerActive: string;
  let areaActive: { id: string; name: string };
  let cashMethodId: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];
  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    customerActor = await createTestUser("CUSTOMER");

    const [adminLogin, dispatcherLogin, financeLogin, customerLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, customerActor.email, customerActor.password),
    ]);
    tokens = {
      admin: adminLogin.accessToken as string,
      dispatcher: dispatcherLogin.accessToken as string,
      finance: financeLogin.accessToken as string,
      customer: customerLogin.accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    customerActive = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerActive);
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
    await Promise.all([admin, dispatcher, finance, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function createDriverWithToken(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const login = await loginTestUser(app, user.email, user.password);
    assert.ok(login.accessToken, `expected an access token for ${label}`);
    const res = await request(app)
      .post("/api/v1/drivers")
      .set(auth(tokens.admin))
      .send({ driverNumber: `PH81-DRV-${Math.random().toString(36).slice(2)}`, userId: user.id });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdDriverIds.push(res.body.data.id);
    return { driverId: res.body.data.id as string, userId: user.id, token: login.accessToken as string };
  }

  async function createBaseOrder(overrides: Record<string, unknown> = {}) {
    const res = await request(app)
      .post("/api/v1/orders")
      .set(auth(tokens.admin))
      .send({
        customerId: customerActive,
        orderType: "DELIVERY_ONLY",
        paymentType: "CASH_ON_DELIVERY",
        receiverName: "Phase81 Receiver",
        receiverPhone: "+96170000015",
        receiverAreaId: areaActive.id,
        receiverAddress: "1 Phase81 St",
        description: "Phase81 driver-cash order",
        orderAmount: "100.00",
        deliveryFee: "5.00",
        collectionPaymentMethodId: cashMethodId,
        ...overrides,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    createdOrderIds.push(res.body.data.id);
    return res.body.data;
  }

  function cashPath(qs = "") {
    return `/api/v1/driver/me/cash${qs}`;
  }

  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function getAccount(driverId: string) {
    return prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
  }

  // wallet_transactions/company_financial_transactions have no driver-scoped
  // column to filter by, and Driver Cash primitives structurally cannot
  // write to either table — a before/after delta (see "Separation of
  // money" below) is the rigorous check; this helper is used only where a
  // simple "zero of either exists" snapshot is sufficient context.
  // Scoped to this file's own dedicated `admin` actor rather than a global
  // lifetime count — this suite never processes a Wallet/Company
  // transaction as that actor, so a nonzero result can only come from a
  // genuine cross-ledger regression, never from unrelated concurrently-
  // running test files (each creates its own distinct admin user). A bare
  // global count here previously flaked under parallel test execution once
  // Phase 8.4 (company revenue) and later Phase 8.8 (adjustments/reversals)
  // gave those tables real concurrent writers.
  async function countWalletAndCompanyTransactions() {
    const [walletTx, companyTx] = await Promise.all([
      prisma.wallet_transactions.count({ where: { processed_by_id: admin.id } }),
      prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } }),
    ]);
    return { walletTx, companyTx };
  }

  // ============================================================
  // DRIVER OWN CASH AUTH (1-7)
  // ============================================================

  describe("Driver own cash auth", () => {
    test("1. unauthenticated GET -> 401", async () => {
      const res = await request(app).get(cashPath());
      assert.equal(res.status, 401);
    });

    test("2. linked DRIVER with driver.cash.read_own -> 200", async () => {
      const driver = await createDriverWithToken("driver2");
      const res = await request(app).get(cashPath()).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("3. CUSTOMER -> 403", async () => {
      const res = await request(app).get(cashPath()).set(auth(tokens.customer));
      assert.equal(res.status, 403);
    });

    test("4. DISPATCHER -> 403 (real permission set lacks driver.cash.read_own)", async () => {
      const res = await request(app).get(cashPath()).set(auth(tokens.dispatcher));
      assert.equal(res.status, 403);
    });

    test("5. FINANCE -> 403 (real permission set lacks driver.cash.read_own)", async () => {
      const res = await request(app).get(cashPath()).set(auth(tokens.finance));
      assert.equal(res.status, 403);
    });

    test("6. ADMIN without linked Driver profile -> safe 403", async () => {
      const res = await request(app).get(cashPath()).set(auth(tokens.admin));
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, "FORBIDDEN");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|relation|foreign key/i);
    });

    test("7. permission-holder without Driver profile -> safe 403 (same as 6, explicit)", async () => {
      const res = await request(app).get(cashPath()).set(auth(tokens.admin));
      assert.equal(res.status, 403);
    });
  });

  // ============================================================
  // INITIAL ACCOUNT (8-11)
  // ============================================================

  describe("Initial account", () => {
    test("8-11. newly-created Driver has a zero-balance cash account, empty history, read is a no-op", async () => {
      const driver = await createDriverWithToken("driver-initial");
      const before = await getAccount(driver.driverId);

      const res = await request(app).get(cashPath()).set(auth(driver.token));
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.account.currentBalance, "0"); // 9
      assert.deepEqual(res.body.data.transactions, []); // 10

      const after = await getAccount(driver.driverId);
      assert.equal(after.updated_at.getTime(), before.updated_at.getTime(), "a read must never mutate the account"); // 11
    });
  });

  // ============================================================
  // COLLECTION CREDIT (12-19)
  // ============================================================

  describe("Collection credit", () => {
    test("12-19. credit 100: balance/transaction fields all correct, orderId/createdById stored when provided", async () => {
      const driver = await createDriverWithToken("driver-credit");
      const order = await createBaseOrder();

      // Uses the focused creditDriverCollection helper directly (not the
      // generic applyDriverCashTransaction), composed into a transaction
      // exactly the way Phase 8.3/8.4 will later compose it into a larger
      // delivery-finalization transaction.
      const result = await prisma.$transaction((tx) =>
        creditDriverCollection(tx, {
          driverId: driver.driverId,
          amount: decimal("100.00"),
          orderId: order.id,
          createdById: driver.userId,
        })
      );

      assert.equal(result.account.current_balance.toString(), "100"); // 12, 17
      assert.equal(result.transaction.amount.toString(), "100"); // 14
      assert.equal(result.transaction.balance_before.toString(), "0"); // 15
      assert.equal(result.transaction.balance_after.toString(), "100"); // 16
      assert.equal(result.transaction.order_id, order.id); // 18
      assert.equal(result.transaction.created_by_id, driver.userId); // 19

      const transactionCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } });
      assert.equal(transactionCount, 1); // 13
    });
  });

  // ============================================================
  // MULTIPLE COLLECTIONS (20-21)
  // ============================================================

  describe("Multiple collections", () => {
    test("20-21. credit 100 then credit 50: correct chained before/after, final account 150", async () => {
      const driver = await createDriverWithToken("driver-multi");
      const first = await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });
      const second = await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("50.00") });

      assert.equal(first.transaction.balance_before.toString(), "0");
      assert.equal(first.transaction.balance_after.toString(), "100");
      assert.equal(second.transaction.balance_before.toString(), "100");
      assert.equal(second.transaction.balance_after.toString(), "150");

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "150");
    });
  });

  // ============================================================
  // SETTLEMENT LEDGER PRIMITIVE (22-25)
  // ============================================================

  describe("Settlement ledger primitive", () => {
    test("22-25. starting balance 150, debit 40 -> 110; wallet/company ledgers untouched", async () => {
      const driver = await createDriverWithToken("driver-settlement");
      // Phase 8.3 test suites now create real wallet/company rows elsewhere
      // in a full-suite run, so this asserts a DELTA of zero rather than a
      // global absolute count (matches the pattern already used by the
      // "Separation of money" test below).
      const { walletTx: walletBefore, companyTx: companyBefore } = await countWalletAndCompanyTransactions();

      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("150.00") });
      const before = await getAccount(driver.driverId);
      assert.equal(before.current_balance.toString(), "150");

      // Deliberately not linking a real settlement_id — Phase 8.6 owns
      // driver_settlements row creation; this only exercises the primitive.
      const result = await prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("40.00") }));

      assert.equal(result.transaction.type, "SETTLEMENT");
      assert.equal(result.transaction.amount.toString(), "40"); // 23
      assert.equal(result.transaction.balance_before.toString(), "150");
      assert.equal(result.transaction.balance_after.toString(), "110"); // 23
      assert.equal(result.account.current_balance.toString(), "110");

      const { walletTx: walletAfter, companyTx: companyAfter } = await countWalletAndCompanyTransactions();
      assert.equal(walletAfter, walletBefore); // 24
      assert.equal(companyAfter, companyBefore); // 25
    });
  });

  // ============================================================
  // INSUFFICIENT DEBIT (26-29)
  // ============================================================

  describe("Insufficient debit", () => {
    test("26-29. balance 100, debit 120 rejected, account/ledger untouched", async () => {
      const driver = await createDriverWithToken("driver-insufficient");
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });

      await assert.rejects(
        () => prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("120.00") })),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          return true;
        }
      );

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "100"); // 28

      const transactionCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } });
      assert.equal(transactionCount, 1, "only the original collection, no partial debit row"); // 29
    });
  });

  // ============================================================
  // ADJUSTMENT TECHNICAL FOUNDATION (30-31)
  // ============================================================

  describe("Adjustment technical foundation", () => {
    test("30-31. internal ADJUSTMENT credit and debit both append correctly", async () => {
      const driver = await createDriverWithToken("driver-adjustment");
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });

      const creditAdj = await prisma.$transaction((tx) =>
        applyDriverCashAdjustment(tx, { driverId: driver.driverId, direction: "CREDIT", amount: decimal("10.00"), notes: "correction credit" })
      );
      assert.equal(creditAdj.transaction.type, "ADJUSTMENT");
      assert.equal(creditAdj.transaction.balance_before.toString(), "100");
      assert.equal(creditAdj.transaction.balance_after.toString(), "110");

      const debitAdj = await prisma.$transaction((tx) =>
        applyDriverCashAdjustment(tx, { driverId: driver.driverId, direction: "DEBIT", amount: decimal("5.00"), notes: "correction debit" })
      );
      assert.equal(debitAdj.transaction.type, "ADJUSTMENT");
      assert.equal(debitAdj.transaction.balance_before.toString(), "110");
      assert.equal(debitAdj.transaction.balance_after.toString(), "105");

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "105");
    });
  });

  // ============================================================
  // TYPE/DIRECTION GUARD (foundation-level, not separately numbered above)
  // ============================================================

  describe("Type/direction guard", () => {
    test("applyDriverCashTransaction rejects a technically-invalid type/direction combination", async () => {
      const driver = await createDriverWithToken("driver-type-direction-guard");
      await assert.rejects(() =>
        prisma.$transaction((tx) =>
          applyDriverCashTransaction(tx, { driverId: driver.driverId, type: "COLLECTION", direction: "DEBIT", amount: decimal("10.00") })
        )
      );
      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "0", "a rejected combination must never mutate the balance");
    });
  });

  // ============================================================
  // REVERSAL TECHNICAL FOUNDATION (32)
  // ============================================================

  describe("Reversal technical foundation", () => {
    test("32. low-level REVERSAL type can technically be recorded with explicit direction/reversalOfId", async () => {
      const driver = await createDriverWithToken("driver-reversal");
      const original = await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });

      // Technical-level only — NOT the complete Phase 8.8 reversal workflow
      // (no eligibility/exactly-once/inverse-amount enforcement here).
      const reversal = await prisma.$transaction((tx) =>
        applyDriverCashReversal(tx, {
          driverId: driver.driverId,
          direction: "DEBIT",
          amount: decimal("100.00"),
          reversalOfId: original.transaction.id,
          notes: "technical reversal test",
        })
      );
      assert.equal(reversal.transaction.type, "REVERSAL");
      assert.equal(reversal.transaction.reversal_of_id, original.transaction.id);
      assert.equal(reversal.transaction.balance_after.toString(), "0");

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "0");
    });
  });

  // ============================================================
  // DECIMAL (33-37)
  // ============================================================

  describe("Decimal behavior", () => {
    test("33. 0.10 + 0.20 -> exact 0.30, no float drift", async () => {
      const driver = await createDriverWithToken("driver-decimal-exact");
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("0.10") });
      const second = await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("0.20") });
      assert.equal(second.transaction.balance_after.toString(), "0.3");
      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "0.3");
    });

    test("34. >2 decimal places rejected", async () => {
      const driver = await createDriverWithToken("driver-decimal-places");
      await assert.rejects(() =>
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("10.001") })
      );
      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "0");
    });

    test("35. negative mutation amount rejected", async () => {
      const driver = await createDriverWithToken("driver-decimal-negative");
      await assert.rejects(() =>
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("-10.00") })
      );
    });

    test("36. zero mutation amount rejected", async () => {
      const driver = await createDriverWithToken("driver-decimal-zero");
      await assert.rejects(() =>
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("0") })
      );
    });

    test("37. NUMERIC(14,2) overflow rejected", async () => {
      const driver = await createDriverWithToken("driver-decimal-overflow");
      await assert.rejects(() =>
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("9999999999999.99") })
      );
    });
  });

  // ============================================================
  // ATOMIC ROLLBACK (38)
  // ============================================================

  describe("Atomic rollback", () => {
    test("38. duplicate idempotencyKey rolls back the balance mutation along with the failed ledger insert", async () => {
      const driver = await createDriverWithToken("driver-rollback");
      const key = `ph81-idem-${Math.random().toString(36).slice(2)}`;
      const first = await runDriverCashTransaction({
        driverId: driver.driverId,
        type: "COLLECTION",
        direction: "CREDIT",
        amount: decimal("100.00"),
        idempotencyKey: key,
      });
      assert.equal(first.account.current_balance.toString(), "100");

      await assert.rejects(() =>
        runDriverCashTransaction({
          driverId: driver.driverId,
          type: "COLLECTION",
          direction: "CREDIT",
          amount: decimal("50.00"),
          idempotencyKey: key,
        })
      );

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "100", "the second (rejected) credit's balance mutation must have rolled back");
      const transactionCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId } });
      assert.equal(transactionCount, 1);
    });
  });

  // ============================================================
  // CONCURRENT CREDITS (39)
  // ============================================================

  describe("Concurrent credits", () => {
    test("39. two real concurrent COLLECTION credits (+100, +50) never lose an update", async () => {
      const driver = await createDriverWithToken("driver-concurrent-credit");

      const [a, b] = await Promise.all([
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") }),
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("50.00") }),
      ]);

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "150");

      const rows = await prisma.driver_cash_transactions.findMany({ where: { driver_id: driver.driverId }, orderBy: { balance_before: "asc" } });
      assert.equal(rows.length, 2);
      // Whichever order they serialized in, the chain must be coherent: one
      // starts at 0, the other picks up exactly where the first left off.
      assert.equal(rows[0].balance_before.toString(), "0");
      assert.equal(rows[0].balance_after.toString(), rows[1].balance_before.toString());
      assert.equal(rows[1].balance_after.toString(), "150");
      assert.deepEqual(
        [a.transaction.id, b.transaction.id].sort(),
        rows.map((r) => r.id).sort()
      );
    });
  });

  // ============================================================
  // CONCURRENT DEBIT PROTECTION (40)
  // ============================================================

  describe("Concurrent debit protection", () => {
    test("40. balance 100, two concurrent debits of 80: at most one succeeds, balance never negative", async () => {
      const driver = await createDriverWithToken("driver-concurrent-debit");
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });

      const results = await Promise.allSettled([
        prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("80.00") })),
        prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("80.00") })),
      ]);

      const fulfilled = results.filter((r) => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      assert.equal(fulfilled.length, 1, JSON.stringify(results));
      assert.equal(rejected.length, 1);

      const account = await getAccount(driver.driverId);
      assert.ok(!account.current_balance.isNegative(), "balance must never go negative");
      assert.equal(account.current_balance.toString(), "20");

      const debitRows = await prisma.driver_cash_transactions.count({ where: { driver_id: driver.driverId, type: "SETTLEMENT" } });
      assert.equal(debitRows, 1, "only the winning debit's ledger row exists");
    });
  });

  // ============================================================
  // LEDGER CONSISTENCY (41-43)
  // ============================================================

  describe("Ledger consistency", () => {
    test("41-43. chronological chain reconciles exactly, final row matches account, earlier rows immutable", async () => {
      const driver = await createDriverWithToken("driver-chain");
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("50.00") });
      await prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("40.00") }));

      const rows = await prisma.driver_cash_transactions.findMany({ where: { driver_id: driver.driverId }, orderBy: { created_at: "asc" } });
      assert.equal(rows.length, 3);
      for (let i = 1; i < rows.length; i++) {
        assert.equal(rows[i - 1].balance_after.toString(), rows[i].balance_before.toString()); // 41
      }

      const account = await getAccount(driver.driverId);
      assert.equal(rows[rows.length - 1].balance_after.toString(), account.current_balance.toString()); // 42

      const firstRowSnapshot = { ...rows[0] };
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("1.00") });
      const firstRowAfter = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: rows[0].id } });
      assert.deepEqual(firstRowAfter, firstRowSnapshot); // 43
    });
  });

  // ============================================================
  // DRIVER CASH API (44-52)
  // ============================================================

  describe("Driver cash API", () => {
    test("44-49. serialization, pagination defaults/explicit/max, deterministic newest-first order", async () => {
      const driver = await createDriverWithToken("driver-api");
      for (const amount of ["10.00", "20.00", "30.00"]) {
        await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal(amount) });
      }

      const defaultRes = await request(app).get(cashPath()).set(auth(driver.token));
      assert.equal(defaultRes.status, 200);
      assert.equal(typeof defaultRes.body.data.account.currentBalance, "string"); // 44
      assert.equal(defaultRes.body.meta.page, 1); // 46
      assert.equal(defaultRes.body.meta.limit, 20);
      for (const tx of defaultRes.body.data.transactions) {
        assert.equal(typeof tx.amount, "string"); // 45
        assert.equal(typeof tx.balanceBefore, "string");
        assert.equal(typeof tx.balanceAfter, "string");
      }
      // 49: newest-first
      const amounts = defaultRes.body.data.transactions.map((t: { amount: string }) => t.amount);
      assert.deepEqual(amounts, ["30", "20", "10"]);

      const paged = await request(app).get(cashPath("?page=1&limit=2")).set(auth(driver.token));
      assert.equal(paged.status, 200);
      assert.equal(paged.body.data.transactions.length, 2); // 47
      assert.equal(paged.body.meta.limit, 2);
      assert.equal(paged.body.meta.total, 3);
      assert.equal(paged.body.meta.totalPages, 2);

      const overMax = await request(app).get(cashPath("?limit=101")).set(auth(driver.token));
      assert.equal(overMax.status, 400); // 48
    });

    test("50. optional type filter works", async () => {
      const driver = await createDriverWithToken("driver-type-filter");
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") });
      await prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("40.00") }));

      const collectionsOnly = await request(app).get(cashPath("?type=COLLECTION")).set(auth(driver.token));
      assert.equal(collectionsOnly.status, 200);
      assert.equal(collectionsOnly.body.data.transactions.length, 1);
      assert.equal(collectionsOnly.body.data.transactions[0].type, "COLLECTION");

      const settlementsOnly = await request(app).get(cashPath("?type=SETTLEMENT")).set(auth(driver.token));
      assert.equal(settlementsOnly.status, 200);
      assert.equal(settlementsOnly.body.data.transactions.length, 1);
      assert.equal(settlementsOnly.body.data.transactions[0].type, "SETTLEMENT");
    });

    test("51-52. only the authenticated Driver's own account is returned; no driverId input can widen scope", async () => {
      const driverA = await createDriverWithToken("driverA-scope");
      const driverB = await createDriverWithToken("driverB-scope");
      await runDriverCashTransaction({ driverId: driverA.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("11.00") });
      await runDriverCashTransaction({ driverId: driverB.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("22.00") });

      const resA = await request(app).get(cashPath(`?driverId=${driverB.driverId}`)).set(auth(driverA.token));
      assert.equal(resA.status, 200);
      assert.equal(resA.body.data.account.currentBalance, "11", "the spoofed driverId query param must have no effect");
      assert.equal(resA.body.data.transactions.length, 1);
      assert.equal(resA.body.data.transactions[0].amount, "11");
    });
  });

  // ============================================================
  // DTO SECURITY (53)
  // ============================================================

  describe("DTO security", () => {
    test("53. response never exposes idempotencyKey, createdBy internals, finance-internal notes, wallet/company data", async () => {
      const driver = await createDriverWithToken("driver-dto-security");
      await runDriverCashTransaction({
        driverId: driver.driverId,
        type: "COLLECTION",
        direction: "CREDIT",
        amount: decimal("100.00"),
        createdById: driver.userId,
        notes: "internal finance note",
        idempotencyKey: `ph81-dto-${Math.random().toString(36).slice(2)}`,
      });

      const res = await request(app).get(cashPath()).set(auth(driver.token));
      assert.equal(res.status, 200);

      const entry = res.body.data.transactions[0];
      assert.deepEqual(Object.keys(entry).sort(), ["amount", "balanceAfter", "balanceBefore", "createdAt", "id", "order", "settlement", "type"].sort());

      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /createdBy/i);
      assert.doesNotMatch(serialized, /internal finance note/i);
      assert.doesNotMatch(serialized, /password_hash/i);
      assert.doesNotMatch(serialized, /auth_sessions/i);
      assert.doesNotMatch(serialized, /refresh_token/i);
      assert.doesNotMatch(serialized, /reversal/i);
      assert.doesNotMatch(serialized, /wallet/i);
      assert.doesNotMatch(serialized, /company_financial/i);
    });
  });

  // ============================================================
  // ACCOUNT INTEGRITY (54)
  // ============================================================

  describe("Account integrity", () => {
    test("54. Driver with a missing cash account fails closed, never auto-created, never repaired", async () => {
      const driver = await createDriverWithToken("driver-corrupted");
      // Deliberately corrupt the fixture — never reachable through any real
      // API. No dependent driver_cash_transactions rows exist yet, so this
      // delete is safe.
      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driver.driverId } });

      const res = await request(app).get(cashPath()).set(auth(driver.token));
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);

      const stillMissing = await prisma.driver_cash_accounts.findUnique({ where: { driver_id: driver.driverId } });
      assert.equal(stillMissing, null, "must never auto-create the missing account");

      await assert.rejects(() =>
        runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("10.00") })
      );
    });
  });

  // ============================================================
  // APPEND-ONLY (55-56)
  // ============================================================

  describe("Append-only", () => {
    test("55. no public mutation endpoint exists for editing/deleting cash transactions", async () => {
      const driver = await createDriverWithToken("driver-append-only");
      const result = await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("10.00") });

      const patchAttempt = await request(app).patch(cashPath(`/${result.transaction.id}`)).set(auth(driver.token)).send({ amount: "999" });
      assert.equal(patchAttempt.status, 404);
      const deleteAttempt = await request(app).delete(cashPath(`/transactions/${result.transaction.id}`)).set(auth(driver.token));
      assert.equal(deleteAttempt.status, 404);
    });

    test("56. subsequent ledger operations never modify a previous transaction row", async () => {
      const driver = await createDriverWithToken("driver-immutable");
      const first = await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("10.00") });
      const firstSnapshot = { ...first.transaction };
      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("20.00") });
      await prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("5.00") }));

      const firstAfter = await prisma.driver_cash_transactions.findUniqueOrThrow({ where: { id: first.transaction.id } });
      assert.deepEqual(firstAfter, firstSnapshot);
    });
  });

  // ============================================================
  // COMPANY ORDER EXACT DELIVERY (57-58)
  //
  // Phase 8.3 integrated the exact DELIVERY_ONLY branch. Phase 8.4 then
  // integrated exact COMPANY_ORDER too — both order types now credit
  // Driver Cash identically (the actual physical cash the Driver collected)
  // and finalize. See tests/driver-orders/company-order-finance.test.ts for
  // the dedicated Phase 8.4 Company Finance suite.
  // ============================================================

  describe("Company Order exact delivery", () => {
    test("57-58. an exact COMPANY_ORDER /deliver creates one driver_cash_transactions row and finalizes", async () => {
      const driver = await createDriverWithToken("driver-company-order-exact");
      const order = await createBaseOrder({ orderType: "COMPANY_ORDER" });
      const assign = await request(app).post(`/api/v1/orders/${order.id}/assign`).set(auth(tokens.admin)).send({ driverId: driver.driverId });
      assert.equal(assign.status, 200);
      const pickup = await request(app).post(`/api/v1/driver/orders/${order.id}/pickup`).set(auth(driver.token)).send();
      assert.equal(pickup.status, 200);
      const start = await request(app).post(`/api/v1/driver/orders/${order.id}/start-delivery`).set(auth(driver.token)).send();
      assert.equal(start.status, 200);
      const deliver = await request(app).post(`/api/v1/driver/orders/${order.id}/deliver`).set(auth(driver.token)).send({ actualAmountCollected: "105.00" });
      assert.equal(deliver.status, 200, JSON.stringify(deliver.body));

      const cashTx = await prisma.driver_cash_transactions.findFirstOrThrow({ where: { order_id: order.id } }); // 57
      assert.equal(cashTx.type, "COLLECTION");
      assert.equal(cashTx.amount.toString(), "105");

      const row = await prisma.orders.findUniqueOrThrow({ where: { id: order.id } });
      assert.equal(row.financial_status, "FINALIZED"); // 58
      assert.equal(row.status, "DELIVERED");

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "105");
    });
  });

  // ============================================================
  // SEPARATION OF MONEY (59-62)
  // ============================================================

  describe("Separation of money", () => {
    test("59-62. COLLECTION and SETTLEMENT change only Driver Cash tables", async () => {
      const driver = await createDriverWithToken("driver-separation");

      const { walletTx: walletBefore, companyTx: companyBefore } = await countWalletAndCompanyTransactions();

      await runDriverCashTransaction({ driverId: driver.driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal("100.00") }); // 59
      await prisma.$transaction((tx) => debitDriverSettlement(tx, { driverId: driver.driverId, amount: decimal("40.00") })); // 60

      const { walletTx: walletAfter, companyTx: companyAfter } = await countWalletAndCompanyTransactions();
      assert.equal(walletAfter, walletBefore); // 61
      assert.equal(companyAfter, companyBefore); // 62

      const account = await getAccount(driver.driverId);
      assert.equal(account.current_balance.toString(), "60");
    });
  });
});
