import { Prisma } from "../../generated/prisma/client";
import type { DriverExpenseVehicleType } from "../../generated/prisma/enums";

// ============================================================================
// Driver Expenses — pure calculation engine (Phase 2; reused by Phase 3).
//
//   price per liter   = price per 20 liters / 20
//   cost per km       = price per liter * consumption (L/100 km) / 100
//   estimated expense = distance (km) * cost per km
//
// EXACT arithmetic. Prisma's default Decimal is configured with 20
// significant digits and silently ROUNDS any product wider than that, so all
// arithmetic here runs on a dedicated 64-digit clone (wide enough for every
// value the driver_* columns can hold) and the result is handed back as an
// ordinary Prisma.Decimal. Division by 20 and by 100 is expressed as exact
// multiplication by 0.05 and 0.01. Nothing is rounded: display rounding is a
// frontend concern, and the stored estimated_expense (NUMERIC(24,10)) is the
// exact value the DB CHECK constraint recomputes.
//
// No JS Number arithmetic, no I/O, no Prisma client — safe to call anywhere.
// ============================================================================

const ExactDecimal = Prisma.Decimal.clone({ precision: 64 });

type DecimalInput = Prisma.Decimal | string;

function exact(value: DecimalInput): InstanceType<typeof ExactDecimal> {
  return new ExactDecimal(value.toString());
}

function toPrismaDecimal(value: InstanceType<typeof ExactDecimal>): Prisma.Decimal {
  // toFixed() with no argument = full exact digits, never exponent notation.
  return new Prisma.Decimal(value.toFixed());
}

export function calculatePricePerLiter(pricePer20Liters: DecimalInput): Prisma.Decimal {
  return toPrismaDecimal(exact(pricePer20Liters).times("0.05"));
}

export function calculateCostPerKm(pricePer20Liters: DecimalInput, consumptionLPer100Km: DecimalInput): Prisma.Decimal {
  return toPrismaDecimal(exact(pricePer20Liters).times("0.05").times(exact(consumptionLPer100Km)).times("0.01"));
}

export function calculateEstimatedExpense(
  distanceKm: DecimalInput,
  pricePer20Liters: DecimalInput,
  consumptionLPer100Km: DecimalInput
): Prisma.Decimal {
  return toPrismaDecimal(
    exact(distanceKm)
      .times(exact(pricePer20Liters))
      .times("0.05")
      .times(exact(consumptionLPer100Km))
      .times("0.01")
  );
}

// Average estimated cost per km over a set of records = total expense /
// total distance (a weighted average, never a mean of per-day rates). The
// ONLY non-exact operation in the engine: a quotient may not terminate, so it
// is rounded HALF-UP to 10 decimals — the scale of the stored expense — and
// computed in the 64-digit context first. Null when no distance was driven.
export const AVERAGE_COST_PER_KM_SCALE = 10;

export function calculateAverageCostPerKm(
  totalEstimatedExpense: DecimalInput,
  totalDistanceKm: DecimalInput
): Prisma.Decimal | null {
  const distance = exact(totalDistanceKm);
  if (distance.isZero()) return null;
  return toPrismaDecimal(
    exact(totalEstimatedExpense)
      .dividedBy(distance)
      .toDecimalPlaces(AVERAGE_COST_PER_KM_SCALE, ExactDecimal.ROUND_HALF_UP)
  );
}

// driver_daily_expenses.estimated_expense is NUMERIC(24,10): at most 14
// integer digits. Extreme (but individually valid) distance x price x
// consumption combinations can exceed it; callers must reject those rather
// than let the database overflow.
export const ESTIMATED_EXPENSE_MAX = new Prisma.Decimal("99999999999999.9999999999");

export function fitsEstimatedExpenseColumn(value: Prisma.Decimal): boolean {
  return value.abs().lessThanOrEqualTo(ESTIMATED_EXPENSE_MAX);
}

export interface FuelConsumptionRates {
  motorcycleConsumptionLPer100Km: DecimalInput;
  carConsumptionLPer100Km: DecimalInput;
}

export function resolveConsumptionRate(
  rates: FuelConsumptionRates,
  vehicleType: DriverExpenseVehicleType
): Prisma.Decimal {
  switch (vehicleType) {
    case "MOTORCYCLE":
      return new Prisma.Decimal(rates.motorcycleConsumptionLPer100Km.toString());
    case "CAR":
      return new Prisma.Decimal(rates.carConsumptionLPer100Km.toString());
    default: {
      const unreachable: never = vehicleType;
      throw new Error(`Unsupported vehicle type: ${String(unreachable)}`);
    }
  }
}

/** Exact decimal text for API responses (never exponent notation). */
export function formatExactDecimal(value: Prisma.Decimal): string {
  return value.toFixed();
}
