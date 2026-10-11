// Driver Expenses report DTOs. Totals are EXACT decimal strings summed from
// the stored daily records (never recalculated with current fuel prices).
// averageCostPerKm = totalEstimatedExpense / totalDistanceKm, rounded half-up
// to 10 decimals; null when no distance was recorded. All amounts are
// ESTIMATED fuel expenses — not payments or reimbursements.

import type { ExpenseVehicleType } from "./daily-expense.types";

export interface ReportFilters {
  from: string;
  to: string;
  driverId: string | null;
  vehicleType: ExpenseVehicleType | null;
}

export interface ReportTotals {
  entries: number;
  totalDistanceKm: string;
  totalEstimatedExpense: string;
  averageCostPerKm: string | null;
}

export interface ReportSummary extends ReportTotals {
  filters: ReportFilters;
  driversWithRecords: number;
}

export interface DriverReportRow extends ReportTotals {
  driverId: string;
  displayName: string;
  isActive: boolean;
  /** Context only — historical entries are classified by their saved vehicle. */
  currentDefaultVehicleType: ExpenseVehicleType | null;
}

export interface VehicleReportRow extends ReportTotals {
  vehicleType: ExpenseVehicleType;
}

export interface DailyTrendRow {
  date: string;
  entries: number;
  totalDistanceKm: string;
  totalEstimatedExpense: string;
}
