import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import {
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedDriverRecord,
  type TestUser,
} from "../helpers/fixtures";

// Driver Expenses — frontend/backend API CONTRACT (Phase 6).
//
// The client's response types (client/src/services/domain.types.ts) are hand
// written. This suite parses those interfaces and asserts every Driver
// Expenses endpoint returns EXACTLY those fields, plus the structured error
// reasons the client branches on — so a rename on either side fails here.
// Fixtures live in 1965 (no other suite or real data uses it) and are removed.

const WINDOW = { gte: new Date(Date.UTC(1965, 0, 1)), lt: new Date(Date.UTC(1966, 0, 1)) };
const API = "/api/v1/driver-expenses";
const CLIENT_SRC = path.join(__dirname, "../../../client/src");
const CLIENT_TYPES = readFileSync(path.join(CLIENT_SRC, "services/domain.types.ts"), "utf8");

/** Field names of a client interface, following `extends` chains. */
function clientFields(name: string): string[] {
  const m = new RegExp(`export interface ${name}(?:\\s+extends\\s+([\\w\\s,]+))?\\s*\\{([\\s\\S]*?)\\n\\}`).exec(CLIENT_TYPES);
  assert.ok(m, `client interface ${name} not found`);
  const own = [...m[2].matchAll(/^\s+(\w+)\??:/gm)].map((x) => x[1]);
  const inherited = (m[1] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap(clientFields);
  return [...new Set([...inherited, ...own])].sort();
}

const keysOf = (o: object) => Object.keys(o).sort();

describe("Driver Expenses — frontend/backend API contract", () => {
  let app: Express;
  let admin: TestUser;
  let token: string;
  const userIds: string[] = [];
  let driverId: string;
  let expenseId: string;
  let expenseUpdatedAt: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function cleanup() {
    const settings = await prisma.driver_fuel_settings.findMany({ where: { effective_from: WINDOW }, select: { id: true } });
    const ids = settings.map((s) => s.id);
    const expenses = await prisma.driver_daily_expenses.findMany({ where: { fuel_settings_id: { in: ids } }, select: { id: true } });
    const profiles = driverId ? await prisma.driver_expense_profiles.findMany({ where: { driver_id: driverId }, select: { id: true } }) : [];
    await prisma.audit_logs.deleteMany({
      where: { entity_id: { in: [...ids, ...expenses.map((e) => e.id), ...profiles.map((p) => p.id)] } },
    });
    await prisma.driver_daily_expenses.deleteMany({ where: { id: { in: expenses.map((e) => e.id) } } });
    await prisma.driver_expense_profiles.deleteMany({ where: { id: { in: profiles.map((p) => p.id) } } });
    await prisma.driver_fuel_settings.deleteMany({ where: { id: { in: ids } } });
  }

  before(async () => {
    app = createApp();
    await cleanup();
    admin = await createTestUser("ADMIN");
    token = (await loginTestUser(app, admin.email, admin.password)).accessToken as string;
    const u = await createTestUser("DRIVER");
    userIds.push(u.id);
    driverId = await seedDriverRecord(u.id);

    const fs = await request(app).post(`${API}/fuel-settings`).set(auth()).send({
      pricePer20Liters: "25.50",
      motorcycleConsumptionLPer100Km: "3.40",
      carConsumptionLPer100Km: "8.75",
      effectiveFrom: "1965-01-01",
    });
    assert.equal(fs.status, 201, JSON.stringify(fs.body));
    const prof = await request(app).put(`${API}/drivers/${driverId}/profile`).set(auth()).send({ defaultVehicleType: "CAR" });
    assert.equal(prof.status, 201);
    const exp = await request(app).post(`${API}/daily-expenses`).set(auth()).send({ driverId, expenseDate: "1965-06-01", distanceKm: "37.25" });
    assert.equal(exp.status, 201, JSON.stringify(exp.body));
    expenseId = exp.body.data.id;
    expenseUpdatedAt = exp.body.data.updatedAt;
  });

  after(async () => {
    await cleanup();
    await cleanupTestDriverRecord(driverId);
    for (const id of userIds) await cleanupTestUser(id);
    await cleanupTestUser(admin.id);
  });

  test("fuel settings responses match FuelSettingsResolution / FuelSettingsDetail", async () => {
    const eff = await request(app).get(`${API}/fuel-settings/effective?date=1965-06-01`).set(auth());
    assert.deepEqual(keysOf(eff.body.data), clientFields("FuelSettingsResolution"));
    assert.deepEqual(keysOf(eff.body.data.settings), clientFields("FuelSettingsDetail"));
    const cur = await request(app).get(`${API}/fuel-settings/current`).set(auth());
    assert.deepEqual(keysOf(cur.body.data), clientFields("FuelSettingsResolution"));
    const list = await request(app).get(`${API}/fuel-settings?limit=1`).set(auth());
    assert.deepEqual(keysOf(list.body.data[0]), clientFields("FuelSettingsDetail"));
    assert.deepEqual(keysOf(list.body.meta), ["limit", "page", "total", "totalPages"]);
  });

  test("driver + profile responses match ExpenseDriverSummary / ExpenseProfileDetail", async () => {
    const list = await request(app).get(`${API}/drivers?limit=100`).set(auth());
    const row = list.body.data.find((d: { driverId: string }) => d.driverId === driverId);
    assert.deepEqual(keysOf(row), clientFields("ExpenseDriverSummary"));
    const prof = await request(app).put(`${API}/drivers/${driverId}/profile`).set(auth()).send({ defaultVehicleType: "CAR" });
    assert.deepEqual(keysOf(prof.body.data), clientFields("ExpenseProfileDetail"));
  });

  test("daily expense responses match DailyExpenseDetail everywhere they appear", async () => {
    const expected = clientFields("DailyExpenseDetail");
    const one = await request(app).get(`${API}/daily-expenses/${expenseId}`).set(auth());
    assert.deepEqual(keysOf(one.body.data), expected);
    const byDate = await request(app).get(`${API}/daily-expenses/by-date/1965-06-01`).set(auth());
    assert.deepEqual(keysOf(byDate.body.data[0]), expected);
    const list = await request(app).get(`${API}/daily-expenses?driverId=${driverId}`).set(auth());
    assert.deepEqual(keysOf(list.body.data[0]), expected);
    const hist = await request(app).get(`${API}/drivers/${driverId}/daily-expenses`).set(auth());
    assert.deepEqual(keysOf(hist.body.data[0]), expected);
    const patched = await request(app)
      .patch(`${API}/daily-expenses/${expenseId}`)
      .set(auth())
      .send({ expectedUpdatedAt: expenseUpdatedAt, notes: "contract" });
    assert.equal(patched.status, 200);
    assert.deepEqual(keysOf(patched.body.data), expected);
    // The client sends expectedUpdatedAt verbatim from updatedAt (ISO, ms precision).
    assert.match(patched.body.data.updatedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  test("report responses match the client report types", async () => {
    const q = `from=1965-01-01&to=1965-12-31&driverId=${driverId}`;
    const summary = await request(app).get(`${API}/reports/summary?${q}`).set(auth());
    assert.deepEqual(keysOf(summary.body.data), clientFields("DriverExpenseReportSummary"));
    assert.deepEqual(keysOf(summary.body.data.filters), clientFields("DriverExpenseReportFilters"));
    const byDriver = await request(app).get(`${API}/reports/by-driver?${q}`).set(auth());
    assert.deepEqual(keysOf(byDriver.body.data[0]), clientFields("DriverExpenseDriverReportRow"));
    const byVehicle = await request(app).get(`${API}/reports/by-vehicle?${q}`).set(auth());
    for (const r of byVehicle.body.data) assert.deepEqual(keysOf(r), clientFields("DriverExpenseVehicleReportRow"));
    const trend = await request(app).get(`${API}/reports/daily-trend?${q}`).set(auth());
    assert.deepEqual(keysOf(trend.body.data[0]), clientFields("DriverExpenseTrendRow"));
  });

  test("every structured error reason the client handles is what the server sends", async () => {
    const reason = (res: request.Response) => res.body?.error?.details?.reason;
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const settingsBody = (effectiveFrom: string) => ({
      pricePer20Liters: "30",
      motorcycleConsumptionLPer100Km: "3",
      carConsumptionLPer100Km: "9",
      effectiveFrom,
    });

    const cases: Array<[string, Promise<request.Response>, number]> = [
      ["DUPLICATE_EFFECTIVE_DATE", request(app).post(`${API}/fuel-settings`).set(auth()).send(settingsBody("1965-01-01")), 409],
      ["RETROACTIVE_CONFLICT", request(app).post(`${API}/fuel-settings`).set(auth()).send(settingsBody("1965-03-01")), 409],
      ["DUPLICATE_DAILY_EXPENSE", request(app).post(`${API}/daily-expenses`).set(auth()).send({ driverId, expenseDate: "1965-06-01", distanceKm: "1" }), 409],
      ["FUTURE_EXPENSE_DATE", request(app).post(`${API}/daily-expenses`).set(auth()).send({ driverId, expenseDate: tomorrow, distanceKm: "1" }), 400],
      ["FUEL_SETTINGS_NOT_CONFIGURED", request(app).post(`${API}/daily-expenses`).set(auth()).send({ driverId, expenseDate: "1850-01-01", distanceKm: "1" }), 409],
      [
        "STALE_DAILY_EXPENSE",
        request(app).patch(`${API}/daily-expenses/${expenseId}`).set(auth()).send({ expectedUpdatedAt: expenseUpdatedAt, notes: "stale" }),
        409,
      ],
    ];
    for (const [code, pending, status] of cases) {
      const res = await pending;
      assert.equal(res.status, status, `${code}: ${JSON.stringify(res.body)}`);
      assert.equal(reason(res), code);
      assert.equal(res.body.success, false);
      assert.ok(typeof res.body.error.message === "string" && res.body.error.message.length > 0);
    }

    // VEHICLE_TYPE_NOT_CONFIGURED needs a driver without a profile.
    const u = await createTestUser("DRIVER");
    userIds.push(u.id);
    const bare = await seedDriverRecord(u.id);
    try {
      const res = await request(app).post(`${API}/daily-expenses`).set(auth()).send({ driverId: bare, expenseDate: "1965-06-02", distanceKm: "1" });
      assert.equal(res.status, 409);
      assert.equal(reason(res), "VEHICLE_TYPE_NOT_CONFIGURED");
    } finally {
      await cleanupTestDriverRecord(bare);
    }

    // Every reason above is one the client maps (dailyExpenseGrid.describeDriverExpenseError).
    const clientErrors = readFileSync(path.join(CLIENT_SRC, "pages/management/driver-expenses/dailyExpenseGrid.ts"), "utf8");
    for (const code of [
      "DUPLICATE_EFFECTIVE_DATE",
      "RETROACTIVE_CONFLICT",
      "DUPLICATE_DAILY_EXPENSE",
      "FUTURE_EXPENSE_DATE",
      "FUEL_SETTINGS_NOT_CONFIGURED",
      "STALE_DAILY_EXPENSE",
      "VEHICLE_TYPE_NOT_CONFIGURED",
    ]) {
      assert.ok(clientErrors.includes(`case '${code}':`), `client does not handle ${code}`);
    }
  });
});
