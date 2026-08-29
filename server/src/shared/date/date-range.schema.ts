import { z } from "zod";
import { parseUtcCalendarDate } from "./day-boundary";

// ============================================================
// Shared YYYY-MM-DD date-range validation (Phase 9.2/9.3) — extracted so
// Phase 9.2's Finance Summary/Transactions and Phase 9.3's Reports validate
// `from`/`to` identically, never two slightly different implementations.
// ============================================================

// Strict YYYY-MM-DD, rejecting malformed strings AND impossible calendar
// dates (e.g. 2026-02-30) via the same UTC parser the services use to build
// the actual query range — a string that fails here could never be turned
// into a valid boundary anyway.
export const dateOnlySchema = z.string().refine((value) => parseUtcCalendarDate(value) !== null, {
  message: "Must be a valid YYYY-MM-DD calendar date",
});

export function fromNotAfterTo(data: { from?: string; to?: string }): boolean {
  if (!data.from || !data.to) return true;
  const from = parseUtcCalendarDate(data.from);
  const to = parseUtcCalendarDate(data.to);
  // Both already individually validated by dateOnlySchema above by the time
  // this cross-field refine runs — non-null here, but guard defensively
  // rather than assert, since a chained .refine cannot see sibling issues.
  if (!from || !to) return true;
  return from.getTime() <= to.getTime();
}
