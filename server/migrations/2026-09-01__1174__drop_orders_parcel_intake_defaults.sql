-- IDEMPOTENT
-- ============================================================================
-- Phase 11.17.4 — remove the temporary Parcel Intake DB defaults on orders.
--
-- Phase 11.17.2 shipped orders.parcel_intake_method / parcel_collection_status
-- as `NOT NULL DEFAULT 'ALREADY_AT_COMPANY' / 'RECEIVED_AT_COMPANY'` purely so
-- the not-yet-parcel-aware Create Order path kept working. Phase 11.17.4 makes
-- Create Order explicitly parcel-aware (the service always writes both columns),
-- so the temporary defaults are dropped. The columns stay NOT NULL — the
-- application is now the sole source of these values.
--
-- Backward compatibility: an old Create Order request that omits
-- `parcelIntakeMethod` is still accepted; the SERVICE resolves the omission to
-- ALREADY_AT_COMPANY (application layer, not the DB). See order.service.ts.
--
-- Safe / non-destructive: DROP DEFAULT only. No NOT NULL change, no table
-- recreate, no data rewrite. Both ALTERs are no-ops if already applied, so this
-- file may be re-run.
-- ============================================================================

BEGIN;

ALTER TABLE public.orders ALTER COLUMN parcel_intake_method DROP DEFAULT;
ALTER TABLE public.orders ALTER COLUMN parcel_collection_status DROP DEFAULT;

COMMIT;
