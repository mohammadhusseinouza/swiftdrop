// Driver Expenses — driver profile + daily expense DTOs. Decimals are exact
// strings (never exponent notation, never rounded); dates are YYYY-MM-DD.
// Driver identity is read live from drivers -> users (never copied).

export type ExpenseVehicleType = "MOTORCYCLE" | "CAR";

// Deliberately minimal: no email/phone, no account, cash or order data.
export interface ExpenseDriverSummary {
  driverId: string;
  displayName: string;
  isActive: boolean;
  profileConfigured: boolean;
  defaultVehicleType: ExpenseVehicleType | null;
}

export interface ExpenseProfileDetail {
  driverId: string;
  defaultVehicleType: ExpenseVehicleType;
  createdAt: string;
  updatedAt: string;
}

export interface DailyExpenseDetail {
  id: string;
  driverId: string;
  driverName: string;
  expenseDate: string;
  vehicleType: ExpenseVehicleType;
  distanceKm: string;
  fuelSettingsId: string;
  fuelSettingsEffectiveFrom: string;
  pricePer20LitersSnapshot: string;
  consumptionLPer100KmSnapshot: string;
  /** Derived from the snapshots (not stored). */
  pricePerLiter: string;
  /** Derived from the snapshots (not stored). */
  costPerKm: string;
  /** Exact stored value (NUMERIC(24,10)); display rounding is the client's job. */
  estimatedExpense: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}
