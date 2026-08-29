// ============================================================
// Centralized UTC calendar-day boundary helpers (Phase 9.1/9.2).
//
// Project convention (no per-company timezone support in V1): all "today"/
// date-range semantics use UTC calendar days — [00:00:00.000Z, next
// 00:00:00.000Z). Never mix server-local/UTC/DB-local semantics across
// metrics. Both src/modules/dashboard/dashboard.service.ts ("today" cards)
// and src/modules/finance/finance-summary.service.ts + finance-transaction.
// service.ts (from/to query params) share this single source of truth.
// ============================================================

export interface UtcDayBoundary {
  start: Date;
  end: Date;
}

// "Today" in UTC, right now — used for Dashboard's ordersToday/deliveredToday/
// failedToday cards.
export function getUtcDayBoundary(now: Date = new Date()): UtcDayBoundary {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// Parses a strict YYYY-MM-DD calendar date into the UTC midnight Date it
// names. Rejects malformed strings AND impossible calendar dates (e.g.
// 2026-02-30) — Date.UTC silently rolls an impossible day over into the next
// month, so the parsed components are round-tripped back out and compared
// against the input rather than trusted blindly.
export function parseUtcCalendarDate(value: string): Date | null {
  const match = DATE_ONLY_PATTERN.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date;
}

// Exclusive end boundary for an inclusive calendar date — "to=2026-08-31"
// means everything strictly before 2026-09-01T00:00:00.000Z.
export function nextUtcDay(date: Date): Date {
  return new Date(date.getTime() + 24 * 60 * 60 * 1000);
}
