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
  seedDriverRecord,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 13.6 — GET /api/v1/customer/me/payouts.
//
// Every payout in this suite is produced by the REAL approved Finance
// workflow (fund wallet via the Phase 8.2 ledger primitive -> POST
// /api/v1/payouts) — never a hand-inserted customer_payouts row. The one
// exception is a single prisma status UPDATE used purely to prove the DTO
// passes a non-COMPLETED status through and still lists the historical
// payout (task §13 / §22) — no business flow is fabricated.
//
// Covers: portal + permission auth (denial before lookup), self-scoping
// (no customerId / walletId trust), authoritative source (customer_payouts),
// exact Customer-safe DTO key set, DTO privacy (no processedBy / notes /
// idempotency / payment_method_id / wallet internals / Driver Cash / Company
// Finance / financial review), positive amount, safe payment-method name,
// friendly-status passthrough + historical preservation, deterministic
// newest-first pagination, payout / wallet / transaction consistency,
// no-op status filter, and zero write side effects.
// ============================================================

const ROW_KEYS = ["id", "payoutNumber", "amount", "paymentMethod", "status", "createdAt"].sort();

const FORBIDDEN_SUBSTRINGS = [
  "processedBy",
  "processed_by",
  "processed_by_id",
  "createdBy",
  "created_by",
  "notes",
  "PH136-NOTE", // the Management notes text seeded below
  "idempotency",
  "Idempotency",
  "payment_method_id",
  "paymentMethodId",
  '"code"',
  "is_active",
  "sort_order",
  "updatedAt",
  "updated_at",
  "wallet_id",
  '"walletId"',
  "wallet_transaction",
  "reversal_of_id",
  "reversalOfId",
  "balance_before",
  "balanceBefore",
  "balance_after",
  "balanceAfter",
  "driverCash",
  "driver_cash",
  "companyFinance",
  "company_financial",
  "settlement",
  "financialStatus",
  "financial_status",
  "needsFinancialReview",
  "auditLog",
];

describe("Customer Portal — Payout History (Phase 13.6)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverUser: TestUser;
  let customerAUser: TestUser;
  let customerBUser: TestUser;
  let noProfileUser: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let cashMethodId: string;
  let cashMethodName: string;
  let customerAId: string;
  let customerBId: string;
  let driverId: string;

  const orderIds: string[] = [];
  const customerRecordIds: string[] = [];
  const driverRecordIds: string[] = [];
  const areaIds: string[] = [];
  const userIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const list = (t?: string, qs = "") => {
    const r = request(app).get(`/api/v1/customer/me/payouts${qs}`);
    return t ? r.set(auth(t)) : r;
  };

  async function fundWallet(customerId: string, amount: string) {
    await runWalletTransaction({
      customerId,
      type: "ORDER_CREDIT",
      direction: "CREDIT",
      amount: new Prisma.Decimal(amount),
    });
  }

  async function createPayout(
    customerId: string,
    amount: string,
    extra: Record<string, unknown> = {},
    actorToken = tokens.finance
  ) {
    const res = await request(app)
      .post("/api/v1/payouts")
      .set(auth(actorToken))
      .set("Idempotency-Key", randomUUID())
      .send({ customerId, amount, paymentMethodId: cashMethodId, ...extra });
    assert.equal(res.status, 201, `create payout -> ${res.status}: ${JSON.stringify(res.body)}`);
    return res.body.data as { id: string; payoutNumber: string };
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverUser = await createTestUser("DRIVER");
    customerAUser = await createTestUser("CUSTOMER");
    customerBUser = await createTestUser("CUSTOMER");
    noProfileUser = await createTestUser("CUSTOMER");
    userIds.push(
      dispatcher.id,
      finance.id,
      driverUser.id,
      customerAUser.id,
      customerBUser.id,
      noProfileUser.id
    );

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverUser.email, driverUser.password),
      loginTestUser(app, customerAUser.email, customerAUser.password),
      loginTestUser(app, customerBUser.email, customerBUser.password),
      loginTestUser(app, noProfileUser.email, noProfileUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customerA: logins[4].accessToken as string,
      customerB: logins[5].accessToken as string,
      noProfile: logins[6].accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `missing token: ${k}`);

    area = await createTestArea();
    areaIds.push(area.id);
    const cash = await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } });
    cashMethodId = cash.id;
    cashMethodName = cash.name;

    customerAId = await seedCustomerRecord(admin.id, { name: "Payout Customer A", portalUserId: customerAUser.id });
    customerBId = await seedCustomerRecord(admin.id, { name: "Payout Customer B", portalUserId: customerBUser.id });
    customerRecordIds.push(customerAId, customerBId);
    // noProfileUser deliberately has NO customers row.

    driverId = await seedDriverRecord(driverUser.id, { driverNumber: "PH136-DRV" });
    driverRecordIds.push(driverId);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of customerRecordIds) await cleanupTestCustomerRecord(id);
    for (const id of driverRecordIds) await cleanupTestDriverRecord(id);
    for (const id of areaIds) await cleanupTestArea(id);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  const rowsFor = async (token: string, qs = "") => (await list(token, qs)).body.data as Array<Record<string, unknown>>;

  // ===========================================================
  // Authorization — portal matrix (task §44)
  // ===========================================================
  describe("authorization", () => {
    test("CUSTOMER -> 200 list; ADMIN/DISPATCHER/FINANCE/DRIVER -> 403; unauthenticated -> 401", async () => {
      const res = await list(tokens.customerA);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.meta);
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        const r = await list(tokens[role]);
        assert.equal(r.status, 403, role);
        assert.equal(r.body.error.code, "FORBIDDEN");
      }
      assert.equal((await list()).status, 401);
    });

    // task §45 — wrong-portal role denied BEFORE any Customer / payout lookup.
    test("portal denial precedes lookup — ADMIN 403 leaks nothing", async () => {
      const res = await list(tokens.admin);
      assert.equal(res.status, 403);
      const json = JSON.stringify(res.body);
      assert.ok(!/customer profile/i.test(json));
      assert.ok(!/prisma/i.test(json));
      assert.ok(!/payout/i.test(json));
    });

    // A CUSTOMER-role account without a customers row: still 403 (data
    // integrity), safe message — the portal guard already passed, so this is
    // getCustomerProfileForUser's own 403.
    test("CUSTOMER role, no customers row -> 403, safe message", async () => {
      const res = await list(tokens.noProfile);
      assert.equal(res.status, 403);
      assert.doesNotMatch(JSON.stringify(res.body), /prisma|stack/i);
    });
  });

  // ===========================================================
  // Self-scoping (task §46)
  // ===========================================================
  describe("self-scoping", () => {
    test("A sees only A's payouts; B sees only B's; ?customerId / ?walletId inert", async () => {
      await fundWallet(customerAId, "100");
      await fundWallet(customerBId, "100");
      const a1 = await createPayout(customerAId, "10.00");
      const a2 = await createPayout(customerAId, "15.00");
      const b1 = await createPayout(customerBId, "20.00");

      const aRows = await rowsFor(tokens.customerA);
      const aIds = aRows.map((r) => r.id);
      assert.deepEqual([...aIds].sort(), [a1.id, a2.id].sort());
      assert.ok(!aIds.includes(b1.id));

      const spoof = await rowsFor(tokens.customerA, `?customerId=${customerBId}&walletId=whatever`);
      assert.deepEqual(
        spoof.map((r) => r.id).sort(),
        [...aIds].sort()
      );

      const bRows = await rowsFor(tokens.customerB);
      assert.deepEqual(
        bRows.map((r) => r.id),
        [b1.id]
      );
    });
  });

  // ===========================================================
  // DTO shape + privacy (task §47 / §48 / §51 / §52 / §53 / §54)
  // ===========================================================
  describe("DTO", () => {
    test("exact key set; positive amount string; safe method name; friendly-safe status; no internal fields", async () => {
      await fundWallet(customerAId, "60");
      const created = await createPayout(customerAId, "40.00", {
        notes: "PH136-NOTE internal management note",
      });

      const rows = await rowsFor(tokens.customerA, "?limit=100");
      const row = rows.find((r) => r.id === created.id)!;
      assert.ok(row, "created payout must appear in the Customer list");

      assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
      assert.deepEqual(Object.keys(row.paymentMethod as object).sort(), ["name"]);
      assert.equal((row.paymentMethod as { name: string }).name, cashMethodName);
      assert.equal(typeof row.amount, "string");
      assert.equal(row.amount, "40", "positive, unsigned, exact server digits");
      assert.equal(row.status, "COMPLETED");
      assert.equal(typeof row.payoutNumber, "string");
      assert.ok((row.payoutNumber as string).length > 0);
      assert.equal(typeof row.createdAt, "string");
      assert.ok(!Number.isNaN(Date.parse(row.createdAt as string)));

      // Seed a real processed_by_id already exists (finance actor). Assert
      // the whole response body never leaks processor / notes / idempotency /
      // method id / wallet internals / Driver Cash / Company Finance.
      const json = JSON.stringify((await list(tokens.customerA, "?limit=100")).body);
      for (const term of FORBIDDEN_SUBSTRINGS) assert.ok(!json.includes(term), `leaked "${term}"`);
      assert.ok(!json.includes(finance.id), "processor user id must not appear");
      assert.ok(!json.includes(finance.email), "processor email must not appear");
    });

    test("processor identity is genuinely stored but never returned (task §52)", async () => {
      const rows = await rowsFor(tokens.customerA, "?limit=100");
      assert.ok(rows.length > 0);
      const dbRow = await prisma.customer_payouts.findFirstOrThrow({
        where: { id: rows[0].id as string },
        select: { processed_by_id: true },
      });
      assert.ok(dbRow.processed_by_id, "payout row really has a processor");
      assert.ok(!JSON.stringify(rows[0]).includes(dbRow.processed_by_id));
    });
  });

  // ===========================================================
  // Authoritative source + payout / wallet / transaction consistency
  // (task §3 / §48 / §49)
  // ===========================================================
  describe("payout / wallet / transaction consistency", () => {
    test("before 100 -> payout 40 -> available 60; payout in /payouts; PAYOUT debit in /transactions", async () => {
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      const cid = await seedCustomerRecord(admin.id, { name: "Consistency C", portalUserId: u.id });
      customerRecordIds.push(cid);
      const login = await loginTestUser(app, u.email, u.password);
      const token = login.accessToken as string;

      await fundWallet(cid, "100");
      const walletBefore = await request(app).get("/api/v1/customer/me/wallet").set(auth(token));
      assert.equal(walletBefore.body.data.availableBalance, "100");

      const created = await createPayout(cid, "40.00");

      // /customer/payouts — the business record.
      const payouts = await rowsFor(token, "?limit=100");
      const payoutRow = payouts.find((r) => r.id === created.id)!;
      assert.ok(payoutRow);
      assert.equal(payoutRow.amount, "40");
      assert.equal(payoutRow.status, "COMPLETED");

      // /customer/transactions — the wallet debit row (distinct concept).
      const txs = await request(app)
        .get("/api/v1/customer/me/wallet/transactions?limit=100")
        .set(auth(token));
      const payoutTx = (txs.body.data as Array<Record<string, unknown>>).find((t) => t.type === "PAYOUT")!;
      assert.ok(payoutTx, "a PAYOUT wallet transaction row exists");
      assert.equal(payoutTx.direction, "DEBIT");
      assert.equal(payoutTx.amount, "40");
      assert.deepEqual(payoutTx.reference, { kind: "PAYOUT", label: created.payoutNumber });

      // /customer/wallet — reduced available balance.
      const walletAfter = await request(app).get("/api/v1/customer/me/wallet").set(auth(token));
      assert.equal(walletAfter.body.data.availableBalance, "60");
    });
  });

  // ===========================================================
  // Status presentation + historical preservation (task §13 / §22 / §50)
  // ===========================================================
  describe("status", () => {
    test("COMPLETED is returned as the raw enum token for the frontend to label", async () => {
      const rows = await rowsFor(tokens.customerA, "?limit=100");
      for (const r of rows) assert.ok(["COMPLETED", "REVERSED", "CANCELLED"].includes(r.status as string));
    });

    // No approved workflow produces REVERSED/CANCELLED (payout.test.ts §56).
    // This UPDATE only proves DTO passthrough + that a non-COMPLETED payout
    // is still listed as history — it does NOT fabricate a business flow.
    test("a payout force-set to REVERSED still appears in history with its current status", async () => {
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      const cid = await seedCustomerRecord(admin.id, { name: "Reversed C", portalUserId: u.id });
      customerRecordIds.push(cid);
      const login = await loginTestUser(app, u.email, u.password);
      const token = login.accessToken as string;

      await fundWallet(cid, "50");
      const created = await createPayout(cid, "25.00");
      await prisma.customer_payouts.update({ where: { id: created.id }, data: { status: "REVERSED" } });

      const rows = await rowsFor(token, "?limit=100");
      const row = rows.find((r) => r.id === created.id)!;
      assert.ok(row, "historical payout is NOT removed from the list");
      assert.equal(row.status, "REVERSED");
      assert.deepEqual(Object.keys(row).sort(), ROW_KEYS);
    });
  });

  // ===========================================================
  // Pagination + deterministic sort (task §56)
  // ===========================================================
  describe("pagination + ordering", () => {
    test("newest-first, deterministic; page/limit/total/totalPages; no dupes / gaps across pages", async () => {
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      const cid = await seedCustomerRecord(admin.id, { name: "Paged C", portalUserId: u.id });
      customerRecordIds.push(cid);
      const login = await loginTestUser(app, u.email, u.password);
      const token = login.accessToken as string;

      await fundWallet(cid, "100");
      const createdIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const p = await createPayout(cid, "5.00");
        createdIds.push(p.id);
      }

      const full = await rowsFor(token, "?limit=100");
      assert.equal(full.length, 5);
      // newest-first: the last created id is first.
      assert.equal(full[0].id, createdIds[createdIds.length - 1]);
      const times = full.map((r) => Date.parse(r.createdAt as string));
      for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] >= times[i], "not created_at DESC");

      const seen: string[] = [];
      let page = 1;
      let totalPages = 1;
      let total = 0;
      do {
        const res = await list(token, `?page=${page}&limit=2`);
        assert.equal(res.body.meta.page, page);
        assert.equal(res.body.meta.limit, 2);
        total = res.body.meta.total;
        totalPages = res.body.meta.totalPages;
        seen.push(...res.body.data.map((r: { id: string }) => r.id));
        page += 1;
      } while (page <= totalPages);
      assert.equal(total, 5);
      assert.equal(totalPages, 3);
      assert.equal(new Set(seen).size, 5);
      assert.deepEqual([...seen].sort(), [...createdIds].sort());
    });

    test("invalid query -> 400", async () => {
      assert.equal((await list(tokens.customerA, "?limit=101")).status, 400);
      assert.equal((await list(tokens.customerA, "?page=0")).status, 400);
      assert.equal((await list(tokens.customerA, "?limit=0")).status, 400);
    });

    // task §57 — no status filter is implemented; an unknown query param is
    // stripped by Zod and has no effect (200, unchanged rows).
    test("status filter NOT USED — ?status=... is inert, not an error", async () => {
      const plain = await rowsFor(tokens.customerA, "?limit=100");
      const withParam = await list(tokens.customerA, "?limit=100&status=REVERSED");
      assert.equal(withParam.status, 200);
      assert.deepEqual(
        (withParam.body.data as Array<{ id: string }>).map((r) => r.id),
        plain.map((r) => r.id)
      );
    });
  });

  // ===========================================================
  // Read-only (task §27 / §55)
  // ===========================================================
  describe("read-only", () => {
    test("repeated GETs create no payout / wallet transaction / order / audit rows", async () => {
      const counts = async () => {
        const [payouts, wt, orders, audit] = await Promise.all([
          prisma.customer_payouts.count({ where: { customer_id: customerAId } }),
          prisma.wallet_transactions.count({ where: { customer_id: customerAId } }),
          prisma.orders.count({ where: { customer_id: customerAId } }),
          prisma.audit_logs.count({ where: { entity_id: customerAId } }),
        ]);
        return { payouts, wt, orders, audit };
      };
      const before = await counts();
      await list(tokens.customerA);
      await list(tokens.customerA, "?page=2&limit=1");
      await list(tokens.customerA, "?limit=100");
      assert.deepEqual(await counts(), before);
    });
  });
});
