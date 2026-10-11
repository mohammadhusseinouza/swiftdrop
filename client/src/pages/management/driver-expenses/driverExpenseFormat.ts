import { formatMoney } from '../../../lib/format';
import { parseExactDecimal, roundExactToFixed } from '../../../lib/exactDecimal';
import type { ExpenseVehicleType } from '../../../services/domain.types';

/**
 * Display formatting for Driver Expenses. Values from the server are EXACT
 * decimal strings; these round HALF-UP for display only (formatMoney alone
 * truncates extra decimals) and never feed anything back into a calculation.
 */

/** Money rounded to 2 decimals: "1.6147875" -> "$1.61". */
export function displayMoney(exact: string | null | undefined, fallback = '—'): string {
  const parsed = exact ? parseExactDecimal(exact) : null;
  return parsed ? formatMoney(roundExactToFixed(parsed, 2)) : fallback;
}

/** Per-unit rate (price per liter, cost per km) — 4 decimals keeps it meaningful. */
export function displayRate(exact: string | null | undefined, fallback = '—'): string {
  const parsed = exact ? parseExactDecimal(exact) : null;
  return parsed ? `$${roundExactToFixed(parsed, 4)}` : fallback;
}

/** Distance with thousands grouping, exact decimals kept: "1234.5" -> "1,234.5 km". */
export function displayKm(exact: string | null | undefined, fallback = '—'): string {
  if (!exact || !parseExactDecimal(exact)) return fallback;
  const [int, frac] = exact.split('.');
  return `${int.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''} km`;
}

/** Plain consumption figure: "3.4" -> "3.4 L/100 km". */
export function displayConsumption(exact: string | null | undefined): string {
  return exact ? `${exact} L/100 km` : '—';
}

export const VEHICLE_LABEL: Record<ExpenseVehicleType, string> = {
  MOTORCYCLE: 'Motorcycle',
  CAR: 'Car',
};

export const VEHICLE_OPTIONS: ReadonlyArray<{ value: ExpenseVehicleType; label: string }> = [
  { value: 'MOTORCYCLE', label: 'Motorcycle' },
  { value: 'CAR', label: 'Car' },
];

/** "2026-10-11" -> "Oct 11, 2026" without any timezone shift. */
export function displayCalendarDate(date: string): string {
  const d = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString(undefined, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
}
