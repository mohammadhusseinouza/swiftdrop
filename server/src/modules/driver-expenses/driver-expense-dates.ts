import { AppError } from "../../shared/errors/app-error";
import { parseUtcCalendarDate } from "../../shared/date/day-boundary";

// Date-only helpers shared by the Driver Expenses services. DATE columns are
// read/written as UTC midnight (shared/date/day-boundary.ts convention), so a
// calendar date round-trips without timezone off-by-one errors.

/** YYYY-MM-DD of a DATE column value (Prisma returns it as UTC midnight). */
export function toCalendarDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

/** Parses an already-validated YYYY-MM-DD string; 400 if it is not one. */
export function parseCalendarDateOrThrow(date: string): Date {
  const parsed = parseUtcCalendarDate(date);
  if (!parsed) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "Must be a valid YYYY-MM-DD calendar date" });
  }
  return parsed;
}
