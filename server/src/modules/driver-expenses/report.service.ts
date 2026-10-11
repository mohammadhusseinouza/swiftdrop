import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { calculateAverageCostPerKm, formatExactDecimal } from "./driver-expense-calculation";
import { driverDisplayName } from "./driver-expense-profile.service";
import type { ExpenseVehicleType } from "./daily-expense.types";
import type { DriverReportQuery, ReportFilterQuery } from "./report.schema";
import type {
  DailyTrendRow,
  DriverReportRow,
  ReportFilters,
  ReportSummary,
  ReportTotals,
  VehicleReportRow,
} from "./report.types";

// ============================================================================
// Driver Expenses — reports (Phase 5). Read-only aggregates over
// driver_daily_expenses ONLY (+ drivers/users for display names and
// driver_expense_profiles for the current default as context). Never touches
// finance, driver cash, settlements, wallets, payouts, orders or deliveries.
//
// Every figure is aggregated in PostgreSQL from the STORED per-day values
// (SUM over NUMERIC is exact; results travel as ::text so no float ever
// appears) — nothing is recalculated with current fuel settings. Vehicle
// filtering/grouping uses the vehicle_type saved on each record, never the
// driver's current default. Dates are DATE literals (::date): no timezone
// conversion can shift a calendar day.
//
// Served by the Phase 1 indexes: (driver_id, expense_date) UNIQUE for
// driver + range, expense_date for range-only scans.
// ============================================================================

function filterSql(f: ReportFilterQuery): Prisma.Sql {
  const clauses: Prisma.Sql[] = [
    Prisma.sql`e.expense_date >= ${f.from}::date`,
    Prisma.sql`e.expense_date <= ${f.to}::date`,
  ];
  if (f.driverId) clauses.push(Prisma.sql`e.driver_id = ${f.driverId}::uuid`);
  if (f.vehicleType) clauses.push(Prisma.sql`e.vehicle_type = ${f.vehicleType}::"DriverExpenseVehicleType"`);
  return Prisma.join(clauses, " AND ");
}

function exactText(value: string | null | undefined): string {
  return formatExactDecimal(new Prisma.Decimal(value ?? "0"));
}

function toTotals(entries: number, distance: string, expense: string): ReportTotals {
  const totalDistanceKm = exactText(distance);
  const totalEstimatedExpense = exactText(expense);
  const average = calculateAverageCostPerKm(totalEstimatedExpense, totalDistanceKm);
  return {
    entries,
    totalDistanceKm,
    totalEstimatedExpense,
    averageCostPerKm: average ? formatExactDecimal(average) : null,
  };
}

function echoFilters(f: ReportFilterQuery): ReportFilters {
  return { from: f.from, to: f.to, driverId: f.driverId ?? null, vehicleType: f.vehicleType ?? null };
}

interface TotalsRow {
  entries: number;
  drivers: number;
  distance: string;
  expense: string;
}

// GET /driver-expenses/reports/summary
export async function getReportSummary(f: ReportFilterQuery): Promise<ReportSummary> {
  const [row] = await prisma.$queryRaw<TotalsRow[]>`
    SELECT COUNT(*)::int AS entries,
           COUNT(DISTINCT e.driver_id)::int AS drivers,
           COALESCE(SUM(e.distance_km), 0)::text AS distance,
           COALESCE(SUM(e.estimated_expense), 0)::text AS expense
    FROM driver_daily_expenses e
    WHERE ${filterSql(f)}
  `;
  return {
    filters: echoFilters(f),
    driversWithRecords: row?.drivers ?? 0,
    ...toTotals(row?.entries ?? 0, row?.distance ?? "0", row?.expense ?? "0"),
  };
}

interface DriverAggregateRow {
  driver_id: string;
  first_name: string;
  last_name: string;
  is_active: boolean;
  default_vehicle_type: ExpenseVehicleType | null;
  entries: number;
  distance: string;
  expense: string;
}

// Whitelisted ORDER BY fragments (never interpolated from user input). Every
// ordering ends with driver_id so pagination is deterministic.
const SORT_SQL: Record<DriverReportQuery["sortBy"], Record<"asc" | "desc", Prisma.Sql>> = {
  name: {
    asc: Prisma.sql`lower(u.first_name) ASC, lower(u.last_name) ASC, e.driver_id ASC`,
    desc: Prisma.sql`lower(u.first_name) DESC, lower(u.last_name) DESC, e.driver_id ASC`,
  },
  distance: {
    asc: Prisma.sql`SUM(e.distance_km) ASC, e.driver_id ASC`,
    desc: Prisma.sql`SUM(e.distance_km) DESC, e.driver_id ASC`,
  },
  expense: {
    asc: Prisma.sql`SUM(e.estimated_expense) ASC, e.driver_id ASC`,
    desc: Prisma.sql`SUM(e.estimated_expense) DESC, e.driver_id ASC`,
  },
};

export interface DriverReportResult {
  items: DriverReportRow[];
  total: number;
}

// GET /driver-expenses/reports/by-driver — grouped by stable driver id
// (identical names stay separate rows), sorted + paginated in the database
// over the complete filtered set. Only drivers with matching records appear
// (inactive drivers included). One query for the page, one for the count.
export async function getDriverReport(q: DriverReportQuery): Promise<DriverReportResult> {
  const where = filterSql(q);
  const [rows, countRows] = await Promise.all([
    prisma.$queryRaw<DriverAggregateRow[]>`
      SELECT e.driver_id,
             u.first_name,
             u.last_name,
             d.is_active,
             p.default_vehicle_type,
             COUNT(*)::int AS entries,
             SUM(e.distance_km)::text AS distance,
             SUM(e.estimated_expense)::text AS expense
      FROM driver_daily_expenses e
      JOIN drivers d ON d.id = e.driver_id
      JOIN users u ON u.id = d.user_id
      LEFT JOIN driver_expense_profiles p ON p.driver_id = e.driver_id
      WHERE ${where}
      GROUP BY e.driver_id, u.first_name, u.last_name, d.is_active, p.default_vehicle_type
      ORDER BY ${SORT_SQL[q.sortBy][q.sortOrder]}
      LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}
    `,
    prisma.$queryRaw<Array<{ total: number }>>`
      SELECT COUNT(DISTINCT e.driver_id)::int AS total FROM driver_daily_expenses e WHERE ${where}
    `,
  ]);
  return {
    items: rows.map((r) => ({
      driverId: r.driver_id,
      displayName: driverDisplayName(r),
      isActive: r.is_active,
      currentDefaultVehicleType: r.default_vehicle_type,
      ...toTotals(r.entries, r.distance, r.expense),
    })),
    total: countRows[0]?.total ?? 0,
  };
}

const VEHICLE_TYPES: readonly ExpenseVehicleType[] = ["MOTORCYCLE", "CAR"];

// GET /driver-expenses/reports/by-vehicle — one row per vehicle type in
// scope (both, or only the filtered one), zeros when it has no entries.
export async function getVehicleReport(f: ReportFilterQuery): Promise<VehicleReportRow[]> {
  const rows = await prisma.$queryRaw<Array<{ vehicle_type: ExpenseVehicleType; entries: number; distance: string; expense: string }>>`
    SELECT e.vehicle_type,
           COUNT(*)::int AS entries,
           SUM(e.distance_km)::text AS distance,
           SUM(e.estimated_expense)::text AS expense
    FROM driver_daily_expenses e
    WHERE ${filterSql(f)}
    GROUP BY e.vehicle_type
  `;
  const byType = new Map(rows.map((r) => [r.vehicle_type, r]));
  const types = f.vehicleType ? [f.vehicleType] : VEHICLE_TYPES;
  return types.map((vehicleType) => {
    const r = byType.get(vehicleType);
    return { vehicleType, ...toTotals(r?.entries ?? 0, r?.distance ?? "0", r?.expense ?? "0") };
  });
}

// GET /driver-expenses/reports/daily-trend — chronological, ONLY dates that
// have at least one saved record (a saved 0 km day appears; a day with no
// record never does). Range bounded by the schema (MAX_TREND_RANGE_DAYS).
export async function getDailyTrend(f: ReportFilterQuery): Promise<DailyTrendRow[]> {
  const rows = await prisma.$queryRaw<Array<{ date: string; entries: number; distance: string; expense: string }>>`
    SELECT e.expense_date::text AS date,
           COUNT(*)::int AS entries,
           SUM(e.distance_km)::text AS distance,
           SUM(e.estimated_expense)::text AS expense
    FROM driver_daily_expenses e
    WHERE ${filterSql(f)}
    GROUP BY e.expense_date
    ORDER BY e.expense_date ASC
  `;
  return rows.map((r) => ({
    date: r.date,
    entries: r.entries,
    totalDistanceKm: exactText(r.distance),
    totalEstimatedExpense: exactText(r.expense),
  }));
}
