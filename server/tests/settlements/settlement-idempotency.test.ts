import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { runDriverCashTransaction } from "../../src/modules/driver-cash/driver-cash-ledger.service";
import {
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedDriverRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Driver Settlement Request Idempotency (Phase 8.9)
//
// POST /api/v1/driver-settlements now requires an Idempotency-Key header.
// Two identical retries (sequential OR concurrent) must produce exactly one
// driver_settlements row, exactly one linked driver_cash_transactions
// SETTLEMENT row, and exactly one audit row — never a raw unique-constraint
// error surfaced to the "losing" concurrent request. The raw key is never
// persisted or echoed back; the derived internal key lives only on
// driver_cash_transactions.idempotency_key (the same column Phase 8.1/8.8
// already use for delivery/reversal dedup).
// ============================================================

describe("Driver Settlement Idempotency (Phase 8.9)", () => {
  let app: Express;
  let admin: TestUser;
  let finance: TestUser;
  let tokens: Record<string, string>;

  let cashMethodId: string;
  let otherMethodId: string;

  const createdDriverIds: string[] = [];
  const createdUserIds: string[] = [];

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

    const cashMethod = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cashMethod.id;
    const other = await prisma.payment_methods.create({
      data: { code: `PH89-SETT-METHOD-${uniqueSuffix()}`, name: "Phase89 Settlement Other Method", is_active: true },
    });
    otherMethodId = other.id;
  });

  after(async () => {
    for (const id of createdDriverIds) await cleanupTestDriverRecord(id);
    for (const id of createdUserIds) await cleanupTestUser(id);
    await prisma.payment_methods.deleteMany({ where: { id: otherMethodId } });
    await Promise.all([admin, finance].map((u) => cleanupTestUser(u.id)));
  });

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function decimal(value: string): Prisma.Decimal {
    return new Prisma.Decimal(value);
  }

  async function createDriverWithAccount(label: string) {
    const user = await createTestUser("DRIVER");
    createdUserIds.push(user.id);
    const driverId = await seedDriverRecord(user.id, { driverNumber: `PH89-DRV-${label}-${uniqueSuffix()}` });
    createdDriverIds.push(driverId);
    return driverId;
  }

  async function fundDriverCash(driverId: string, amount: string) {
    await runDriverCashTransaction({ driverId, type: "COLLECTION", direction: "CREDIT", amount: decimal(amount) });
  }

  async function getCashAccount(driverId: string) {
    return prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
  }

  function settlementsPath() {
    return "/api/v1/driver-settlements";
  }

  async function postSettlementRaw(token: string, body: Record<string, unknown>, headerOverrides?: Record<string, string> | null) {
    const req = request(app).post(settlementsPath()).set(auth(token));
    if (headerOverrides === null) {
      return req.send(body);
    }
    return req.set({ "Idempotency-Key": randomUUID(), ...headerOverrides }).send(body);
  }

  async function postSettlement(token: string, body: Record<string, unknown>, idempotencyKey: string = randomUUID()) {
    return request(app).post(settlementsPath()).set(auth(token)).set("Idempotency-Key", idempotencyKey).send(body);
  }

  // ============================================================
  // HEADER VALIDATION (1-4)
  // ============================================================

  describe("Header validation", () => {
    test("1. missing Idempotency-Key -> 400 (not 401) with valid auth", async () => {
      const driverId = await createDriverWithAccount("h1");
      await fundDriverCash(driverId, "50");
      const res = await postSettlementRaw(tokens.admin, { driverId, amountReceived: "10", paymentMethodId: cashMethodId }, null);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      const count = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(count, 0);
    });

    test("2. empty Idempotency-Key -> 400", async () => {
      const driverId = await createDriverWithAccount("h2");
      await fundDriverCash(driverId, "50");
      const res = await postSettlementRaw(
        tokens.admin,
        { driverId, amountReceived: "10", paymentMethodId: cashMethodId },
        { "Idempotency-Key": "   " }
      );
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("3. oversized Idempotency-Key (>128 chars) -> 400", async () => {
      const driverId = await createDriverWithAccount("h3");
      await fundDriverCash(driverId, "50");
      const res = await postSettlementRaw(
        tokens.admin,
        { driverId, amountReceived: "10", paymentMethodId: cashMethodId },
        { "Idempotency-Key": "x".repeat(129) }
      );
      assert.equal(res.status, 400, JSON.stringify(res.body));
    });

    test("4. valid Idempotency-Key -> succeeds", async () => {
      const driverId = await createDriverWithAccount("h4");
      await fundDriverCash(driverId, "50");
      const res = await postSettlement(tokens.admin, { driverId, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    });

    test("unauthenticated POST still -> 401, never mistaken for header validation", async () => {
      const res = await request(app).post(settlementsPath()).send({ driverId: admin.id, amountReceived: "10", paymentMethodId: cashMethodId });
      assert.equal(res.status, 401);
    });
  });

  // ============================================================
  // SEQUENTIAL REPLAY (5-10)
  // ============================================================

  describe("Sequential replay — same key", () => {
    test("5. same key + same payload replayed -> same settlement id, no duplicate ledger/audit row", async () => {
      const driverId = await createDriverWithAccount("seq1");
      await fundDriverCash(driverId, "500");
      const key = randomUUID();
      const body = { driverId, amountReceived: "300.00", paymentMethodId: cashMethodId, notes: "sequential replay" };

      const first = await postSettlement(tokens.admin, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postSettlement(tokens.admin, body, key);
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.data.id, first.body.data.id);

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "200", "the replay must not debit the account a second time");

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId, type: "SETTLEMENT" } });
      assert.equal(cashTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: first.body.data.id } });
      assert.equal(auditCount, 1);
    });

    test("6. same key + changed amount -> 409, no mutation", async () => {
      const driverId = await createDriverWithAccount("seq2");
      await fundDriverCash(driverId, "500");
      const key = randomUUID();
      const first = await postSettlement(tokens.admin, { driverId, amountReceived: "100.00", paymentMethodId: cashMethodId }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postSettlement(tokens.admin, { driverId, amountReceived: "200.00", paymentMethodId: cashMethodId }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "400");
    });

    test("7. same key + changed driver -> 409, no mutation", async () => {
      const driverA = await createDriverWithAccount("seq3a");
      const driverB = await createDriverWithAccount("seq3b");
      await fundDriverCash(driverA, "200");
      await fundDriverCash(driverB, "200");
      const key = randomUUID();
      const first = await postSettlement(tokens.admin, { driverId: driverA, amountReceived: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postSettlement(tokens.admin, { driverId: driverB, amountReceived: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const settlementCountB = await prisma.driver_settlements.count({ where: { driver_id: driverB } });
      assert.equal(settlementCountB, 0);
      const accountB = await getCashAccount(driverB);
      assert.equal(accountB.current_balance.toString(), "200");
    });

    test("8. same key + changed payment method -> 409, no mutation", async () => {
      const driverId = await createDriverWithAccount("seq4");
      await fundDriverCash(driverId, "200");
      const key = randomUUID();
      const first = await postSettlement(tokens.admin, { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));

      const second = await postSettlement(tokens.admin, { driverId, amountReceived: "50.00", paymentMethodId: otherMethodId }, key);
      assert.equal(second.status, 409, JSON.stringify(second.body));

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
    });

    test("9. same key + same notes replays correctly", async () => {
      const driverId = await createDriverWithAccount("seq5");
      await fundDriverCash(driverId, "200");
      const key = randomUUID();
      const body = { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId };
      const first = await postSettlement(tokens.admin, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await postSettlement(tokens.admin, body, key);
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.equal(second.body.data.id, first.body.data.id);

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
    });

    test("10. same key + changed notes -> 409", async () => {
      const driverId = await createDriverWithAccount("seq6");
      await fundDriverCash(driverId, "200");
      const key = randomUUID();
      const first = await postSettlement(
        tokens.admin,
        { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId, notes: "reason A" },
        key
      );
      assert.equal(first.status, 201, JSON.stringify(first.body));
      const second = await postSettlement(
        tokens.admin,
        { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId, notes: "reason B" },
        key
      );
      assert.equal(second.status, 409, JSON.stringify(second.body));
    });
  });

  // ============================================================
  // CONCURRENT REPLAY (11-13)
  // ============================================================

  describe("Concurrent replay", () => {
    test("11. concurrent identical requests (same key, same payload) -> exactly one settlement, both responses reference it", async () => {
      const driverId = await createDriverWithAccount("conc1");
      await fundDriverCash(driverId, "500");
      const key = randomUUID();
      const body = { driverId, amountReceived: "300.00", paymentMethodId: cashMethodId };

      const [a, b] = await Promise.all([postSettlement(tokens.admin, body, key), postSettlement(tokens.admin, body, key)]);

      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.equal(a.body.data.id, b.body.data.id);

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "200");
      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
      const cashTxCount = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId, type: "SETTLEMENT" } });
      assert.equal(cashTxCount, 1);
      const auditCount = await prisma.audit_logs.count({ where: { entity_type: "DRIVER_SETTLEMENT", entity_id: a.body.data.id } });
      assert.equal(auditCount, 1);
    });

    test("12. concurrent same key but DIFFERENT payload -> exactly one persists, the other 409s", async () => {
      const driverId = await createDriverWithAccount("conc2");
      await fundDriverCash(driverId, "500");
      const key = randomUUID();

      const [a, b] = await Promise.all([
        postSettlement(tokens.admin, { driverId, amountReceived: "100.00", paymentMethodId: cashMethodId }, key),
        postSettlement(tokens.admin, { driverId, amountReceived: "200.00", paymentMethodId: cashMethodId }, key),
      ]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 409], JSON.stringify([a.body, b.body]));

      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
    });

    test("13. different keys, same payload -> both may succeed independently (dedup is key-based, not payload-based)", async () => {
      const driverId = await createDriverWithAccount("conc3");
      await fundDriverCash(driverId, "500");
      const body = { driverId, amountReceived: "200.00", paymentMethodId: cashMethodId };

      const [a, b] = await Promise.all([postSettlement(tokens.admin, body, randomUUID()), postSettlement(tokens.admin, body, randomUUID())]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));
      assert.notEqual(a.body.data.id, b.body.data.id);

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "100");
      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 2);
    });
  });

  // ============================================================
  // FAILED-ATTEMPT / ROLLBACK RETRY (14)
  // ============================================================

  describe("Failed attempt does not consume the key", () => {
    test("14. insufficient-balance attempt with key K fails and does not consume K; funding then retrying K succeeds", async () => {
      const driverId = await createDriverWithAccount("fail1");
      await fundDriverCash(driverId, "10");
      const key = randomUUID();

      const failed = await postSettlement(tokens.admin, { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(failed.status, 400, JSON.stringify(failed.body));
      const settlementCountAfterFail = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCountAfterFail, 0);
      const cashTxAfterFail = await prisma.driver_cash_transactions.count({ where: { driver_id: driverId, type: "SETTLEMENT" } });
      assert.equal(cashTxAfterFail, 0);

      await fundDriverCash(driverId, "100");
      const retried = await postSettlement(tokens.admin, { driverId, amountReceived: "50.00", paymentMethodId: cashMethodId }, key);
      assert.equal(retried.status, 201, JSON.stringify(retried.body));

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "60");
      const settlementCount = await prisma.driver_settlements.count({ where: { driver_id: driverId } });
      assert.equal(settlementCount, 1);
    });
  });

  // ============================================================
  // PRIVACY (15)
  // ============================================================

  describe("Privacy", () => {
    test("15. create and replay responses never expose the idempotency key", async () => {
      const driverId = await createDriverWithAccount("priv1");
      await fundDriverCash(driverId, "100");
      const key = randomUUID();
      const body = { driverId, amountReceived: "20.00", paymentMethodId: cashMethodId };

      const first = await postSettlement(tokens.admin, body, key);
      assert.equal(first.status, 201, JSON.stringify(first.body));
      assert.doesNotMatch(JSON.stringify(first.body), /idempotency/i);

      const second = await postSettlement(tokens.admin, body, key);
      assert.equal(second.status, 201, JSON.stringify(second.body));
      assert.doesNotMatch(JSON.stringify(second.body), /idempotency/i);

      const conflictBody = { driverId, amountReceived: "21.00", paymentMethodId: cashMethodId };
      const conflict = await postSettlement(tokens.admin, conflictBody, key);
      assert.equal(conflict.status, 409);
      assert.doesNotMatch(JSON.stringify(conflict.body), new RegExp(key, "i"));
      assert.doesNotMatch(JSON.stringify(conflict.body), /request:settlement:/i);
    });
  });

  // ============================================================
  // BALANCE COMPETITION REGRESSION (16-17)
  // ============================================================

  describe("Balance competition still enforced alongside idempotency", () => {
    test("16. balance 100, two DIFFERENT-key settlements of 80 each concurrently -> at most one succeeds", async () => {
      const driverId = await createDriverWithAccount("bal1");
      await fundDriverCash(driverId, "100");
      const body = { driverId, amountReceived: "80.00", paymentMethodId: cashMethodId };

      const [a, b] = await Promise.all([postSettlement(tokens.admin, body, randomUUID()), postSettlement(tokens.admin, body, randomUUID())]);
      const statuses = [a.status, b.status].sort();
      assert.deepEqual(statuses, [201, 400], JSON.stringify([a.body, b.body]));

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "20");
      assert.ok(!account.current_balance.isNegative());
    });

    test("17. balance 100, two DIFFERENT-key settlements of 60+40 concurrently -> both succeed, final balance 0", async () => {
      const driverId = await createDriverWithAccount("bal2");
      await fundDriverCash(driverId, "100");

      const [a, b] = await Promise.all([
        postSettlement(tokens.admin, { driverId, amountReceived: "60.00", paymentMethodId: cashMethodId }, randomUUID()),
        postSettlement(tokens.admin, { driverId, amountReceived: "40.00", paymentMethodId: cashMethodId }, randomUUID()),
      ]);
      assert.equal(a.status, 201, JSON.stringify(a.body));
      assert.equal(b.status, 201, JSON.stringify(b.body));

      const account = await getCashAccount(driverId);
      assert.equal(account.current_balance.toString(), "0");
    });
  });
});
