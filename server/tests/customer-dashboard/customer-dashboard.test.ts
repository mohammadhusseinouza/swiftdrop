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
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedTestOrder,
  type TestUser,
} from "../helpers/fixtures";

// ============================================================
// Phase 13.1 — GET /api/v1/customer/me/dashboard.
//
// Covers: portal-family + permission authorization (portal denial BEFORE the
// Customer profile lookup), strict self-scoping (no client customerId),
// available wallet balance source, the approved Phase 8.2 pending rule
// (DELIVERY_ONLY only, delivery fee excluded, prepaid handled, COMPANY_ORDER
// excluded, terminal excluded, DELIVERED excluded), active vs delivered
// counting, FAILED_DELIVERY / RESCHEDULED treated as active, and zero
// financial/side-effect writes.
// ============================================================

const SAFE_KEYS = ["customer", "availableWalletBalance", "pendingAmount", "activeOrders", "deliveredOrders"].sort();

const FORBIDDEN_SUBSTRINGS = [
  "needsFinancialReview",
  "needs_financial_review",
  "financialStatus",
  "financial_status",
  "collectionDifferenceReason",
  "collection_difference_reason",
  "driverCash",
  "driver_cash",
  "companyRevenue",
  "company_financial",
  "settlement",
  "parcelCollection",
  "parcel_collection",
  "auditLog",
];

describe("Customer Portal — Dashboard (Phase 13.1)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driver: TestUser;
  let customerAUser: TestUser;
  let customerBUser: TestUser;
  let orphanCustomerUser: TestUser;
  let tokens: Record<string, string>;

  let area: { id: string; name: string };
  let customerAId: string;
  let customerBId: string;

  const orderIds: string[] = [];
  const customerRecordIds: string[] = [];
  const areaIds: string[] = [];
  const userIds: string[] = [];

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const getDashboard = (t?: string) => {
    const r = request(app).get("/api/v1/customer/me/dashboard");
    return t ? r.set(auth(t)) : r;
  };

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driver = await createTestUser("DRIVER");
    customerAUser = await createTestUser("CUSTOMER");
    customerBUser = await createTestUser("CUSTOMER");
    orphanCustomerUser = await createTestUser("CUSTOMER");
    userIds.push(
      dispatcher.id,
      finance.id,
      driver.id,
      customerAUser.id,
      customerBUser.id,
      orphanCustomerUser.id
    );

    const logins = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
      loginTestUser(app, driver.email, driver.password),
      loginTestUser(app, customerAUser.email, customerAUser.password),
      loginTestUser(app, customerBUser.email, customerBUser.password),
      loginTestUser(app, orphanCustomerUser.email, orphanCustomerUser.password),
    ]);
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customerA: logins[4].accessToken as string,
      customerB: logins[5].accessToken as string,
      orphanCustomer: logins[6].accessToken as string,
    };
    for (const [k, v] of Object.entries(tokens)) assert.ok(v, `missing token: ${k}`);

    area = await createTestArea();
    areaIds.push(area.id);

    // Customer A + wallet (balance 250.00) linked to customerAUser.
    customerAId = await seedCustomerRecord(admin.id, {
      name: "Dashboard Customer A",
      portalUserId: customerAUser.id,
    });
    customerBId = await seedCustomerRecord(admin.id, {
      name: "Dashboard Customer B",
      portalUserId: customerBUser.id,
    });
    customerRecordIds.push(customerAId, customerBId);

    await prisma.customer_wallets.update({
      where: { customer_id: customerAId },
      data: { available_balance: "250.00" },
    });
    await prisma.customer_wallets.update({
      where: { customer_id: customerBId },
      data: { available_balance: "999.00" },
    });

    // ---- Customer A orders ---------------------------------------------
    // (1) Active DELIVERY_ONLY, orderAmount 100 / prepaidOrderAmount 20 →
    //     remaining_order_amount 80 → the ONLY pending contributor.
    const seedA = async (o: Parameters<typeof seedTestOrder>[2]) => {
      const id = await seedTestOrder(customerAId, admin.id, { areaId: area.id, areaName: area.name, ...o });
      orderIds.push(id);
      return id;
    };
    await seedA({
      orderType: "DELIVERY_ONLY",
      status: "RECEIVED",
      orderAmount: "100.00",
      prepaidOrderAmount: "20.00",
      deliveryFee: "15.00",
    });
    // (2) Active COMPANY_ORDER with a positive amount to collect — MUST NOT
    //     add to pending (its product amount is company money).
    await seedA({
      orderType: "COMPANY_ORDER",
      status: "READY_FOR_PICKUP",
      orderAmount: "500.00",
      prepaidOrderAmount: "0",
      deliveryFee: "10.00",
    });
    // (3) Active DELIVERY_ONLY fully prepaid (100 / 100) → 0 pending, even
    //     though remaining_delivery_fee may still be collected.
    await seedA({
      orderType: "DELIVERY_ONLY",
      status: "ASSIGNED",
      orderAmount: "100.00",
      prepaidOrderAmount: "100.00",
      deliveryFee: "12.00",
    });
    // (4) Terminal CANCELLED DELIVERY_ONLY → excluded from pending + active.
    await seedA({
      orderType: "DELIVERY_ONLY",
      status: "CANCELLED",
      orderAmount: "100.00",
      prepaidOrderAmount: "0",
    });
    // (5) DELIVERED DELIVERY_ONLY → counts as delivered, not active, not pending.
    await seedA({
      orderType: "DELIVERY_ONLY",
      status: "DELIVERED",
      orderAmount: "100.00",
      prepaidOrderAmount: "0",
      deliveredAt: new Date(),
    });

    // ---- Customer B orders (must never appear in A's totals) -----------
    const bOrder = await seedTestOrder(customerBId, admin.id, {
      areaId: area.id,
      areaName: area.name,
      orderType: "DELIVERY_ONLY",
      status: "RECEIVED",
      orderAmount: "700.00",
      prepaidOrderAmount: "0",
    });
    orderIds.push(bOrder);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of customerRecordIds) await cleanupTestCustomerRecord(id);
    for (const id of areaIds) await cleanupTestArea(id);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  // ===========================================================
  // Portal / permission matrix (task §45)
  // ===========================================================
  describe("authorization matrix", () => {
    test("CUSTOMER → 200", async () => {
      const res = await getDashboard(tokens.customerA);
      assert.equal(res.status, 200, JSON.stringify(res.body));
    });

    test("ADMIN / DISPATCHER / FINANCE / DRIVER → 403 (portal isolation)", async () => {
      for (const role of ["admin", "dispatcher", "finance", "driver"] as const) {
        const res = await getDashboard(tokens[role]);
        assert.equal(res.status, 403, `${role} expected 403, got ${res.status}`);
        assert.equal(res.body.error.code, "FORBIDDEN");
      }
    });

    test("unauthenticated → 401", async () => {
      const res = await getDashboard();
      assert.equal(res.status, 401);
    });

    test("portal denial precedes Customer profile lookup — ADMIN 403 never leaks profile existence / Prisma internals", async () => {
      const res = await getDashboard(tokens.admin);
      assert.equal(res.status, 403);
      const json = JSON.stringify(res.body);
      assert.ok(!/customer profile/i.test(json), "must not leak the 'no customer profile' message");
      assert.ok(!/prisma/i.test(json));
      assert.ok(!/foreign key/i.test(json));
    });

    test("CUSTOMER role with no linked customers row → 403 (data integrity, safe message)", async () => {
      const res = await getDashboard(tokens.orphanCustomer);
      assert.equal(res.status, 403);
      const json = JSON.stringify(res.body);
      assert.ok(!/prisma/i.test(json));
    });
  });

  // ===========================================================
  // DTO shape + privacy
  // ===========================================================
  describe("response DTO", () => {
    test("exact safe key set — no internal accounting / review / parcel fields", async () => {
      const res = await getDashboard(tokens.customerA);
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), SAFE_KEYS);
      assert.deepEqual(Object.keys(res.body.data.customer).sort(), ["customerNumber", "name"].sort());

      const json = JSON.stringify(res.body);
      for (const term of FORBIDDEN_SUBSTRINGS) {
        assert.ok(!json.includes(term), `leaked forbidden term "${term}"`);
      }
    });

    test("money values are strings; counts are integers", async () => {
      const res = await getDashboard(tokens.customerA);
      const d = res.body.data;
      assert.equal(typeof d.availableWalletBalance, "string");
      assert.equal(typeof d.pendingAmount, "string");
      assert.equal(Number.isInteger(d.activeOrders), true);
      assert.equal(Number.isInteger(d.deliveredOrders), true);
    });
  });

  // ===========================================================
  // Self-scoping (task §46)
  // ===========================================================
  describe("self-scoping", () => {
    test("reflects the authenticated Customer only; ?customerId spoof has no effect", async () => {
      const plain = await getDashboard(tokens.customerA);
      const spoofed = await request(app)
        .get(`/api/v1/customer/me/dashboard?customerId=${customerBId}`)
        .set(auth(tokens.customerA));

      assert.equal(spoofed.status, 200);
      assert.deepEqual(spoofed.body.data, plain.body.data);
      // Customer B's wallet (999) / order (700) never bleed into A's totals.
      assert.notEqual(plain.body.data.availableWalletBalance, "999");
      assert.equal(plain.body.data.customer.name, "Dashboard Customer A");
    });

    test("Customer B sees only B's figures", async () => {
      const res = await getDashboard(tokens.customerB);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.availableWalletBalance, "999");
      assert.equal(res.body.data.customer.name, "Dashboard Customer B");
      assert.equal(res.body.data.activeOrders, 1);
      assert.equal(res.body.data.deliveredOrders, 0);
    });
  });

  // ===========================================================
  // Financial metrics
  // ===========================================================
  describe("metrics for Customer A", () => {
    test("availableWalletBalance = customer_wallets.available_balance (250.00 → '250')", async () => {
      const res = await getDashboard(tokens.customerA);
      assert.equal(res.body.data.availableWalletBalance, "250");
    });

    test("pendingAmount = SUM(remaining_order_amount) over active DELIVERY_ONLY only — 80", async () => {
      // order (1): 100 - 20 = 80 remaining order amount  → counts
      // order (2): COMPANY_ORDER                          → excluded
      // order (3): 100 - 100 = 0                          → +0
      // order (4): CANCELLED (terminal)                   → excluded
      // order (5): DELIVERED                              → excluded
      // delivery fees on every order                      → never counted
      const res = await getDashboard(tokens.customerA);
      assert.equal(res.body.data.pendingAmount, "80");
    });

    test("activeOrders = 3 non-terminal orders (DELIVERED + CANCELLED excluded)", async () => {
      const res = await getDashboard(tokens.customerA);
      assert.equal(res.body.data.activeOrders, 3);
    });

    test("deliveredOrders = 1", async () => {
      const res = await getDashboard(tokens.customerA);
      assert.equal(res.body.data.deliveredOrders, 1);
    });
  });

  // ===========================================================
  // FAILED_DELIVERY / RESCHEDULED are active per the Order engine (task §53)
  // ===========================================================
  describe("FAILED_DELIVERY / RESCHEDULED active-counting", () => {
    let tempCustomerId: string;
    let tempUser: TestUser;
    const tempOrderIds: string[] = [];

    before(async () => {
      tempUser = await createTestUser("CUSTOMER");
      userIds.push(tempUser.id);
      tempCustomerId = await seedCustomerRecord(admin.id, { portalUserId: tempUser.id });
      customerRecordIds.push(tempCustomerId);
      for (const status of ["FAILED_DELIVERY", "RESCHEDULED"] as const) {
        const id = await seedTestOrder(tempCustomerId, admin.id, {
          areaId: area.id,
          areaName: area.name,
          orderType: "DELIVERY_ONLY",
          status,
          orderAmount: "50.00",
          prepaidOrderAmount: "0",
        });
        tempOrderIds.push(id);
        orderIds.push(id);
      }
    });

    test("both FAILED_DELIVERY and RESCHEDULED count as active; pending includes their remaining order amount", async () => {
      const login = await loginTestUser(app, tempUser.email, tempUser.password);
      const res = await getDashboard(login.accessToken as string);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.activeOrders, 2);
      assert.equal(res.body.data.deliveredOrders, 0);
      // 50 + 50 remaining order amount, both active DELIVERY_ONLY.
      assert.equal(res.body.data.pendingAmount, "100");
    });
  });

  // ===========================================================
  // Read-only guarantee (task §54)
  // ===========================================================
  describe("read-only", () => {
    test("repeated reads create no wallet / order / payout / audit rows for the Customer", async () => {
      // Scoped to Customer A's own rows — global ledger tables are shared with
      // other concurrently-running test files, so a global count would be racy.
      const counts = async () => {
        const [wt, payouts, audit, orders, walletUpdatedAt] = await Promise.all([
          prisma.wallet_transactions.count({ where: { customer_id: customerAId } }),
          prisma.customer_payouts.count({ where: { customer_id: customerAId } }),
          prisma.audit_logs.count({ where: { entity_id: customerAId } }),
          prisma.orders.count({ where: { customer_id: customerAId } }),
          prisma.customer_wallets
            .findUnique({ where: { customer_id: customerAId }, select: { updated_at: true } })
            .then((w) => w?.updated_at.toISOString()),
        ]);
        return { wt, payouts, audit, orders, walletUpdatedAt };
      };

      const before = await counts();
      await getDashboard(tokens.customerA);
      await getDashboard(tokens.customerA);
      await getDashboard(tokens.customerA);
      const afterCounts = await counts();
      assert.deepEqual(afterCounts, before);
    });
  });
});
