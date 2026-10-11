import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { getUtcDayBoundary } from "../../src/shared/date/day-boundary";
import {
  applyDriverCashAdjustment,
  applyDriverCashReversal,
  creditDriverCollection,
  debitDriverSettlement,
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
  seedDriverRecord,
  seedTestOrder,
  type SeededOrderOverrides,
  type TestUser,
} from "../helpers/fixtures";

// Management Drivers page summary cards — system-wide totals.
//   GET /api/v1/drivers/totals              (drivers.read) -> activeOrders, outForDelivery, completedToday
//   GET /api/v1/finance/driver-cash/totals  (finance.read) -> currentBalance
// The DB is shared with other suites' leftovers, so every assertion is a
// DELTA against totals read before this file seeds anything.
describe("Drivers page global totals", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverActor: TestUser;
  let customerActor: TestUser;
  let tokens: Record<string, string>;
  let area: { id: string; name: string };
  let customerId: string;

  let d1: string;
  let d2: string;
  let d3Inactive: string;

  const driverUserIds: string[] = [];
  const driverIds: string[] = [];
  const orderIds: string[] = [];

  let opsBefore: { activeOrders: number; outForDelivery: number; completedToday: number };
  let cashBefore: string;

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function decimal(value: string) {
    return new Prisma.Decimal(value);
  }

  function delta(after: string, before: string): string {
    return decimal(after).minus(decimal(before)).toFixed(2);
  }

  async function seedDriver(isActive = true) {
    const user = await createTestUser("DRIVER");
    driverUserIds.push(user.id);
    const id = await seedDriverRecord(user.id, { isActive });
    driverIds.push(id);
    return id;
  }

  async function seedOrder(overrides: SeededOrderOverrides) {
    const id = await seedTestOrder(customerId, admin.id, { areaId: area.id, areaName: area.name, ...overrides });
    orderIds.push(id);
    return id;
  }

  async function seedAttempt(
    orderId: string,
    driverId: string,
    attemptNumber: number,
    outcome: "DELIVERED" | "FAILED",
    when: Date
  ) {
    await prisma.delivery_attempts.create({
      data: {
        order_id: orderId,
        driver_id: driverId,
        attempt_number: attemptNumber,
        expected_collection: decimal("25.00"),
        actual_collection: outcome === "DELIVERED" ? decimal("25.00") : undefined,
        outcome,
        started_at: when,
        completed_at: when,
      },
    });
  }

  async function readOps() {
    const res = await request(app).get("/api/v1/drivers/totals").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    return res.body.data as { activeOrders: number; outForDelivery: number; completedToday: number };
  }

  async function readCash() {
    const res = await request(app).get("/api/v1/finance/driver-cash/totals").set(auth(tokens.admin));
    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    return res.body.data.currentBalance as string;
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
    customerId = await seedCustomerRecord(admin.id);

    opsBefore = await readOps();
    cashBefore = await readCash();

    d1 = await seedDriver();
    d2 = await seedDriver();
    d3Inactive = await seedDriver(false);

    // ---- currently held work ------------------------------------------
    await seedOrder({ status: "ASSIGNED", currentDriverId: d1 }); // active
    await seedOrder({ status: "OUT_FOR_DELIVERY", currentDriverId: d1 }); // active + OFD
    await seedOrder({ status: "PICKED_UP", currentDriverId: d2, orderType: "COMPANY_ORDER" }); // active
    await seedOrder({ status: "FAILED_DELIVERY", currentDriverId: d2 }); // active (retryable)
    await seedOrder({ status: "ASSIGNED", currentDriverId: d3Inactive }); // active, inactive driver
    await seedOrder({ status: "RECEIVED" }); // unassigned -> excluded
    await seedOrder({ status: "OUT_FOR_DELIVERY" }); // OFD but no driver -> excluded
    await seedOrder({ status: "CANCELLED", currentDriverId: d1 }); // terminal -> excluded

    // Reassigned order (d1 -> d2) with permanent assignment history: still
    // ONE active order, held by d2 only.
    const reassigned = await seedOrder({ status: "ASSIGNED", currentDriverId: d2 });
    await prisma.order_assignments.createMany({
      data: [
        {
          order_id: reassigned,
          driver_id: d1,
          assigned_by_id: admin.id,
          is_current: false,
          ended_at: new Date(),
          end_reason: "REASSIGNED",
        },
        { order_id: reassigned, driver_id: d2, assigned_by_id: admin.id, is_current: true },
      ],
    });

    // ---- delivered today ----------------------------------------------
    const { start, end } = getUtcDayBoundary();
    const now = new Date();

    // Failed by d1, then reassigned and delivered by d2: counts once (d2).
    const retried = await seedOrder({ status: "DELIVERED", currentDriverId: d2, deliveredAt: now });
    await seedAttempt(retried, d1, 1, "FAILED", now);
    await seedAttempt(retried, d2, 2, "DELIVERED", now);

    const today = await seedOrder({ status: "DELIVERED", currentDriverId: d1, deliveredAt: now });
    await seedAttempt(today, d1, 1, "DELIVERED", now);

    // Inactive driver, exactly at the start-of-day boundary -> included.
    const atStart = await seedOrder({ status: "DELIVERED", currentDriverId: d3Inactive, deliveredAt: start });
    await seedAttempt(atStart, d3Inactive, 1, "DELIVERED", start);

    // 1ms before today -> excluded.
    const yesterday = new Date(start.getTime() - 1);
    const old = await seedOrder({ status: "DELIVERED", currentDriverId: d1, deliveredAt: yesterday });
    await seedAttempt(old, d1, 1, "DELIVERED", yesterday);

    // Exactly at the exclusive end boundary -> excluded.
    const boundary = await seedOrder({ status: "DELIVERED", currentDriverId: d2, deliveredAt: end });
    await seedAttempt(boundary, d2, 1, "DELIVERED", end);

    // ---- cash ledger (authoritative balance via the real ledger) ---------
    await prisma.$transaction(async (tx) => {
      await creditDriverCollection(tx, { driverId: d1, amount: decimal("300.00") });
      await debitDriverSettlement(tx, { driverId: d1, amount: decimal("100.00") }); // d1 = 200
      await creditDriverCollection(tx, { driverId: d2, amount: decimal("50.00") });
      await applyDriverCashAdjustment(tx, { driverId: d2, direction: "DEBIT", amount: decimal("20.00") });
      await applyDriverCashReversal(tx, { driverId: d2, direction: "CREDIT", amount: decimal("5.00") }); // d2 = 35
      await creditDriverCollection(tx, { driverId: d3Inactive, amount: decimal("40.00") }); // inactive = 40
    });
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(area.id);
    for (const id of driverUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, driverActor, customerActor].map((u) => cleanupTestUser(u.id)));
  });

  describe("GET /api/v1/drivers/totals", () => {
    test("assigned orders = currently held active orders, once each, inactive drivers included", async () => {
      const now = await readOps();
      // d1: ASSIGNED, OUT_FOR_DELIVERY; d2: PICKED_UP, FAILED_DELIVERY,
      // reassigned ASSIGNED; d3 (inactive): ASSIGNED.
      assert.equal(now.activeOrders - opsBefore.activeOrders, 6);
    });

    test("out for delivery counts only OUT_FOR_DELIVERY orders held by a driver", async () => {
      const now = await readOps();
      assert.equal(now.outForDelivery - opsBefore.outForDelivery, 1);
    });

    test("delivered today uses the UTC day [start, end) and counts a reassigned order once", async () => {
      const now = await readOps();
      // retried (d2), today (d1), atStart (d3). Not yesterday, not `end`.
      assert.equal(now.completedToday - opsBefore.completedToday, 3);
    });

    test("every total equals the sum of the per-driver Driver Detail figures", async () => {
      const details = await Promise.all(
        [d1, d2, d3Inactive].map((id) => request(app).get(`/api/v1/drivers/${id}`).set(auth(tokens.admin)))
      );
      const sum = { activeOrders: 0, outForDelivery: 0, completedToday: 0 };
      for (const res of details) {
        assert.equal(res.status, 200);
        const s = res.body.data.operationalSummary;
        sum.activeOrders += s.activeOrders;
        sum.outForDelivery += s.outForDelivery;
        sum.completedToday += s.completedToday;
      }
      const now = await readOps();
      assert.equal(now.activeOrders - opsBefore.activeOrders, sum.activeOrders);
      assert.equal(now.outForDelivery - opsBefore.outForDelivery, sum.outForDelivery);
      assert.equal(now.completedToday - opsBefore.completedToday, sum.completedToday);
    });

    test("filters / pagination params on the list do not apply to totals", async () => {
      const plain = await readOps();
      const res = await request(app)
        .get("/api/v1/drivers/totals?search=zzz-no-match&isActive=false&page=9&limit=1")
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, plain);
    });

    test("operational only — DISPATCHER gets 200 and no cash field", async () => {
      const res = await request(app).get("/api/v1/drivers/totals").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), ["activeOrders", "completedToday", "outForDelivery"]);
    });

    test("DRIVER / CUSTOMER -> 403, no auth -> 401", async () => {
      const [driver, customer, anon] = await Promise.all([
        request(app).get("/api/v1/drivers/totals").set(auth(tokens.driver)),
        request(app).get("/api/v1/drivers/totals").set(auth(tokens.customer)),
        request(app).get("/api/v1/drivers/totals"),
      ]);
      assert.equal(driver.status, 403);
      assert.equal(customer.status, 403);
      assert.equal(anon.status, 401);
    });
  });

  describe("GET /api/v1/finance/driver-cash/totals", () => {
    test("cash held = sum of authoritative balances after collections, settlement and corrections", async () => {
      const now = await readCash();
      // d1 200 + d2 35 + inactive d3 40.
      assert.equal(delta(now, cashBefore), "275.00");
    });

    test("matches the sum of the per-driver Cash Held figures", async () => {
      const details = await Promise.all(
        [d1, d2, d3Inactive].map((id) => request(app).get(`/api/v1/finance/driver-cash/${id}`).set(auth(tokens.admin)))
      );
      let sum = decimal("0");
      for (const res of details) {
        assert.equal(res.status, 200);
        sum = sum.plus(decimal(res.body.data.currentBalance));
      }
      assert.equal(delta(await readCash(), cashBefore), sum.toFixed(2));
    });

    test("a further settlement lowers the total by exactly its amount", async () => {
      const beforeSettlement = await readCash();
      await prisma.$transaction((tx) =>
        debitDriverSettlement(tx, { driverId: d3Inactive, amount: decimal("15.00") })
      );
      assert.equal(delta(await readCash(), beforeSettlement), "-15.00");
    });

    test("FINANCE -> 200", async () => {
      const res = await request(app).get("/api/v1/finance/driver-cash/totals").set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data), ["currentBalance"]);
    });

    test("DISPATCHER (no finance.read) / DRIVER / CUSTOMER -> 403, no auth -> 401", async () => {
      const [dispatcherRes, driver, customer, anon] = await Promise.all([
        request(app).get("/api/v1/finance/driver-cash/totals").set(auth(tokens.dispatcher)),
        request(app).get("/api/v1/finance/driver-cash/totals").set(auth(tokens.driver)),
        request(app).get("/api/v1/finance/driver-cash/totals").set(auth(tokens.customer)),
        request(app).get("/api/v1/finance/driver-cash/totals"),
      ]);
      assert.equal(dispatcherRes.status, 403);
      assert.equal(driver.status, 403);
      assert.equal(customer.status, 403);
      assert.equal(anon.status, 401);
    });
  });
});
