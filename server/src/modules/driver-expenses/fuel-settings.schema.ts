import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";
import { dateOnlySchema } from "../../shared/date/date-range.schema";

const { Decimal } = Prisma;

// Bounds mirror the driver_fuel_settings columns exactly:
//   price_per_20_liters                NUMERIC(14,2)
//   motorcycle / car consumption       NUMERIC(6,2)
export const FUEL_DECIMAL_PLACES = 2;
export const FUEL_PRICE_MAX = new Decimal("999999999999.99");
export const FUEL_CONSUMPTION_MAX = new Decimal("9999.99");

// Decimal at a column's scale/range — strictly positive by default, or
// non-negative with allowZero. Parsed by decimal.js from the raw JSON value
// (string or number, same convention as order money), never through JS
// float arithmetic. Shared by the Driver Expenses schemas.
export function decimalInput(label: string, max: Prisma.Decimal, options: { allowZero?: boolean } = {}) {
  return z.union([z.string(), z.number()]).transform((raw, ctx): Prisma.Decimal => {
    let value: Prisma.Decimal;
    try {
      value = new Decimal(typeof raw === "string" ? raw.trim() : raw);
    } catch {
      ctx.addIssue({ code: "custom", message: `${label} must be a valid number` });
      return z.NEVER;
    }
    if (!value.isFinite()) {
      ctx.addIssue({ code: "custom", message: `${label} must be a valid number` });
      return z.NEVER;
    }
    if (options.allowZero ? value.isNegative() : !value.greaterThan(0)) {
      ctx.addIssue({
        code: "custom",
        message: options.allowZero ? `${label} must not be negative` : `${label} must be greater than zero`,
      });
      return z.NEVER;
    }
    if (value.decimalPlaces() > FUEL_DECIMAL_PLACES) {
      ctx.addIssue({ code: "custom", message: `${label} supports at most ${FUEL_DECIMAL_PLACES} decimal places` });
      return z.NEVER;
    }
    if (value.greaterThan(max)) {
      ctx.addIssue({ code: "custom", message: `${label} exceeds the supported range` });
      return z.NEVER;
    }
    return value;
  });
}

// Derived values (price per liter, cost per km) are never accepted as input.
export const CreateFuelSettingsSchema = z.object({
  pricePer20Liters: decimalInput("Price per 20 liters", FUEL_PRICE_MAX),
  motorcycleConsumptionLPer100Km: decimalInput("Motorcycle consumption", FUEL_CONSUMPTION_MAX),
  carConsumptionLPer100Km: decimalInput("Car consumption", FUEL_CONSUMPTION_MAX),
  effectiveFrom: dateOnlySchema,
});

export type CreateFuelSettingsInput = z.infer<typeof CreateFuelSettingsSchema>;

export const ListFuelSettingsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type ListFuelSettingsQuery = z.infer<typeof ListFuelSettingsQuerySchema>;

export const EffectiveFuelSettingsQuerySchema = z.object({
  date: dateOnlySchema,
});

export type EffectiveFuelSettingsQuery = z.infer<typeof EffectiveFuelSettingsQuerySchema>;
