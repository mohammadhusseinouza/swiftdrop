import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
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
  type SeededOrderOverrides,
  type TestUser,
} from "../helpers/fixtures";

// Management Customers page summary cards — system-wide totals.
//   GET /api/v1/customers/totals (customers.read) -> activeOrders, deliveredOrders
//   GET /api/v1/wallets/totals   (wallets.read)   -> availableBalance, pendingAmount
// The DB is shared with other suites' leftovers, so every assertion is a
// DELTA: totals are read before and after seeding this file's fixtures.
describe("Customers page global totals", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };

  let customerA: string;
  let customerB: string;

  const createdOrderIds: string[] = [];
  const createdCustomerIds: string[] = [];

  let walletBefore: { availableBalance: string; pendingAmount: string };
  let ordersBefore: { activeOrders: number; deliveredOrders: number };

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async function seedOrder(customerId: string, overrides: SeededOrderOverrides) {
    const id = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    createdOrderIds.push(id);
    return id;
  }

  async function readWalletTotals() {
    const res = await request(app).get("/api/v1/wallets/totals").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    return res.body.data as { availableBalance: string; pendingAmount: string };
  }

  async function readOrderTotals() {
    const res = await request(app).get("/api/v1/customers/totals").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    return res.body.data as { activeOrders: number; deliveredOrders: number };
  }

  function delta(after: string, before: string): string {
    return new Prisma.Decimal(after).minus(new Prisma.Decimal(before)).toFixed(2);
  }

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverActor = await createTestUser("DRIVER");
    customerActor = await createTestUser("CUSTOMER");

    const logins = await Promise.all(
      [admin, dispatcher, finance, driverActor, customerActor].map((u) => loginTestUser(app, u.email, u.password))
    );
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customer: logins[4].accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) {
      assert.ok(token, `expected an access token for ${role}`);
    }

    area = await createTestArea();

    walletBefore = await readWalletTotals();
    ordersBefore = await readOrderTotals();

    customerA = await seedCustomerRecord(admin.id);
    customerB = await seedCustomerRecord(admin.id);
    createdCustomerIds.push(customerA, customerB);

    // Cached wallet balances (the same column a single Customer's
    // "Available Wallet" reads).
    await prisma.customer_wallets.update({
      where: { customer_id: customerA },
      data: { available_balance: new Prisma.Decimal("120.50") },
    });
    await prisma.customer_wallets.update({
      where: { customer_id: customerB },
      data: { available_balance: new Prisma.Decimal("79.25") },
    });

    // Customer A — active orders.
    await seedOrder(customerA, { orderType: "DELIVERY_ONLY", status: "RECEIVED", orderAmount: "100.00" }); // pending 100
    await seedOrder(customerA, {
      orderType: "DELIVERY_ONLY",
      status: "ASSIGNED",
      orderAmount: "50.00",
      prepaidOrderAmount: "20.00",
      paymentType: "PARTIALLY_PAID",
    }); // pending 30 (remaining only; delivery fee never pending)
    await seedOrder(customerA, { orderType: "COMPANY_ORDER", status: "RECEIVED", orderAmount: "200.00" }); // active, never pending

    // Customer B — one active retryable + terminal orders.
    await seedOrder(customerB, { orderType: "DELIVERY_ONLY", status: "FAILED_DELIVERY", orderAmount: "25.00" }); // active, pending 25
    await seedOrder(customerB, { orderType: "DELIVERY_ONLY", status: "DELIVERED", orderAmount: "70.00" }); // delivered only
    await seedOrder(customerB, { orderType: "DELIVERY_ONLY", status: "CANCELLED", orderAmount: "40.00" }); // neither
    await seedOrder(customerB, { orderType: "DELIVERY_ONLY", status: "RETURNED_TO_CUSTOMER", orderAmount: "60.00" }); // neither
    await seedOrder(customerB, { orderType: "COMPANY_ORDER", status: "RETURNED_TO_COMPANY", orderAmount: "90.00" }); // neither
  });

  after(async () => {
    for (const id of createdOrderIds) await cleanupTestOrder(id);
    for (const id of createdCustomerIds) await cleanupTestCustomerRecord(id);
    await cleanupTestArea(area.id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  describe("GET /api/v1/wallets/totals", () => {
    test("available wallet = sum of every customer's cached available balance", async () => {
      const now = await readWalletTotals();
      assert.equal(delta(now.availableBalance, walletBefore.availableBalance), "199.75");
    });

    test("pending = DELIVERY_ONLY remaining order amount on active orders only", async () => {
      const now = await readWalletTotals();
      // 100 + 30 + 25. COMPANY_ORDER and terminal (DELIVERED / CANCELLED /
      // RETURNED_*) orders contribute nothing.
      assert.equal(delta(now.pendingAmount, walletBefore.pendingAmount), "155.00");
    });

    test("matches the sum of the per-customer wallet detail figures", async () => {
      const [a, b] = await Promise.all(
        [customerA, customerB].map((id) => request(app).get(`/api/v1/wallets/${id}`).set(auth(tokens.admin)))
      );
      const pendingSum = new Prisma.Decimal(a.body.data.wallet.pendingAmount).plus(b.body.data.wallet.pendingAmount);
      const availableSum = new Prisma.Decimal(a.body.data.wallet.availableBalance).plus(
        b.body.data.wallet.availableBalance
      );
      const now = await readWalletTotals();
      assert.equal(delta(now.pendingAmount, walletBefore.pendingAmount), pendingSum.toFixed(2));
      assert.equal(delta(now.availableBalance, walletBefore.availableBalance), availableSum.toFixed(2));
    });

    test("FINANCE -> 200", async () => {
      const res = await request(app).get("/api/v1/wallets/totals").set(auth(tokens.finance));
      assert.equal(res.status, 200);
    });

    test("DISPATCHER (no wallets.read) -> 403", async () => {
      const res = await request(app).get("/api/v1/wallets/totals").set(auth(tokens.dispatcher));
      assert.equal(res.status, 403);
    });

    test("DRIVER / CUSTOMER -> 403, no auth -> 401", async () => {
      const [driver, customer, anon] = await Promise.all([
        request(app).get("/api/v1/wallets/totals").set(auth(tokens.driver)),
        request(app).get("/api/v1/wallets/totals").set(auth(tokens.customer)),
        request(app).get("/api/v1/wallets/totals"),
      ]);
      assert.equal(driver.status, 403);
      assert.equal(customer.status, 403);
      assert.equal(anon.status, 401);
    });
  });

  describe("GET /api/v1/customers/totals", () => {
    test("active orders count every non-terminal order across customers, any order type", async () => {
      const now = await readOrderTotals();
      // A: RECEIVED, ASSIGNED, COMPANY_ORDER RECEIVED; B: FAILED_DELIVERY.
      assert.equal(now.activeOrders - ordersBefore.activeOrders, 4);
    });

    test("delivered orders count only DELIVERED", async () => {
      const now = await readOrderTotals();
      assert.equal(now.deliveredOrders - ordersBefore.deliveredOrders, 1);
    });

    test("matches the sum of the per-customer detail order summaries", async () => {
      const [a, b] = await Promise.all(
        [customerA, customerB].map((id) => request(app).get(`/api/v1/customers/${id}`).set(auth(tokens.admin)))
      );
      const now = await readOrderTotals();
      assert.equal(
        now.activeOrders - ordersBefore.activeOrders,
        a.body.data.orderSummary.activeOrders + b.body.data.orderSummary.activeOrders
      );
      assert.equal(
        now.deliveredOrders - ordersBefore.deliveredOrders,
        a.body.data.orderSummary.deliveredOrders + b.body.data.orderSummary.deliveredOrders
      );
    });

    test("response is operational only — never carries wallet money", async () => {
      const res = await request(app).get("/api/v1/customers/totals").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), ["activeOrders", "deliveredOrders"]);
    });

    test("FINANCE -> 200", async () => {
      const res = await request(app).get("/api/v1/customers/totals").set(auth(tokens.finance));
      assert.equal(res.status, 200);
    });

    test("DRIVER / CUSTOMER -> 403, no auth -> 401", async () => {
      const [driver, customer, anon] = await Promise.all([
        request(app).get("/api/v1/customers/totals").set(auth(tokens.driver)),
        request(app).get("/api/v1/customers/totals").set(auth(tokens.customer)),
        request(app).get("/api/v1/customers/totals"),
      ]);
      assert.equal(driver.status, 403);
      assert.equal(customer.status, 403);
      assert.equal(anon.status, 401);
    });
  });
});
