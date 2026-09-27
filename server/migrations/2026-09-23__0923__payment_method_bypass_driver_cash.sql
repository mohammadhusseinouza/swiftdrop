-- IDEMPOTENT
-- ============================================================================
-- Configurable Direct Payment Settlement
--
-- 1. payment_methods.bypass_driver_cash (BOOLEAN NOT NULL DEFAULT false)
--    false -> money collected at delivery with this method enters the
--             delivering Driver's cash account (unchanged behavior).
--    true  -> money collected at delivery with this method is received
--             directly by the company and NEVER enters Driver Cash.
--    Every existing row is backfilled to false by the column default, so
--    current behavior is preserved exactly until an admin opts a method in.
--
-- 2. company_direct_collections — append-only record of money collected at
--    delivery that was received DIRECTLY by the company (the routing decision
--    for a bypass-enabled method). It is NOT revenue (company_financial_
--    transactions keeps revenue ownership), NOT Driver Cash (no driver
--    balance / settlement obligation) and NOT the customer wallet. It exists
--    so the routing decision is persisted with the completed financial event:
--    toggling payment_methods.bypass_driver_cash later never rewrites history.
--    One row per Order at most (idempotency_key UNIQUE, deterministic key
--    `delivery:<orderId>:direct-company-collection`), amount strictly > 0
--    (a zero collection posts nothing, same as the Driver Cash ledger).
--
-- Additive only: no data is modified or removed. Safe to re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.payment_methods
  ADD COLUMN IF NOT EXISTS bypass_driver_cash BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.company_direct_collections (
  id                UUID          NOT NULL DEFAULT gen_random_uuid(),
  order_id          UUID          NOT NULL,
  driver_id         UUID          NULL,
  payment_method_id UUID          NOT NULL,
  amount            NUMERIC(14,2) NOT NULL,
  created_by_id     UUID          NULL,
  notes             TEXT          NULL,
  idempotency_key   VARCHAR(200)  NULL,
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  CONSTRAINT company_direct_collections_pkey PRIMARY KEY (id),
  CONSTRAINT company_direct_collections_idempotency_key_key UNIQUE (idempotency_key),
  CONSTRAINT company_direct_collections_amount_positive CHECK (amount > 0),
  CONSTRAINT company_direct_collections_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT company_direct_collections_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT company_direct_collections_payment_method_id_fkey
    FOREIGN KEY (payment_method_id) REFERENCES public.payment_methods(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT company_direct_collections_created_by_id_fkey
    FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE INDEX IF NOT EXISTS company_direct_collections_created_at_idx
  ON public.company_direct_collections (created_at);
CREATE INDEX IF NOT EXISTS company_direct_collections_order_id_idx
  ON public.company_direct_collections (order_id);
CREATE INDEX IF NOT EXISTS company_direct_collections_driver_id_created_at_idx
  ON public.company_direct_collections (driver_id, created_at);

COMMIT;
