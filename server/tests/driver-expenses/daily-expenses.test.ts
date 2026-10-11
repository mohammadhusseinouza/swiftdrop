import "../helpers/setup";
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import type { Express } from "express";
import { createApp } from "../../src/app";
import { prisma } from "../../src/db/prisma";
import { getUtcDayBoundary, parseUtcCalendarDate } from "../../src/shared/date/day-boundary";
import { Prisma } from "../../src/generated/prisma/client";
import { createDailyExpense } from "../../src/modules/driver-expenses/daily-expense.service";
import { findApplicableFuelSettings } from "../../src/modules/driver-expenses/fuel-settings.service";
import {
  cleanupTestDriverRecord,
  cleanupTestUser,
  createTestUser,
  loginTestUser,
  seedDriverRecord,
  uniqueSuffix,
  type TestUser,
} from "../helpers/fixtures";

// Fuel settings are GLOBAL and the dev DB is shared: every settings row this
// suite creates is effective inside 1980–1989 (past dates, since expenses
// cannot be future-dated; Phase 2's suite owns 2090–2099) and is removed in
// after(), together with the expenses referencing it.
const WINDOW = { gte: new Date(Date.UTC(1980, 0, 1)), lt: new Date(Date.UTC(1990, 0, 1)) };
const API = "/api/v1/driver-expenses";

describe("Driver Expenses — profiles & daily expenses", () => {
  let app: Express;
  let admin: TestUser;
  let tokens: Record<string, string>;
  const otherUsers: TestUser[] = [];
  const driverUserIds: string[] = [];
  const driverIds: string[] = [];
  const suffix = uniqueSuffix();

  let alpha: string; // profile MOTORCYCLE
  let bravo: string; // profile-less until configured in tests
  let charlie: string; // inactive
  let v1Id: string;
  let v2Id: string;

  function auth(token = tokens.admin) {
    return { Authorization: `Bearer ${token}` };
  }

  function day(value: string): Date {
    const d = parseUtcCalendarDate(value);
    assert.ok(d, value);
    return d;
  }

  async function seedNamedDriver(firstName: string, isActive = true) {
    const user = await createTestUser("DRIVER");
    driverUserIds.push(user.id);
    await prisma.users.update({ where: { id: user.id }, data: { first_name: firstName, last_name: `Exp${suffix}` } });
    const id = await seedDriverRecord(user.id, { isActive });
    driverIds.push(id);
    return id;
  }

  async function createSettings(effectiveFrom: string, price: string, moto: string, car: string) {
    const res = await request(app)
      .post(`${API}/fuel-settings`)
      .set(auth())
      .send({ pricePer20Liters: price, motorcycleConsumptionLPer100Km: moto, carConsumptionLPer100Km: car, effectiveFrom });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.data.id as string;
  }

  function createExpense(body: Record<string, unknown>, token = tokens.admin) {
    return request(app).post(`${API}/daily-expenses`).set(auth(token)).send(body);
  }

  function patchExpense(id: string, body: Record<string, unknown>) {
    return request(app).patch(`${API}/daily-expenses/${id}`).set(auth()).send(body);
  }

  function setProfile(driverId: string, defaultVehicleType: unknown, token = tokens.admin) {
    return request(app).put(`${API}/drivers/${driverId}/profile`).set(auth(token)).send({ defaultVehicleType });
  }

  async function auditCount(entityId: string, action: string) {
    return prisma.audit_logs.count({ where: { entity_id: entityId, action } });
  }

  async function removeExpenses(ids: string[]) {
    await prisma.audit_logs.deleteMany({ where: { entity_id: { in: ids } } });
    await prisma.driver_daily_expenses.deleteMany({ where: { id: { in: ids } } });
  }

  async function cleanup() {
    const settings = await prisma.driver_fuel_settings.findMany({ where: { effective_from: WINDOW }, select: { id: true } });
    const settingIds = settings.map((s) => s.id);
    const expenses = await prisma.driver_daily_expenses.findMany({
      where: { OR: [{ driver_id: { in: driverIds } }, { fuel_settings_id: { in: settingIds } }] },
      select: { id: true },
    });
    const profiles = await prisma.driver_expense_profiles.findMany({
      where: { driver_id: { in: driverIds } },
      select: { id: true },
    });
    const entityIds = [...settingIds, ...expenses.map((e) => e.id), ...profiles.map((p) => p.id)];
    await prisma.audit_logs.deleteMany({ where: { entity_id: { in: entityIds } } });
    await prisma.driver_daily_expenses.deleteMany({ where: { id: { in: expenses.map((e) => e.id) } } });
    await prisma.driver_expense_profiles.deleteMany({ where: { id: { in: profiles.map((p) => p.id) } } });
    await prisma.driver_fuel_settings.deleteMany({ where: { id: { in: settingIds } } });
  }

  before(async () => {
    app = createApp();
    await cleanup();
    admin = await createTestUser("ADMIN");
    for (const role of ["DISPATCHER", "FINANCE", "DRIVER", "CUSTOMER"]) otherUsers.push(await createTestUser(role));
    const logins = await Promise.all(
      [admin, ...otherUsers].map((u) => loginTestUser(app, u.email, u.password))
    );
    tokens = {
      admin: logins[0].accessToken as string,
      dispatcher: logins[1].accessToken as string,
      finance: logins[2].accessToken as string,
      driver: logins[3].accessToken as string,
      customer: logins[4].accessToken as string,
    };
    for (const [role, token] of Object.entries(tokens)) assert.ok(token, role);

    alpha = await seedNamedDriver("Alpha");
    bravo = await seedNamedDriver("Bravo");
    charlie = await seedNamedDriver("Charlie", false);

    v1Id = await createSettings("1980-01-01", "25.50", "3.40", "8.75");
    v2Id = await createSettings("1980-06-01", "30.00", "3.00", "9.00");
  });

  after(async () => {
    await cleanup();
    for (const id of driverIds) await cleanupTestDriverRecord(id);
    for (const id of driverUserIds) await cleanupTestUser(id);
    await Promise.all([admin, ...otherUsers].map((u) => cleanupTestUser(u.id)));
  });

  // ==========================================================================
  describe("driver profiles", () => {
    test("lists drivers with names resolved from users and only the needed fields", async () => {
      const res = await request(app).get(`${API}/drivers?search=Exp${suffix}&limit=100`).set(auth());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.meta.total, 3);
      assert.deepEqual(
        res.body.data.map((d: { displayName: string }) => d.displayName),
        [`Alpha Exp${suffix}`, `Bravo Exp${suffix}`, `Charlie Exp${suffix}`]
      );
      for (const d of res.body.data) {
        assert.deepEqual(Object.keys(d).sort(), [
          "defaultVehicleType",
          "displayName",
          "driverId",
          "isActive",
          "profileConfigured",
        ]);
      }
      const c = res.body.data.find((d: { driverId: string }) => d.driverId === charlie);
      assert.equal(c.isActive, false);
      assert.equal(c.profileConfigured, false);
      assert.equal(c.defaultVehicleType, null);

      const inactiveOnly = await request(app).get(`${API}/drivers?search=Exp${suffix}&isActive=false`).set(auth());
      assert.deepEqual(inactiveOnly.body.data.map((d: { driverId: string }) => d.driverId), [charlie]);
    });

    test("create (201) then change (200) the default vehicle, each audited once", async () => {
      const created = await setProfile(alpha, "CAR");
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(created.body.data.defaultVehicleType, "CAR");

      const changed = await setProfile(alpha, "MOTORCYCLE");
      assert.equal(changed.status, 200);
      assert.equal(changed.body.data.defaultVehicleType, "MOTORCYCLE");

      const same = await setProfile(alpha, "MOTORCYCLE");
      assert.equal(same.status, 200);
      assert.equal(same.body.data.updatedAt, changed.body.data.updatedAt, "no-op writes nothing");

      const profile = await prisma.driver_expense_profiles.findUniqueOrThrow({ where: { driver_id: alpha } });
      assert.equal(await auditCount(profile.id, "DRIVER_EXPENSE_PROFILE_CREATED"), 1);
      assert.equal(await auditCount(profile.id, "DRIVER_EXPENSE_PROFILE_UPDATED"), 1);
      const update = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_id: profile.id, action: "DRIVER_EXPENSE_PROFILE_UPDATED" },
      });
      assert.deepEqual(update.previous_values, { defaultVehicleType: "CAR" });
      assert.deepEqual(update.new_values, { defaultVehicleType: "MOTORCYCLE" });
      assert.equal(update.actor_user_id, admin.id);

      const listed = await request(app).get(`${API}/drivers?search=Exp${suffix}`).set(auth());
      const a = listed.body.data.find((d: { driverId: string }) => d.driverId === alpha);
      assert.equal(a.profileConfigured, true);
      assert.equal(a.defaultVehicleType, "MOTORCYCLE");
    });

    test("rejects invalid vehicle types, unknown and malformed driver ids", async () => {
      for (const bad of ["TRUCK", "car", "", null, 3]) {
        assert.equal((await setProfile(bravo, bad)).status, 400, String(bad));
      }
      const unknown = await setProfile("00000000-0000-4000-8000-000000000000", "CAR");
      assert.equal(unknown.status, 404);
      assert.equal((await setProfile("not-a-uuid", "CAR")).status, 400);
      assert.equal(await prisma.driver_expense_profiles.count({ where: { driver_id: bravo } }), 0);
    });

    test("concurrent profile creation -> exactly one profile and one CREATED audit", async () => {
      const fresh = await seedNamedDriver("Delta");
      const results = await Promise.all(
        ["CAR", "MOTORCYCLE", "CAR", "MOTORCYCLE", "CAR"].map((t) => setProfile(fresh, t))
      );
      assert.deepEqual(results.map((r) => r.status).filter((s) => s === 201), [201]);
      for (const r of results) assert.ok([200, 201].includes(r.status), JSON.stringify(r.body));
      assert.equal(await prisma.driver_expense_profiles.count({ where: { driver_id: fresh } }), 1);
      const profile = await prisma.driver_expense_profiles.findUniqueOrThrow({ where: { driver_id: fresh } });
      assert.equal(await auditCount(profile.id, "DRIVER_EXPENSE_PROFILE_CREATED"), 1);
    });
  });

  // ==========================================================================
  describe("daily expense creation", () => {
    test("motorcycle (profile default): exact expense + snapshots of the version in effect", async () => {
      await setProfile(alpha, "MOTORCYCLE");
      const res = await createExpense({ driverId: alpha, expenseDate: "1980-03-10", distanceKm: "37.25", notes: " route A " });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const d = res.body.data;
      assert.equal(d.driverName, `Alpha Exp${suffix}`);
      assert.equal(d.expenseDate, "1980-03-10");
      assert.equal(d.vehicleType, "MOTORCYCLE");
      assert.equal(d.distanceKm, "37.25");
      assert.equal(d.fuelSettingsId, v1Id);
      assert.equal(d.fuelSettingsEffectiveFrom, "1980-01-01");
      assert.equal(d.pricePer20LitersSnapshot, "25.5");
      assert.equal(d.consumptionLPer100KmSnapshot, "3.4");
      assert.equal(d.pricePerLiter, "1.275");
      assert.equal(d.costPerKm, "0.04335");
      assert.equal(d.estimatedExpense, "1.6147875");
      assert.equal(d.notes, "route A");

      const row = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: d.id } });
      assert.equal(row.estimated_expense.toFixed(10), "1.6147875000", "stored exactly, not rounded to cents");
      assert.equal(await auditCount(d.id, "DRIVER_DAILY_EXPENSE_CREATED"), 1);
    });

    test("car via vehicle override (overrides the motorcycle default)", async () => {
      const res = await createExpense({ driverId: alpha, expenseDate: "1980-03-11", distanceKm: "120.40", vehicleType: "CAR" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.vehicleType, "CAR");
      assert.equal(res.body.data.consumptionLPer100KmSnapshot, "8.75");
      assert.equal(res.body.data.estimatedExpense, "13.432125");
    });

    test("zero kilometers is a valid record with a zero expense", async () => {
      const res = await createExpense({ driverId: alpha, expenseDate: "1980-03-12", distanceKm: 0 });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.data.distanceKm, "0");
      assert.equal(res.body.data.estimatedExpense, "0");
    });

    test("resolves the version effective on the expense date (not the newest)", async () => {
      const before = await createExpense({ driverId: alpha, expenseDate: "1980-05-31", distanceKm: "10", vehicleType: "CAR" });
      assert.equal(before.body.data.fuelSettingsId, v1Id);
      assert.equal(before.body.data.estimatedExpense, "1.115625");
      const onV2 = await createExpense({ driverId: alpha, expenseDate: "1980-06-15", distanceKm: "10", vehicleType: "CAR" });
      assert.equal(onV2.body.data.fuelSettingsId, v2Id);
      assert.equal(onV2.body.data.pricePer20LitersSnapshot, "30");
      assert.equal(onV2.body.data.consumptionLPer100KmSnapshot, "9");
      assert.equal(onV2.body.data.estimatedExpense, "1.35");
    });

    test("no profile and no override -> 409 VEHICLE_TYPE_NOT_CONFIGURED, nothing written", async () => {
      const res = await createExpense({ driverId: bravo, expenseDate: "1980-03-10", distanceKm: "5" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "VEHICLE_TYPE_NOT_CONFIGURED");
      assert.equal(await prisma.driver_daily_expenses.count({ where: { driver_id: bravo } }), 0);
      // An override works without a profile.
      const ok = await createExpense({ driverId: bravo, expenseDate: "1980-03-10", distanceKm: "5", vehicleType: "MOTORCYCLE" });
      assert.equal(ok.status, 201);
    });

    test("no applicable fuel settings -> 409 FUEL_SETTINGS_NOT_CONFIGURED", async () => {
      const res = await createExpense({ driverId: alpha, expenseDate: "1850-01-01", distanceKm: "5" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "FUEL_SETTINGS_NOT_CONFIGURED");
      assert.equal(await prisma.driver_daily_expenses.count({ where: { expense_date: day("1850-01-01") } }), 0);
    });

    test("unknown driver -> 404; inactive driver can still be recorded", async () => {
      const unknown = await createExpense({
        driverId: "00000000-0000-4000-8000-000000000000",
        expenseDate: "1980-03-10",
        distanceKm: "5",
        vehicleType: "CAR",
      });
      assert.equal(unknown.status, 404);
      const inactive = await createExpense({ driverId: charlie, expenseDate: "1980-03-10", distanceKm: "5", vehicleType: "CAR" });
      assert.equal(inactive.status, 201);
    });

    test("duplicate driver/date -> 409 with the existing id, original untouched", async () => {
      const original = await prisma.driver_daily_expenses.findUniqueOrThrow({
        where: { driver_id_expense_date: { driver_id: alpha, expense_date: day("1980-03-10") } },
      });
      const dup = await createExpense({ driverId: alpha, expenseDate: "1980-03-10", distanceKm: "999", vehicleType: "CAR" });
      assert.equal(dup.status, 409);
      assert.equal(dup.body.error.details.reason, "DUPLICATE_DAILY_EXPENSE");
      assert.equal(dup.body.error.details.existingExpenseId, original.id);
      const now = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: original.id } });
      assert.equal(now.distance_km.toFixed(), original.distance_km.toFixed());
      assert.equal(now.updated_at.getTime(), original.updated_at.getTime());
      assert.equal(await auditCount(original.id, "DRIVER_DAILY_EXPENSE_CREATED"), 1);
    });

    test("server-derived fields in the request are ignored", async () => {
      const res = await createExpense({
        driverId: alpha,
        expenseDate: "1980-03-13",
        distanceKm: "10",
        vehicleType: "CAR",
        estimatedExpense: "1",
        pricePer20LitersSnapshot: "1",
        fuelSettingsId: v2Id,
      });
      assert.equal(res.status, 201);
      assert.equal(res.body.data.estimatedExpense, "1.115625");
      assert.equal(res.body.data.fuelSettingsId, v1Id);
    });

    test("distance validation", async () => {
      for (const bad of ["-1", "-0.01", "1.234", "1000000.00", "abc", "", null, true]) {
        const res = await createExpense({ driverId: alpha, expenseDate: "1980-03-20", distanceKm: bad, vehicleType: "CAR" });
        assert.equal(res.status, 400, `distance ${JSON.stringify(bad)}`);
      }
      assert.equal((await createExpense({ driverId: alpha, expenseDate: "1980-03-20", vehicleType: "CAR" })).status, 400);
      const max = await createExpense({ driverId: alpha, expenseDate: "1980-03-20", distanceKm: "999999.99", vehicleType: "CAR" });
      assert.equal(max.status, 201, JSON.stringify(max.body));
      assert.equal(max.body.data.estimatedExpense, "111562.498884375");
    });

    test("other validation: dates, notes, vehicle type", async () => {
      for (const body of [
        { expenseDate: "1980-02-30" },
        { expenseDate: "1980/03/21" },
        { vehicleType: "TRUCK" },
        { notes: "x".repeat(1001) },
        { driverId: "nope" },
      ]) {
        const res = await createExpense({ driverId: alpha, expenseDate: "1980-03-21", distanceKm: "1", vehicleType: "CAR", ...body });
        assert.equal(res.status, 400, JSON.stringify(body));
      }
      const blankNotes = await createExpense({ driverId: alpha, expenseDate: "1980-03-21", distanceKm: "1", vehicleType: "CAR", notes: "   " });
      assert.equal(blankNotes.status, 201);
      assert.equal(blankNotes.body.data.notes, null);
    });

    test("a result that would overflow NUMERIC(24,10) -> 400, nothing written", async () => {
      await createSettings("1981-01-01", "999999999999.99", "9999.99", "9999.99");
      const res = await createExpense({ driverId: alpha, expenseDate: "1981-01-02", distanceKm: "999999.99", vehicleType: "CAR" });
      assert.equal(res.status, 400);
      assert.equal(await prisma.driver_daily_expenses.count({ where: { expense_date: day("1981-01-02") } }), 0);
      assert.equal(await prisma.audit_logs.count({ where: { action: "DRIVER_DAILY_EXPENSE_CREATED", new_values: { path: ["expenseDate"], equals: "1981-01-02" } } }), 0);
    });

    test("future expense dates are rejected; today is allowed (UTC business date)", async () => {
      const today = getUtcDayBoundary().start;
      const tomorrow = new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const future = await createExpense({ driverId: charlie, expenseDate: tomorrow, distanceKm: "1", vehicleType: "CAR" });
      assert.equal(future.status, 400);
      assert.equal(future.body.error.details.reason, "FUTURE_EXPENSE_DATE");
      assert.equal(await prisma.driver_daily_expenses.count({ where: { expense_date: day(tomorrow) } }), 0);

      const todayStr = today.toISOString().slice(0, 10);
      // 0 km: this test is about the date rule, independent of which settings apply.
      const ok = await createExpense({ driverId: charlie, expenseDate: todayStr, distanceKm: "0", vehicleType: "CAR" });
      assert.equal(ok.status, 201, JSON.stringify(ok.body));
      // Remove it: a recorded day after the test settings window would (rightly)
      // make later settings in that window retroactive.
      await removeExpenses([ok.body.data.id]);
    });

    test("service: the UTC business date decides 'future', not the caller's timezone", async () => {
      // 23:30 at UTC-5 on 1989-12-31 is already 1990-01-01 in UTC.
      const lateWest = new Date("1989-12-31T23:30:00-05:00");
      await assert.rejects(
        createDailyExpense(
          { driverId: charlie, expenseDate: "1990-01-02", distanceKm: new Prisma.Decimal("1"), vehicleType: "CAR" },
          admin.id,
          lateWest
        ),
        (e: unknown) => (e as { statusCode?: number }).statusCode === 400
      );
      const created = await createDailyExpense(
        { driverId: charlie, expenseDate: "1989-12-31", distanceKm: new Prisma.Decimal("0"), vehicleType: "CAR" },
        admin.id,
        lateWest
      );
      assert.equal(created.expenseDate, "1989-12-31");
      await removeExpenses([created.id]);
    });

    test("changing the default vehicle never alters recorded expenses", async () => {
      const before = await prisma.driver_daily_expenses.findMany({ where: { driver_id: alpha }, orderBy: { id: "asc" } });
      assert.ok(before.length > 0);
      assert.equal((await setProfile(alpha, "CAR")).status, 200);
      const after = await prisma.driver_daily_expenses.findMany({ where: { driver_id: alpha }, orderBy: { id: "asc" } });
      assert.deepEqual(after, before);
      await setProfile(alpha, "MOTORCYCLE");
    });
  });

  // ==========================================================================
  describe("daily expense corrections", () => {
    async function fresh(date: string, vehicleType: "CAR" | "MOTORCYCLE", distanceKm = "100") {
      const res = await createExpense({ driverId: bravo, expenseDate: date, distanceKm, vehicleType, notes: "n1" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.data;
    }

    test("distance correction recalculates with the ORIGINAL settings, audited with old/new", async () => {
      const e = await fresh("1980-04-01", "MOTORCYCLE"); // V1 even though V2 exists
      const res = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: "50" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.fuelSettingsId, v1Id);
      assert.equal(res.body.data.pricePer20LitersSnapshot, "25.5");
      assert.equal(res.body.data.estimatedExpense, "2.1675"); // 50 * 0.04335
      assert.notEqual(res.body.data.updatedAt, e.updatedAt);
      assert.equal(res.body.data.expenseDate, "1980-04-01");

      const audit = await prisma.audit_logs.findFirstOrThrow({
        where: { entity_id: e.id, action: "DRIVER_DAILY_EXPENSE_CORRECTED" },
      });
      assert.equal(audit.actor_user_id, admin.id);
      assert.deepEqual(audit.previous_values, { distanceKm: "100", estimatedExpense: "4.335" });
      assert.deepEqual(audit.new_values, { distanceKm: "50", estimatedExpense: "2.1675" });
    });

    test("vehicle-type correction takes the new type's rate from the SAME historical version", async () => {
      const e = await fresh("1980-04-02", "MOTORCYCLE");
      const res = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, vehicleType: "CAR" });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.vehicleType, "CAR");
      assert.equal(res.body.data.consumptionLPer100KmSnapshot, "8.75", "V1 car rate, not V2's 9");
      assert.equal(res.body.data.estimatedExpense, "11.15625");
      const row = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: e.id } });
      assert.equal(row.fuel_settings_id, v1Id);
    });

    test("notes-only correction leaves the calculation untouched", async () => {
      const e = await fresh("1980-04-03", "CAR");
      const res = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, notes: "fixed typo" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.notes, "fixed typo");
      assert.equal(res.body.data.estimatedExpense, e.estimatedExpense);
      const audit = await prisma.audit_logs.findFirstOrThrow({ where: { entity_id: e.id, action: "DRIVER_DAILY_EXPENSE_CORRECTED" } });
      assert.deepEqual(audit.previous_values, { notes: "n1" });
      assert.deepEqual(audit.new_values, { notes: "fixed typo" });
      const cleared = await patchExpense(e.id, { expectedUpdatedAt: res.body.data.updatedAt, notes: null });
      assert.equal(cleared.body.data.notes, null);
    });

    test("no-op correction writes and audits nothing", async () => {
      const e = await fresh("1980-04-04", "CAR");
      const res = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: "100.00", vehicleType: "CAR", notes: "n1" });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.updatedAt, e.updatedAt);
      assert.equal(await auditCount(e.id, "DRIVER_DAILY_EXPENSE_CORRECTED"), 0);
    });

    test("driver and date are immutable (ignored if sent)", async () => {
      const e = await fresh("1980-04-05", "CAR");
      const res = await patchExpense(e.id, {
        expectedUpdatedAt: e.updatedAt,
        distanceKm: "1",
        driverId: alpha,
        expenseDate: "1980-12-31",
        fuelSettingsId: v2Id,
      });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.driverId, bravo);
      assert.equal(res.body.data.expenseDate, "1980-04-05");
      assert.equal(res.body.data.fuelSettingsId, v1Id);
    });

    test("stale expectedUpdatedAt -> 409 STALE_DAILY_EXPENSE, nothing written", async () => {
      const e = await fresh("1980-04-06", "CAR");
      const first = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: "10" });
      assert.equal(first.status, 200);
      const stale = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: "20" });
      assert.equal(stale.status, 409);
      assert.equal(stale.body.error.details.reason, "STALE_DAILY_EXPENSE");
      assert.equal(stale.body.error.details.currentUpdatedAt, first.body.data.updatedAt);
      const row = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: e.id } });
      assert.equal(row.distance_km.toFixed(), "10");
      assert.equal(await auditCount(e.id, "DRIVER_DAILY_EXPENSE_CORRECTED"), 1);
    });

    test("concurrent corrections -> exactly one wins, one audit", async () => {
      const e = await fresh("1980-04-07", "CAR");
      const results = await Promise.all(
        ["11", "22", "33", "44"].map((km) => patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: km }))
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409, 409]);
      const winner = results.find((r) => r.status === 200)!;
      const row = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: e.id } });
      assert.equal(row.distance_km.toFixed(), winner.body.data.distanceKm);
      assert.equal(row.estimated_expense.toFixed(), winner.body.data.estimatedExpense);
      assert.equal(await auditCount(e.id, "DRIVER_DAILY_EXPENSE_CORRECTED"), 1);
    });

    test("validation: expectedUpdatedAt required, at least one field, unknown id", async () => {
      const e = await fresh("1980-04-08", "CAR");
      assert.equal((await patchExpense(e.id, { distanceKm: "1" })).status, 400);
      assert.equal((await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt })).status, 400);
      assert.equal((await patchExpense(e.id, { expectedUpdatedAt: "yesterday", distanceKm: "1" })).status, 400);
      assert.equal((await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: "-1" })).status, 400);
      const missing = await patchExpense("00000000-0000-4000-8000-000000000000", { expectedUpdatedAt: e.updatedAt, notes: "x" });
      assert.equal(missing.status, 404);
    });

    test("new fuel settings never change recorded or corrected values", async () => {
      const e = await fresh("1980-07-01", "CAR"); // V2
      await createSettings("1980-08-01", "80.00", "5.00", "15.00");
      const res = await request(app).get(`${API}/daily-expenses/${e.id}`).set(auth());
      assert.equal(res.body.data.estimatedExpense, e.estimatedExpense);
      const corrected = await patchExpense(e.id, { expectedUpdatedAt: e.updatedAt, distanceKm: "200" });
      assert.equal(corrected.body.data.fuelSettingsId, v2Id);
      assert.equal(corrected.body.data.estimatedExpense, "27"); // 200 * 30 * 9 * 0.0005
    });
  });

  // ==========================================================================
  describe("reads", () => {
    test("by-date returns only recorded entries, ordered by driver name", async () => {
      const res = await request(app).get(`${API}/daily-expenses/by-date/1980-03-10`).set(auth());
      assert.equal(res.status, 200);
      const mine = res.body.data.filter((r: { driverId: string }) => driverIds.includes(r.driverId));
      assert.deepEqual(
        mine.map((r: { driverName: string }) => r.driverName),
        [`Alpha Exp${suffix}`, `Bravo Exp${suffix}`, `Charlie Exp${suffix}`]
      );
      const empty = await request(app).get(`${API}/daily-expenses/by-date/1980-03-30`).set(auth());
      assert.deepEqual(empty.body.data.filter((r: { driverId: string }) => driverIds.includes(r.driverId)), []);
      assert.equal((await request(app).get(`${API}/daily-expenses/by-date/1980-13-01`).set(auth())).status, 400);
    });

    test("get one returns the record with calculation details; 404 / 400 otherwise", async () => {
      const row = await prisma.driver_daily_expenses.findFirstOrThrow({ where: { driver_id: alpha } });
      const res = await request(app).get(`${API}/daily-expenses/${row.id}`).set(auth());
      assert.equal(res.status, 200);
      assert.equal(res.body.data.id, row.id);
      assert.ok(res.body.data.pricePerLiter && res.body.data.costPerKm);
      assert.equal((await request(app).get(`${API}/daily-expenses/00000000-0000-4000-8000-000000000000`).set(auth())).status, 404);
      assert.equal((await request(app).get(`${API}/daily-expenses/nope`).set(auth())).status, 400);
    });

    test("driver history: date range + pagination, newest first", async () => {
      const res = await request(app)
        .get(`${API}/drivers/${alpha}/daily-expenses?from=1980-03-10&to=1980-03-13&limit=2`)
        .set(auth());
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.meta.total, 4); // 03-10, 03-11, 03-12, 03-13
      assert.deepEqual(res.body.data.map((r: { expenseDate: string }) => r.expenseDate), ["1980-03-13", "1980-03-12"]);
      const page2 = await request(app)
        .get(`${API}/drivers/${alpha}/daily-expenses?from=1980-03-10&to=1980-03-13&limit=2&page=2`)
        .set(auth());
      assert.deepEqual(page2.body.data.map((r: { expenseDate: string }) => r.expenseDate), ["1980-03-11", "1980-03-10"]);
      assert.equal((await request(app).get(`${API}/drivers/${alpha}/daily-expenses?from=1980-03-13&to=1980-03-10`).set(auth())).status, 400);
      assert.equal(
        (await request(app).get(`${API}/drivers/00000000-0000-4000-8000-000000000000/daily-expenses`).set(auth())).status,
        404
      );
    });

    test("list filters by driver and date", async () => {
      const byDriverDate = await request(app).get(`${API}/daily-expenses?driverId=${bravo}&date=1980-03-10`).set(auth());
      assert.equal(byDriverDate.status, 200);
      assert.equal(byDriverDate.body.meta.total, 1);
      assert.equal(byDriverDate.body.data[0].driverId, bravo);
      const range = await request(app).get(`${API}/daily-expenses?driverId=${alpha}&from=1980-05-01&to=1980-06-30`).set(auth());
      assert.deepEqual(range.body.data.map((r: { expenseDate: string }) => r.expenseDate), ["1980-06-15", "1980-05-31"]);
      assert.equal((await request(app).get(`${API}/daily-expenses?date=1980-03-10&from=1980-03-01`).set(auth())).status, 400);
    });
  });

  // ==========================================================================
  describe("concurrency", () => {
    test("concurrent duplicate creation -> one 201, the rest 409, one row, one audit", async () => {
      const results = await Promise.all(
        Array.from({ length: 5 }, (_, i) =>
          createExpense({ driverId: charlie, expenseDate: "1980-09-01", distanceKm: `${i + 1}`, vehicleType: "CAR" })
        )
      );
      assert.deepEqual(results.map((r) => r.status).sort(), [201, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        assert.equal(r.body.error.details.reason, "DUPLICATE_DAILY_EXPENSE");
      }
      const rows = await prisma.driver_daily_expenses.findMany({
        where: { driver_id: charlie, expense_date: day("1980-09-01") },
      });
      assert.equal(rows.length, 1);
      assert.equal(await auditCount(rows[0].id, "DRIVER_DAILY_EXPENSE_CREATED"), 1);
      assert.equal(
        await prisma.audit_logs.count({
          where: { action: "DRIVER_DAILY_EXPENSE_CREATED", new_values: { path: ["expenseDate"], equals: "1980-09-01" } },
        }),
        1,
        "losers leave no audit"
      );
    });

    test("expense creation racing settings creation never leaves an inconsistent history", async () => {
      await createSettings("1982-01-01", "20.00", "3.00", "8.00");
      for (let m = 2; m <= 9; m++) {
        const month = String(m).padStart(2, "0");
        const [expense, settings] = await Promise.all([
          createExpense({ driverId: bravo, expenseDate: `1982-${month}-15`, distanceKm: "10", vehicleType: "CAR" }),
          request(app)
            .post(`${API}/fuel-settings`)
            .set(auth())
            .send({
              pricePer20Liters: `${20 + m}.00`,
              motorcycleConsumptionLPer100Km: "3.00",
              carConsumptionLPer100Km: "8.00",
              effectiveFrom: `1982-${month}-01`,
            }),
        ]);
        assert.equal(expense.status, 201, JSON.stringify(expense.body));
        assert.ok([201, 409].includes(settings.status), JSON.stringify(settings.body));
        if (settings.status === 409) assert.equal(settings.body.error.details.reason, "RETROACTIVE_CONFLICT");

        // Invariant: the recorded day's settings are exactly what its date resolves to.
        const applicable = await findApplicableFuelSettings(prisma, day(`1982-${month}-15`));
        assert.equal(expense.body.data.fuelSettingsId, applicable?.id, `month ${month}`);
        if (settings.status === 201) assert.equal(expense.body.data.fuelSettingsId, settings.body.data.id);
      }
    });

    test("committed expenses block settings that would reinterpret them", async () => {
      const res = await request(app)
        .post(`${API}/fuel-settings`)
        .set(auth())
        .send({ pricePer20Liters: "99.00", motorcycleConsumptionLPer100Km: "1", carConsumptionLPer100Km: "1", effectiveFrom: "1980-03-05" });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.details.reason, "RETROACTIVE_CONFLICT");
      assert.equal(res.body.error.details.earliestAffectedExpenseDate, "1980-03-10");
    });
  });

  // ==========================================================================
  describe("isolation and authorization", () => {
    test("creating and correcting expenses changes no finance, cash, wallet, settlement or order data", async () => {
      const snapshot = () =>
        Promise.all([
          prisma.company_financial_transactions.count(),
          prisma.company_direct_collections.count(),
          prisma.driver_cash_transactions.count(),
          prisma.driver_cash_accounts.findMany({ select: { id: true, current_balance: true }, orderBy: { id: "asc" } }),
          prisma.driver_settlements.count(),
          prisma.wallet_transactions.count(),
          prisma.customer_wallets.findMany({ select: { id: true, available_balance: true }, orderBy: { id: "asc" } }),
          prisma.customer_payouts.count(),
          prisma.orders.count(),
          prisma.order_assignments.count(),
          prisma.delivery_attempts.count(),
          prisma.order_status_history.count(),
        ]);
      const before = await snapshot();
      const created = await createExpense({ driverId: charlie, expenseDate: "1980-10-01", distanceKm: "42", vehicleType: "MOTORCYCLE" });
      assert.equal(created.status, 201);
      const corrected = await patchExpense(created.body.data.id, { expectedUpdatedAt: created.body.data.updatedAt, distanceKm: "43" });
      assert.equal(corrected.status, 200);
      assert.equal((await setProfile(charlie, "CAR")).status, 201);
      assert.deepEqual(await snapshot(), before);
    });

    test("every endpoint is administrator-only", async () => {
      const row = await prisma.driver_daily_expenses.findFirstOrThrow({ where: { driver_id: alpha } });
      const endpoints: Array<{ method: "get" | "put" | "post" | "patch"; path: string; body?: object }> = [
        { method: "get", path: `${API}/drivers` },
        { method: "put", path: `${API}/drivers/${bravo}/profile`, body: { defaultVehicleType: "CAR" } },
        { method: "get", path: `${API}/drivers/${alpha}/daily-expenses` },
        { method: "get", path: `${API}/daily-expenses` },
        { method: "post", path: `${API}/daily-expenses`, body: { driverId: alpha, expenseDate: "1980-11-01", distanceKm: "1", vehicleType: "CAR" } },
        { method: "get", path: `${API}/daily-expenses/by-date/1980-03-10` },
        { method: "get", path: `${API}/daily-expenses/${row.id}` },
        { method: "patch", path: `${API}/daily-expenses/${row.id}`, body: { expectedUpdatedAt: row.updated_at.toISOString(), notes: "x" } },
      ];
      for (const role of ["dispatcher", "finance", "driver", "customer"]) {
        for (const e of endpoints) {
          const res = await request(app)[e.method](e.path).set(auth(tokens[role])).send(e.body ?? {});
          assert.equal(res.status, 403, `${role} ${e.method} ${e.path}`);
        }
      }
      for (const e of endpoints) {
        const res = await request(app)[e.method](e.path).send(e.body ?? {});
        assert.equal(res.status, 401, `anon ${e.method} ${e.path}`);
      }
      assert.equal(await prisma.driver_daily_expenses.count({ where: { expense_date: day("1980-11-01") } }), 0);
      assert.equal(await prisma.driver_expense_profiles.count({ where: { driver_id: bravo } }), 0);
      const unchanged = await prisma.driver_daily_expenses.findUniqueOrThrow({ where: { id: row.id } });
      assert.equal(unchanged.updated_at.getTime(), row.updated_at.getTime());
    });
  });
});
