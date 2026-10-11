import type { ExpenseVehicleType } from '../../../services/domain.types';
import type { DriverExpenseReportParams } from '../../../services/driverExpensesApi';
import { isAfterDate, isValidCalendarDate, shiftDate } from './dailyExpenseGrid';

/**
 * Driver Expenses Reports — period presets and filters, PURE (UTC calendar
 * dates only; YYYY-MM-DD strings never pass through local time).
 *
 *   Today       today's UTC business date
 *   This Week   Monday..Sunday of today's UTC calendar week
 *   This Month  1st..last day of today's UTC month
 *   Custom      a validated inclusive from..to
 */

export type ReportPeriod = 'today' | 'week' | 'month' | 'custom';

export const REPORT_PERIODS: ReadonlyArray<{ id: ReportPeriod; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'This Week' },
  { id: 'month', label: 'This Month' },
  { id: 'custom', label: 'Custom' },
];

/** Must stay in sync with the backend's MAX_TREND_RANGE_DAYS. */
export const MAX_TREND_RANGE_DAYS = 366;

export interface ReportFiltersState {
  period: ReportPeriod;
  customFrom: string;
  customTo: string;
  driverId: string;
  vehicleType: '' | ExpenseVehicleType;
}

export function defaultReportFilters(today: string): ReportFiltersState {
  return { period: 'week', customFrom: today, customTo: today, driverId: '', vehicleType: '' };
}

function utcDay(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

export function weekRange(today: string): { from: string; to: string } {
  const dow = utcDay(today).getUTCDay(); // 0 = Sunday
  const from = shiftDate(today, -((dow + 6) % 7));
  return { from, to: shiftDate(from, 6) };
}

export function monthRange(today: string): { from: string; to: string } {
  const d = utcDay(today);
  const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export function rangeDays(from: string, to: string): number {
  return Math.round((utcDay(to).getTime() - utcDay(from).getTime()) / 86_400_000) + 1;
}

export type ResolvedReportRange =
  | { ok: true; from: string; to: string }
  | { ok: false; message: string };

export function resolveReportRange(filters: ReportFiltersState, today: string): ResolvedReportRange {
  switch (filters.period) {
    case 'today':
      return { ok: true, from: today, to: today };
    case 'week':
      return { ok: true, ...weekRange(today) };
    case 'month':
      return { ok: true, ...monthRange(today) };
    case 'custom': {
      const { customFrom: from, customTo: to } = filters;
      if (!isValidCalendarDate(from) || !isValidCalendarDate(to)) {
        return { ok: false, message: 'Choose a valid start and end date.' };
      }
      if (isAfterDate(from, to)) return { ok: false, message: 'The start date must not be after the end date.' };
      return { ok: true, from, to };
    }
  }
}

/** Query params for every report endpoint (all sections share one filter). */
export function toReportParams(
  range: { from: string; to: string },
  filters: Pick<ReportFiltersState, 'driverId' | 'vehicleType'>,
): DriverExpenseReportParams {
  return {
    from: range.from,
    to: range.to,
    ...(filters.driverId ? { driverId: filters.driverId } : {}),
    ...(filters.vehicleType ? { vehicleType: filters.vehicleType } : {}),
  };
}
