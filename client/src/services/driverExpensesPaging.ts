import type { ExpenseDriverSummary } from './domain.types';

/** Backend page-size maximum; the all-drivers query pages at this size. */
export const ALL_DRIVERS_PAGE_SIZE = 100;
/** Safety bound (10,000 drivers) so a broken meta can never loop forever. */
export const ALL_DRIVERS_MAX_PAGES = 100;

export type DriverPageResult =
  | { items: ExpenseDriverSummary[]; totalPages: number }
  | { error: unknown };

/**
 * Pure paging loop behind getAllExpenseDrivers: requests pages 1..N until the
 * last page (short page or page >= totalPages), de-duplicating by driver id
 * in case the set shifts mid-scan. Any page error fails the whole load — a
 * partial driver list would silently omit drivers from the daily grid.
 */
export async function loadAllExpenseDrivers(
  fetchPage: (page: number) => Promise<DriverPageResult>,
  pageSize = ALL_DRIVERS_PAGE_SIZE,
  maxPages = ALL_DRIVERS_MAX_PAGES,
): Promise<{ data: ExpenseDriverSummary[] } | { error: unknown }> {
  const byId = new Map<string, ExpenseDriverSummary>();
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page);
    if ('error' in result) return { error: result.error };
    for (const d of result.items) byId.set(d.driverId, d);
    if (result.items.length < pageSize || page >= result.totalPages) return { data: [...byId.values()] };
  }
  return { error: { status: 'CUSTOM_ERROR', error: 'Too many drivers to load for daily entry.' } };
}
