import "../helpers/setup";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestDriverRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestCustomer,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedDriverRecord,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 13.5 — GET /api/v1/customer/me/wallet/transactions.
//
// Every ledger row in this suite is produced by a REAL approved workflow
// (exact DELIVERY_ONLY delivery -> ORDER_CREDIT; POST /payouts -> PAYOUT;
// POST /wallets/:id/adjust -> ADJUSTMENT; POST /wallet-transactions/:id/
// reverse -> REVERSAL) — never a hand-inserted wallet_transactions row.
//
// Covers: portal + permission auth (denial before lookup), self-scoping
// (no customerId/walletId trust), pagination + deterministic newest-first,
// each transaction type's Customer-safe presentation, direction derived from
// balances, safe Order / payout references, append-only (reversal is its own
// row), DTO privacy (no processedBy / notes / reason / balanceBefore /
// credit-debit / reversalOfId / idempotency), missing-wallet 500, type
// filter, bounded queries, and zero write side effects.
// ============================================================

const ROW_KEYS = ["id", "type", "occurredAt", "direction", "amount", "balanceAfter", "reference"].sort();

const FORBIDDEN_SUBSTRINGS = [
  "processedBy",
  "processed_by",
  "createdBy",
  "created_by",
  "balanceBefore",
  "balance_before",
  '"credit"',
  '"debit"',
  "paymentMethod",
  "payment_method",
  "notes",
  "reason",
  "goodwill", // the adjustment reason text
  "fat finger", // the reversal reason text
  "reversalOfId",
  "reversal_of_id",
  "idempotency",
  "wallet_id",
  '"walletId"',
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

describe("Customer Portal — Wallet Transactions (Phase 13.5)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverUser: TestUser;
  let customerAUser: TestUser;
  let customerBUser: TestUser;
  let noWalletUser: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let cashMethodId: string;
  let customerAId: string;
  let customerBId: string;
  let noWalletCustomerId: string;
  let driverId: string;

  let orderNumber: string;
  let payoutNumber: string;

  const orderIds: string[] = [];
  const customerRecordIds: string[] = [];
  const driverRecordIds: string[] = [];
  const areaIds: string[] = [];
  const userIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const list = (t?: string, qs = "") => {
    const r = request(app).get(`/api/v1/customer/me/wallet/transactions${qs}`);
    return t ? r.set(auth(t)) : r;
  };
  const post = (url: string, token: string, body?: unknown) =>
    request(app).post(url).set(auth(token)).send(body ?? {});
  async function ok(p: request.Test, label: string) {
    const res = await p;
    assert.ok(res.status >= 200 && res.status < 300, `${label} -> ${res.status}: ${JSON.stringify(res.body)}`);
    return res;
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverUser = await createTestUser("DRIVER");
    customerAUser = await createTestUser("CUSTOMER");
    customerBUser = await createTestUser("CUSTOMER");
    noWalletUser = await createTestUser("CUSTOMER");
    userIds.push(dispatcher.id, finance.id, driverUser.id, customerAUser.id, customerBUser.id, noWalletUser.id);

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driverUser.email, driverUser.password),
      loginTestUser(app, customerAUser.email, customerAUser.password),
      loginTestUser(app, customerBUser.email, customerBUser.password),
      loginTestUser(app, noWalletUser.email, noWalletUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customerA: logins[4].accessToken as string,
      customerB: logins[5].accessToken as string,
      noWallet: logins[6].accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `missing token: ${k}`);

    area = await createTestArea();
    areaIds.push(area.id);
    cashMethodId = (await prisma.payment_methods.findFirstOrThrow({ where: { code: "CASH" } })).id;

    customerAId = await seedCustomerRecord(admin.id, { name: "Tx Customer A", portalUserId: customerAUser.id });
    customerBId = await seedCustomerRecord(admin.id, { name: "Tx Customer B", portalUserId: customerBUser.id });
    customerRecordIds.push(customerAId, customerBId);
    noWalletCustomerId = await createTestCustomer(noWalletUser.id, admin.id);
    customerRecordIds.push(noWalletCustomerId);

    driverId = await seedDriverRecord(driverUser.id, { driverNumber: "PH135-DRV" });
    driverRecordIds.push(driverId);

    // ---- Customer A ledger via real workflows -------------------------
    // (1) ORDER_CREDIT +100 (balance 0 -> 100): exact DELIVERY_ONLY delivery.
    const createRes = await ok(
      request(app)
        .post("/api/v1/orders")
        .set(auth(tokens.admin))
        .send({
          customerId: customerAId,
          orderType: "DELIVERY_ONLY",
          paymentType: "CASH_ON_DELIVERY",
          receiverName: "Tx Receiver",
          receiverPhone: "+96170000135",
          receiverAreaId: area.id,
          receiverAddress: "1 Tx St",
          description: "Phase 13.5 tx parcel",
          orderAmount: "100.00",
          deliveryFee: "5.00",
          collectionPaymentMethodId: cashMethodId,
          parcelIntakeMethod: "ALREADY_AT_COMPANY",
        }),
      "create order"
    );
    const orderId = createRes.body.data.id as string;
    orderIds.push(orderId);
    orderNumber = (
      await prisma.orders.findUniqueOrThrow({ where: { id: orderId }, select: { order_number: true } })
    ).order_number;
    await ok(post(`/api/v1/orders/${orderId}/assign`, tokens.admin, { driverId }), "assign");
    await ok(post(`/api/v1/driver/orders/${orderId}/pickup`, tokens.driver), "pickup");
    await ok(post(`/api/v1/driver/orders/${orderId}/start-delivery`, tokens.driver), "start");
    await ok(post(`/api/v1/driver/orders/${orderId}/deliver`, tokens.driver, { actualAmountCollected: "105.00" }), "deliver");

    // (2) ADJUSTMENT +20 (100 -> 120).
    const adjRes = await ok(
      post(`/api/v1/wallets/${customerAId}/adjust`, tokens.admin, {
        direction: "CREDIT",
        amount: "20.00",
        reason: "goodwill",
      }),
      "adjust credit"
    );
    const adjTxId = adjRes.body.data.id as string;

    // (3) REVERSAL -20 (120 -> 100): reverse the adjustment above.
    await ok(
      post(`/api/v1/wallet-transactions/${adjTxId}/reverse`, tokens.admin, { reason: "fat finger" }),
      "reverse adjustment"
    );

    // (4) PAYOUT -30 (100 -> 70): approved Finance payout workflow.
    const payoutRes = await ok(
      request(app)
        .post("/api/v1/payouts")
        .set(auth(tokens.admin))
        .set("Idempotency-Key", randomUUID())
        .send({ customerId: customerAId, amount: "30.00", paymentMethodId: cashMethodId }),
      "create payout"
    );
    payoutNumber = payoutRes.body.data.payoutNumber as string;

    // ---- Customer B: one ADJUSTMENT so B's ledger is non-empty --------
    await ok(
      post(`/api/v1/wallets/${customerBId}/adjust`, tokens.admin, { direction: "CREDIT", amount: "500.00", reason: "b-only" }),
      "adjust B"
    );
  });

  after(async () => {
    // wallet_transactions (incl. self-referencing reversal pairs) + payouts
    // are cleared by cleanupTestCustomerRecord in FK-safe order.
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of customerRecordIds) await cleanupTestCustomerRecord(id);
    for (const id of driverRecordIds) await cleanupTestDriverRecord(id);
    for (const id of areaIds) await cleanupTestArea(id);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  const rowsFor = async (token: string, qs = "") => (await list(token, qs)).body.data as Array<Record<string, unknown>>;
  const byType = (rows: Array<Record<string, unknown>>, type: string) => rows.find((r) => r.type === type);

  // ===========================================================
  // Authorization (task §48)
  // ===========================================================
  describe("authorization", () => {
    test("CUSTOMER -> 200 list; ADMIN/DISPATCHER/FINANCE/DRIVER -> 403; unauthenticated -> 401", async () => {
      const res = await list(tokens.customerA);
      assert.equal(res.status, 200);
      assert.ok(Array.isArray(res.body.data));
      assert.ok(res.body.meta);
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        assert.equal((await list(tokens[role])).status, 403, role);
      }
      assert.equal((await list()).status, 401);
    });

    test("portal denial precedes wallet lookup — ADMIN 403 leaks nothing", async () => {
      const res = await list(tokens.admin);
      const json = JSON.stringify(res.body);
      assert.ok(!/prisma/i.test(json));
      assert.ok(!/wallet/i.test(json));
    });
  });

  // ===========================================================
  // Self-scoping (task §49)
  // ===========================================================
  describe("self-scoping", () => {
    test("A sees only A's 4 rows; ?customerId / ?walletId inert", async () => {
      const plain = await rowsFor(tokens.customerA);
      assert.equal(plain.length, 4);
      const spoof = await rowsFor(tokens.customerA, `?customerId=${customerBId}&walletId=whatever`);
      assert.deepEqual(
        spoof.map((r) => r.id).sort(),
        plain.map((r) => r.id).sort()
      );
    });

    test("B sees only B's single ADJUSTMENT (500)", async () => {
      const rows = await rowsFor(tokens.customerB);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].type, "ADJUSTMENT");
      assert.equal(rows[0].amount, "500");
    });
  });

  // ===========================================================
  // Ordering + pagination (task §22 / §50)
  // ===========================================================
  describe("ordering + pagination", () => {
    test("newest-first, deterministic; page/limit/total/totalPages, no dupes across pages", async () => {
      const full = await rowsFor(tokens.customerA, "?limit=100");
      const times = full.map((r) => Date.parse(r.occurredAt as string));
      for (let i = 1; i < times.length; i += 1) assert.ok(times[i - 1] >= times[i], "not created_at DESC");
      // newest row is the PAYOUT (last workflow step).
      assert.equal(full[0].type, "PAYOUT");

      const seen: string[] = [];
      let page = 1;
      let totalPages = 1;
      let total = 0;
      do {
        const res = await list(tokens.customerA, `?page=${page}&limit=2`);
        assert.equal(res.body.meta.page, page);
        assert.equal(res.body.meta.limit, 2);
        total = res.body.meta.total;
        totalPages = res.body.meta.totalPages;
        seen.push(...res.body.data.map((r: { id: string }) => r.id));
        page += 1;
      } while (page <= totalPages);
      assert.equal(total, 4);
      assert.equal(totalPages, 2);
      assert.equal(new Set(seen).size, 4);
    });

    test("invalid query -> 400", async () => {
      assert.equal((await list(tokens.customerA, "?limit=101")).status, 400);
      assert.equal((await list(tokens.customerA, "?page=0")).status, 400);
      assert.equal((await list(tokens.customerA, "?type=bogus")).status, 400);
    });
  });

  // ===========================================================
  // Per-type presentation (task §51 - §54) + direction from balances (§13)
  // ===========================================================
  describe("transaction presentation", () => {
    test("ORDER_CREDIT: CREDIT +100, balanceAfter 100, safe Order reference", async () => {
      const rows = await rowsFor(tokens.customerA, "?limit=100");
      const r = byType(rows, "ORDER_CREDIT")!;
      assert.equal(r.direction, "CREDIT");
      assert.equal(r.amount, "100");
      assert.equal(r.balanceAfter, "100");
      assert.deepEqual(r.reference, { kind: "ORDER", label: orderNumber });
    });

    test("ADJUSTMENT: CREDIT +20, no reference", async () => {
      const r = byType(await rowsFor(tokens.customerA, "?limit=100"), "ADJUSTMENT")!;
      assert.equal(r.direction, "CREDIT");
      assert.equal(r.amount, "20");
      assert.equal(r.reference, null);
    });

    test("REVERSAL: DEBIT -20 (direction from balances, not type), no reference", async () => {
      const r = byType(await rowsFor(tokens.customerA, "?limit=100"), "REVERSAL")!;
      assert.equal(r.direction, "DEBIT");
      assert.equal(r.amount, "20");
      assert.equal(r.reference, null);
    });

    test("PAYOUT: DEBIT -30, safe payout reference", async () => {
      const r = byType(await rowsFor(tokens.customerA, "?limit=100"), "PAYOUT")!;
      assert.equal(r.direction, "DEBIT");
      assert.equal(r.amount, "30");
      assert.deepEqual(r.reference, { kind: "PAYOUT", label: payoutNumber });
    });

    test("balanceAfter chain is consistent and ends at the current wallet balance", async () => {
      const rows = (await rowsFor(tokens.customerA, "?limit=100")).slice().reverse(); // oldest -> newest
      assert.deepEqual(
        rows.map((r) => r.balanceAfter),
        ["100", "120", "100", "70"]
      );
      const wallet = await prisma.customer_wallets.findUniqueOrThrow({
        where: { customer_id: customerAId },
        select: { available_balance: true },
      });
      assert.equal(rows[rows.length - 1].balanceAfter, wallet.available_balance.toString());
    });
  });

  // ===========================================================
  // Append-only (task §38 / §39)
  // ===========================================================
  describe("append-only", () => {
    test("the ADJUSTMENT and its REVERSAL are both present as separate rows", async () => {
      const rows = await rowsFor(tokens.customerA, "?limit=100");
      assert.equal(rows.filter((r) => r.type === "ADJUSTMENT").length, 1);
      assert.equal(rows.filter((r) => r.type === "REVERSAL").length, 1);
    });
  });

  // ===========================================================
  // DTO shape + privacy (task §55)
  // ===========================================================
  describe("DTO privacy", () => {
    test("exact key set; money strings; no internal / actor / note fields", async () => {
      const rows = await rowsFor(tokens.customerA, "?limit=100");
      for (const r of rows) {
        assert.deepEqual(Object.keys(r).sort(), ROW_KEYS);
        assert.equal(typeof r.amount, "string");
        assert.equal(typeof r.balanceAfter, "string");
        assert.ok(["CREDIT", "DEBIT", "NONE"].includes(r.direction as string));
      }
      const json = JSON.stringify((await list(tokens.customerA, "?limit=100")).body);
      for (const term of FORBIDDEN_SUBSTRINGS) assert.ok(!json.includes(term), `leaked "${term}"`);
    });
  });

  // ===========================================================
  // Type filter (task §20)
  // ===========================================================
  describe("type filter", () => {
    test("?type=payout returns only PAYOUT rows", async () => {
      const res = await list(tokens.customerA, "?type=payout");
      assert.equal(res.body.meta.total, 1);
      assert.equal(res.body.data[0].type, "PAYOUT");
    });
    test("?type=order_credit returns only ORDER_CREDIT rows", async () => {
      const res = await list(tokens.customerA, "?type=order_credit");
      assert.equal(res.body.meta.total, 1);
      assert.equal(res.body.data[0].type, "ORDER_CREDIT");
    });
  });

  // ===========================================================
  // Missing wallet (task §57) + read-only (task §56)
  // ===========================================================
  describe("missing wallet + read-only", () => {
    test("Customer with no wallet row -> 500 data-integrity; no wallet auto-created", async () => {
      const res = await list(tokens.noWallet);
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      assert.equal(await prisma.customer_wallets.findUnique({ where: { customer_id: noWalletCustomerId } }), null);
    });

    test("repeated reads create no ledger / payout / order / audit rows", async () => {
      const counts = async () => {
        const [wt, payouts, orders, audit] = await Promise.all([
          prisma.wallet_transactions.count({ where: { customer_id: customerAId } }),
          prisma.customer_payouts.count({ where: { customer_id: customerAId } }),
          prisma.orders.count({ where: { customer_id: customerAId } }),
          prisma.audit_logs.count({ where: { entity_id: customerAId } }),
        ]);
        return { wt, payouts, orders, audit };
      };
      const before = await counts();
      await list(tokens.customerA);
      await list(tokens.customerA, "?type=adjustment");
      await list(tokens.customerA, "?page=2&limit=2");
      assert.deepEqual(await counts(), before);
    });
  });
});
