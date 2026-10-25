-- IDEMPOTENT
-- ============================================================================
-- Settlement-Based Financial Release — FR.2: database foundation
--
-- Contract:       docs/settlement-financial-release-contract.md (§3, §4, §11)
-- Business rules: docs/requirements.md §55
--
-- ADDITIVE ONLY. No existing row is updated, backfilled, rewritten or removed.
--   * Every historical order keeps financial_release_mode = NULL, which means
--     legacy immediate processing.
--   * Every historical settlement keeps NULL allocation metadata
--     (allocated_total / unattributed_amount / unattributed_reason), which means
--     a legacy-format settlement.
--   * No existing idempotency key, ledger row, balance or amount is touched.
--
-- Objects:
--   1. Enums FinancialReleaseMode, FinancialReleaseStatus,
--      FinancialReleaseReviewStatus, DriverSettlementCorrectionType,
--      OrderFinancialReleaseCorrectionType; OrderFinancialStatus gains
--      AWAITING_SETTLEMENT, COLLECTION_VOIDED, RELEASE_REVERSED (not used by any
--      statement below — PostgreSQL forbids using a newly added enum value in
--      the same transaction).
--   2. orders.financial_release_mode (nullable) + CHECK + index.
--   3. driver_settlements: allocated_total, unattributed_amount,
--      unattributed_reason (nullable) + CHECKs + UNIQUE (id, driver_id)
--      (composite-FK target).
--   4. order_financial_releases.
--   5. driver_settlement_corrections.
--   6. order_financial_release_corrections.
--   7. driver_settlement_allocations (composite FKs make cross-driver
--      allocation impossible at the database level).
--   8. Partial indexes.
--   9. system_settings row 'financial_release.settlement_mode_enabled' = false
--      (INSERT ... ON CONFLICT DO NOTHING — an existing row is never changed).
--
-- Every FK is ON DELETE RESTRICT / ON UPDATE NO ACTION. All money columns are
-- NUMERIC(14,2), the existing ledger precision. Constraint and index names
-- match what Prisma derives from schema.prisma, so `prisma migrate diff`
-- against a migrated database reports only the SQL-only CHECK constraints and
-- partial indexes that Prisma cannot express.
--
-- Safe to re-run: every object is guarded (IF NOT EXISTS / catalog lookups).
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'FinancialReleaseMode' AND n.nspname = 'public') THEN
    CREATE TYPE public."FinancialReleaseMode" AS ENUM ('IMMEDIATE', 'ON_SETTLEMENT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'FinancialReleaseStatus' AND n.nspname = 'public') THEN
    CREATE TYPE public."FinancialReleaseStatus" AS ENUM ('PENDING', 'RELEASED', 'VOIDED', 'RELEASE_REVERSED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'FinancialReleaseReviewStatus' AND n.nspname = 'public') THEN
    CREATE TYPE public."FinancialReleaseReviewStatus" AS ENUM ('NOT_REQUIRED', 'AWAITING_REVIEW', 'RESOLVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'DriverSettlementCorrectionType' AND n.nspname = 'public') THEN
    CREATE TYPE public."DriverSettlementCorrectionType" AS ENUM ('SETTLEMENT_REVERSAL', 'SETTLEMENT_SHORTFALL');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'OrderFinancialReleaseCorrectionType' AND n.nspname = 'public') THEN
    CREATE TYPE public."OrderFinancialReleaseCorrectionType" AS ENUM ('COLLECTION_VOID', 'RELEASE_REVERSAL');
  END IF;
END
$$;

ALTER TYPE public."OrderFinancialStatus" ADD VALUE IF NOT EXISTS 'AWAITING_SETTLEMENT';
ALTER TYPE public."OrderFinancialStatus" ADD VALUE IF NOT EXISTS 'COLLECTION_VOIDED';
ALTER TYPE public."OrderFinancialStatus" ADD VALUE IF NOT EXISTS 'RELEASE_REVERSED';

-- ---------------------------------------------------------------------------
-- 2. orders.financial_release_mode
-- ---------------------------------------------------------------------------

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS financial_release_mode public."FinancialReleaseMode" NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'orders_financial_release_mode_delivered_chk'
                   AND conrelid = 'public.orders'::regclass) THEN
    -- A release mode is only ever decided by a delivery.
    ALTER TABLE public.orders
      ADD CONSTRAINT orders_financial_release_mode_delivered_chk
      CHECK (financial_release_mode IS NULL OR delivered_at IS NOT NULL);
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS orders_financial_release_mode_financial_status_idx
  ON public.orders (financial_release_mode, financial_status);

-- ---------------------------------------------------------------------------
-- 3. driver_settlements allocation metadata
-- ---------------------------------------------------------------------------

ALTER TABLE public.driver_settlements
  ADD COLUMN IF NOT EXISTS allocated_total     NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS unattributed_amount NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS unattributed_reason TEXT          NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'driver_settlements_allocation_metadata_presence_chk'
                   AND conrelid = 'public.driver_settlements'::regclass) THEN
    -- Both NULL = legacy-format settlement; a reason only exists on an
    -- allocation-format settlement.
    ALTER TABLE public.driver_settlements
      ADD CONSTRAINT driver_settlements_allocation_metadata_presence_chk
      CHECK (
        ((allocated_total IS NULL) = (unattributed_amount IS NULL))
        AND (unattributed_reason IS NULL OR unattributed_amount IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'driver_settlements_allocation_metadata_values_chk'
                   AND conrelid = 'public.driver_settlements'::regclass) THEN
    ALTER TABLE public.driver_settlements
      ADD CONSTRAINT driver_settlements_allocation_metadata_values_chk
      CHECK (
        allocated_total IS NULL
        OR (
          allocated_total >= 0
          AND unattributed_amount >= 0
          AND amount_received = allocated_total + unattributed_amount
        )
      );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'driver_settlements_unattributed_reason_chk'
                   AND conrelid = 'public.driver_settlements'::regclass) THEN
    -- Decision A11: unattributed money needs a meaningful written explanation.
    ALTER TABLE public.driver_settlements
      ADD CONSTRAINT driver_settlements_unattributed_reason_chk
      CHECK (
        unattributed_amount IS NULL
        OR unattributed_amount = 0
        OR (unattributed_reason IS NOT NULL AND length(btrim(unattributed_reason)) >= 10)
      );
  END IF;
END
$$;

-- Composite-FK target for allocations / corrections (id is already unique, so
-- every existing row satisfies it).
CREATE UNIQUE INDEX IF NOT EXISTS driver_settlements_id_driver_id_key
  ON public.driver_settlements (id, driver_id);

-- ---------------------------------------------------------------------------
-- 4. order_financial_releases
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_financial_releases (
  id                             UUID                                  NOT NULL DEFAULT gen_random_uuid(),
  order_id                       UUID                                  NOT NULL,
  customer_id                    UUID                                  NOT NULL,
  driver_id                      UUID                                  NOT NULL,
  collection_transaction_id      UUID                                  NOT NULL,
  order_type                     public."OrderType"                    NOT NULL,
  delivered_at                   TIMESTAMPTZ(3)                        NOT NULL,
  collection_amount              NUMERIC(14,2)                         NOT NULL,
  allocated_amount               NUMERIC(14,2)                         NOT NULL DEFAULT 0,
  review_status                  public."FinancialReleaseReviewStatus" NOT NULL,
  release_status                 public."FinancialReleaseStatus"       NOT NULL DEFAULT 'PENDING',
  planned_customer_wallet_amount NUMERIC(14,2)                         NULL,
  planned_company_product_amount NUMERIC(14,2)                         NULL,
  planned_company_fee_amount     NUMERIC(14,2)                         NULL,
  wallet_transaction_id          UUID                                  NULL,
  company_product_transaction_id UUID                                  NULL,
  company_fee_transaction_id     UUID                                  NULL,
  released_at                    TIMESTAMPTZ(3)                        NULL,
  released_by_id                 UUID                                  NULL,
  released_by_settlement_id      UUID                                  NULL,
  created_at                     TIMESTAMPTZ(3)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at                     TIMESTAMPTZ(3)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT order_financial_releases_pkey PRIMARY KEY (id),

  CONSTRAINT ofr_collection_amount_positive_chk CHECK (collection_amount > 0),
  CONSTRAINT ofr_allocated_amount_range_chk CHECK (allocated_amount >= 0 AND allocated_amount <= collection_amount),

  -- Planned split: unknown (all NULL) exactly while a collection difference
  -- awaits resolution; otherwise all three are set.
  CONSTRAINT ofr_planned_presence_chk CHECK (
    ((planned_customer_wallet_amount IS NULL) = (review_status = 'AWAITING_REVIEW'))
    AND ((planned_company_product_amount IS NULL) = (review_status = 'AWAITING_REVIEW'))
    AND ((planned_company_fee_amount IS NULL) = (review_status = 'AWAITING_REVIEW'))
  ),
  CONSTRAINT ofr_planned_values_chk CHECK (
    planned_customer_wallet_amount IS NULL
    OR (
      planned_customer_wallet_amount >= 0
      AND planned_company_product_amount >= 0
      AND planned_company_fee_amount >= 0
      AND planned_customer_wallet_amount + planned_company_product_amount + planned_company_fee_amount = collection_amount
    )
  ),

  -- CLAUDE.md §12/§63: a COMPANY_ORDER never credits a wallet; a DELIVERY_ONLY
  -- order never produces company product revenue.
  CONSTRAINT ofr_order_type_buckets_chk CHECK (
    (order_type <> 'DELIVERY_ONLY'
      OR (COALESCE(planned_company_product_amount, 0) = 0 AND company_product_transaction_id IS NULL))
    AND (order_type <> 'COMPANY_ORDER'
      OR (COALESCE(planned_customer_wallet_amount, 0) = 0 AND wallet_transaction_id IS NULL))
  ),

  -- Release state machine (contract §4.1).
  CONSTRAINT ofr_release_state_chk CHECK (
    (release_status = 'PENDING'
      AND released_at IS NULL AND released_by_id IS NULL AND released_by_settlement_id IS NULL
      AND wallet_transaction_id IS NULL AND company_product_transaction_id IS NULL AND company_fee_transaction_id IS NULL)
    OR (release_status = 'VOIDED'
      AND allocated_amount = 0
      AND released_at IS NULL AND released_by_id IS NULL AND released_by_settlement_id IS NULL
      AND wallet_transaction_id IS NULL AND company_product_transaction_id IS NULL AND company_fee_transaction_id IS NULL)
    OR (release_status = 'RELEASED'
      AND allocated_amount = collection_amount
      AND released_at IS NOT NULL AND released_by_id IS NOT NULL
      AND review_status <> 'AWAITING_REVIEW')
    OR (release_status = 'RELEASE_REVERSED'
      AND released_at IS NOT NULL AND released_by_id IS NOT NULL
      AND review_status <> 'AWAITING_REVIEW')
  ),

  -- A released row references exactly the postings of its non-zero planned
  -- amounts (planned amounts are guaranteed non-NULL there by the two CHECKs above).
  CONSTRAINT ofr_posted_transactions_chk CHECK (
    release_status NOT IN ('RELEASED', 'RELEASE_REVERSED')
    OR (
      ((wallet_transaction_id IS NOT NULL) = (planned_customer_wallet_amount > 0))
      AND ((company_product_transaction_id IS NOT NULL) = (planned_company_product_amount > 0))
      AND ((company_fee_transaction_id IS NOT NULL) = (planned_company_fee_amount > 0))
    )
  ),

  CONSTRAINT order_financial_releases_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_customer_id_fkey
    FOREIGN KEY (customer_id) REFERENCES public.customers(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_driver_id_fkey
    FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_collection_transaction_id_fkey
    FOREIGN KEY (collection_transaction_id) REFERENCES public.driver_cash_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_wallet_transaction_id_fkey
    FOREIGN KEY (wallet_transaction_id) REFERENCES public.wallet_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_company_product_transaction_id_fkey
    FOREIGN KEY (company_product_transaction_id) REFERENCES public.company_financial_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_company_fee_transaction_id_fkey
    FOREIGN KEY (company_fee_transaction_id) REFERENCES public.company_financial_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_released_by_id_fkey
    FOREIGN KEY (released_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_releases_released_by_settlement_id_fkey
    FOREIGN KEY (released_by_settlement_id) REFERENCES public.driver_settlements(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS order_financial_releases_order_id_key
  ON public.order_financial_releases (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_financial_releases_collection_transaction_id_key
  ON public.order_financial_releases (collection_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_financial_releases_wallet_transaction_id_key
  ON public.order_financial_releases (wallet_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_financial_releases_company_product_transaction_id_key
  ON public.order_financial_releases (company_product_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_financial_releases_company_fee_transaction_id_key
  ON public.order_financial_releases (company_fee_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_financial_releases_id_driver_id_key
  ON public.order_financial_releases (id, driver_id);
CREATE INDEX IF NOT EXISTS ofr_driver_id_release_status_delivered_at_idx
  ON public.order_financial_releases (driver_id, release_status, delivered_at);
CREATE INDEX IF NOT EXISTS order_financial_releases_customer_id_release_status_idx
  ON public.order_financial_releases (customer_id, release_status);
CREATE INDEX IF NOT EXISTS order_financial_releases_release_status_review_status_idx
  ON public.order_financial_releases (release_status, review_status);
CREATE INDEX IF NOT EXISTS order_financial_releases_delivered_at_idx
  ON public.order_financial_releases (delivered_at);
CREATE INDEX IF NOT EXISTS order_financial_releases_released_at_idx
  ON public.order_financial_releases (released_at);
CREATE INDEX IF NOT EXISTS order_financial_releases_released_by_settlement_id_idx
  ON public.order_financial_releases (released_by_settlement_id);

-- ---------------------------------------------------------------------------
-- 5. driver_settlement_corrections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_settlement_corrections (
  id                  UUID                                    NOT NULL DEFAULT gen_random_uuid(),
  settlement_id       UUID                                    NOT NULL,
  driver_id           UUID                                    NOT NULL,
  correction_type     public."DriverSettlementCorrectionType" NOT NULL,
  amount              NUMERIC(14,2)                           NOT NULL,
  reason              TEXT                                    NOT NULL,
  cash_transaction_id UUID                                    NOT NULL,
  created_by_id       UUID                                    NOT NULL,
  idempotency_key     VARCHAR(200)                            NOT NULL,
  created_at          TIMESTAMPTZ(3)                          NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT driver_settlement_corrections_pkey PRIMARY KEY (id),
  CONSTRAINT dsc_amount_positive_chk CHECK (amount > 0),
  -- Non-blank at the database level. The legacy generic reversal endpoint
  -- (reason >= 1 char) also writes this row and its behavior is preserved; the
  -- ">= 10 characters" rule for the NEW correction endpoints is enforced by
  -- their request schemas.
  CONSTRAINT dsc_reason_not_blank_chk CHECK (length(btrim(reason)) > 0),
  CONSTRAINT dsc_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),

  CONSTRAINT driver_settlement_corrections_settlement_id_driver_id_fkey
    FOREIGN KEY (settlement_id, driver_id) REFERENCES public.driver_settlements(id, driver_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT driver_settlement_corrections_cash_transaction_id_fkey
    FOREIGN KEY (cash_transaction_id) REFERENCES public.driver_cash_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT driver_settlement_corrections_created_by_id_fkey
    FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_settlement_corrections_cash_transaction_id_key
  ON public.driver_settlement_corrections (cash_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS driver_settlement_corrections_idempotency_key_key
  ON public.driver_settlement_corrections (idempotency_key);
CREATE INDEX IF NOT EXISTS driver_settlement_corrections_settlement_id_idx
  ON public.driver_settlement_corrections (settlement_id);
CREATE INDEX IF NOT EXISTS driver_settlement_corrections_driver_id_created_at_idx
  ON public.driver_settlement_corrections (driver_id, created_at);
-- At most one SETTLEMENT_REVERSAL per settlement (legacy or allocation-format).
CREATE UNIQUE INDEX IF NOT EXISTS dsc_one_reversal_per_settlement_uq
  ON public.driver_settlement_corrections (settlement_id)
  WHERE correction_type = 'SETTLEMENT_REVERSAL';

-- ---------------------------------------------------------------------------
-- 6. order_financial_release_corrections
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.order_financial_release_corrections (
  id                                      UUID                                         NOT NULL DEFAULT gen_random_uuid(),
  release_id                              UUID                                         NOT NULL,
  correction_type                         public."OrderFinancialReleaseCorrectionType" NOT NULL,
  reason                                  TEXT                                         NOT NULL,
  driver_cash_reversal_transaction_id     UUID                                         NULL,
  wallet_reversal_transaction_id          UUID                                         NULL,
  company_product_reversal_transaction_id UUID                                         NULL,
  company_fee_reversal_transaction_id     UUID                                         NULL,
  created_by_id                           UUID                                         NOT NULL,
  idempotency_key                         VARCHAR(200)                                 NOT NULL,
  created_at                              TIMESTAMPTZ(3)                               NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT order_financial_release_corrections_pkey PRIMARY KEY (id),
  -- Only the new release-correction endpoints write this table.
  CONSTRAINT ofrc_reason_meaningful_chk CHECK (length(btrim(reason)) >= 10),
  CONSTRAINT ofrc_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT ofrc_type_shape_chk CHECK (
    (correction_type = 'COLLECTION_VOID'
      AND driver_cash_reversal_transaction_id IS NOT NULL
      AND wallet_reversal_transaction_id IS NULL
      AND company_product_reversal_transaction_id IS NULL
      AND company_fee_reversal_transaction_id IS NULL)
    OR (correction_type = 'RELEASE_REVERSAL'
      AND driver_cash_reversal_transaction_id IS NULL
      AND (wallet_reversal_transaction_id IS NOT NULL
        OR company_product_reversal_transaction_id IS NOT NULL
        OR company_fee_reversal_transaction_id IS NOT NULL))
  ),

  CONSTRAINT order_financial_release_corrections_release_id_fkey
    FOREIGN KEY (release_id) REFERENCES public.order_financial_releases(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ofrc_driver_cash_reversal_transaction_id_fkey
    FOREIGN KEY (driver_cash_reversal_transaction_id) REFERENCES public.driver_cash_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ofrc_wallet_reversal_transaction_id_fkey
    FOREIGN KEY (wallet_reversal_transaction_id) REFERENCES public.wallet_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ofrc_company_product_reversal_transaction_id_fkey
    FOREIGN KEY (company_product_reversal_transaction_id) REFERENCES public.company_financial_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT ofrc_company_fee_reversal_transaction_id_fkey
    FOREIGN KEY (company_fee_reversal_transaction_id) REFERENCES public.company_financial_transactions(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT order_financial_release_corrections_created_by_id_fkey
    FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS order_financial_release_corrections_release_id_key
  ON public.order_financial_release_corrections (release_id);
CREATE UNIQUE INDEX IF NOT EXISTS ofrc_driver_cash_reversal_transaction_id_key
  ON public.order_financial_release_corrections (driver_cash_reversal_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS ofrc_wallet_reversal_transaction_id_key
  ON public.order_financial_release_corrections (wallet_reversal_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS ofrc_company_product_reversal_transaction_id_key
  ON public.order_financial_release_corrections (company_product_reversal_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS ofrc_company_fee_reversal_transaction_id_key
  ON public.order_financial_release_corrections (company_fee_reversal_transaction_id);
CREATE UNIQUE INDEX IF NOT EXISTS order_financial_release_corrections_idempotency_key_key
  ON public.order_financial_release_corrections (idempotency_key);
CREATE INDEX IF NOT EXISTS ofrc_correction_type_created_at_idx
  ON public.order_financial_release_corrections (correction_type, created_at);

-- ---------------------------------------------------------------------------
-- 7. driver_settlement_allocations
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_settlement_allocations (
  id                        UUID           NOT NULL DEFAULT gen_random_uuid(),
  settlement_id             UUID           NOT NULL,
  release_id                UUID           NOT NULL,
  driver_id                 UUID           NOT NULL,
  amount                    NUMERIC(14,2)  NOT NULL,
  created_by_id             UUID           NOT NULL,
  created_at                TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reversed_by_correction_id UUID           NULL,

  CONSTRAINT driver_settlement_allocations_pkey PRIMARY KEY (id),
  CONSTRAINT dsa_amount_positive_chk CHECK (amount > 0),

  -- Both composite FKs share driver_id, so the settlement and the release must
  -- belong to the same driver — enforced by the database itself.
  CONSTRAINT driver_settlement_allocations_settlement_id_driver_id_fkey
    FOREIGN KEY (settlement_id, driver_id) REFERENCES public.driver_settlements(id, driver_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT driver_settlement_allocations_release_id_driver_id_fkey
    FOREIGN KEY (release_id, driver_id) REFERENCES public.order_financial_releases(id, driver_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT driver_settlement_allocations_created_by_id_fkey
    FOREIGN KEY (created_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT driver_settlement_allocations_reversed_by_correction_id_fkey
    FOREIGN KEY (reversed_by_correction_id) REFERENCES public.driver_settlement_corrections(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS driver_settlement_allocations_settlement_id_release_id_key
  ON public.driver_settlement_allocations (settlement_id, release_id);
CREATE INDEX IF NOT EXISTS driver_settlement_allocations_release_id_idx
  ON public.driver_settlement_allocations (release_id);
CREATE INDEX IF NOT EXISTS driver_settlement_allocations_driver_id_created_at_idx
  ON public.driver_settlement_allocations (driver_id, created_at);
CREATE INDEX IF NOT EXISTS driver_settlement_allocations_reversed_by_correction_id_idx
  ON public.driver_settlement_allocations (reversed_by_correction_id);

-- ---------------------------------------------------------------------------
-- 8. Partial indexes (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------

-- Outstanding settlement-mode collections per driver, oldest delivery first.
CREATE INDEX IF NOT EXISTS ofr_outstanding_idx
  ON public.order_financial_releases (driver_id, delivered_at, id)
  WHERE release_status = 'PENDING' AND allocated_amount < collection_amount;

-- ---------------------------------------------------------------------------
-- 9. Activation setting — seeded DISABLED. Never overwrites an existing row.
-- ---------------------------------------------------------------------------

INSERT INTO public.system_settings (key, value, description)
VALUES (
  'financial_release.settlement_mode_enabled',
  'false'::jsonb,
  'Settlement-based financial release. Admin-only; changed only through the dedicated activation endpoint (FR.11).'
)
ON CONFLICT (key) DO NOTHING;

COMMIT;
