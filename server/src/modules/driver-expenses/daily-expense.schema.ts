import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { dateOnlySchema, fromNotAfterTo } from "../../shared/date/date-range.schema";
import { decimalInput } from "./fuel-settings.schema";

// driver_daily_expenses.distance_km is NUMERIC(8,2): >= 0, 2 decimals.
export const DISTANCE_MAX = new Prisma.Decimal("999999.99");
export const NOTES_MAX_LENGTH = 1000;

export const VehicleTypeSchema = z.enum(["MOTORCYCLE", "CAR"]);

const distanceKm = decimalInput("Distance", DISTANCE_MAX, { allowZero: true });

// Trimmed; an empty string clears the notes (stored as NULL).
const notes = z
  .string()
  .trim()
  .max(NOTES_MAX_LENGTH, `Notes must be at most ${NOTES_MAX_LENGTH} characters`)
  .transform((value) => (value === "" ? null : value))
  .nullable();

const uuidParam = z.string().uuid();

export const DriverIdParamSchema = z.object({ driverId: uuidParam });
export const DailyExpenseIdParamSchema = z.object({ id: uuidParam });
export const ExpenseDateParamSchema = z.object({ date: dateOnlySchema });

const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

export const ListExpenseDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  isActive: booleanQueryParam.optional(),
});
export type ListExpenseDriversQuery = z.infer<typeof ListExpenseDriversQuerySchema>;

export const UpsertExpenseProfileSchema = z.object({
  defaultVehicleType: VehicleTypeSchema,
});
export type UpsertExpenseProfileInput = z.infer<typeof UpsertExpenseProfileSchema>;

// The calculated expense, snapshots and settings reference are server-derived
// and never accepted (unknown keys are stripped).
export const CreateDailyExpenseSchema = z.object({
  driverId: uuidParam,
  expenseDate: dateOnlySchema,
  distanceKm,
  vehicleType: VehicleTypeSchema.optional(),
  notes: notes.optional(),
});
export type CreateDailyExpenseInput = z.infer<typeof CreateDailyExpenseSchema>;

// Correction: driver and date are immutable in V1. `expectedUpdatedAt` is
// the record's `updatedAt` as last read — a compare-and-update guard so a
// concurrent correction can never be silently overwritten.
export const UpdateDailyExpenseSchema = z
  .object({
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    distanceKm: distanceKm.optional(),
    vehicleType: VehicleTypeSchema.optional(),
    notes: notes.optional(),
  })
  .refine((v) => v.distanceKm !== undefined || v.vehicleType !== undefined || v.notes !== undefined, {
    message: "Provide at least one of distanceKm, vehicleType or notes",
  });
export type UpdateDailyExpenseInput = z.infer<typeof UpdateDailyExpenseSchema>;

const dateRangeShape = {
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
};

export const ListDailyExpensesQuerySchema = z
  .object({ ...dateRangeShape, driverId: uuidParam.optional(), date: dateOnlySchema.optional() })
  .refine(fromNotAfterTo, { message: "from must not be after to", path: ["from"] })
  .refine((v) => v.date === undefined || (v.from === undefined && v.to === undefined), {
    message: "Use either date or from/to, not both",
    path: ["date"],
  });
export type ListDailyExpensesQuery = z.infer<typeof ListDailyExpensesQuerySchema>;

export const DriverExpenseHistoryQuerySchema = z
  .object(dateRangeShape)
  .refine(fromNotAfterTo, { message: "from must not be after to", path: ["from"] });
export type DriverExpenseHistoryQuery = z.infer<typeof DriverExpenseHistoryQuerySchema>;
