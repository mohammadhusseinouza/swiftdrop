-- IDEMPOTENT
-- ============================================================================
-- Driver Expenses — Phase 1: independent database module
--
-- Three new tables owned exclusively by the Driver Expenses module. The ONLY
-- external business-data reference is drivers.id (driver identity). Nothing
-- here references or is referenced by orders, delivery, driver cash,
-- settlements, wallets, payouts or company finance, and no existing table or
-- column is altered.
--
-- 1. driver_fuel_settings — append-only configuration history. The settings
--    applicable to an expense date are the row with the greatest
--    effective_from <= that date (one row per effective date). Changing the
--    fuel price / consumption is a NEW row; old rows are never rewritten.
--
-- 2. driver_expense_profiles — one per driver: the default vehicle type.
--    No copy of driver identity data.
--
-- 3. driver_daily_expenses — one per driver per calendar date. Snapshots the
--    fuel price and the used vehicle type's consumption so a later settings
--    change can never alter a recorded day. estimated_expense is stored
--    EXACTLY (scale 10 is the exact scale of the formula over these column
--    precisions) and a CHECK guarantees it equals:
--      distance_km * (price_per_20_liters / 20) * (consumption / 100)
--      = distance_km * price_per_20_liters * consumption * 0.0005
--
-- Additive only: no data is modified or removed. Safe to re-run.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'DriverExpenseVehicleType' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE public."DriverExpenseVehicleType" AS ENUM ('MOTORCYCLE', 'CAR');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.driver_fuel_settings (
  id                                 UUID           NOT NULL DEFAULT gen_random_uuid(),
  price_per_20_liters                NUMERIC(14,2)  NOT NULL,
  motorcycle_consumption_l_per_100km NUMERIC(6,2)   NOT NULL,
  car_consumption_l_per_100km        NUMERIC(6,2)   NOT NULL,
  effective_from                     DATE           NOT NULL,
  created_at                         TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT driver_fuel_settings_pkey PRIMARY KEY (id),
  CONSTRAINT driver_fuel_settings_price_positive CHECK (price_per_20_liters > 0),
  CONSTRAINT driver_fuel_settings_motorcycle_consumption_positive CHECK (motorcycle_consumption_l_per_100km > 0),
  CONSTRAINT driver_fuel_settings_car_consumption_positive CHECK (car_consumption_l_per_100km > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_fuel_settings_effective_from_key
  ON public.driver_fuel_settings (effective_from);

CREATE TABLE IF NOT EXISTS public.driver_expense_profiles (
  id                   UUID                              NOT NULL DEFAULT gen_random_uuid(),
  driver_id            UUID                              NOT NULL,
  default_vehicle_type public."DriverExpenseVehicleType" NOT NULL,
  created_at           TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT driver_expense_profiles_pkey PRIMARY KEY (id),
  CONSTRAINT driver_expense_profiles_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_expense_profiles_driver_id_key
  ON public.driver_expense_profiles (driver_id);

CREATE TABLE IF NOT EXISTS public.driver_daily_expenses (
  id                               UUID                              NOT NULL DEFAULT gen_random_uuid(),
  driver_id                        UUID                              NOT NULL,
  expense_date                     DATE                              NOT NULL,
  vehicle_type                     public."DriverExpenseVehicleType" NOT NULL,
  distance_km                      NUMERIC(8,2)                      NOT NULL,
  fuel_settings_id                 UUID                              NOT NULL,
  price_per_20_liters_snapshot     NUMERIC(14,2)                     NOT NULL,
  consumption_l_per_100km_snapshot NUMERIC(6,2)                      NOT NULL,
  estimated_expense                NUMERIC(24,10)                    NOT NULL,
  notes                            TEXT                              NULL,
  created_at                       TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                       TIMESTAMPTZ(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT driver_daily_expenses_pkey PRIMARY KEY (id),
  CONSTRAINT driver_daily_expenses_distance_non_negative CHECK (distance_km >= 0),
  CONSTRAINT driver_daily_expenses_price_snapshot_positive CHECK (price_per_20_liters_snapshot > 0),
  CONSTRAINT driver_daily_expenses_consumption_snapshot_positive CHECK (consumption_l_per_100km_snapshot > 0),
  CONSTRAINT driver_daily_expenses_estimated_expense_formula CHECK (
    estimated_expense = distance_km * price_per_20_liters_snapshot * consumption_l_per_100km_snapshot * 0.0005
  ),
  CONSTRAINT driver_daily_expenses_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT driver_daily_expenses_fuel_settings_id_fkey
    FOREIGN KEY (fuel_settings_id) REFERENCES public.driver_fuel_settings(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_daily_expenses_driver_id_expense_date_key
  ON public.driver_daily_expenses (driver_id, expense_date);
CREATE INDEX IF NOT EXISTS driver_daily_expenses_expense_date_idx
  ON public.driver_daily_expenses (expense_date);
CREATE INDEX IF NOT EXISTS driver_daily_expenses_fuel_settings_id_idx
  ON public.driver_daily_expenses (fuel_settings_id);

COMMIT;
