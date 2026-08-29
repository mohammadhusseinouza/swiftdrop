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
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Customer Payout Request Idempotency (Phase 8.9)
//
// POST /api/v1/payouts now requires an Idempotency-Key header. Two identical
// retries (sequential OR concurrent) must produce exactly one
// customer_payouts row, exactly one linked wallet_transactions PAYOUT row,
// and exactly one audit row — never a raw unique-constraint error surfaced
// to the "losing" concurrent request. The raw key is never persisted or
// echoed back; the derived internal key lives only on
// wallet_transactions.idempotency_key (the same column Phase 8.2/8.3/8.8
// already use for delivery/reversal dedup).
// ============================================================

describe("Customer Payout Idempotency (Phase 8.9)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let tokens: Record<string, string>;

  let areaActive: { id: string; name: string };
  let cashMethodId: string;
  let otherMethodId: string;

  const createdCustomerIds: string[] = [];
  const createdAreaIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    finance = await createTestUser("FINANCE");

    const [adminLogin, financeLogin] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, finance.email, finance.password),
    ]);
    tokens = { admin: adminLogin.accessToken as string, finance: financeLogin.accessToken as string };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    areaActive = await createTestArea();
    createdAreaIds.push(areaActive.id);
    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const other = await prisma.payment_methods.create({
      data: { code: `PH89-METHOD-${uniqueSuffix()}`, name: "Phase89 Other Method", is_active: true },
    });
    otherMethodId = other.id;
  });

  after(async () => {
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    for (const id of createdAreaIds) await cleanupTestArea(id);
    await prisma.payment_methods.deleteMany({ where: { id: otherMethodId } });
    await Promise.all([admin, finance].map((u) => cleanupTestUser(u.id)));
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

  function payoutsPath() {
    return "/api/v1/payouts";
  }

  async function postPayoutRaw(token: string, body: Record<string, unknown>, headerOverrides?: Record<string, string> | null) {
    const req = request(app).post(payoutsPath()).set(auth(token));
    if (headerOverrides === null) {
      return req.send(body);
    }
    return req.set({ "Idempotency-Key": randomUUID(), ...headerOverrides }).send(body);
  }

  async function postPayout(token: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(app).post(payoutsPath()).set(auth(token)).set("Idempotency-Key", idempotencyKey).send(body);
  }

  // ============================================================
  // HEADER VALIDATION (1-4)
  // ============================================================

  describe("Header validation", () => {
    test("1. missing Idempotency-Key -> 400 (not 401) with valid auth", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const res = await postPayoutRaw(tokens.admin, { customerId, amount: "10", paymentMethodId: cashMethodId }, null);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      const count = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(count, 0);
    });

    test("2. empty Idempotency-Key -> 400", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const res = await postPayoutRaw(tokens.admin, { customerId, amount: "10", paymentMethodId: cashMethodId }, { "Idempotency-Key": "   " });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("3. oversized Idempotency-Key (>128 chars) -> 400", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const res = await postPayoutRaw(tokens.admin, { customerId, amount: "10", paymentMethodId: cashMethodId }, { "Idempotency-Key": "x".repeat(129) });
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("4. valid Idempotency-Key -> succeeds", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "50");
      const res = await postPayout(tokens.admin, { customerId, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });

    test("unauthenticated POST still -> 401, never mistaken for header validation", async () => {
      const res = await request(app).post(payoutsPath()).send({ customerId: admin.id, amount: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 401);
    });
  });

  // ============================================================
  // SEQUENTIAL REPLAY (5-10)
  // ============================================================

  describe("Sequential replay — same key", () => {
    test("5. same key + same payload replayed -> same payout id, no duplicate ledger/audit row", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");
      const key = randomUUID();
      const body = { customerId, amount: "300.00", paymentMethodId: cashMethodId, notes: "sequential replay" };

      const first = await postPayout(tokens.admin, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postPayout(tokens.admin, body, key);
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.data.id, first.body.data.id);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "200", "the replay must not debit the wallet a second time");

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { customer_id: customerId, type: "PAYOUT" } });
      assert.equal(walletTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "CUSTOMER_PAYOUT", entity_id: first.body.data.id } });
      assert.equal(auditCount, 1);
    });

    test("6. same key + changed amount -> 409, no mutation", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");
      const key = randomUUID();
      const first = await postPayout(tokens.admin, { customerId, amount: "100.00", paymentMethodId: cashMethodId }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postPayout(tokens.admin, { customerId, amount: "200.00", paymentMethodId: cashMethodId }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "400");
    });

    test("7. same key + changed customer -> 409, no mutation", async () => {
      const customerA = await createCustomer();
      const customerB = await createCustomer();
      await fundWallet(customerA, "200");
      await fundWallet(customerB, "200");
      const key = randomUUID();
      const first = await postPayout(tokens.admin, { customerId: customerA, amount: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postPayout(tokens.admin, { customerId: customerB, amount: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const payoutCountB = await prisma.customer_payouts.count({ where: { customer_id: customerB } });
      assert.equal(payoutCountB, 0);
      const walletB = await getWallet(customerB);
      assert.equal(walletB.available_balance.toString(), "200");
    });

    test("8. same key + changed payment method -> 409, no mutation", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");
      const key = randomUUID();
      const first = await postPayout(tokens.admin, { customerId, amount: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postPayout(tokens.admin, { customerId, amount: "50.00", paymentMethodId: otherMethodId }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
    });

    test("9. same key + same notes (including undefined vs undefined) replays correctly", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");
      const key = randomUUID();
      const body = { customerId, amount: "50.00", paymentMethodId: cashMethodId };
      const first = await postPayout(tokens.admin, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await postPayout(tokens.admin, body, key);
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.data.id, first.body.data.id);

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
    });

    test("10. same key + changed notes -> 409", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");
      const key = randomUUID();
      const first = await postPayout(tokens.admin, { customerId, amount: "50.00", paymentMethodId: cashMethodId, notes: "reason A" }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await postPayout(tokens.admin, { customerId, amount: "50.00", paymentMethodId: cashMethodId, notes: "reason B" }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));
    });
  });

  // ============================================================
  // CONCURRENT REPLAY (11-13)
  // ============================================================

  describe("Concurrent replay", () => {
    test("11. concurrent identical requests (same key, same payload) -> exactly one payout, both responses reference it", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");
      const key = randomUUID();
      const body = { customerId, amount: "300.00", paymentMethodId: cashMethodId };

      const [a, b] = await Promise.all([postPayout(tokens.admin, body, key), postPayout(tokens.admin, body, key)]);

      // Neither side of a same-key concurrent race may surface a raw
      // unique-constraint error — the loser must recover the committed
      // original resource.
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.equal(a.body.data.id, b.body.data.id);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "200");
      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
      const walletTxCount = await prisma.wallet_transactions.count({ where: { customer_id: customerId, type: "PAYOUT" } });
      assert.equal(walletTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "CUSTOMER_PAYOUT", entity_id: a.body.data.id } });
      assert.equal(auditCount, 1);
    });

    test("12. concurrent same key but DIFFERENT payload -> exactly one persists, the other 409s", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");
      const key = randomUUID();

      const [a, b] = await Promise.all([
        postPayout(tokens.admin, { customerId, amount: "100.00", paymentMethodId: cashMethodId }, key),
        postPayout(tokens.admin, { customerId, amount: "200.00", paymentMethodId: cashMethodId }, key),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
      const wallet = await getWallet(customerId);
      assert.ok(wallet.available_balance.toString() === "400" || wallet.available_balance.toString() === "300");
    });

    test("13. different keys, same payload -> both may succeed independently (dedup is key-based, not payload-based)", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "500");
      const body = { customerId, amount: "200.00", paymentMethodId: cashMethodId };

      const [a, b] = await Promise.all([postPayout(tokens.admin, body, randomUUID()), postPayout(tokens.admin, body, randomUUID())]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.notEqual(a.body.data.id, b.body.data.id);

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "100");
      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 2);
    });
  });

  // ============================================================
  // FAILED-ATTEMPT / ROLLBACK RETRY (14-15)
  // ============================================================

  describe("Failed attempt does not consume the key", () => {
    test("14. insufficient-balance attempt with key K fails and does not consume K; funding then retrying K succeeds", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "10");
      const key = randomUUID();

      const failed = await postPayout(tokens.admin, { customerId, amount: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(failed.status, 400, JSON.stringify(failed.body));
      const payoutCountAfterFail = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCountAfterFail, 0);
      const walletTxAfterFail = await prisma.wallet_transactions.count({ where: { customer_id: customerId, type: "PAYOUT" } });
      assert.equal(walletTxAfterFail, 0);

      await fundWallet(customerId, "100");
      const retried = await postPayout(tokens.admin, { customerId, amount: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(retried.status, 201, JSON.stringify(retried.body));

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "60");
      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1);
    });
  });

  // ============================================================
  // REPLAY AFTER LATER REVERSAL (16)
  // ============================================================

  describe("Replay after the payout was later reversed", () => {
    test("16. retry with the original key + payload after reversal returns the ORIGINAL payout in its CURRENT (REVERSED) state — no second payout", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "200");
      const key = randomUUID();
      const body = { customerId, amount: "80.00", paymentMethodId: cashMethodId };

      const created = await postPayout(tokens.admin, body, key);
      assert.equal(created.status, 201, JSON.stringify(created.body));

      const payoutTx = await prisma.wallet_transactions.findFirstOrThrow({ where: { payout_id: created.body.data.id } });
      const reverse = await request(app)
        .post(`/api/v1/wallet-transactions/${payoutTx.id}/reverse`)
        .set(auth(tokens.admin))
        .send({ reason: "phase89 replay-after-reversal check" });
      assert.equal(reverse.status, 201, JSON.stringify(reverse.body));

      const payoutAfterReversal = await prisma.customer_payouts.findUniqueOrThrow({ where: { id: created.body.data.id } });
      assert.equal(payoutAfterReversal.status, "REVERSED");

      const replay = await postPayout(tokens.admin, body, key);
      assert.equal(replay.status, 201, JSON.stringify(replay.body));
      assert.equal(replay.body.data.id, created.body.data.id);
      assert.equal(replay.body.data.status, "REVERSED", "the replay must return the CURRENT state, never recreate");

      const payoutCount = await prisma.customer_payouts.count({ where: { customer_id: customerId } });
      assert.equal(payoutCount, 1, "no second payout was created by the replay");
    });
  });

  // ============================================================
  // PRIVACY (17)
  // ============================================================

  describe("Privacy", () => {
    test("17. create and replay responses never expose the idempotency key", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const key = randomUUID();
      const body = { customerId, amount: "20.00", paymentMethodId: cashMethodId };

      const first = await postPayout(tokens.admin, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.doesNotMatch(JSON.stringify(first.body), /idempotency/i);

      const second = await postPayout(tokens.admin, body, key);
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.doesNotMatch(JSON.stringify(second.body), /idempotency/i);

      // A 409 conflict response is allowed to explain itself in plain English
      // ("Idempotency key was already used for a different request.") — the
      // privacy requirement is that it never leaks the RAW client key, the
      // derived internal key, or the underlying ledger idempotency_key
      // column format, not that it avoid the word entirely.
      const conflictBody = { customerId, amount: "21.00", paymentMethodId: cashMethodId };
      const conflict = await postPayout(tokens.admin, conflictBody, key);
      assert.equal(conflict.status, 409);
      assert.doesNotMatch(JSON.stringify(conflict.body), new RegExp(key, "i"));
      assert.doesNotMatch(JSON.stringify(conflict.body), /request:payout:/i);
    });
  });

  // ============================================================
  // BALANCE COMPETITION REGRESSION (18-19)
  // ============================================================

  describe("Balance competition still enforced alongside idempotency", () => {
    test("18. balance 100, two DIFFERENT-key payouts of 80 each concurrently -> at most one succeeds", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");
      const body = { customerId, amount: "80.00", paymentMethodId: cashMethodId };

      const [a, b] = await Promise.all([postPayout(tokens.admin, body, randomUUID()), postPayout(tokens.admin, body, randomUUID())]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "20");
      assert.ok(!wallet.available_balance.isNegative());
    });

    test("19. balance 100, two DIFFERENT-key payouts of 60+40 concurrently -> both succeed, final balance 0", async () => {
      const customerId = await createCustomer();
      await fundWallet(customerId, "100");

      const [a, b] = await Promise.all([
        postPayout(tokens.admin, { customerId, amount: "60.00", paymentMethodId: cashMethodId }, randomUUID()),
        postPayout(tokens.admin, { customerId, amount: "40.00", paymentMethodId: cashMethodId }, randomUUID()),
      ]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));

      const wallet = await getWallet(customerId);
      assert.equal(wallet.available_balance.toString(), "0");
    });
  });
});
