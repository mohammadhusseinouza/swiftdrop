import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { parseUtcCalendarDate } from "../../src/shared/date/day-boundary";
import { calculateAverageCostPerKm, calculateEstimatedExpense } from "../../src/modules/driver-expenses/driver-expense-calculation";
import {
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedDriverRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// Reports aggregate GLOBAL data on a shared dev DB, so every fixture lives in
// 1975 (no other suite or real data uses that window) and is removed in
// after(). Records are seeded directly (computed by the shared engine, so the
// DB formula CHECK holds) to control dates, vehicles and settings precisely.
//
// Fixture (S1 from 1975-01-01: price 20, moto 3, car 8; S2 from 1975-03-01:
// price 30, moto 3, car 10). 1975-02-03 is a Monday.
//   A "Same Name" (active, default MOTORCYCLE)
//     02-03 MOTO 10    S1 -> 0.3
//     02-04 CAR  20    S1 -> 1.6
//     03-03 CAR  10    S2 -> 1.5
//   B "Same Name" (INACTIVE, identical name, no profile)
//     02-03 CAR  0     S1 -> 0      (saved zero-km day)
//     02-05 MOTO 33.33 S1 -> 0.9999
//   C "Zed" (active)
//     02-09 MOTO 7.25  S1 -> 0.2175 (Sunday)
//     03-31 MOTO 1     S2 -> 0.045
//   D (active, no records)
const WINDOW = { gte: new Date(Date.UTC(1975, 0, 1)), lt: new Date(Date.UTC(1976, 0, 1)) };
const R = "/api/v1/driver-expenses/reports";

describe("Driver Expenses — reports", () => {
  let app: Express;
  let admin: TestUser;
  const others: TestUser[] = [];
  let tokens: Record<string, string>;
  const userIds: string[] = [];
  const driverIds: string[] = [];
  const suffix = uniqueSuffix();
  let A: string, B: string, C: string, D: string;

  const auth = (t = tokens.admin) => ({ Authorization: `Bearer ${t}` });
  const get = (path: string, token?: string) => request(app).get(`${R}${path}`).set(auth(token));
  const day = (v: string) => {
    const d = parseUtcCalendarDate(v);
    assert.ok(d);
    return d;
  };

  async function seedDriver(firstName: string, lastName: string, isActive = true) {
    const u = await createTestUser("DRIVER");
    userIds.push(u.id);
    await prisma.users.update({ where: { id: u.id }, data: { first_name: firstName, last_name: lastName } });
    const id = await seedDriverRecord(u.id, { isActive });
    driverIds.push(id);
    return id;
  }

  async function cleanup() {
    const settings = await prisma.driver_fuel_settings.findMany({ where: { effective_from: WINDOW }, select: { id: true } });
    const ids = settings.map((s) => s.id);
    await prisma.driver_daily_expenses.deleteMany({
      where: { OR: [{ fuel_settings_id: { in: ids } }, { driver_id: { in: driverIds } }] },
    });
    await prisma.driver_expense_profiles.deleteMany({ where: { driver_id: { in: driverIds } } });
    await prisma.driver_fuel_settings.deleteMany({ where: { id: { in: ids } } });
  }

  before(async () => {
    app = createApp();
    await cleanup();
    admin = await createTestUser("ADMIN");
    for (const role of ["DISPATCHER", "FINANCE", "DRIVER", "CUSTOMER"]) others.push(await createTestUser(role));
    const logins = await Promise.all([admin, ...others].map((u) => loginTestUser(app, u.email, u.password)));
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customer: logins[4].accessToken as string,
    };

    A = await seedDriver("Same", `Name${suffix}`);
    B = await seedDriver("Same", `Name${suffix}`, false);
    C = await seedDriver("Zed", `R${suffix}`);
    D = await seedDriver("Dee", `R${suffix}`);
    await prisma.driver_expense_profiles.create({ data: { driver_id: A, default_vehicle_type: "MOTORCYCLE" } });

    const s1 = await prisma.driver_fuel_settings.create({
      data: { price_per_20_liters: "20", motorcycle_consumption_l_per_100km: "3", car_consumption_l_per_100km: "8", effective_from: day("1975-01-01") },
    });
    const s2 = await prisma.driver_fuel_settings.create({
      data: { price_per_20_liters: "30", motorcycle_consumption_l_per_100km: "3", car_consumption_l_per_100km: "10", effective_from: day("1975-03-01") },
    });
    const rows: Array<[string, string, "MOTORCYCLE" | "CAR", string, typeof s1]> = [
      [A, "1975-02-03", "MOTORCYCLE", "10", s1],
      [A, "1975-02-04", "CAR", "20", s1],
      [A, "1975-03-03", "CAR", "10", s2],
      [B, "1975-02-03", "CAR", "0", s1],
      [B, "1975-02-05", "MOTORCYCLE", "33.33", s1],
      [C, "1975-02-09", "MOTORCYCLE", "7.25", s1],
      [C, "1975-03-31", "MOTORCYCLE", "1", s2],
    ];
    for (const [driverId, date, vehicle, km, s] of rows) {
      const consumption = vehicle === "CAR" ? s.car_consumption_l_per_100km : s.motorcycle_consumption_l_per_100km;
      await prisma.driver_daily_expenses.create({
        data: {
          driver_id: driverId,
          expense_date: day(date),
          vehicle_type: vehicle,
          distance_km: km,
          fuel_settings_id: s.id,
          price_per_20_liters_snapshot: s.price_per_20_liters,
          consumption_l_per_100km_snapshot: consumption,
          estimated_expense: calculateEstimatedExpense(km, s.price_per_20_liters, consumption),
        },
      });
    }
  });

  after(async () => {
    await cleanup();
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    for (const id of userIds) await cleanupTestUser(id);
    await Promise.all([admin, ...others].map((u) => cleanupTestUser(u.id)));
  });

  const YEAR = "from=1975-01-01&to=1975-12-31";

  describe("summary", () => {
    test("single day (Today-style range)", async () => {
      const res = await get("/summary?from=1975-02-03&to=1975-02-03");
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.deepEqual(res.body.data, {
        filters: { from: "1975-02-03", to: "1975-02-03", driverId: null, vehicleType: null },
        driversWithRecords: 2, // A and B; the 0 km entry still counts
        entries: 2,
        totalDistanceKm: "10",
        totalEstimatedExpense: "0.3",
        averageCostPerKm: "0.03",
      });
    });

    test("Monday–Sunday week", async () => {
      const res = await get("/summary?from=1975-02-03&to=1975-02-09");
      assert.equal(res.body.data.entries, 5);
      assert.equal(res.body.data.driversWithRecords, 3);
      assert.equal(res.body.data.totalDistanceKm, "70.58");
      assert.equal(res.body.data.totalEstimatedExpense, "3.1174");
      assert.equal(res.body.data.averageCostPerKm, "0.0441683196");
    });

    test("calendar month (March) uses the stored values of the S2 price change", async () => {
      const res = await get("/summary?from=1975-03-01&to=1975-03-31");
      assert.deepEqual(
        { e: res.body.data.entries, d: res.body.data.totalDistanceKm, x: res.body.data.totalEstimatedExpense, a: res.body.data.averageCostPerKm },
        { e: 2, d: "11", x: "1.545", a: "0.1404545455" }
      );
    });

    test("custom range over everything: exact sums, distinct drivers (not all drivers)", async () => {
      const res = await get(`/summary?${YEAR}`);
      assert.equal(res.body.data.entries, 7);
      assert.equal(res.body.data.driversWithRecords, 3, "D has no records and is not counted");
      assert.equal(res.body.data.totalDistanceKm, "81.58");
      assert.equal(res.body.data.totalEstimatedExpense, "4.6624");
      assert.equal(res.body.data.averageCostPerKm, "0.0571512626");
    });

    test("driver, vehicle and combined filters", async () => {
      const a = await get(`/summary?${YEAR}&driverId=${A}`);
      assert.deepEqual([a.body.data.entries, a.body.data.totalDistanceKm, a.body.data.totalEstimatedExpense, a.body.data.averageCostPerKm], [3, "40", "3.4", "0.085"]);
      const car = await get(`/summary?${YEAR}&vehicleType=CAR`);
      assert.deepEqual([car.body.data.entries, car.body.data.driversWithRecords, car.body.data.totalDistanceKm, car.body.data.totalEstimatedExpense], [3, 2, "30", "3.1"]);
      const both = await get(`/summary?${YEAR}&driverId=${A}&vehicleType=CAR`);
      assert.deepEqual([both.body.data.entries, both.body.data.totalDistanceKm, both.body.data.totalEstimatedExpense, both.body.data.averageCostPerKm], [2, "30", "3.1", "0.1033333333"]);
    });

    test("empty period -> zeros and an unavailable average (no divide-by-zero)", async () => {
      const res = await get("/summary?from=1975-06-01&to=1975-06-30");
      assert.deepEqual(
        [res.body.data.entries, res.body.data.driversWithRecords, res.body.data.totalDistanceKm, res.body.data.totalEstimatedExpense, res.body.data.averageCostPerKm],
        [0, 0, "0", "0", null]
      );
      const zeroOnly = await get(`/summary?from=1975-02-03&to=1975-02-03&driverId=${B}`);
      assert.equal(zeroOnly.body.data.entries, 1, "a saved 0 km day is an entry");
      assert.equal(zeroOnly.body.data.averageCostPerKm, null, "0 km total -> no average");
    });

    test("the average is total expense / total distance, rounded half-up to 10 dp", () => {
      assert.equal(calculateAverageCostPerKm("1", "3")?.toFixed(), "0.3333333333");
      assert.equal(calculateAverageCostPerKm("2", "3")?.toFixed(), "0.6666666667");
      assert.equal(calculateAverageCostPerKm("5", "0"), null);
    });
  });

  describe("by driver", () => {
    test("groups by driver id: identical names stay separate, inactive drivers included, no zero rows", async () => {
      const res = await get(`/by-driver?${YEAR}&sortBy=expense&sortOrder=desc`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.meta.total, 3);
      assert.deepEqual(
        res.body.data.map((r: { driverId: string; entries: number; totalDistanceKm: string; totalEstimatedExpense: string }) => [
          r.driverId,
          r.entries,
          r.totalDistanceKm,
          r.totalEstimatedExpense,
        ]),
        [
          [A, 3, "40", "3.4"],
          [B, 2, "33.33", "0.9999"],
          [C, 2, "8.25", "0.2625"],
        ]
      );
      const b = res.body.data.find((r: { driverId: string }) => r.driverId === B);
      assert.equal(b.isActive, false);
      assert.equal(b.displayName, `Same Name${suffix}`);
      assert.equal(b.averageCostPerKm, "0.03");
      const a = res.body.data.find((r: { driverId: string }) => r.driverId === A);
      assert.equal(a.currentDefaultVehicleType, "MOTORCYCLE");
      assert.ok(!res.body.data.some((r: { driverId: string }) => r.driverId === D));
    });

    test("sorting by distance and by name (stable tie-break by driver id)", async () => {
      const dist = await get(`/by-driver?${YEAR}&sortBy=distance&sortOrder=asc`);
      assert.deepEqual(dist.body.data.map((r: { driverId: string }) => r.driverId), [C, B, A]);
      const name = await get(`/by-driver?${YEAR}&sortBy=name&sortOrder=asc`);
      const sameNames = [A, B].sort();
      assert.deepEqual(name.body.data.map((r: { driverId: string }) => r.driverId), [...sameNames, C]);
      const nameDesc = await get(`/by-driver?${YEAR}&sortBy=name&sortOrder=desc`);
      assert.deepEqual(nameDesc.body.data.map((r: { driverId: string }) => r.driverId), [C, ...sameNames]);
    });

    test("pagination is over the complete sorted set", async () => {
      const pages = await Promise.all(
        [1, 2, 3, 4].map((p) => get(`/by-driver?${YEAR}&sortBy=expense&sortOrder=desc&limit=1&page=${p}`))
      );
      assert.deepEqual(pages.map((p) => p.body.data.map((r: { driverId: string }) => r.driverId)), [[A], [B], [C], []]);
      assert.deepEqual(pages[0].body.meta, { page: 1, limit: 1, total: 3, totalPages: 3 });
    });

    test("specific driver + vehicle filters", async () => {
      const res = await get(`/by-driver?${YEAR}&driverId=${A}&vehicleType=CAR`);
      assert.equal(res.body.meta.total, 1);
      assert.deepEqual([res.body.data[0].driverId, res.body.data[0].entries, res.body.data[0].totalEstimatedExpense], [A, 2, "3.1"]);
      const none = await get(`/by-driver?${YEAR}&driverId=${D}`);
      assert.deepEqual([none.body.data, none.body.meta.total], [[], 0]);
    });
  });

  describe("by vehicle", () => {
    test("classified by the vehicle saved on each day, not the current default", async () => {
      const res = await get(`/by-vehicle?${YEAR}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, [
        { vehicleType: "MOTORCYCLE", entries: 4, totalDistanceKm: "51.58", totalEstimatedExpense: "1.5624", averageCostPerKm: "0.0302908104" },
        { vehicleType: "CAR", entries: 3, totalDistanceKm: "30", totalEstimatedExpense: "3.1", averageCostPerKm: "0.1033333333" },
      ]);
    });

    test("changing a default vehicle does not change historical reporting", async () => {
      const before = await get(`/by-vehicle?${YEAR}`);
      await prisma.driver_expense_profiles.update({ where: { driver_id: A }, data: { default_vehicle_type: "CAR" } });
      const after = await get(`/by-vehicle?${YEAR}`);
      assert.deepEqual(after.body.data, before.body.data);
      const drv = await get(`/by-driver?${YEAR}&driverId=${A}`);
      assert.equal(drv.body.data[0].currentDefaultVehicleType, "CAR");
      assert.equal(drv.body.data[0].totalEstimatedExpense, "3.4");
      await prisma.driver_expense_profiles.update({ where: { driver_id: A }, data: { default_vehicle_type: "MOTORCYCLE" } });
    });

    test("respects the vehicle filter (only that type) and returns zeros for an empty type", async () => {
      const car = await get(`/by-vehicle?${YEAR}&vehicleType=CAR`);
      assert.deepEqual(car.body.data.map((r: { vehicleType: string }) => r.vehicleType), ["CAR"]);
      const cOnly = await get(`/by-vehicle?${YEAR}&driverId=${C}`);
      assert.deepEqual(cOnly.body.data[1], { vehicleType: "CAR", entries: 0, totalDistanceKm: "0", totalEstimatedExpense: "0", averageCostPerKm: null });
    });
  });

  describe("daily trend", () => {
    test("chronological, only recorded dates; a saved 0 km day appears, a missing day does not", async () => {
      const res = await get(`/daily-trend?${YEAR}`);
      assert.equal(res.status, 200);
      assert.deepEqual(res.body.data, [
        { date: "1975-02-03", entries: 2, totalDistanceKm: "10", totalEstimatedExpense: "0.3" },
        { date: "1975-02-04", entries: 1, totalDistanceKm: "20", totalEstimatedExpense: "1.6" },
        { date: "1975-02-05", entries: 1, totalDistanceKm: "33.33", totalEstimatedExpense: "0.9999" },
        { date: "1975-02-09", entries: 1, totalDistanceKm: "7.25", totalEstimatedExpense: "0.2175" },
        { date: "1975-03-03", entries: 1, totalDistanceKm: "10", totalEstimatedExpense: "1.5" },
        { date: "1975-03-31", entries: 1, totalDistanceKm: "1", totalEstimatedExpense: "0.045" },
      ]);
      const zero = await get(`/daily-trend?${YEAR}&driverId=${B}&vehicleType=CAR`);
      assert.deepEqual(zero.body.data, [{ date: "1975-02-03", entries: 1, totalDistanceKm: "0", totalEstimatedExpense: "0" }]);
      const empty = await get("/daily-trend?from=1975-06-01&to=1975-06-30");
      assert.deepEqual(empty.body.data, []);
    });

    test("range is bounded to 366 days", async () => {
      assert.equal((await get("/daily-trend?from=1975-01-01&to=1976-01-01")).status, 200); // 366 days
      const tooLong = await get("/daily-trend?from=1975-01-01&to=1976-01-02");
      assert.equal(tooLong.status, 400);
      // Aggregated endpoints are not bounded (they return a fixed-size result).
      assert.equal((await get("/summary?from=1900-01-01&to=2100-12-31")).status, 200);
    });
  });

  describe("validation, authorization, isolation", () => {
    test("invalid dates, ranges and filters -> 400", async () => {
      for (const qs of [
        "",
        "from=1975-01-01",
        "to=1975-01-01",
        "from=1975-02-30&to=1975-03-01",
        "from=1975/01/01&to=1975-01-31",
        "from=1975-03-01&to=1975-02-01",
        `${YEAR}&vehicleType=TRUCK`,
        `${YEAR}&driverId=nope`,
      ]) {
        for (const ep of ["/summary", "/by-driver", "/by-vehicle", "/daily-trend"]) {
          assert.equal((await get(`${ep}?${qs}`)).status, 400, `${ep}?${qs}`);
        }
      }
      for (const qs of ["sortBy=total", "sortOrder=up", "limit=101", "page=0"]) {
        assert.equal((await get(`/by-driver?${YEAR}&${qs}`)).status, 400, qs);
      }
    });

    test("administrator-only", async () => {
      for (const ep of ["/summary", "/by-driver", "/by-vehicle", "/daily-trend"]) {
        for (const role of ["dispatcher", "finance", "driver", "customer"]) {
          assert.equal((await get(`${ep}?${YEAR}`, tokens[role])).status, 403, `${role} ${ep}`);
        }
        assert.equal((await request(app).get(`${R}${ep}?${YEAR}`)).status, 401, `anon ${ep}`);
      }
    });

    test("reports are read-only and independent of finance, cash, wallet, settlement and order data", async () => {
      const counts = () =>
        Promise.all([
          prisma.company_financial_transactions.count(),
          prisma.driver_cash_transactions.count(),
          prisma.driver_settlements.count(),
          prisma.wallet_transactions.count(),
          prisma.customer_payouts.count(),
          prisma.orders.count(),
          prisma.driver_daily_expenses.count(),
          prisma.audit_logs.count(),
        ]);
      const before = await counts();
      await Promise.all(["/summary", "/by-driver", "/by-vehicle", "/daily-trend"].map((ep) => get(`${ep}?${YEAR}`)));
      assert.deepEqual(await counts(), before);
      // The SQL reads exactly these tables (identity + the module's own data).
      const source = (await import("node:fs")).readFileSync("src/modules/driver-expenses/report.service.ts", "utf8");
      const tables = new Set([...source.matchAll(/\b(?:FROM|JOIN)\s+([a-z_]+)/g)].map((m) => m[1]));
      assert.deepEqual([...tables].sort(), ["driver_daily_expenses", "driver_expense_profiles", "drivers", "users"]);
    });
  });
});
