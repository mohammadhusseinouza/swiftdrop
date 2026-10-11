// Driver Expenses — fuel settings DTOs. All decimals are exact strings
// (never exponent notation, never rounded); dates are YYYY-MM-DD calendar
// dates (UTC business-day convention, shared/date/day-boundary.ts).

export interface FuelSettingsDerived {
  pricePerLiter: string;
  motorcycleCostPerKm: string;
  carCostPerKm: string;
}

export interface FuelSettingsDetail extends FuelSettingsDerived {
  id: string;
  effectiveFrom: string;
  pricePer20Liters: string;
  motorcycleConsumptionLPer100Km: string;
  carConsumptionLPer100Km: string;
  createdAt: string;
}

// GET /current and GET /effective — an explicit unconfigured state rather
// than invented default rates.
export interface FuelSettingsResolution {
  date: string;
  configured: boolean;
  settings: FuelSettingsDetail | null;
}
