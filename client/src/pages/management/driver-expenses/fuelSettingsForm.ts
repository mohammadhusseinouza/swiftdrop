import { z } from 'zod';
import { formatExactDecimal, multiplyExact, parseExactDecimal } from '../../../lib/exactDecimal';
import { isValidCalendarDate, significantDecimals } from './dailyExpenseGrid';

/**
 * Fuel settings "create version" form — validation + exact live preview.
 * Bounds mirror the backend (price NUMERIC(14,2), consumption NUMERIC(6,2),
 * all strictly > 0). The server re-validates and derives the saved values.
 */

const DECIMAL_TEXT = /^\d+(?:\.\d+)?$/;

/** Plain non-negative decimal with at most 2 significant decimals (backend rule). */
function isTwoDecimal(value: string): boolean {
  return DECIMAL_TEXT.test(value.trim()) && significantDecimals(value) <= 2;
}

function positiveTwoDecimal(label: string, maxIntegerDigits: number) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required.`)
    .refine(isTwoDecimal, `${label} must be a number with up to 2 decimals.`)
    .refine((v) => (parseExactDecimal(v)?.mantissa ?? 0n) > 0n, `${label} must be greater than zero.`)
    .refine((v) => v.split('.')[0].replace(/^0+(?=\d)/, '').length <= maxIntegerDigits, `${label} is too large.`);
}

export const fuelSettingsFormSchema = z.object({
  pricePer20Liters: positiveTwoDecimal('Price for 20 liters', 12),
  motorcycleConsumptionLPer100Km: positiveTwoDecimal('Motorcycle consumption', 4),
  carConsumptionLPer100Km: positiveTwoDecimal('Car consumption', 4),
  effectiveFrom: z.string().refine(isValidCalendarDate, 'Choose a valid effective date.'),
});

export type FuelSettingsFormValues = z.infer<typeof fuelSettingsFormSchema>;

export interface FuelSettingsPreview {
  pricePerLiter: string | null;
  motorcycleCostPerKm: string | null;
  carCostPerKm: string | null;
}

/** price / 20 and price / 20 * consumption / 100, exactly; null if not computable. */
export function previewFuelSettings(values: {
  pricePer20Liters: string;
  motorcycleConsumptionLPer100Km: string;
  carConsumptionLPer100Km: string;
}): FuelSettingsPreview {
  const price = isTwoDecimal(values.pricePer20Liters) ? parseExactDecimal(values.pricePer20Liters) : null;
  const perLiterFactor = parseExactDecimal('0.05');
  const perHundred = parseExactDecimal('0.01');
  if (!price || !perLiterFactor || !perHundred) {
    return { pricePerLiter: null, motorcycleCostPerKm: null, carCostPerKm: null };
  }
  const perLiter = multiplyExact(price, perLiterFactor);
  const cost = (consumption: string) => {
    const c = isTwoDecimal(consumption) ? parseExactDecimal(consumption) : null;
    return c ? formatExactDecimal(multiplyExact(perLiter, c, perHundred)) : null;
  };
  return {
    pricePerLiter: formatExactDecimal(perLiter),
    motorcycleCostPerKm: cost(values.motorcycleConsumptionLPer100Km),
    carCostPerKm: cost(values.carConsumptionLPer100Km),
  };
}
