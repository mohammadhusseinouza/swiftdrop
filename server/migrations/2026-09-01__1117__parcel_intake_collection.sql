-- ============================================================================
-- Phase 11.17.2 — Parcel Intake & Collection — Database structure
--
-- Source of truth: docs/parcel-intake-collection-database-contract.md
-- Feature spec:     docs/delivery_management_system_parcel_intake_collection_feature_change_spec_v1.md
--
-- SCOPE: database structure + safe backfill ONLY. No business workflow, no API.
--
-- Single transaction — PostgreSQL DDL is transactional, so any failure rolls the
-- whole thing back. apply.mjs also guards against a partial / repeat run.
--
-- STAGED-COMPATIBILITY NOTE (contract §9, task §28/§29):
--   orders.parcel_intake_method / orders.parcel_collection_status are added
--   NOT NULL *with a temporary DB default* (ALREADY_AT_COMPANY / RECEIVED_AT_COMPANY)
--   so the still-unmodified Phase 11.4/6.2 Create-Order path keeps working until
--   Phase 11.17.4 sets them explicitly from the request. Phase 11.17.4 must then
--   drop both defaults (DB + Prisma @default) and own the receipt fields.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- 1. Enums
-- ----------------------------------------------------------------------------

CREATE TYPE public."ParcelIntakeMethod" AS ENUM (
    'ALREADY_AT_COMPANY',
    'DRIVER_COLLECTION'
);

CREATE TYPE public."ParcelCollectionStatus" AS ENUM (
    'AWAITING_ASSIGNMENT',
    'ASSIGNED',
    'COLLECTED_FROM_SENDER',
    'FAILED',
    'RESCHEDULED',
    'RECEIVED_AT_COMPANY'
);

CREATE TYPE public."ParcelCollectionAttemptOutcome" AS ENUM (
    'COLLECTED',
    'FAILED'
);

CREATE TYPE public."ParcelCollectionAssignmentEndReason" AS ENUM (
    'REASSIGNED',
    'FAILED',
    'RECEIVED_AT_COMPANY',
    'ORDER_CANCELLED'
);

-- ----------------------------------------------------------------------------
-- 2. failed_collection_reasons (mirrors failed_delivery_reasons) + canonical seed
-- ----------------------------------------------------------------------------

CREATE TABLE public.failed_collection_reasons (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    name           character varying(150) NOT NULL,
    requires_notes boolean DEFAULT false NOT NULL,
    is_active      boolean DEFAULT true NOT NULL,
    sort_order     integer DEFAULT 0 NOT NULL,
    created_at     timestamp(3) with time zone DEFAULT now() NOT NULL,
    updated_at     timestamp(3) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT failed_collection_reasons_pkey PRIMARY KEY (id),
    CONSTRAINT failed_collection_reasons_name_key UNIQUE (name)
);

CREATE INDEX failed_collection_reasons_is_active_sort_order_idx
    ON public.failed_collection_reasons USING btree (is_active, sort_order);

-- Canonical V1 catalog (contract §6). Idempotent — safe to re-run.
INSERT INTO public.failed_collection_reasons (name, requires_notes, sort_order) VALUES
    ('Sender unavailable',             false, 10),
    ('Parcel not ready',               false, 20),
    ('Unable to contact sender',       false, 30),
    ('Incorrect collection address',   false, 40),
    ('Sender requested reschedule',    false, 50),
    ('Collection cancelled by sender', true,  60),
    ('Other',                          true,  70)
ON CONFLICT (name) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. parcel_collection_assignments (separate from order_assignments)
-- ----------------------------------------------------------------------------

CREATE TABLE public.parcel_collection_assignments (
    id             uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id       uuid NOT NULL,
    driver_id      uuid NOT NULL,
    assigned_by_id uuid NOT NULL,
    assigned_at    timestamp(3) with time zone DEFAULT now() NOT NULL,
    ended_at       timestamp(3) with time zone,
    end_reason     public."ParcelCollectionAssignmentEndReason",
    is_current     boolean DEFAULT true NOT NULL,
    CONSTRAINT parcel_collection_assignments_pkey PRIMARY KEY (id),
    CONSTRAINT parcel_collection_assignments_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT,
    CONSTRAINT parcel_collection_assignments_driver_id_fkey
        FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT,
    CONSTRAINT parcel_collection_assignments_assigned_by_id_fkey
        FOREIGN KEY (assigned_by_id) REFERENCES public.users(id) ON DELETE RESTRICT,
    -- contract §8.2: is_current <=> (ended_at IS NULL AND end_reason IS NULL)
    CONSTRAINT parcel_collection_assignments_current_state_chk CHECK (
        (is_current AND ended_at IS NULL AND end_reason IS NULL)
        OR (NOT is_current AND ended_at IS NOT NULL AND end_reason IS NOT NULL)
    )
);

CREATE INDEX parcel_collection_assignments_order_id_is_current_idx
    ON public.parcel_collection_assignments USING btree (order_id, is_current);
CREATE INDEX parcel_collection_assignments_driver_id_is_current_idx
    ON public.parcel_collection_assignments USING btree (driver_id, is_current);
CREATE INDEX parcel_collection_assignments_assigned_at_idx
    ON public.parcel_collection_assignments USING btree (assigned_at);

-- contract §8: at most one current collection assignment per order. APPROVED.
CREATE UNIQUE INDEX parcel_collection_assignments_one_current_per_order_uq
    ON public.parcel_collection_assignments USING btree (order_id)
    WHERE is_current;

-- ----------------------------------------------------------------------------
-- 4. parcel_collection_attempts (separate from delivery_attempts)
-- ----------------------------------------------------------------------------

CREATE TABLE public.parcel_collection_attempts (
    id                          uuid DEFAULT gen_random_uuid() NOT NULL,
    order_id                    uuid NOT NULL,
    driver_id                   uuid NOT NULL,
    attempt_number              integer NOT NULL,
    outcome                     public."ParcelCollectionAttemptOutcome" NOT NULL,
    failed_collection_reason_id uuid,
    notes                       text,
    started_at                  timestamp(3) with time zone DEFAULT now() NOT NULL,
    completed_at                timestamp(3) with time zone,
    created_at                  timestamp(3) with time zone DEFAULT now() NOT NULL,
    CONSTRAINT parcel_collection_attempts_pkey PRIMARY KEY (id),
    CONSTRAINT parcel_collection_attempts_order_id_attempt_number_key
        UNIQUE (order_id, attempt_number),
    CONSTRAINT parcel_collection_attempts_order_id_fkey
        FOREIGN KEY (order_id) REFERENCES public.orders(id) ON DELETE RESTRICT,
    CONSTRAINT parcel_collection_attempts_driver_id_fkey
        FOREIGN KEY (driver_id) REFERENCES public.drivers(id) ON DELETE RESTRICT,
    CONSTRAINT parcel_collection_attempts_failed_collection_reason_id_fkey
        FOREIGN KEY (failed_collection_reason_id)
        REFERENCES public.failed_collection_reasons(id) ON DELETE SET NULL
);

CREATE INDEX parcel_collection_attempts_driver_id_started_at_idx
    ON public.parcel_collection_attempts USING btree (driver_id, started_at);
CREATE INDEX parcel_collection_attempts_outcome_completed_at_idx
    ON public.parcel_collection_attempts USING btree (outcome, completed_at);

-- contract §5: at most one COLLECTED attempt per order.
CREATE UNIQUE INDEX parcel_collection_attempts_one_collected_per_order_uq
    ON public.parcel_collection_attempts USING btree (order_id)
    WHERE outcome = 'COLLECTED';

-- ----------------------------------------------------------------------------
-- 5. orders — new Parcel Intake columns
--    The two enum columns are NOT NULL with a TEMPORARY default (see header).
--    ADD COLUMN ... NOT NULL DEFAULT fills all existing rows in place —
--    that is the backfill for those two columns.
-- ----------------------------------------------------------------------------

ALTER TABLE public.orders
    ADD COLUMN parcel_intake_method public."ParcelIntakeMethod"
        NOT NULL DEFAULT 'ALREADY_AT_COMPANY',
    ADD COLUMN parcel_collection_status public."ParcelCollectionStatus"
        NOT NULL DEFAULT 'RECEIVED_AT_COMPANY',
    ADD COLUMN current_parcel_collection_driver_id uuid,
    ADD COLUMN parcel_collection_contact_name character varying(200),
    ADD COLUMN parcel_collection_phone character varying(30),
    ADD COLUMN parcel_collection_alt_phone character varying(30),
    ADD COLUMN parcel_collection_area_id uuid,
    ADD COLUMN parcel_collection_area character varying(150),
    ADD COLUMN parcel_collection_address character varying(500),
    ADD COLUMN parcel_collection_notes text,
    ADD COLUMN parcel_collected_from_sender_at timestamp(3) with time zone,
    ADD COLUMN received_at_company_at timestamp(3) with time zone,
    ADD COLUMN received_at_company_by_id uuid;

-- ----------------------------------------------------------------------------
-- 6. Backfill existing orders (contract §9)
--    intake_method / collection_status already set by the DEFAULT above.
--    current_parcel_collection_driver_id already NULL. Snapshot fields stay NULL.
--    Every existing order has a valid created_by_id (verified in preflight),
--    so receipt actor is always recoverable.
-- ----------------------------------------------------------------------------

UPDATE public.orders
SET received_at_company_at    = created_at,
    received_at_company_by_id = created_by_id
WHERE received_at_company_at IS NULL;

-- ----------------------------------------------------------------------------
-- 7. orders — foreign keys + indexes for the new columns
-- ----------------------------------------------------------------------------

ALTER TABLE public.orders
    ADD CONSTRAINT orders_current_parcel_collection_driver_id_fkey
        FOREIGN KEY (current_parcel_collection_driver_id)
        REFERENCES public.drivers(id) ON DELETE SET NULL,
    ADD CONSTRAINT orders_parcel_collection_area_id_fkey
        FOREIGN KEY (parcel_collection_area_id)
        REFERENCES public.areas(id) ON DELETE SET NULL,
    ADD CONSTRAINT orders_received_at_company_by_id_fkey
        FOREIGN KEY (received_at_company_by_id)
        REFERENCES public.users(id) ON DELETE RESTRICT;

CREATE INDEX orders_parcel_collection_status_idx
    ON public.orders USING btree (parcel_collection_status);
CREATE INDEX orders_parcel_intake_method_idx
    ON public.orders USING btree (parcel_intake_method);
CREATE INDEX orders_current_parcel_collection_driver_id_idx
    ON public.orders USING btree (current_parcel_collection_driver_id);

COMMIT;
