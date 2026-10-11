import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { getUtcDayBoundary } from "../../shared/date/day-boundary";
import {
  calculateCostPerKm,
  calculateEstimatedExpense,
  calculatePricePerLiter,
  fitsEstimatedExpenseColumn,
  formatExactDecimal,
  resolveConsumptionRate,
} from "./driver-expense-calculation";
import { parseCalendarDateOrThrow, toCalendarDate } from "./driver-expense-dates";
import { assertDriverExists, driverDisplayName } from "./driver-expense-profile.service";
import { findApplicableFuelSettings, lockFuelSettingsTimelineShared } from "./fuel-settings.service";
import type {
  CreateDailyExpenseInput,
  DriverExpenseHistoryQuery,
  ListDailyExpensesQuery,
  UpdateDailyExpenseInput,
} from "./daily-expense.schema";
import type { DailyExpenseDetail } from "./daily-expense.types";

// ============================================================================
// Driver Expenses — daily expense records (Phase 3).
//
// Independent module: reads drivers/users (identity), driver_expense_profiles
// and driver_fuel_settings; writes ONLY driver_daily_expenses + the shared
// audit log. Never reads or writes driver cash, settlements, company finance,
// wallets, payouts, orders or delivery data.
//
// Every expense is computed server-side by the shared Phase 2 engine from a
// SNAPSHOT of its fuel settings (price + the used vehicle type's
// consumption). Recorded days are never recalculated when settings change.
// ============================================================================

const dailyExpenseSelect = {
  id: true,
  driver_id: true,
  expense_date: true,
  vehicle_type: true,
  distance_km: true,
  fuel_settings_id: true,
  price_per_20_liters_snapshot: true,
  consumption_l_per_100km_snapshot: true,
  estimated_expense: true,
  notes: true,
  created_at: true,
  updated_at: true,
  driver_fuel_settings: { select: { effective_from: true } },
  drivers: { select: { users: { select: { first_name: true, last_name: true } } } },
} satisfies Prisma.driver_daily_expensesSelect;

type DailyExpenseRow = Prisma.driver_daily_expensesGetPayload<{ select: typeof dailyExpenseSelect }>;

function toDailyExpenseDetail(row: DailyExpenseRow): DailyExpenseDetail {
  return {
    id: row.id,
    driverId: row.driver_id,
    driverName: driverDisplayName(row.drivers.users),
    expenseDate: toCalendarDate(row.expense_date),
    vehicleType: row.vehicle_type,
    distanceKm: formatExactDecimal(row.distance_km),
    fuelSettingsId: row.fuel_settings_id,
    fuelSettingsEffectiveFrom: toCalendarDate(row.driver_fuel_settings.effective_from),
    pricePer20LitersSnapshot: formatExactDecimal(row.price_per_20_liters_snapshot),
    consumptionLPer100KmSnapshot: formatExactDecimal(row.consumption_l_per_100km_snapshot),
    pricePerLiter: formatExactDecimal(calculatePricePerLiter(row.price_per_20_liters_snapshot)),
    costPerKm: formatExactDecimal(
      calculateCostPerKm(row.price_per_20_liters_snapshot, row.consumption_l_per_100km_snapshot)
    ),
    estimatedExpense: formatExactDecimal(row.estimated_expense),
    notes: row.notes,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function conflict(reason: string, message: string, extra: Record<string, unknown> = {}): AppError {
  return new AppError({ statusCode: 409, code: "CONFLICT", message, details: { reason, ...extra } });
}

function assertFitsColumn(estimated: Prisma.Decimal): void {
  if (!fitsEstimatedExpenseColumn(estimated)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "The calculated expense exceeds the supported range — check the distance",
    });
  }
}

function duplicateDailyExpense(driverId: string, expenseDate: string, existingId?: string): AppError {
  return conflict("DUPLICATE_DAILY_EXPENSE", "A daily expense already exists for this driver on this date", {
    driverId,
    expenseDate,
    ...(existingId ? { existingExpenseId: existingId } : {}),
  });
}

// ----------------------------------------------------------------------------
// POST /driver-expenses/daily-expenses
// ----------------------------------------------------------------------------
export async function createDailyExpense(
  input: CreateDailyExpenseInput,
  actorUserId: string,
  now: Date = new Date()
): Promise<DailyExpenseDetail> {
  const expenseDate = parseCalendarDateOrThrow(input.expenseDate);
  // Distance can only be recorded for a day that has started: dates after
  // today's UTC business date are rejected (project UTC convention). A
  // future-dated entry would otherwise also block settings for every earlier
  // date via the retroactive guard. Corrections never change the date, so
  // existing records stay readable and correctable.
  if (expenseDate.getTime() > getUtcDayBoundary(now).start.getTime()) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Expense date cannot be in the future",
      details: { reason: "FUTURE_EXPENSE_DATE", expenseDate: input.expenseDate },
    });
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Timeline lock FIRST (same key and ordering as createFuelSettings),
      // held until COMMIT: covers resolving settings, calculating and the
      // insert, so no settings version can appear in between.
      await lockFuelSettingsTimelineShared(tx);

      await assertDriverExists(tx, input.driverId);

      let vehicleType = input.vehicleType;
      if (!vehicleType) {
        const profile = await tx.driver_expense_profiles.findUnique({
          where: { driver_id: input.driverId },
          select: { default_vehicle_type: true },
        });
        vehicleType = profile?.default_vehicle_type;
      }
      if (!vehicleType) {
        throw conflict(
          "VEHICLE_TYPE_NOT_CONFIGURED",
          "This driver has no default vehicle type — configure the driver's profile or provide vehicleType"
        );
      }

      const settings = await findApplicableFuelSettings(tx, expenseDate);
      if (!settings) {
        throw conflict(
          "FUEL_SETTINGS_NOT_CONFIGURED",
          "No fuel settings are effective on this date — create fuel settings effective on or before it",
          { expenseDate: input.expenseDate }
        );
      }

      const existing = await tx.driver_daily_expenses.findUnique({
        where: { driver_id_expense_date: { driver_id: input.driverId, expense_date: expenseDate } },
        select: { id: true },
      });
      if (existing) throw duplicateDailyExpense(input.driverId, input.expenseDate, existing.id);

      const consumption = resolveConsumptionRate(
        {
          motorcycleConsumptionLPer100Km: settings.motorcycle_consumption_l_per_100km,
          carConsumptionLPer100Km: settings.car_consumption_l_per_100km,
        },
        vehicleType
      );
      const estimated = calculateEstimatedExpense(input.distanceKm, settings.price_per_20_liters, consumption);
      assertFitsColumn(estimated);

      const row = await tx.driver_daily_expenses.create({
        data: {
          driver_id: input.driverId,
          expense_date: expenseDate,
          vehicle_type: vehicleType,
          distance_km: input.distanceKm,
          fuel_settings_id: settings.id,
          price_per_20_liters_snapshot: settings.price_per_20_liters,
          consumption_l_per_100km_snapshot: consumption,
          estimated_expense: estimated,
          notes: input.notes ?? null,
        },
        select: dailyExpenseSelect,
      });

      const detail = toDailyExpenseDetail(row);
      await createAuditLog(tx, {
        actorUserId,
        action: "DRIVER_DAILY_EXPENSE_CREATED",
        entityType: "DRIVER_DAILY_EXPENSE",
        entityId: row.id,
        newValues: {
          driverId: detail.driverId,
          expenseDate: detail.expenseDate,
          vehicleType: detail.vehicleType,
          distanceKm: detail.distanceKm,
          fuelSettingsId: detail.fuelSettingsId,
          pricePer20LitersSnapshot: detail.pricePer20LitersSnapshot,
          consumptionLPer100KmSnapshot: detail.consumptionLPer100KmSnapshot,
          estimatedExpense: detail.estimatedExpense,
          notes: detail.notes,
        },
      });
      return detail;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // (driver_id, expense_date) unique index — authoritative under races.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw duplicateDailyExpense(input.driverId, input.expenseDate);
    }
    throw error;
  }
}

// ----------------------------------------------------------------------------
// PATCH /driver-expenses/daily-expenses/:id — correction.
//
// Driver and date are immutable. The record's ORIGINAL fuel settings stay
// authoritative: the price snapshot is kept, and a vehicle-type change takes
// the new type's consumption from that same historical version — never from
// today's settings. Compare-and-update on updated_at: a stale
// expectedUpdatedAt (a concurrent correction won) -> 409, nothing written.
// The timeline lock is not needed: the date and settings reference never
// change, so neither resolution nor the retroactive guard can be affected.
// ----------------------------------------------------------------------------
export async function updateDailyExpense(
  id: string,
  input: UpdateDailyExpenseInput,
  actorUserId: string
): Promise<DailyExpenseDetail> {
  const expected = new Date(input.expectedUpdatedAt);

  return prisma.$transaction(async (tx) => {
    const existing = await tx.driver_daily_expenses.findUnique({
      where: { id },
      select: {
        ...dailyExpenseSelect,
        driver_fuel_settings: {
          select: {
            effective_from: true,
            price_per_20_liters: true,
            motorcycle_consumption_l_per_100km: true,
            car_consumption_l_per_100km: true,
          },
        },
      },
    });
    if (!existing) {
      throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Daily expense not found" });
    }

    const stale = () =>
      conflict("STALE_DAILY_EXPENSE", "This daily expense was changed by another request — reload and try again", {
        currentUpdatedAt: existing.updated_at.toISOString(),
      });
    if (existing.updated_at.getTime() !== expected.getTime()) throw stale();

    const settings = existing.driver_fuel_settings;
    const rates = {
      motorcycleConsumptionLPer100Km: settings.motorcycle_consumption_l_per_100km,
      carConsumptionLPer100Km: settings.car_consumption_l_per_100km,
    };
    // The stored snapshots must still equal their referenced version; a
    // mismatch is a data-integrity failure, never silently "repaired".
    if (
      !settings.price_per_20_liters.equals(existing.price_per_20_liters_snapshot) ||
      !resolveConsumptionRate(rates, existing.vehicle_type).equals(existing.consumption_l_per_100km_snapshot)
    ) {
      console.error(`[daily-expense.service] snapshot/settings mismatch on daily expense ${id}`);
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Daily expense snapshot is inconsistent" });
    }

    const vehicleType = input.vehicleType ?? existing.vehicle_type;
    const distanceKm = input.distanceKm ?? existing.distance_km;
    const notes = input.notes !== undefined ? input.notes : existing.notes;

    const consumption = resolveConsumptionRate(rates, vehicleType);
    const estimated = calculateEstimatedExpense(distanceKm, existing.price_per_20_liters_snapshot, consumption);
    assertFitsColumn(estimated);

    const unchanged =
      vehicleType === existing.vehicle_type &&
      distanceKm.equals(existing.distance_km) &&
      notes === existing.notes;
    if (unchanged) return toDailyExpenseDetail(existing);

    // Strictly increasing updated_at so the guard can never be defeated by
    // two writes landing in the same millisecond.
    const now = new Date(Math.max(Date.now(), existing.updated_at.getTime() + 1));
    const claim = await tx.driver_daily_expenses.updateMany({
      where: { id, updated_at: existing.updated_at },
      data: {
        vehicle_type: vehicleType,
        distance_km: distanceKm,
        consumption_l_per_100km_snapshot: consumption,
        estimated_expense: estimated,
        notes,
        updated_at: now,
      },
    });
    if (claim.count !== 1) throw stale();

    const updated = await tx.driver_daily_expenses.findUniqueOrThrow({ where: { id }, select: dailyExpenseSelect });
    const before = toDailyExpenseDetail(existing);
    const after = toDailyExpenseDetail(updated);

    const fields = ["vehicleType", "distanceKm", "consumptionLPer100KmSnapshot", "estimatedExpense", "notes"] as const;
    const previousValues: Record<string, unknown> = {};
    const newValues: Record<string, unknown> = {};
    for (const f of fields) {
      if (before[f] !== after[f]) {
        previousValues[f] = before[f];
        newValues[f] = after[f];
      }
    }
    await createAuditLog(tx, {
      actorUserId,
      action: "DRIVER_DAILY_EXPENSE_CORRECTED",
      entityType: "DRIVER_DAILY_EXPENSE",
      entityId: id,
      previousValues: previousValues as Prisma.InputJsonValue,
      newValues: newValues as Prisma.InputJsonValue,
      metadata: {
        driverId: after.driverId,
        expenseDate: after.expenseDate,
        fuelSettingsId: after.fuelSettingsId,
        pricePer20LitersSnapshot: after.pricePer20LitersSnapshot,
      },
    });
    return after;
  });
}

// ----------------------------------------------------------------------------
// Reads
// ----------------------------------------------------------------------------

export async function getDailyExpense(id: string): Promise<DailyExpenseDetail> {
  const row = await prisma.driver_daily_expenses.findUnique({ where: { id }, select: dailyExpenseSelect });
  if (!row) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Daily expense not found" });
  return toDailyExpenseDetail(row);
}

// GET /daily-expenses/by-date/:date — every RECORDED entry for one date
// (bounded by the number of drivers; no rows are invented for drivers
// without an entry). Ordered by driver name for data entry.
export async function listDailyExpensesForDate(date: string): Promise<DailyExpenseDetail[]> {
  const rows = await prisma.driver_daily_expenses.findMany({
    where: { expense_date: parseCalendarDateOrThrow(date) },
    select: dailyExpenseSelect,
    orderBy: [{ drivers: { users: { first_name: "asc" } } }, { drivers: { users: { last_name: "asc" } } }, { id: "asc" }],
  });
  return rows.map(toDailyExpenseDetail);
}

function dateRangeWhere(range: { from?: string; to?: string; date?: string }): Prisma.DateTimeFilter | undefined {
  if (range.date) return { equals: parseCalendarDateOrThrow(range.date) };
  if (!range.from && !range.to) return undefined;
  return {
    ...(range.from ? { gte: parseCalendarDateOrThrow(range.from) } : {}),
    ...(range.to ? { lte: parseCalendarDateOrThrow(range.to) } : {}),
  };
}

export interface ListDailyExpensesResult {
  items: DailyExpenseDetail[];
  total: number;
}

async function paginate(
  where: Prisma.driver_daily_expensesWhereInput,
  page: number,
  limit: number
): Promise<ListDailyExpensesResult> {
  const [rows, total] = await Promise.all([
    prisma.driver_daily_expenses.findMany({
      where,
      select: dailyExpenseSelect,
      orderBy: [{ expense_date: "desc" }, { id: "asc" }],
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.driver_daily_expenses.count({ where }),
  ]);
  return { items: rows.map(toDailyExpenseDetail), total };
}

// GET /daily-expenses?driverId&date|from&to — newest date first. Served by
// the (driver_id, expense_date) unique index and the expense_date index.
export async function listDailyExpenses(query: ListDailyExpensesQuery): Promise<ListDailyExpensesResult> {
  const where: Prisma.driver_daily_expensesWhereInput = {};
  if (query.driverId) where.driver_id = query.driverId;
  const dates = dateRangeWhere(query);
  if (dates) where.expense_date = dates;
  return paginate(where, query.page, query.limit);
}

// GET /drivers/:driverId/daily-expenses — 404 for an unknown driver (an
// existing driver with no entries is an empty page).
export async function listDriverExpenseHistory(
  driverId: string,
  query: DriverExpenseHistoryQuery
): Promise<ListDailyExpensesResult> {
  await assertDriverExists(prisma, driverId);
  const where: Prisma.driver_daily_expensesWhereInput = { driver_id: driverId };
  const dates = dateRangeWhere(query);
  if (dates) where.expense_date = dates;
  return paginate(where, query.page, query.limit);
}
