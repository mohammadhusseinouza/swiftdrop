import { Prisma } from "../../generated/prisma/client";
import type { driver_fuel_settings } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { getUtcDayBoundary } from "../../shared/date/day-boundary";
import { parseCalendarDateOrThrow, toCalendarDate } from "./driver-expense-dates";
import { calculateCostPerKm, calculatePricePerLiter, formatExactDecimal } from "./driver-expense-calculation";
import type { CreateFuelSettingsInput, ListFuelSettingsQuery } from "./fuel-settings.schema";
import type { FuelSettingsDetail, FuelSettingsResolution } from "./fuel-settings.types";

// ============================================================================
// Driver Expenses — fuel settings (Phase 2). Independent module: reads and
// writes ONLY driver_fuel_settings (+ reads driver_daily_expenses for the
// retroactive guard, + the shared audit log). No finance, driver cash,
// settlement, wallet, payout, order or delivery data is touched.
//
// Resolution rule: the settings applicable to a calendar date D are the row
// with the greatest effective_from <= D. effective_from is UNIQUE, so the
// result is deterministic and never depends on creation order/timestamps.
//
// Append-only: there is no update or delete path. A change is a new row.
// ============================================================================

type DbClient = Prisma.TransactionClient | typeof prisma;

function toFuelSettingsDetail(row: driver_fuel_settings): FuelSettingsDetail {
  return {
    id: row.id,
    effectiveFrom: toCalendarDate(row.effective_from),
    pricePer20Liters: formatExactDecimal(row.price_per_20_liters),
    motorcycleConsumptionLPer100Km: formatExactDecimal(row.motorcycle_consumption_l_per_100km),
    carConsumptionLPer100Km: formatExactDecimal(row.car_consumption_l_per_100km),
    pricePerLiter: formatExactDecimal(calculatePricePerLiter(row.price_per_20_liters)),
    motorcycleCostPerKm: formatExactDecimal(
      calculateCostPerKm(row.price_per_20_liters, row.motorcycle_consumption_l_per_100km)
    ),
    carCostPerKm: formatExactDecimal(calculateCostPerKm(row.price_per_20_liters, row.car_consumption_l_per_100km)),
    createdAt: row.created_at.toISOString(),
  };
}

// Serializes every write that can change how a date resolves to settings.
// Phase 3's daily-expense writes MUST take this same lock in their
// transaction so a settings insert and an expense insert can never interleave
// between the retroactive check and the write (transaction-scoped; released
// at COMMIT/ROLLBACK).
export async function lockFuelSettingsTimeline(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('swiftdrop.driver_expenses.fuel_settings_timeline', 0))`;
}

// SHARED mode of the same timeline lock, for daily-expense writers (Phase 3).
// Shared holders never block each other (two expense entries can proceed in
// parallel; the (driver_id, expense_date) unique index arbitrates them), but
// every shared holder excludes, and is excluded by, the EXCLUSIVE holder in
// createFuelSettings — so resolving settings + writing an expense can never
// interleave with the retroactive check + settings insert. Same key, same
// "lock first" ordering, a single lock per transaction: no deadlock cycle.
export async function lockFuelSettingsTimelineShared(tx: Prisma.TransactionClient): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended('swiftdrop.driver_expenses.fuel_settings_timeline', 0))`;
}

/** The settings row applicable to a calendar date, or null. Reusable by Phase 3. */
export async function findApplicableFuelSettings(client: DbClient, date: Date): Promise<driver_fuel_settings | null> {
  return client.driver_fuel_settings.findFirst({
    where: { effective_from: { lte: date } },
    orderBy: { effective_from: "desc" },
  });
}

async function resolveFor(date: Date): Promise<FuelSettingsResolution> {
  const row = await findApplicableFuelSettings(prisma, date);
  return {
    date: toCalendarDate(date),
    configured: row !== null,
    settings: row ? toFuelSettingsDetail(row) : null,
  };
}

// GET /current — "today" is the UTC business day (project convention, same
// boundary as the Dashboard/Finance "today" figures).
export async function getCurrentFuelSettings(now: Date = new Date()): Promise<FuelSettingsResolution> {
  return resolveFor(getUtcDayBoundary(now).start);
}

// GET /effective?date=YYYY-MM-DD
export async function getFuelSettingsForDate(date: string): Promise<FuelSettingsResolution> {
  return resolveFor(parseCalendarDateOrThrow(date));
}

export interface ListFuelSettingsResult {
  items: FuelSettingsDetail[];
  total: number;
}

// GET / — full history, newest effective date first (future rows included).
export async function listFuelSettings(query: ListFuelSettingsQuery): Promise<ListFuelSettingsResult> {
  const [rows, total] = await Promise.all([
    prisma.driver_fuel_settings.findMany({
      orderBy: { effective_from: "desc" },
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.driver_fuel_settings.count(),
  ]);
  return { items: rows.map(toFuelSettingsDetail), total };
}

function duplicateEffectiveDate(effectiveFrom: string): AppError {
  return new AppError({
    statusCode: 409,
    code: "CONFLICT",
    message: `Fuel settings already exist for ${effectiveFrom}`,
    details: { reason: "DUPLICATE_EFFECTIVE_DATE", effectiveFrom },
  });
}

// POST / — creates a new effective-dated version. Never edits or recomputes
// anything that already exists.
//
// Retroactive guard: a new version effective from E becomes the resolution
// for every date >= E up to the next version. If any recorded daily expense
// on/after E was computed with an OLDER version (effective_from < E), the
// insert would contradict that recorded day's interpretation -> 409. Past
// effective dates with no affected expenses (backfilling history) and any
// future date are allowed.
export async function createFuelSettings(input: CreateFuelSettingsInput, actorUserId: string): Promise<FuelSettingsDetail> {
  const effectiveFrom = parseCalendarDateOrThrow(input.effectiveFrom);

  try {
    return await prisma.$transaction(async (tx) => {
      await lockFuelSettingsTimeline(tx);

      const existing = await tx.driver_fuel_settings.findUnique({
        where: { effective_from: effectiveFrom },
        select: { id: true },
      });
      if (existing) throw duplicateEffectiveDate(input.effectiveFrom);

      const affected = await tx.driver_daily_expenses.findFirst({
        where: {
          expense_date: { gte: effectiveFrom },
          driver_fuel_settings: { effective_from: { lt: effectiveFrom } },
        },
        orderBy: { expense_date: "asc" },
        select: { expense_date: true },
      });
      if (affected) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message:
            "Fuel settings cannot take effect from this date because daily expenses on or after it were already recorded with earlier settings",
          details: {
            reason: "RETROACTIVE_CONFLICT",
            effectiveFrom: input.effectiveFrom,
            earliestAffectedExpenseDate: toCalendarDate(affected.expense_date),
          },
        });
      }

      const row = await tx.driver_fuel_settings.create({
        data: {
          price_per_20_liters: input.pricePer20Liters,
          motorcycle_consumption_l_per_100km: input.motorcycleConsumptionLPer100Km,
          car_consumption_l_per_100km: input.carConsumptionLPer100Km,
          effective_from: effectiveFrom,
        },
      });

      const detail = toFuelSettingsDetail(row);
      await createAuditLog(tx, {
        actorUserId,
        action: "DRIVER_FUEL_SETTINGS_CREATED",
        entityType: "DRIVER_FUEL_SETTINGS",
        entityId: row.id,
        newValues: {
          effectiveFrom: detail.effectiveFrom,
          pricePer20Liters: detail.pricePer20Liters,
          motorcycleConsumptionLPer100Km: detail.motorcycleConsumptionLPer100Km,
          carConsumptionLPer100Km: detail.carConsumptionLPer100Km,
        },
      });
      return detail;
    });
  } catch (error) {
    if (error instanceof AppError) throw error;
    // Unique-index backstop (e.g. a writer that did not take the lock).
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw duplicateEffectiveDate(input.effectiveFrom);
    }
    throw error;
  }
}
