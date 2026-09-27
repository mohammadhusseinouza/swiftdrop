-- IDEMPOTENT
-- ============================================================================
-- Customer / Driver sequential business-number generation
--
-- customers.customer_number and drivers.driver_number were previously
-- REQUIRED, client-supplied, arbitrary strings (see the "employee_number
-- precedent" comments in customer.schema.ts / driver.schema.ts before this
-- change). Generation now moves entirely to the database, using two native
-- PostgreSQL sequences so concurrent creates can never collide (nextval() is
-- atomic) and the numbers are guaranteed strictly sequential:
--
--   customer_number_seq -> CUST-000001, CUST-000002, ...
--   driver_number_seq   -> DRV-000001,  DRV-000002,  ...
--
-- The column DEFAULT is set to compute the formatted value directly from the
-- sequence (mirrors the existing `id UUID @default(dbgenerated("gen_random_
-- uuid()"))` convention already used throughout this schema), so the
-- application only has to omit the column on INSERT — Postgres fills it in.
-- An explicit value may still be supplied (e.g. by seed/dev scripts) since
-- this is an ordinary column default, not a generated-always column.
--
-- Existing rows (pre-existing ad hoc numbers, e.g. "CUS-VISUAL-001") are
-- backfilled into the new convention, oldest row first (created_at, then id
-- to break ties), so the visible ordering matches creation order. IDs,
-- relationships, financial data and every other column are untouched.
--
-- Idempotent: sequences use IF NOT EXISTS; each backfill loop is guarded by
-- "no row already matches the new format", so re-running this file after a
-- successful run touches zero rows. Setting a column DEFAULT is naturally
-- idempotent (setting the same default twice is a no-op difference).
-- ============================================================================

BEGIN;

CREATE SEQUENCE IF NOT EXISTS public.customer_number_seq AS bigint START WITH 1 INCREMENT BY 1;
CREATE SEQUENCE IF NOT EXISTS public.driver_number_seq AS bigint START WITH 1 INCREMENT BY 1;

-- Backfill existing customers, oldest first. Guarded so this never re-runs
-- once every row already carries a CUST-###### number (including rows
-- created by the app after this migration, via the column default below).
DO $$
DECLARE
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE customer_number ~ '^CUST-[0-9]{6,}$') THEN
    FOR r IN SELECT id FROM public.customers ORDER BY created_at ASC, id ASC LOOP
      UPDATE public.customers
      SET customer_number = 'CUST-' || lpad(nextval('public.customer_number_seq')::text, 6, '0')
      WHERE id = r.id;
    END LOOP;
  END IF;
END $$;

-- Backfill existing drivers, oldest first. Same guard shape as above.
DO $$
DECLARE
  r RECORD;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.drivers WHERE driver_number ~ '^DRV-[0-9]{6,}$') THEN
    FOR r IN SELECT id FROM public.drivers ORDER BY created_at ASC, id ASC LOOP
      UPDATE public.drivers
      SET driver_number = 'DRV-' || lpad(nextval('public.driver_number_seq')::text, 6, '0')
      WHERE id = r.id;
    END LOOP;
  END IF;
END $$;

-- From here on, an INSERT that omits customer_number / driver_number gets the
-- next sequential value automatically.
ALTER TABLE public.customers
  ALTER COLUMN customer_number SET DEFAULT ('CUST-' || lpad(nextval('public.customer_number_seq')::text, 6, '0'));
ALTER TABLE public.drivers
  ALTER COLUMN driver_number SET DEFAULT ('DRV-' || lpad(nextval('public.driver_number_seq')::text, 6, '0'));

COMMIT;
