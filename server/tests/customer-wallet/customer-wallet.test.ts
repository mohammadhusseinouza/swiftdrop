import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestArea,
  cleanupTestCustomerRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestCustomer,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 13.4 — GET /api/v1/customer/me/wallet.
//
// Covers: portal-family + permission authorization (portal denial BEFORE the
// wallet / pending lookup), strict self-scoping, available balance source,
// the approved Phase 8.2 pending rule (DELIVERY_ONLY only, delivery fee
// excluded, prepaid, COMPANY_ORDER excluded, terminal excluded,
// FAILED_DELIVERY/RESCHEDULED active), REVIEW_REQUIRED privacy, missing-wallet
// data-integrity failure, exact DTO key set, byte-for-byte agreement with the
// Dashboard endpoint, and zero write side effects.
// ============================================================

const SAFE_KEYS = ["customer", "availableBalance", "pendingAmount"].sort();

const FORBIDDEN_SUBSTRINGS = [
  "walletId",
  "wallet_id",
  "transactions",
  "wallet_transactions",
  "processedBy",
  "processed_by",
  "payout",
  "driverCash",
  "driver_cash",
  "driver_settlements",
  "companyRevenue",
  "company_financial",
  "financialStatus",
  "financial_status",
  "needsFinancialReview",
  "needs_financial_review",
  "collectionDifferenceReason",
  "collection_difference_reason",
  "actualAmountCollected",
  "reversal",
  "idempotency",
  "auditLog",
  "createdAt",
  "updatedAt",
];

describe("Customer Portal — Wallet (Phase 13.4)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customerAUser: TestUser;
  let customerBUser: TestUser;
  let noWalletCustomerUser: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let customerAId: string;
  let customerBId: string;
  let noWalletCustomerId: string;

  const orderIds: string[] = [];
  const customerRecordIds: string[] = [];
  const areaIds: string[] = [];
  const userIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const getWallet = (t?: string, qs = "") => {
    const r = request(app).get(`/api/v1/customer/me/wallet${qs}`);
    return t ? r.set(auth(t)) : r;
  };
  const getDashboard = (t: string) => request(app).get("/api/v1/customer/me/dashboard").set(auth(t));

  async function seedA(overrides: Parameters<typeof seedTestOrder>[2]) {
    const id = await seedTestOrder(customerAId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    orderIds.push(id);
    return id;
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customerAUser = await createTestUser("CUSTOMER");
    customerBUser = await createTestUser("CUSTOMER");
    noWalletCustomerUser = await createTestUser("CUSTOMER");
    userIds.push(
      dispatcher.id,
      finance.id,
      driver.id,
      customerAUser.id,
      customerBUser.id,
      noWalletCustomerUser.id
    );

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
      loginTestUser(app, customerAUser.email, customerAUser.password),
      loginTestUser(app, customerBUser.email, customerBUser.password),
      loginTestUser(app, noWalletCustomerUser.email, noWalletCustomerUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customerA: logins[4].accessToken as string,
      customerB: logins[5].accessToken as string,
      noWalletCustomer: logins[6].accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `missing token: ${k}`);

    area = await createTestArea();
    areaIds.push(area.id);

    customerAId = await seedCustomerRecord(admin.id, { name: "Wallet Customer A", portalUserId: customerAUser.id });
    customerBId = await seedCustomerRecord(admin.id, { name: "Wallet Customer B", portalUserId: customerBUser.id });
    customerRecordIds.push(customerAId, customerBId);

    // A Customer WITHOUT a wallet row (createTestCustomer does not create one).
    noWalletCustomerId = await createTestCustomer(noWalletCustomerUser.id, admin.id);
    customerRecordIds.push(noWalletCustomerId);

    await prisma.customer_wallets.update({ where: { customer_id: customerAId }, data: { available_balance: "250.00" } });
    await prisma.customer_wallets.update({ where: { customer_id: customerBId }, data: { available_balance: "40.00" } });

    // Customer A pending: only order (1) contributes 80.
    await seedA({ orderType: "DELIVERY_ONLY", status: "RECEIVED", orderAmount: "100.00", prepaidOrderAmount: "20.00", deliveryFee: "10.00" });
    await seedA({ orderType: "COMPANY_ORDER", status: "READY_FOR_PICKUP", orderAmount: "500.00", deliveryFee: "10.00" });
    await seedA({ orderType: "DELIVERY_ONLY", status: "ASSIGNED", orderAmount: "100.00", prepaidOrderAmount: "100.00", deliveryFee: "12.00" });
    await seedA({ orderType: "DELIVERY_ONLY", status: "CANCELLED", orderAmount: "100.00" });
    await seedA({ orderType: "DELIVERY_ONLY", status: "DELIVERED", orderAmount: "100.00", deliveredAt: new Date() });

    // Customer B: an active DELIVERY_ONLY worth 700 that must never leak into A.
    orderIds.push(
      await seedTestOrder(customerBId, admin.id, {
        areaId: area.id,
        areaName: area.name,
        orderType: "DELIVERY_ONLY",
        status: "RECEIVED",
        orderAmount: "700.00",
      })
    );
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    // noWalletCustomerId has no wallet — cleanupTestCustomerRecord's wallet
    // deleteMany is a no-op there, still FK-safe.
    for (const id of customerRecordIds) await cleanupTestCustomerRecord(id);
    for (const id of areaIds) await cleanupTestArea(id);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  // ===========================================================
  // Portal / permission matrix (task §48)
  // ===========================================================
  describe("authorization", () => {
    test("CUSTOMER -> 200", async () => {
      assert.equal((await getWallet(tokens.customerA)).status, 200);
    });

    test("ADMIN / DISPATCHER / FINANCE / DRIVER -> 403; unauthenticated -> 401", async () => {
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        const res = await getWallet(tokens[role]);
        assert.equal(res.status, 403, role);
        assert.equal(res.body.error.code, "FORBIDDEN");
      }
      assert.equal((await getWallet()).status, 401);
    });

    test("portal denial precedes wallet lookup — ADMIN 403 leaks nothing", async () => {
      const res = await getWallet(tokens.admin);
      assert.equal(res.status, 403);
      const json = JSON.stringify(res.body);
      assert.ok(!/customer profile/i.test(json));
      assert.ok(!/prisma/i.test(json));
      assert.ok(!/wallet/i.test(json));
    });
  });

  // ===========================================================
  // DTO shape + privacy (task §36 / §59)
  // ===========================================================
  describe("DTO", () => {
    test("exact key set; money strings; no ledger / payout / finance / timestamp fields", async () => {
      const res = await getWallet(tokens.customerA);
      assert.deepEqual(Object.keys(res.body.data).sort(), SAFE_KEYS);
      assert.deepEqual(Object.keys(res.body.data.customer).sort(), ["customerNumber", "name"].sort());
      assert.equal(typeof res.body.data.availableBalance, "string");
      assert.equal(typeof res.body.data.pendingAmount, "string");
      const json = JSON.stringify(res.body);
      for (const term of FORBIDDEN_SUBSTRINGS) assert.ok(!json.includes(term), `leaked "${term}"`);
    });
  });

  // ===========================================================
  // Self-scoping (task §35 / §49)
  // ===========================================================
  describe("self-scoping", () => {
    test("A sees only A; ?customerId=<B> has no effect", async () => {
      const plain = await getWallet(tokens.customerA);
      const spoof = await getWallet(tokens.customerA, `?customerId=${customerBId}`);
      assert.equal(spoof.status, 200);
      assert.deepEqual(spoof.body.data, plain.body.data);
      assert.equal(plain.body.data.customer.name, "Wallet Customer A");
      assert.notEqual(plain.body.data.availableBalance, "40");
    });

    test("B sees only B", async () => {
      const res = await getWallet(tokens.customerB);
      assert.equal(res.body.data.availableBalance, "40");
      assert.equal(res.body.data.pendingAmount, "700");
      assert.equal(res.body.data.customer.name, "Wallet Customer B");
    });
  });

  // ===========================================================
  // Figures (task §50 - §56)
  // ===========================================================
  describe("figures for Customer A", () => {
    test("availableBalance = customer_wallets.available_balance (250.00 -> '250')", async () => {
      assert.equal((await getWallet(tokens.customerA)).body.data.availableBalance, "250");
    });

    test("pendingAmount = 80 — DELIVERY_ONLY remaining order amount only; fee, COMPANY_ORDER, prepaid=full, terminal all excluded", async () => {
      assert.equal((await getWallet(tokens.customerA)).body.data.pendingAmount, "80");
    });
  });

  describe("FAILED_DELIVERY / RESCHEDULED remain pending (task §54)", () => {
    test("both contribute their remaining order amount", async () => {
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      const cid = await seedCustomerRecord(admin.id, { portalUserId: u.id });
      customerRecordIds.push(cid);
      for (const status of ["FAILED_DELIVERY", "RESCHEDULED"] as const) {
        orderIds.push(
          await seedTestOrder(cid, admin.id, {
            areaId: area.id,
            areaName: area.name,
            orderType: "DELIVERY_ONLY",
            status,
            orderAmount: "50.00",
          })
        );
      }
      const login = await loginTestUser(app, u.email, u.password);
      const res = await getWallet(login.accessToken as string);
      assert.equal(res.body.data.pendingAmount, "100");
    });
  });

  describe("delivered REVIEW_REQUIRED (task §56)", () => {
    test("no review fields; no third bucket; available/pending unchanged by it", async () => {
      const u = await createTestUser("CUSTOMER");
      userIds.push(u.id);
      const cid = await seedCustomerRecord(admin.id, { portalUserId: u.id });
      customerRecordIds.push(cid);
      orderIds.push(
        await seedTestOrder(cid, admin.id, {
          areaId: area.id,
          areaName: area.name,
          orderType: "DELIVERY_ONLY",
          status: "DELIVERED",
          deliveredAt: new Date(),
          financialStatus: "REVIEW_REQUIRED",
          needsFinancialReview: true,
          actualAmountCollected: "60.00",
          collectionDifferenceReason: "short by 40",
          orderAmount: "100.00",
        })
      );
      const login = await loginTestUser(app, u.email, u.password);
      const res = await getWallet(login.accessToken as string);
      assert.deepEqual(Object.keys(res.body.data).sort(), SAFE_KEYS);
      assert.equal(res.body.data.pendingAmount, "0"); // delivered -> not active -> not pending
      const json = JSON.stringify(res.body);
      assert.ok(!json.includes("REVIEW_REQUIRED"));
      assert.ok(!json.includes("short by 40"));
      assert.ok(!json.includes("60.00"));
    });
  });

  // ===========================================================
  // Missing wallet (task §57)
  // ===========================================================
  describe("missing wallet", () => {
    test("registered Customer with no wallet row -> 500 data-integrity, safe generic message", async () => {
      const res = await getWallet(tokens.noWalletCustomer);
      assert.equal(res.status, 500);
      assert.equal(res.body.error.code, "INTERNAL_ERROR");
      const json = JSON.stringify(res.body);
      assert.ok(!/prisma/i.test(json));
      // no auto-created wallet
      const wallet = await prisma.customer_wallets.findUnique({ where: { customer_id: noWalletCustomerId } });
      assert.equal(wallet, null);
    });
  });

  // ===========================================================
  // Dashboard consistency (task §34)
  // ===========================================================
  describe("dashboard consistency", () => {
    test("wallet endpoint figures byte-for-byte match the dashboard endpoint", async () => {
      const [w, d] = await Promise.all([getWallet(tokens.customerA), getDashboard(tokens.customerA)]);
      assert.equal(w.body.data.availableBalance, d.body.data.availableWalletBalance);
      assert.equal(w.body.data.pendingAmount, d.body.data.pendingAmount);
      assert.equal(w.body.data.customer.customerNumber, d.body.data.customer.customerNumber);
    });
  });

  // ===========================================================
  // Read-only (task §58)
  // ===========================================================
  describe("read-only", () => {
    test("repeated reads create no wallet transaction / payout / order / audit rows; wallet row unchanged", async () => {
      const snap = async () => {
        const [wt, payouts, orders, audit, wallet] = await Promise.all([
          prisma.wallet_transactions.count({ where: { customer_id: customerAId } }),
          prisma.customer_payouts.count({ where: { customer_id: customerAId } }),
          prisma.orders.count({ where: { customer_id: customerAId } }),
          prisma.audit_logs.count({ where: { entity_id: customerAId } }),
          prisma.customer_wallets.findUnique({
            where: { customer_id: customerAId },
            select: { available_balance: true, updated_at: true },
          }),
        ]);
        return {
          wt,
          payouts,
          orders,
          audit,
          bal: wallet?.available_balance.toString(),
          updatedAt: wallet?.updated_at.toISOString(),
        };
      };
      const before = await snap();
      await getWallet(tokens.customerA);
      await getWallet(tokens.customerA);
      await getWallet(tokens.customerA);
      assert.deepEqual(await snap(), before);
    });
  });
});
