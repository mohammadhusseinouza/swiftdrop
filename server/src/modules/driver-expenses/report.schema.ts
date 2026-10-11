import { z } from "zod";
import { dateOnlySchema, fromNotAfterTo } from "../../shared/date/date-range.schema";
import { parseUtcCalendarDate } from "../../shared/date/day-boundary";
import { VehicleTypeSchema } from "./daily-expense.schema";

// Driver Expenses reports — every endpoint takes an explicit inclusive
// calendar range (presets like Today / This Week / This Month are resolved
// by the client into from/to) plus optional driver and vehicle filters.
// vehicleType filters by the vehicle SAVED on each daily record.

/** The daily trend returns one row per date; bound the range it may span. */
export const MAX_TREND_RANGE_DAYS = 366;

const reportFilterShape = {
  from: dateOnlySchema,
  to: dateOnlySchema,
  driverId: z.string().uuid().optional(),
  vehicleType: VehicleTypeSchema.optional(),
};

export const ReportFilterQuerySchema = z
  .object(reportFilterShape)
  .refine(fromNotAfterTo, { message: "from must not be after to", path: ["from"] });
export type ReportFilterQuery = z.infer<typeof ReportFilterQuerySchema>;

export const DriverReportQuerySchema = z
  .object({
    ...reportFilterShape,
    sortBy: z.enum(["name", "distance", "expense"]).optional().default("expense"),
    sortOrder: z.enum(["asc", "desc"]).optional().default("desc"),
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  })
  .refine(fromNotAfterTo, { message: "from must not be after to", path: ["from"] });
export type DriverReportQuery = z.infer<typeof DriverReportQuerySchema>;

function rangeDays(from: string, to: string): number {
  const a = parseUtcCalendarDate(from);
  const b = parseUtcCalendarDate(to);
  if (!a || !b) return 0;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

export const DailyTrendQuerySchema = ReportFilterQuerySchema.refine(
  (v) => rangeDays(v.from, v.to) <= MAX_TREND_RANGE_DAYS,
  { message: `The daily trend supports at most ${MAX_TREND_RANGE_DAYS} days`, path: ["to"] }
);
