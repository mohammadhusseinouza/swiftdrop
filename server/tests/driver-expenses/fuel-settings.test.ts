import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { Prisma } from "../../src/generated/prisma/client";
import { getUtcDayBoundary, parseUtcCalendarDate } from "../../src/shared/date/day-boundary";
import { calculateEstimatedExpense } from "../../src/modules/driver-expenses/driver-expense-calculation";
import {
  getCurrentFuelSettings,
  getFuelSettingsForDate,
} from "../../src/modules/driver-expenses/fuel-settings.service";
import {
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedDriverRecord,
  type TestUser,
} from "../helpers/fixtures";

// Fuel settings are GLOBAL (one row per effective date), and the dev DB is
// shared. Every row this suite creates uses an effective date inside
// TEST_YEARS (far from real data) and is removed in after(). No other suite
// writes these tables.
const TEST_YEARS = { gte: new Date(Date.UTC(2090, 0, 1)), lt: new Date(Date.UTC(2100, 0, 1)) };
const BASE = "/api/v1/driver-expenses/fuel-settings";

describe("Driver Expenses — Fuel Settings API", () => {
  let app: Express;
  let admin: TestUser;
  let dispatcher: TestUser;
  let finance: TestUser;
  let driverUser: TestUser;
  let customerUser: TestUser;
  let tokens: Record<string, string>;
  let driverId: string;
  const driverUserIds: string[] = [];

  function auth(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  function create(body: Record<string, unknown>, token = tokens.admin) {
    return request(app).post(BASE).set(auth(token)).send(body);
  }

  function settings(effectiveFrom: string, overrides: Record<string, unknown> = {}) {
    return {
      pricePer20Liters: "25.50",
      motorcycleConsumptionLPer100Km: "3.40",
      carConsumptionLPer100Km: "8.75",
      effectiveFrom,
      ...overrides,
    };
  }

  function day(value: string): Date {
    const d = parseUtcCalendarDate(value);
    assert.ok(d);
    return d;
  }

  // Inserts a recorded daily expense directly (Phase 3 has no API yet),
  // computed by the shared engine so it satisfies the DB formula CHECK.
  async function recordExpense(fuelSettingsId: string, expenseDate: string) {
    const fs = await prisma.driver_fuel_settings.findUniqueOrThrow({ where: { id: fuelSettingsId } });
    return prisma.driver_daily_expenses.create({
      data: {
        driver_id: driverId,
        expense_date: day(expenseDate),
        vehicle_type: "CAR",
        distance_km: new Prisma.Decimal("42.50"),
        fuel_settings_id: fs.id,
        price_per_20_liters_snapshot: fs.price_per_20_liters,
        consumption_l_per_100km_snapshot: fs.car_consumption_l_per_100km,
        estimated_expense: calculateEstimatedExpense("42.50", fs.price_per_20_liters, fs.car_consumption_l_per_100km),
      },
    });
  }

  async function cleanupTestRows() {
    const rows = await prisma.driver_fuel_settings.findMany({
      where: { effective_from: TEST_YEARS },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await prisma.driver_daily_expenses.deleteMany({ where: { fuel_settings_id: { in: ids } } });
    await prisma.audit_logs.deleteMany({ where: { entity_type: "DRIVER_FUEL_SETTINGS", entity_id: { in: ids } } });
    await prisma.driver_fuel_settings.deleteMany({ where: { id: { in: ids } } });
  }

  before(async () => {
    app = createApp();
    await cleanupTestRows();
    admin = await createTestUser("ADMIN");
    dispatcher = await createTestUser("DISPATCHER");
    finance = await createTestUser("FINANCE");
    driverUser = await createTestUser("DRIVER");
    customerUser = await createTestUser("CUSTOMER");
    const logins = await Promise.all(
      [admin, dispatcher, finance, driverUser, customerUser].map((u) => loginTestUser(app, u.email, u.password))
    );
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customer: logins[4].accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) assert.ok(token, role);

    const expenseDriverUser = await createTestUser("DRIVER");
    driverUserIds.push(expenseDriverUser.id);
    driverId = await seedDriverRecord(expenseDriverUser.id);
  });

  after(async () => {
    await cleanupTestRows();
    await cleanupTestDriverRecord(driverId);
    for (const id of driverUserIds) await cleanupTestUser(id);
    await Promise.all([admin, dispatcher, finance, driverUser, customerUser].map((u) => cleanupTestUser(u.id)));
  });

  describe("create", () => {
    test("creates a version and returns exact derived values", async () => {
      const res = await create(settings("2090-01-01"));
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const d = res.body.data;
      assert.equal(d.effectiveFrom, "2090-01-01");
      assert.equal(d.pricePer20Liters, "25.5");
      assert.equal(d.motorcycleConsumptionLPer100Km, "3.4");
      assert.equal(d.carConsumptionLPer100Km, "8.75");
      assert.equal(d.pricePerLiter, "1.275");
      assert.equal(d.motorcycleCostPerKm, "0.04335");
      assert.equal(d.carCostPerKm, "0.1115625");
      assert.ok(d.id && d.createdAt);

      const row = await prisma.driver_fuel_settings.findUniqueOrThrow({ where: { id: d.id } });
      assert.equal(row.price_per_20_liters.toFixed(2), "25.50");
      const audit = await prisma.audit_logs.findFirst({
        where: { entity_type: "DRIVER_FUEL_SETTINGS", entity_id: d.id, action: "DRIVER_FUEL_SETTINGS_CREATED" },
      });
      assert.ok(audit, "creation is audited");
      assert.equal(audit.actor_user_id, admin.id);
    });

    test("accepts JSON numbers without float drift", async () => {
      const res = await create(
        settings("2090-01-02", { pricePer20Liters: 19.99, motorcycleConsumptionLPer100Km: 2.1, carConsumptionLPer100Km: 7 })
      );
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.pricePer20Liters, "19.99");
      assert.equal(res.body.data.pricePerLiter, "0.9995");
      assert.equal(res.body.data.motorcycleCostPerKm, "0.0209895");
    });

    test("ignores client-supplied derived values", async () => {
      const res = await create(settings("2090-01-03", { pricePerLiter: "999", carCostPerKm: "999" }));
      assert.equal(res.status, 201);
      assert.equal(res.body.data.pricePerLiter, "1.275");
      assert.equal(res.body.data.carCostPerKm, "0.1115625");
    });

    test("invalid or non-positive prices -> 400", async () => {
      for (const price of ["0", "-1", "0.00", "abc", "", "1.234", "1000000000000.00", null, true]) {
        const res = await create(settings("2090-02-01", { pricePer20Liters: price }));
        assert.equal(res.status, 400, `price ${JSON.stringify(price)}`);
        assert.equal(res.body.error.code, "VALIDATION_ERROR");
      }
      const missing = await create({ motorcycleConsumptionLPer100Km: "3", carConsumptionLPer100Km: "8", effectiveFrom: "2090-02-01" });
      assert.equal(missing.status, 400);
    });

    test("invalid consumption rates -> 400", async () => {
      for (const field of ["motorcycleConsumptionLPer100Km", "carConsumptionLPer100Km"]) {
        for (const value of ["0", "-3.4", "3.401", "10000.00", "x"]) {
          const res = await create(settings("2090-02-02", { [field]: value }));
          assert.equal(res.status, 400, `${field}=${value}`);
        }
      }
    });

    test("invalid effective dates -> 400", async () => {
      for (const value of ["2090-02-30", "2090/03/01", "2090-03-01T00:00:00Z", "03-01-2090", "", undefined]) {
        const res = await create(settings(value as string));
        assert.equal(res.status, 400, `effectiveFrom=${String(value)}`);
      }
      assert.equal(await prisma.driver_fuel_settings.count({ where: { effective_from: day("2090-02-01") } }), 0);
    });

    test("duplicate effective date -> 409 DUPLICATE_EFFECTIVE_DATE, original untouched", async () => {
      const first = await create(settings("2090-04-01"));
      assert.equal(first.status, 201);
      const dup = await create(settings("2090-04-01", { pricePer20Liters: "99.99" }));
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.code, "CONFLICT");
      assert.equal(dup.body.error.details.reason, "DUPLICATE_EFFECTIVE_DATE");
      const row = await prisma.driver_fuel_settings.findUniqueOrThrow({ where: { effective_from: day("2090-04-01") } });
      assert.equal(row.price_per_20_liters.toFixed(2), "25.50");
    });

    test("concurrent creation of the same effective date -> exactly one 201", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) => create(settings("2090-05-01", { pricePer20Liters: `${30 + i}.00` })))
      );
      const statuses = results.map((r) => r.status).sort();
      assert.deepEqual(statuses, [201, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        assert.equal(r.body.error.details.reason, "DUPLICATE_EFFECTIVE_DATE");
      }
      assert.equal(await prisma.driver_fuel_settings.count({ where: { effective_from: day("2090-05-01") } }), 1);
    });
  });

  describe("resolution", () => {
    test("a date resolves to the newest version effective on or before it", async () => {
      await create(settings("2091-01-01", { pricePer20Liters: "20.00" }));
      await create(settings("2091-03-01", { pricePer20Liters: "30.00" }));

      const check = async (date: string, expected: string | null) => {
        const res = await request(app).get(`${BASE}/effective?date=${date}`).set(auth(tokens.admin));
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.equal(res.body.data.date, date);
        if (expected === null) return;
        assert.equal(res.body.data.configured, true);
        assert.equal(res.body.data.settings.pricePer20Liters, expected);
      };
      await check("2091-01-01", "20"); // effective date itself is inclusive
      await check("2091-02-28", "20");
      await check("2091-03-01", "30");
      await check("2099-12-31", null);
    });

    test("a future version never affects earlier dates", async () => {
      await create(settings("2093-01-01", { pricePer20Liters: "21.00" }));
      await create(settings("2093-07-01", { pricePer20Liters: "40.00" })); // "future" relative to the dates below
      const before = await getFuelSettingsForDate("2093-06-30");
      assert.equal(before.settings?.pricePer20Liters, "21");
      const onIt = await getFuelSettingsForDate("2093-07-01");
      assert.equal(onIt.settings?.pricePer20Liters, "40");
    });

    test("no applicable configuration -> explicit unconfigured state, no invented rates", async () => {
      const res = await request(app).get(`${BASE}/effective?date=1850-01-01`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, { date: "1850-01-01", configured: false, settings: null });
    });

    test("invalid date query -> 400", async () => {
      for (const q of ["", "?date=2091-13-01", "?date=2091-02-29", "?date=yesterday"]) {
        const res = await request(app).get(`${BASE}/effective${q}`).set(auth(tokens.admin));
        assert.equal(res.status, 400, q);
      }
    });

    test("current = the version effective on today's UTC business date", async () => {
      const today = getUtcDayBoundary().start.toISOString().slice(0, 10);
      const [current, effective] = await Promise.all([
        request(app).get(`${BASE}/current`).set(auth(tokens.admin)),
        request(app).get(`${BASE}/effective?date=${today}`).set(auth(tokens.admin)),
      ]);
      assert.equal(current.status, 200);
      assert.equal(current.body.data.date, today);
      assert.deepEqual(current.body.data, effective.body.data);
      // Test rows are all in 2090+, so they can never be "current" today.
      if (current.body.data.settings) {
        assert.ok(current.body.data.settings.effectiveFrom <= today);
      }
    });

    test("timezone boundaries: 'today' is the UTC calendar date of the instant", async () => {
      await create(settings("2094-06-16", { pricePer20Liters: "50.00" }));
      await create(settings("2094-06-15", { pricePer20Liters: "45.00" }));
      // 23:30 in UTC-5 on the 15th is already the 16th in UTC.
      const lateWest = await getCurrentFuelSettings(new Date("2094-06-15T23:30:00-05:00"));
      assert.equal(lateWest.date, "2094-06-16");
      assert.equal(lateWest.settings?.pricePer20Liters, "50");
      // 00:30 in UTC+3 on the 16th is still the 15th in UTC.
      const earlyEast = await getCurrentFuelSettings(new Date("2094-06-16T00:30:00+03:00"));
      assert.equal(earlyEast.date, "2094-06-15");
      assert.equal(earlyEast.settings?.pricePer20Liters, "45");
      // Exact UTC midnight belongs to the new day.
      const midnight = await getCurrentFuelSettings(new Date("2094-06-16T00:00:00.000Z"));
      assert.equal(midnight.date, "2094-06-16");
      // DATE values round-trip without an off-by-one.
      const row = await prisma.driver_fuel_settings.findUniqueOrThrow({ where: { effective_from: day("2094-06-16") } });
      assert.equal(row.effective_from.toISOString(), "2094-06-16T00:00:00.000Z");
    });
  });

  describe("history", () => {
    test("lists versions newest effective date first, paginated", async () => {
      await create(settings("2095-01-01"));
      await create(settings("2095-02-01"));
      await create(settings("2095-03-01"));
      const res = await request(app).get(`${BASE}?page=1&limit=100`).set(auth(tokens.admin));
      assert.equal(res.status, 200);
      assert.equal(res.body.meta.limit, 100);
      assert.ok(res.body.meta.total >= 3);
      const dates: string[] = res.body.data.map((r: { effectiveFrom: string }) => r.effectiveFrom);
      const mine = dates.filter((d) => d.startsWith("2095-"));
      assert.deepEqual(mine, ["2095-03-01", "2095-02-01", "2095-01-01"]);
      assert.deepEqual([...dates].sort().reverse(), dates, "globally ordered by effective date desc");

      const page = await request(app).get(`${BASE}?page=1&limit=2`).set(auth(tokens.admin));
      assert.equal(page.body.data.length, 2);
      assert.equal(page.body.meta.totalPages, Math.ceil(page.body.meta.total / 2));
    });
  });

  describe("historical consistency", () => {
    test("settings are immutable: no update or delete routes exist", async () => {
      const created = await create(settings("2096-01-01"));
      const id = created.body.data.id;
      for (const method of ["patch", "put", "delete"] as const) {
        const res = await request(app)[method](`${BASE}/${id}`).set(auth(tokens.admin)).send({ pricePer20Liters: "1.00" });
        assert.equal(res.status, 404, method);
      }
      // Creating a later version never rewrites the earlier one.
      await create(settings("2096-02-01", { pricePer20Liters: "60.00" }));
      const row = await prisma.driver_fuel_settings.findUniqueOrThrow({ where: { id } });
      assert.equal(row.price_per_20_liters.toFixed(2), "25.50");
    });

    test("creating settings never recalculates recorded expenses", async () => {
      const v1 = await create(settings("2097-01-01", { pricePer20Liters: "20.00" }));
      const expense = await recordExpense(v1.body.data.id, "2097-01-10");
      const later = await create(settings("2097-02-01", { pricePer20Liters: "90.00" }));
      assert.equal(later.status, 201);
      const after = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: expense.id } });
      assert.equal(after.estimated_expense.toFixed(), expense.estimated_expense.toFixed());
      assert.equal(after.fuel_settings_id, v1.body.data.id);
      assert.equal(after.updated_at.getTime(), expense.updated_at.getTime());
    });

    test("retroactive settings that would reinterpret recorded expenses -> 409", async () => {
      const a = await create(settings("2098-01-01", { pricePer20Liters: "20.00" }));
      await recordExpense(a.body.data.id, "2098-03-10");

      for (const date of ["2098-02-01", "2098-03-10"]) {
        const res = await create(settings(date));
        assert.equal(res.status, 409, date);
        assert.equal(res.body.error.details.reason, "RETROACTIVE_CONFLICT");
        assert.equal(res.body.error.details.earliestAffectedExpenseDate, "2098-03-10");
        assert.equal(await prisma.driver_fuel_settings.count({ where: { effective_from: day(date) } }), 0);
      }

      // After the last recorded day: allowed.
      assert.equal((await create(settings("2098-03-11"))).status, 201);
      // Before version A takes effect (resolves only 2097-12-xx dates, none recorded): allowed.
      assert.equal((await create(settings("2097-12-15"))).status, 201);
      // The recorded day still resolves to the version it was computed with.
      const resolved = await getFuelSettingsForDate("2098-03-10");
      assert.equal(resolved.settings?.id, a.body.data.id);
    });
  });

  describe("authorization (administrators only)", () => {
    const endpoints = [
      { method: "get", path: `${BASE}/current` },
      { method: "get", path: `${BASE}/effective?date=2090-01-01` },
      { method: "get", path: BASE },
      { method: "post", path: BASE },
    ] as const;

    test("DISPATCHER, FINANCE, DRIVER and CUSTOMER -> 403 on every endpoint", async () => {
      for (const role of ["dispatcher", "finance", "driver", "customer"]) {
        for (const e of endpoints) {
          const res = await request(app)[e.method](e.path).set(auth(tokens[role])).send(settings("2099-01-01"));
          assert.equal(res.status, 403, `${role} ${e.method} ${e.path}`);
        }
      }
      assert.equal(await prisma.driver_fuel_settings.count({ where: { effective_from: day("2099-01-01") } }), 0);
    });

    test("anonymous -> 401 on every endpoint", async () => {
      for (const e of endpoints) {
        const res = await request(app)[e.method](e.path).send(settings("2099-01-02"));
        assert.equal(res.status, 401, `${e.method} ${e.path}`);
      }
    });
  });

  describe("module isolation", () => {
    test("creating settings writes nothing to finance, driver cash, wallet or order tables", async () => {
      const counts = () =>
        Promise.all([
          prisma.company_financial_transactions.count(),
          prisma.driver_cash_transactions.count(),
          prisma.driver_cash_accounts.count(),
          prisma.driver_settlements.count(),
          prisma.wallet_transactions.count(),
          prisma.customer_payouts.count(),
          prisma.orders.count(),
        ]);
      const before = await counts();
      assert.equal((await create(settings("2099-06-01"))).status, 201);
      assert.deepEqual(await counts(), before);
    });
  });
});
