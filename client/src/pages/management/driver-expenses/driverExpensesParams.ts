import { isAfterDate, isValidCalendarDate } from './dailyExpenseGrid';

/** Driver Expenses page URL state: ?tab=daily|drivers|fuel|reports & ?date=YYYY-MM-DD. */

export type DriverExpensesTabId = 'daily' | 'drivers' | 'fuel' | 'reports';

export const DRIVER_EXPENSES_TABS: ReadonlyArray<{ id: DriverExpensesTabId; label: string }> = [
  { id: 'daily', label: 'Daily Expenses' },
  { id: 'drivers', label: 'Drivers' },
  { id: 'fuel', label: 'Fuel Settings' },
  { id: 'reports', label: 'Reports' },
];

export function parseTab(raw: string | null): DriverExpensesTabId {
  return raw === 'drivers' || raw === 'fuel' || raw === 'reports' ? raw : 'daily';
}

/**
 * The selected expense date: a valid YYYY-MM-DD no later than today (UTC
 * business date). Anything else — missing, malformed, impossible or future —
 * falls back to today, so a hand-edited URL can never target a future day.
 */
export function resolveSelectedDate(raw: string | null, today: string): string {
  if (!raw || !isValidCalendarDate(raw) || isAfterDate(raw, today)) return today;
  return raw;
}

/** True when any driver on any date has an unsaved draft. */
export function hasAnyDrafts(drafts: Record<string, Record<string, unknown>>): boolean {
  return Object.values(drafts).some((byDriver) => Object.keys(byDriver).length > 0);
}
