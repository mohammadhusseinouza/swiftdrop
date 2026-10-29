-- IDEMPOTENT
-- ============================================================================
-- Customer Receiver Memory — saved receivers for Create / Edit Order autocomplete
--
-- One new table, customer_receivers: the latest reusable receiver details per
-- (customer, normalized primary phone). Rows are written ONLY by the order
-- create / edit transactions (order.service.ts -> customer-receiver.service.ts).
--
-- ADDITIVE ONLY:
--   * No existing table or column is altered. The orders.receiver_* snapshot
--     columns stay the single source for every order consumer (Order Detail,
--     list, labels, Driver / Customer portals, reports); nothing reads receiver
--     data for an order from this table.
--   * No backfill: existing orders do not create rows here.
--   * orders gets no customer_receiver_id column — the identity is fully
--     determined by (customer_id, normalized_phone), so a stored link would be
--     redundant and could go stale when an order's customer or phone changes.
--
-- The unique (customer_id, normalized_phone) index is what makes concurrent
-- order creation safe: writes use INSERT ... ON CONFLICT on it.
--
-- Safe to re-run.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_receivers (
  id                UUID           NOT NULL DEFAULT gen_random_uuid(),
  customer_id       UUID           NOT NULL,
  name              VARCHAR(200)   NOT NULL,
  phone             VARCHAR(30)    NOT NULL,
  normalized_phone  VARCHAR(20)    NOT NULL,
  alternative_phone VARCHAR(30),
  area_id           UUID,
  address           VARCHAR(500)   NOT NULL,
  building_floor    VARCHAR(200),
  map_link          VARCHAR(1000),
  instructions      TEXT,
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT customer_receivers_pkey PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_receivers_customer_id_normalized_phone_key
  ON public.customer_receivers (customer_id, normalized_phone);

CREATE INDEX IF NOT EXISTS customer_receivers_customer_id_updated_at_idx
  ON public.customer_receivers (customer_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS customer_receivers_area_id_idx
  ON public.customer_receivers (area_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_receivers_customer_id_fkey') THEN
    ALTER TABLE public.customer_receivers
      ADD CONSTRAINT customer_receivers_customer_id_fkey
      FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customer_receivers_area_id_fkey') THEN
    ALTER TABLE public.customer_receivers
      ADD CONSTRAINT customer_receivers_area_id_fkey
      FOREIGN KEY (area_id) REFERENCES public.areas(id) ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END
$$;

COMMIT;
