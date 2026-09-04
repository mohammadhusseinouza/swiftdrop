-- IDEMPOTENT
-- ============================================================================
-- Phase 11.17.3 correction — parcel_collection_attempts.started_at
--
-- The Phase 11.17.2 bootstrap defined started_at as `NOT NULL DEFAULT now()`,
-- mirroring delivery_attempts. But V1 has NO "start parcel collection" action
-- (contract §5 / task §19) — a collection attempt only has a completion time.
-- started_at was therefore silently becoming now() (~= completed_at), which is
-- a fabricated start time.
--
-- Forward correction: make started_at nullable and drop the default. The
-- service now inserts started_at = NULL explicitly for both COLLECTED and
-- FAILED attempts. A future "start collection" action can populate it later.
--
-- Safe / non-destructive: no table recreate, no data rewrite. The two ALTERs
-- are no-ops if already applied, so this file may be re-run.
-- (parcel_collection_attempts held 0 rows when this ran — the feature is not
--  yet wired into Create Order, so no operational history exists.)
-- ============================================================================

BEGIN;

ALTER TABLE public.parcel_collection_attempts ALTER COLUMN started_at DROP DEFAULT;
ALTER TABLE public.parcel_collection_attempts ALTER COLUMN started_at DROP NOT NULL;

COMMIT;
