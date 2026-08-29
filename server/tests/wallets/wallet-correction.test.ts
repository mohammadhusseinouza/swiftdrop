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
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Wallet Adjustments + Reversals (Phase 8.8)
//
// POST /api/v1/wallets/:customerId/adjust — manual correction (no existing
// transaction is being undone).
// POST /api/v1/wallet-transactions/:transactionId/reverse — undo one
// specific finalized transaction via a new inverse row.
// ============================================================

describe("Wallet Adjustments + Reversals (Phase 8.8)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;
  let cashMethodId: string;
  let areaActive: { id: string; name: string };

  const createdCustomerIds: string[] = [];
  const createdUserIds: string[] = [];
  const createdOrderIds: string[] = [];
  const createdAreaIds: string[] = [];

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

    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
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

  async function createCustomer() {
    const id = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(id);
    return id;
  }

  async function fundWallet(customerId: string, amount: string) {
    await runWalletTransaction({ customerId, type: "ORDER_CREDIT", direction: "CREDIT", amount: decimal(amount) });
  }

  async function getWallet(customerId: string) {
    return prisma.customer_wallets.findUniqueOrThrow({ where: { customer_id: customerId } });
  }

  function adjustPath(customerId: string) {
    return `/api/v1/wallets/${customerId}/adjust`;
  }
  function reversePath(transactionId: string) {
    return `/api/v1/wallet-transactions/${transactionId}/reverse`;
  }

  async function postAdjust(token: string, customerId: string, body: Record<string, unknown>) {
    return request(app).post(adjustPath(customerId)).set(auth(token)).send(body);
  }
  async function postReverse(token: string, transactionId: string, body: Record<string, unknown>) {
    return request(app).post(reversePath(transactionId)).set(auth(token)).send(body);
  }

  // ============================================================
  // RBAC (adjust + reverse)
  // ============================================================

  describe("RBAC", () => {
    test("unauthenticated adjust/reverse -> 401", async () => {
      const adjustRes = await request(app).post(adjustPath("00000000-0000-0000-0000-000000000000")).send({});
      assert.equal(adjustRes.status, 401);
      const reverseRes = await request(app).post(reversePath("00000000-0000-0000-0000-000000000000")).send({});
      assert.equal(reverseRes.status, 401);
    });

    test("ADMIN and FINANCE allowed; DISPATCHER/DRIVER/CUSTOMER forbidden for adjust", async () => {
      const customerId = await createCustomer();
      const body = { direction: "CREDIT", amount: "10.00", reason: "rbac check" };

      const asAdmin = await postAdjust(tokens.admin, customerId, body);
      assert.equal(asAdmin.status, 201, JSON.stringify(asAdmin.body));
      const asFinance = await postAdjust(tokens.finance, customerId, body);
      assert.equal(asFinance.status, 201, JSON.stringify(asFinance.body));

      const asDispatcher = await postAdjust(tokens.dispatcher, customerId, body);
      assert.equal(asDispatcher.status, 403);
      const asDriver = await postAdjust(tokens.driver, customerId, body);
      assert.equal(asDriver.status, 403);
      const asCustomer = await postAdjust(tokens.customer, customerId, body);
      assert.equal(asCustomer.status, 403);
    });

    test("ADMIN and FINANCE allowed; DISPATCHER/DRIVER/CUSTOMER forbidden for reverse", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const tx = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId } });

      const asDispatcher = await postReverse(tokens.dispatcher, tx.id, { reason: "x" });
      assert.equal(asDispatcher.status, 403);
      const asDriver = await postReverse(tokens.driver, tx.id, { reason: "x" });
      assert.equal(asDriver.status, 403);
      const asCustomer = await postReverse(tokens.customer, tx.id, { reason: "x" });
      assert.equal(asCustomer.status, 403);

      const asFinance = await postReverse(tokens.finance, tx.id, { reason: "finance reverses" });
      assert.equal(asFinance.status, 201, JSON.stringify(asFinance.body));
    });
  });

  // ============================================================
  // WALLET ADJUSTMENT (1-7)
  // ============================================================

  describe("Wallet adjustment", () => {
    test("1. wallet=100, CREDIT 50 -> 150, ADJUSTMENT credit=50/debit=0", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const res = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "50.00", reason: "goodwill credit" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "ADJUSTMENT");
      assert.equal(res.body.data.credit, "50");
      assert.equal(res.body.data.debit, "0");
      assert.equal(res.body.data.balanceBefore, "100");
      assert.equal(res.body.data.balanceAfter, "150");
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "150");
    });

    test("2. wallet=100, DEBIT 40 -> 60, ADJUSTMENT debit=40/credit=0", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const res = await postAdjust(tokens.admin, customerId, { direction: "DEBIT", amount: "40.00", reason: "correction" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.credit, "0");
      assert.equal(res.body.data.debit, "40");
      assert.equal(res.body.data.balanceAfter, "60");
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "60");
    });

    test("3. DEBIT 101 from 100 rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const res = await postAdjust(tokens.admin, customerId, { direction: "DEBIT", amount: "101.00", reason: "too much" });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100");
    });

    test("4. zero/negative/>2 decimals/overflow rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "1000");
      const zero = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "0", reason: "x" });
      assert.equal(zero.status, 400);
      const negative = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "-10", reason: "x" });
      assert.equal(negative.status, 400);
      const decimals = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "10.001", reason: "x" });
      assert.equal(decimals.status, 400);
      const overflow = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "999999999999999.99", reason: "x" });
      assert.equal(overflow.status, 400);
    });

    test("5. blank reason rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const blank = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "10.00", reason: "   " });
      assert.equal(blank.status, 400);
      const missing = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "10.00" });
      assert.equal(missing.status, 400);
    });

    test("6. actor/reason/audit correct", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const res = await postAdjust(tokens.finance, customerId, { direction: "CREDIT", amount: "25.00", reason: "manual credit example" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.processedBy.id, finance.id);
      assert.equal(res.body.data.notes, "manual credit example");

      const auditRow = await prisma.audit_logs.findFirstOrThrow({ where: { action: "WALLET_ADJUSTMENT_CREATED", entity_id: (await getWallet(customerId)).id } });
      assert.equal(auditRow.actor_user_id, finance.id);
      const metadata = auditRow.metadata as Record<string, unknown>;
      assert.equal(metadata.direction, "CREDIT");
      assert.equal(metadata.amount, "25");
      assert.equal(metadata.reason, "manual credit example");
    });

    test("7. rejected adjustments never touch older transactions", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const before = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });
      const snapshot = before.map((t) => ({ ...t }));

      await postAdjust(tokens.admin, customerId, { direction: "DEBIT", amount: "999.00", reason: "x" });

      const after = await prisma.wallet_transactions.findMany({ where: { customer_id: customerId }, orderBy: { created_at: "asc" } });
      assert.deepEqual(after, snapshot);
    });
  });

  // ============================================================
  // WALLET ORDER_CREDIT REVERSAL (17-19 in spec numbering)
  // ============================================================

  describe("Wallet ORDER_CREDIT reversal", () => {
    test("17-18. reverse ORDER_CREDIT +100 -> wallet 0, original unchanged", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      const originalSnapshot = { ...original };

      const res = await postReverse(tokens.admin, original.id, { reason: "wrong customer credited" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "REVERSAL");
      assert.equal(res.body.data.debit, "100");
      assert.equal(res.body.data.credit, "0");

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0"); // 17

      const reversalRow = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(reversalRow.reversal_of_id, original.id);

      const originalAfter = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: original.id } });
      assert.deepEqual(originalAfter, originalSnapshot); // 18
    });

    test("19. second reversal of the same transaction rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      const first = await postReverse(tokens.admin, original.id, { reason: "first reversal" });
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postReverse(tokens.admin, original.id, { reason: "second attempt" });
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const reversalCount = await prisma.wallet_transactions.count({ where: { reversal_of_id: original.id } });
      assert.equal(reversalCount, 1);
    });
  });

  // ============================================================
  // WALLET INSUFFICIENT REVERSAL (20)
  // ============================================================

  describe("Wallet insufficient-balance reversal", () => {
    test("20. ORDER_CREDIT +100 then PAYOUT -100 leaves wallet=0; reversing the credit is rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });

      const payout = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ customerId, amount: "100.00", paymentMethodId: cashMethodId });
      assert.equal(payout.status, 201, JSON.stringify(payout.body));
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");

      const res = await postReverse(tokens.admin, original.id, { reason: "would go negative" });
      assert.equal(res.status, 400, JSON.stringify(res.body));

      const reversalCount = await prisma.wallet_transactions.count({ where: { reversal_of_id: original.id } });
      assert.equal(reversalCount, 0, "no reversal row when it would make the wallet negative");
      const walletAfter = await getWallet(customerId);
      assert.equal(walletAfter.available_balance.toString(), "0");
    });
  });

  // ============================================================
  // PAYOUT REVERSAL (21-27)
  // ============================================================

  describe("Payout reversal", () => {
    test("21-27. reversing a payout's Wallet transaction credits the wallet back and marks the payout REVERSED", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId }); // 21
      assert.equal(payoutRes.status, 201, JSON.stringify(payoutRes.body));
      assert.equal(payoutRes.body.data.status, "COMPLETED"); // 22

      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      const payoutTxSnapshot = { ...payoutTx };
      const walletBeforeReversal = await getWallet(customerId);
      assert.equal(walletBeforeReversal.available_balance.toString(), "60");

      const res = await postReverse(tokens.admin, payoutTx.id, { reason: "customer disputed the payout" }); // 23
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.type, "REVERSAL");
      assert.equal(res.body.data.credit, "40");

      const walletAfter = await getWallet(customerId);
      assert.equal(walletAfter.available_balance.toString(), "100");

      const reversalRow = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: res.body.data.id } });
      assert.equal(reversalRow.reversal_of_id, payoutTx.id);
      assert.equal(reversalRow.payout_id, null, "the reversal row must never copy the UNIQUE payout_id relation");

      const payoutRow = await prisma.customer_payouts.findUniqueOrThrow({ where: { id: payoutRes.body.data.id } });
      assert.equal(payoutRow.status, "REVERSED"); // 24 (only status changed)
      assert.equal(payoutRow.amount.toString(), "40");
      assert.equal(payoutRow.payment_method_id, cashMethodId);
      assert.equal(payoutRow.processed_by_id, admin.id);

      const payoutTxAfter = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: payoutTx.id } });
      assert.deepEqual({ ...payoutTxAfter }, payoutTxSnapshot); // 25 — original PAYOUT ledger unchanged

      const repeated = await postReverse(tokens.admin, payoutTx.id, { reason: "repeat" }); // 26
      assert.equal(repeated.status, 409, JSON.stringify(repeated.body));

      const cashTx = await prisma.driver_cash_transactions.count(); // 27 scoped check below is more precise; this is a coarse sanity smoke check
      assert.ok(cashTx >= 0);
    });

    test("payout reversal creates zero Driver Cash / Company Finance effects (scoped)", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const driverUser = await createTestUser("DRIVER");
      createdUserIds.push(driverUser.id);
      const driverRes = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH88-DRV-SEP-${Math.random().toString(36).slice(2)}`, userId: driverUser.id });
      assert.equal(driverRes.status, 201, JSON.stringify(driverRes.body));
      const driverId = driverRes.body.data.id as string;

      const cashBefore = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId } });
      const companyBefore = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });

      const payoutRes = await request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ customerId, amount: "40.00", paymentMethodId: cashMethodId });
      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: payoutRes.body.data.id } });
      const reverseRes = await postReverse(tokens.admin, payoutTx.id, { reason: "cross-ledger separation check" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));

      const cashAfter = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId } });
      assert.equal(cashAfter, cashBefore);
      const companyAfter = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      assert.equal(companyAfter, companyBefore);

      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driverId } });
      await prisma.drivers.deleteMany({ where: { id: driverId } });
    });
  });

  // ============================================================
  // REVERSAL-OF-REVERSAL (41)
  // ============================================================

  describe("Reversal of a reversal", () => {
    test("41. attempting to reverse a REVERSAL transaction is rejected", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      const firstReversal = await postReverse(tokens.admin, original.id, { reason: "undo credit" });
      assert.equal(firstReversal.status, 201, JSON.stringify(firstReversal.body));

      const res = await postReverse(tokens.admin, firstReversal.body.data.id, { reason: "undo the undo" });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });
  });

  // ============================================================
  // CORRUPT ORIGINAL (42)
  // ============================================================

  describe("Corrupt original", () => {
    test("42. a Wallet transaction with both credit and debit nonzero fails closed with 500", async () => {
      const customerId = await createCustomer();
      const wallet = await getWallet(customerId);
      const corrupt = await prisma.wallet_transactions.create({
        data: {
          wallet_id: wallet.id,
          customer_id: customerId,
          type: "ADJUSTMENT",
          credit: new Prisma.Decimal("10.00"),
          debit: new Prisma.Decimal("5.00"),
          balance_before: new Prisma.Decimal("0"),
          balance_after: new Prisma.Decimal("10"),
        },
      });
      const res = await postReverse(tokens.admin, corrupt.id, { reason: "attempt on corrupt row" });
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack|at Object/i);
      const reversalCount = await prisma.wallet_transactions.count({ where: { reversal_of_id: corrupt.id } });
      assert.equal(reversalCount, 0);
    });
  });

  // ============================================================
  // CONCURRENT REVERSAL (45)
  // ============================================================

  describe("Concurrent reversal", () => {
    test("45. two simultaneous reversal requests for the same transaction: exactly one succeeds", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });

      const [a, b] = await Promise.all([
        postReverse(tokens.admin, original.id, { reason: "race A" }),
        postReverse(tokens.finance, original.id, { reason: "race B" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.equal(statuses[0], 201, JSON.stringify([a.body, b.body]));
      assert.ok([400, 409].includes(statuses[1]));

      const reversalCount = await prisma.wallet_transactions.count({ where: { reversal_of_id: original.id } });
      assert.equal(reversalCount, 1);
      const auditCount = await prisma.audit_logs.count({
        where: { action: { in: ["WALLET_TRANSACTION_REVERSED", "CUSTOMER_PAYOUT_REVERSED"] }, metadata: { path: ["originalTransactionId"], equals: original.id } },
      });
      assert.equal(auditCount, 1);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
    });
  });

  // ============================================================
  // ADJUSTMENT CONCURRENCY (48, 50)
  // ============================================================

  describe("Adjustment concurrency", () => {
    test("48. wallet=100, concurrent DEBIT 80 + DEBIT 80: at most one succeeds, never negative", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const [a, b] = await Promise.all([
        postAdjust(tokens.admin, customerId, { direction: "DEBIT", amount: "80.00", reason: "A" }),
        postAdjust(tokens.finance, customerId, { direction: "DEBIT", amount: "80.00", reason: "B" }),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "20");
      assert.ok(!wallet.available_balance.isNegative());
    });

    test("50. wallet adjustment DEBIT serializes correctly against a concurrent payout", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const [adjustRes, payoutRes] = await Promise.all([
        postAdjust(tokens.admin, customerId, { direction: "DEBIT", amount: "80.00", reason: "adjustment" }),
        request(app)
          .post("/api/v1/payouts")
          .set(auth(tokens.finance))
          .set("Idempotency-Key", randomUUID())
          .send({ customerId, amount: "80.00", paymentMethodId: cashMethodId }),
      ]);
      const statuses = [adjustRes.status, payoutRes.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([adjustRes.body, payoutRes.body]));
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "20");
      assert.ok(!wallet.available_balance.isNegative());
    });
  });

  // ============================================================
  // ROLLBACK (54)
  // ============================================================

  describe("Rollback", () => {
    test("54. duplicate reversal idempotency collision leaves no partial balance change", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });

      await prisma.wallet_transactions.create({
        data: {
          wallet_id: (await getWallet(customerId)).id,
          customer_id: customerId,
          type: "REVERSAL",
          credit: new Prisma.Decimal("0"),
          debit: new Prisma.Decimal("1.00"),
          balance_before: new Prisma.Decimal("999"),
          balance_after: new Prisma.Decimal("998"),
          idempotency_key: `reversal:wallet:${original.id}`,
        },
      });

      const res = await postReverse(tokens.admin, original.id, { reason: "collides" });
      assert.equal(res.status, 409, JSON.stringify(res.body));
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100", "no partial balance change from the rolled-back collision");

      await prisma.wallet_transactions.deleteMany({ where: { idempotency_key: `reversal:wallet:${original.id}` } });
    });
  });

  // ============================================================
  // CROSS-LEDGER SEPARATION (57)
  // ============================================================

  describe("Cross-ledger separation", () => {
    test("57. a Wallet adjustment changes only Wallet tables", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const driverUser = await createTestUser("DRIVER");
      createdUserIds.push(driverUser.id);
      const driverRes = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH88-DRV-WSEP-${Math.random().toString(36).slice(2)}`, userId: driverUser.id });
      assert.equal(driverRes.status, 201, JSON.stringify(driverRes.body));
      const driverId = driverRes.body.data.id as string;

      const cashBefore = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId } });
      const companyBefore = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });

      const res = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "10.00", reason: "wallet-only check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const cashAfter = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId } });
      assert.equal(cashAfter, cashBefore);
      const companyAfter = await prisma.company_financial_transactions.count({ where: { created_by_id: admin.id } });
      assert.equal(companyAfter, companyBefore);

      await prisma.driver_cash_accounts.deleteMany({ where: { driver_id: driverId } });
      await prisma.drivers.deleteMany({ where: { id: driverId } });
    });
  });

  // ============================================================
  // OPERATIONAL IMMUTABILITY (62)
  // ============================================================

  describe("Operational immutability", () => {
    test("62. reversing an Order-linked Wallet credit never changes the Order/DeliveryAttempt/status history", async () => {
      // Uses a directly-linked ORDER_CREDIT (via the ledger primitive with an
      // orderId) against a dedicated, test-owned Order fixture rather than a
      // full delivery flow, matching this file's established scope
      // (wallet-only) — Phase 8.3's own test suite already exhaustively
      // covers the full HTTP delivery path.
      const customerId = await createCustomer();
      const orderId = await seedTestOrder(customerId, admin.id, { areaId: areaActive.id, areaName: areaActive.name });
      createdOrderIds.push(orderId);
      const orderBefore = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      const attemptsBefore = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      const historyBefore = await prisma.order_status_history.count({ where: { order_id: orderId } });

      const result = await runWalletTransaction({
        customerId,
        type: "ORDER_CREDIT",
        direction: "CREDIT",
        amount: decimal("50.00"),
        orderId,
      });

      const res = await postReverse(tokens.admin, result.transaction.id, { reason: "order-linked reversal check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));

      const orderAfter = await prisma.orders.findUniqueOrThrow({ where: { id: orderId } });
      assert.deepEqual(orderAfter, orderBefore, "reversing a wallet credit must never mutate the linked Order");
      const attemptsAfter = await prisma.delivery_attempts.count({ where: { order_id: orderId } });
      assert.equal(attemptsAfter, attemptsBefore);
      const historyAfter = await prisma.order_status_history.count({ where: { order_id: orderId } });
      assert.equal(historyAfter, historyBefore);
    });
  });

  // ============================================================
  // READ INTEGRATION (65)
  // ============================================================

  describe("Read integration", () => {
    test("65. Management Wallet transaction history shows ADJUSTMENT and REVERSAL entries", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const adjustRes = await postAdjust(tokens.admin, customerId, { direction: "CREDIT", amount: "10.00", reason: "visible in history" });
      assert.equal(adjustRes.status, 201, JSON.stringify(adjustRes.body));
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      const reverseRes = await postReverse(tokens.admin, original.id, { reason: "visible in history too" });
      assert.equal(reverseRes.status, 201, JSON.stringify(reverseRes.body));

      const list = await request(app).get(`/api/v1/wallets/${customerId}/transactions`).set(auth(tokens.admin));
      assert.equal(list.status, 200, JSON.stringify(list.body));
      assert.ok(list.body.data.some((t: { type: string }) => t.type === "ADJUSTMENT"));
      assert.ok(list.body.data.some((t: { type: string }) => t.type === "REVERSAL"));
    });
  });

  // ============================================================
  // APPEND ONLY (68)
  // ============================================================

  describe("Append only", () => {
    test("68. original Wallet transaction is byte-for-byte unchanged after reversal", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const original = await prisma.wallet_transactions.findFirstOrThrow({ where: { customer_id: customerId, type: "ORDER_CREDIT" } });
      const snapshot = { ...original };
      const res = await postReverse(tokens.admin, original.id, { reason: "append-only check" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const after = await prisma.wallet_transactions.findUniqueOrThrow({ where: { id: original.id } });
      assert.deepEqual(after, snapshot);
    });
  });
});
