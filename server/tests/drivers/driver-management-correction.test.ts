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
  cleanupTestDriverRecord,
  cleanupTestOrder,
  cleanupTestUser,
  createTestArea,
  createTestUser,
  loginTestUser,
  seedCustomerRecord,
  seedDriverRecord,
  seedTestOrder,
  uniqueEmail,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// Phase 11.7 correction — Driver Management backend contract + privacy.
describe("Driver Management correction (Phase 11.7)", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let tokens: Record<string, string>;
  let areaId: string;
  let areaName: string;
  let customerId: string;

  const driverIds: string[] = [];
  const userIds: string[] = [];
  const orderIds: string[] = [];

  before(async () => {
    app = createApp();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    const [a, d, f] = await Promise.all([
      loginTestUser(app, admin.email, admin.password),
      loginTestUser(app, dispatcher.email, dispatcher.password),
      loginTestUser(app, finance.email, finance.password),
    ]);
    tokens = { admin: a.accessToken as string, dispatcher: d.accessToken as string, finance: f.accessToken as string };

    const area = await createTestArea();
    areaId = area.id;
    areaName = area.name;
    customerId = await seedCustomerRecord(admin.id);
  });

  after(async () => {
    for (const id of orderIds) await cleanupTestOrder(id);
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    await cleanupTestCustomerRecord(customerId);
    await cleanupTestArea(areaId);
    for (const id of userIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance].map((u) => cleanupTestUser(u.id)));
  });

  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  async function newDriver(overrides: { isActive?: boolean } = {}): Promise<{ driverId: string; userId: string }> {
    const user = await createTestUser("DRIVER");
    userIds.push(user.id);
    const driverId = await seedDriverRecord(user.id, { isActive: overrides.isActive ?? true });
    driverIds.push(driverId);
    return { driverId, userId: user.id };
  }

  async function seedOrder(overrides: Parameters<typeof seedTestOrder>[2]): Promise<string> {
    const id = await seedTestOrder(customerId, admin.id, { areaId, areaName, ...overrides });
    orderIds.push(id);
    return id;
  }

  async function seedDeliveredAttempt(orderId: string, driverId: string, when: Date, attemptNumber = 1) {
    await prisma.delivery_attempts.create({
      data: {
        order_id: orderId,
        driver_id: driverId,
        attempt_number: attemptNumber,
        expected_collection: new Prisma.Decimal("25.00"),
        actual_collection: new Prisma.Decimal("25.00"),
        outcome: "DELIVERED",
        started_at: when,
        completed_at: when,
      },
    });
  }

  // ===================================================================
  // PART 1 — generic Driver DTO financial privacy
  // ===================================================================

  describe("generic Driver DTO privacy", () => {
    test("GET /drivers/:id has NO cash field for ADMIN / DISPATCHER / FINANCE", async () => {
      const { driverId } = await newDriver();
      for (const role of ["admin", "dispatcher", "finance"] as const) {
        const res = await request(app).get(`/api/v1/drivers/${driverId}`).set(auth(tokens[role]));
        assert.equal(res.status, 200, role);
        assert.equal("cashAccount" in res.body.data, false, `${role}: cashAccount leaked`);
        assert.doesNotMatch(JSON.stringify(res.body), /currentBalance/i, `${role}: balance leaked`);
        assert.ok(res.body.data.operationalSummary, `${role}: operationalSummary missing`);
      }
    });

    test("GET /drivers list carries operationalSummary and NO cash", async () => {
      const res = await request(app).get("/api/v1/drivers?limit=5").set(auth(tokens.dispatcher));
      assert.equal(res.status, 200);
      for (const row of res.body.data) {
        assert.deepEqual(Object.keys(row.operationalSummary).sort(), [
          "activeOrders",
          "completedToday",
          "outForDelivery",
        ]);
        assert.equal("cashAccount" in row, false);
      }
    });
  });

  // ===================================================================
  // PART 2 — operational summaries
  // ===================================================================

  describe("operational summaries", () => {
    test("activeOrders / outForDelivery / completedToday are authoritative and historically attributed", async () => {
      const { driverId: a } = await newDriver();
      const { driverId: b } = await newDriver();

      // A: 2 active (ASSIGNED + OUT_FOR_DELIVERY), 1 terminal (DELIVERED, must NOT count as active)
      await seedOrder({ status: "ASSIGNED", currentDriverId: a });
      await seedOrder({ status: "OUT_FOR_DELIVERY", currentDriverId: a });
      const deliveredForA = await seedOrder({ status: "DELIVERED", currentDriverId: a });

      // A historical successful attempt today -> completedToday = 1
      await seedDeliveredAttempt(deliveredForA, a, new Date());

      // An order currently held by B, but the successful attempt today was A's
      // (i.e. reassigned away from A after A delivered nothing here) — proves
      // completedToday counts by delivery_attempts.driver_id, not current driver.
      const reassignedOrder = await seedOrder({ status: "RETURNED_TO_CUSTOMER", currentDriverId: b });
      await seedDeliveredAttempt(reassignedOrder, a, new Date(), 1);

      const resA = await request(app).get(`/api/v1/drivers/${a}`).set(auth(tokens.admin));
      assert.equal(resA.body.data.operationalSummary.activeOrders, 2);
      assert.equal(resA.body.data.operationalSummary.outForDelivery, 1);
      assert.equal(resA.body.data.operationalSummary.completedToday, 2);

      const resB = await request(app).get(`/api/v1/drivers/${b}`).set(auth(tokens.admin));
      assert.equal(resB.body.data.operationalSummary.activeOrders, 0);
      assert.equal(resB.body.data.operationalSummary.completedToday, 0);
    });

    test("completedToday ignores an attempt completed before today (UTC day boundary)", async () => {
      const { driverId } = await newDriver();
      const order = await seedOrder({ status: "DELIVERED", currentDriverId: driverId });
      const yesterday = new Date(Date.now() - 36 * 60 * 60 * 1000);
      await seedDeliveredAttempt(order, driverId, yesterday);

      const res = await request(app).get(`/api/v1/drivers/${driverId}`).set(auth(tokens.admin));
      assert.equal(res.body.data.operationalSummary.completedToday, 0);
    });
  });

  // ===================================================================
  // PART 3 — Management Driver Cash API
  // ===================================================================

  describe("Management Driver Cash API", () => {
    test("balance + transactions + summaries: finance.read only (ADMIN/FINANCE 200, DISPATCHER 403)", async () => {
      const { driverId } = await newDriver();
      const paths = [
        `/api/v1/finance/driver-cash/${driverId}`,
        `/api/v1/finance/driver-cash/${driverId}/transactions`,
        `/api/v1/finance/driver-cash/summaries?driverIds=${driverId}`,
      ];
      for (const p of paths) {
        assert.equal((await request(app).get(p).set(auth(tokens.admin))).status, 200, `admin ${p}`);
        assert.equal((await request(app).get(p).set(auth(tokens.finance))).status, 200, `finance ${p}`);
        assert.equal((await request(app).get(p).set(auth(tokens.dispatcher))).status, 403, `dispatcher ${p}`);
      }
    });

    test("balance detail is { driverId, currentBalance }", async () => {
      const { driverId } = await newDriver();
      const res = await request(app).get(`/api/v1/finance/driver-cash/${driverId}`).set(auth(tokens.finance));
      assert.equal(res.status, 200);
      assert.deepEqual(Object.keys(res.body.data).sort(), ["currentBalance", "driverId"]);
      assert.equal(res.body.data.currentBalance, "0");
    });

    test("transactions are paginated and privacy-safe (no idempotency key / reversal_of_id / auth)", async () => {
      const { driverId } = await newDriver();
      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
      // Seed two ledger rows directly.
      await prisma.driver_cash_transactions.create({
        data: {
          account_id: account.id,
          driver_id: driverId,
          type: "COLLECTION",
          amount: new Prisma.Decimal("25.00"),
          balance_before: new Prisma.Decimal("0"),
          balance_after: new Prisma.Decimal("25.00"),
          created_by_id: admin.id,
          idempotency_key: `ph117-${uniqueSuffix()}`,
          notes: "seed collection",
        },
      });

      const res = await request(app)
        .get(`/api/v1/finance/driver-cash/${driverId}/transactions?limit=1`)
        .set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.total, 1);
      const entry = res.body.data[0];
      assert.equal(entry.direction, "CREDIT");
      assert.equal(entry.amount, "25");
      assert.equal(entry.balanceAfter, "25");
      const serialized = JSON.stringify(res.body);
      assert.doesNotMatch(serialized, /idempotency/i);
      assert.doesNotMatch(serialized, /reversal_of_id|reversalOf/i);
      assert.doesNotMatch(serialized, /password/i);
      // clean ledger row before cleanupTestDriverRecord
      await prisma.driver_cash_transactions.deleteMany({ where: { driver_id: driverId } });
    });

    test("summaries returns only requested drivers that have an account; DISPATCHER 403", async () => {
      const { driverId: d1 } = await newDriver();
      const { driverId: d2 } = await newDriver();
      const res = await request(app)
        .get(`/api/v1/finance/driver-cash/summaries?driverIds=${d1},${d2}`)
        .set(auth(tokens.finance));
      assert.equal(res.status, 200);
      const ids = res.body.data.map((r: { driverId: string }) => r.driverId).sort();
      assert.deepEqual(ids, [d1, d2].sort());
      for (const r of res.body.data) assert.deepEqual(Object.keys(r).sort(), ["currentBalance", "driverId"]);

      const denied = await request(app)
        .get(`/api/v1/finance/driver-cash/summaries?driverIds=${d1}`)
        .set(auth(tokens.dispatcher));
      assert.equal(denied.status, 403);
    });

    test("cash endpoints 404 for an unknown driver id", async () => {
      const missing = "00000000-0000-0000-0000-000000000000";
      assert.equal(
        (await request(app).get(`/api/v1/finance/driver-cash/${missing}`).set(auth(tokens.admin))).status,
        404
      );
    });
  });

  // ===================================================================
  // PART 4 — current orders endpoint
  // ===================================================================

  describe("current-orders endpoint", () => {
    test("returns only ACTIVE current work, paginated, orders.read for all three roles", async () => {
      const { driverId } = await newDriver();
      await seedOrder({ status: "ASSIGNED", currentDriverId: driverId });
      await seedOrder({ status: "OUT_FOR_DELIVERY", currentDriverId: driverId });
      await seedOrder({ status: "DELIVERED", currentDriverId: driverId }); // excluded
      await seedOrder({ status: "CANCELLED", currentDriverId: driverId }); // excluded (terminal, not just "not delivered")

      for (const role of ["admin", "dispatcher", "finance"] as const) {
        const res = await request(app)
          .get(`/api/v1/drivers/${driverId}/current-orders`)
          .set(auth(tokens[role]));
        assert.equal(res.status, 200, role);
        assert.equal(res.body.meta.total, 2, `${role}: expected 2 active`);
        for (const o of res.body.data) {
          assert.ok(["ASSIGNED", "OUT_FOR_DELIVERY"].includes(o.status));
          assert.equal(o.currentDriver.id, driverId);
        }
      }

      const page = await request(app)
        .get(`/api/v1/drivers/${driverId}/current-orders?limit=1&page=2`)
        .set(auth(tokens.admin));
      assert.equal(page.body.data.length, 1);
      assert.equal(page.body.meta.total, 2);
    });

    test("404 for an unknown driver id", async () => {
      const res = await request(app)
        .get("/api/v1/drivers/00000000-0000-0000-0000-000000000000/current-orders")
        .set(auth(tokens.admin));
      assert.equal(res.status, 404);
    });
  });

  // ===================================================================
  // PART 5 — delivery history endpoint
  // ===================================================================

  describe("delivery-history endpoint", () => {
    test("historical attribution: a reassigned-away order keeps the delivering driver's attempt", async () => {
      const { driverId: a } = await newDriver();
      const { driverId: b } = await newDriver();

      const order = await seedOrder({ status: "DELIVERED", currentDriverId: b });
      // A made a failed attempt first, then B delivered.
      await prisma.delivery_attempts.create({
        data: {
          order_id: order,
          driver_id: a,
          attempt_number: 1,
          expected_collection: new Prisma.Decimal("25.00"),
          outcome: "FAILED",
          started_at: new Date(Date.now() - 3600_000),
          completed_at: new Date(Date.now() - 3600_000),
        },
      });
      await seedDeliveredAttempt(order, b, new Date(), 2);

      const histA = await request(app).get(`/api/v1/drivers/${a}/delivery-history`).set(auth(tokens.admin));
      assert.equal(histA.body.meta.total, 1);
      assert.equal(histA.body.data[0].outcome, "FAILED");
      assert.equal(histA.body.data[0].order.id, order);

      const histB = await request(app).get(`/api/v1/drivers/${b}/delivery-history`).set(auth(tokens.dispatcher));
      assert.equal(histB.body.meta.total, 1);
      assert.equal(histB.body.data[0].outcome, "DELIVERED");
      // the row may show the order's resulting/current status
      assert.equal(histB.body.data[0].order.status, "DELIVERED");
    });

    test("paginated; no row is fabricated for an order the driver never attempted", async () => {
      const { driverId } = await newDriver();
      await seedOrder({ status: "ASSIGNED", currentDriverId: driverId }); // assigned, never attempted
      const res = await request(app).get(`/api/v1/drivers/${driverId}/delivery-history`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.total, 0);
    });
  });

  // ===================================================================
  // PART 7 — Add Driver (new-login mode)
  // ===================================================================

  describe("create driver — new-login mode", () => {
    test("atomically creates a DRIVER login + driver + zero-balance cash account + audit", async () => {
      const email = uniqueEmail("ph117-newlogin");
      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({
          driverNumber: `PH117-NL-${uniqueSuffix()}`,
          user: { email, password: "DriverPw123!", firstName: "New", lastName: "Login", phone: "+9611234567" },
        });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const driverId = res.body.data.id;
      driverIds.push(driverId);
      const createdUser = await prisma.users.findUniqueOrThrow({
        where: { email },
        include: { roles: true },
      });
      userIds.push(createdUser.id);

      assert.equal(createdUser.roles.code, "DRIVER");
      assert.equal(res.body.data.user.email, email);
      assert.doesNotMatch(JSON.stringify(res.body), /password/i);

      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
      assert.equal(account.current_balance.toString(), "0");
      assert.equal(await prisma.driver_cash_transactions.count({ where: { account_id: account.id } }), 0);

      const auditRows = await prisma.audit_logs.findMany({ where: { entity_type: "DRIVER", entity_id: driverId } });
      assert.equal(auditRows.length, 1);
      assert.equal(auditRows[0].action, "DRIVER_CREATED");
      assert.doesNotMatch(JSON.stringify(auditRows[0]), /password|hash|token|balance/i);
    });

    test("role escalation attempt is rejected (strict) and never elevates", async () => {
      const email = uniqueEmail("ph117-escalate");
      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({
          driverNumber: `PH117-ESC-${uniqueSuffix()}`,
          user: {
            email,
            password: "DriverPw123!",
            firstName: "Esc",
            lastName: "Alate",
            roleCode: "ADMIN",
            permissions: ["drivers.manage"],
          },
        });
      assert.equal(res.status, 400);
      assert.equal(res.body.error.code, "VALIDATION_ERROR");
      assert.equal(await prisma.users.count({ where: { email } }), 0, "no user created by a rejected request");
    });

    test("duplicate email -> 409, no partial rows (create atomicity)", async () => {
      const email = uniqueEmail("ph117-dupe");
      const first = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({
          driverNumber: `PH117-D1-${uniqueSuffix()}`,
          user: { email, password: "DriverPw123!", firstName: "Dup", lastName: "One" },
        });
      assert.equal(first.status, 201);
      driverIds.push(first.body.data.id);
      userIds.push((await prisma.users.findUniqueOrThrow({ where: { email } })).id);

      const driverNumber2 = `PH117-D2-${uniqueSuffix()}`;
      const second = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({
          driverNumber: driverNumber2,
          user: { email, password: "DriverPw123!", firstName: "Dup", lastName: "Two" },
        });
      assert.equal(second.status, 409);
      assert.equal(await prisma.drivers.count({ where: { driver_number: driverNumber2 } }), 0);
    });

    test("duplicate driverNumber -> 409, no orphan user", async () => {
      const existing = await newDriver();
      const existingNumber = (await prisma.drivers.findUniqueOrThrow({ where: { id: existing.driverId } })).driver_number;
      const email = uniqueEmail("ph117-dupnum");
      const res = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({
          driverNumber: existingNumber,
          user: { email, password: "DriverPw123!", firstName: "Dup", lastName: "Num" },
        });
      assert.equal(res.status, 409);
      assert.equal(await prisma.users.count({ where: { email } }), 0, "no orphan user from a rejected create");
    });

    test("legacy existing-user link mode still works, DISPATCHER/FINANCE 403", async () => {
      const linkUser = await createTestUser("DRIVER");
      userIds.push(linkUser.id);
      const denied = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.dispatcher))
        .send({ driverNumber: `PH117-LGCY-${uniqueSuffix()}`, userId: linkUser.id });
      assert.equal(denied.status, 403);

      const ok = await request(app)
        .post("/api/v1/drivers")
        .set(auth(tokens.admin))
        .send({ driverNumber: `PH117-LGCY-${uniqueSuffix()}`, userId: linkUser.id });
      assert.equal(ok.status, 201);
      driverIds.push(ok.body.data.id);
      assert.equal(ok.body.data.user.id, linkUser.id);
    });
  });

  // ===================================================================
  // PART 8 — Edit Driver
  // ===================================================================

  describe("edit driver", () => {
    test("updates linked User profile fields transactionally + audits DRIVER_UPDATED", async () => {
      const { driverId, userId } = await newDriver();
      const res = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ firstName: "Renamed", phone: "+9617654321" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.user.firstName, "Renamed");
      assert.equal(res.body.data.user.phone, "+9617654321");

      const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
      assert.equal(user.first_name, "Renamed");

      const audit = await prisma.audit_logs.findFirst({
        where: { entity_type: "DRIVER", entity_id: driverId, action: "DRIVER_UPDATED" },
        orderBy: { created_at: "desc" },
      });
      assert.ok(audit);
      assert.doesNotMatch(JSON.stringify(audit), /password|hash|token|balance/i);
    });

    test("email conflict -> 409", async () => {
      const { driverId } = await newDriver();
      const other = await createTestUser("DRIVER");
      userIds.push(other.id);
      const res = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ email: other.email });
      assert.equal(res.status, 409);
    });

    test("DISPATCHER/FINANCE cannot edit (drivers.manage = ADMIN only)", async () => {
      const { driverId } = await newDriver();
      for (const role of ["dispatcher", "finance"] as const) {
        const res = await request(app)
          .patch(`/api/v1/drivers/${driverId}`)
          .set(auth(tokens[role]))
          .send({ firstName: "Nope" });
        assert.equal(res.status, 403, role);
      }
    });
  });

  // ===================================================================
  // PART 13/14 — deactivation safety
  // ===================================================================

  describe("deactivation safety", () => {
    test("deactivate: driver.is_active false, linked user.is_active untouched, cash unchanged, new assignment rejected", async () => {
      const { driverId, userId } = await newDriver();
      const account = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { driver_id: driverId } });
      await prisma.driver_cash_accounts.update({ where: { id: account.id }, data: { current_balance: new Prisma.Decimal("40.00") } });

      const res = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ isActive: false });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.isActive, false);

      const user = await prisma.users.findUniqueOrThrow({ where: { id: userId } });
      assert.equal(user.is_active, true, "user login must stay active");

      const cashAfter = await prisma.driver_cash_accounts.findUniqueOrThrow({ where: { id: account.id } });
      assert.equal(cashAfter.current_balance.toString(), "40");

      const audit = await prisma.audit_logs.findFirst({
        where: { entity_type: "DRIVER", entity_id: driverId, action: "DRIVER_DEACTIVATED" },
      });
      assert.ok(audit);

      // new assignment to the inactive driver is rejected
      const order = await seedOrder({ status: "RECEIVED" });
      const assign = await request(app)
        .post(`/api/v1/orders/${order}/assign`)
        .set(auth(tokens.admin))
        .send({ driverId });
      assert.equal(assign.status, 400);

      const react = await request(app)
        .patch(`/api/v1/drivers/${driverId}`)
        .set(auth(tokens.admin))
        .send({ isActive: true });
      assert.equal(react.status, 200);
      assert.ok(
        await prisma.audit_logs.findFirst({
          where: { entity_type: "DRIVER", entity_id: driverId, action: "DRIVER_REACTIVATED" },
        })
      );

      await prisma.driver_cash_accounts.update({ where: { id: account.id }, data: { current_balance: new Prisma.Decimal("0") } });
    });
  });

  // ===================================================================
  // Driver self-service regression
  // ===================================================================

  describe("driver self-service regression", () => {
    test("GET /driver/me/cash + /driver/me/orders still work for a DRIVER", async () => {
      const user = await createTestUser("DRIVER");
      userIds.push(user.id);
      const driverId = await seedDriverRecord(user.id);
      driverIds.push(driverId);
      const login = await loginTestUser(app, user.email, user.password);
      const t = login.accessToken as string;

      const cash = await request(app).get("/api/v1/driver/me/cash").set(auth(t));
      assert.equal(cash.status, 200);
      assert.equal(cash.body.data.account.currentBalance, "0");

      const orders = await request(app).get("/api/v1/driver/me/orders").set(auth(t));
      assert.equal(orders.status, 200);
    });
  });
});
