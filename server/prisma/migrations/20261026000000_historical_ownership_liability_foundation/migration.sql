-- IDEMPOTENT
-- ============================================================================
-- FR.12A.9 — Historical ownership resolution: company-assumed historical
-- liability (database foundation)
--
-- Design: docs/fr12a7b-company-assumed-historical-liability-design.md
-- (approved policy direction P1, L1–L7, D8, D10 — see §11 of that document).
--
-- ADDITIVE ONLY. No existing row is inserted, updated, backfilled or removed.
--   * Recording a historical liability NEVER creates a wallet credit, a
--     driver cash movement, a payout, a settlement or company revenue. The
--     liability register is a separate sub-ledger.
--   * driver_cash_historical_reconciliations is untouched; its ownership
--     column stays pinned to UNRESOLVED (dchr_ownership_unresolved_chk). An
--     approved ledger reconciliation remains evidence only.
--
-- Objects:
--   1. Enums HistoricalOwnershipOutcome, HistoricalCollectionVerification,
--      HistoricalOwnershipEvidenceKind (decisions reuse
--      HistoricalReconciliationDecisionType).
--   2. historical_liability_policies            (immutable, versioned)
--      (the collected amount is verified ONLY by an approved ledger
--       reconciliation whose anchor is the settlement that handed the whole
--       balance over — validity SQL SETTLEMENT_INCLUSION_NOT_ESTABLISHED)
--   3. historical_liability_policy_decisions    (append-only lifecycle)
--   4. historical_ownership_resolutions         (immutable proposal)
--   5. historical_ownership_resolution_evidence (immutable fingerprints)
--   6. historical_ownership_resolution_decisions (append-only lifecycle)
--   7. historical_liabilities                   (the liability register)
--   8. historical_liability_reviews             (append-only periodic reviews)
--
-- Approved policy rules enforced here (generic, never incident-specific):
--   L1  held_collection_amount = collected_amount (the full verified
--       collected amount is a liability, never revenue);
--   L2  tracked_shortfall_amount = GREATEST(expected − collected, 0), tracked
--       separately and never part of the recognized amount (no loss posting);
--   D8  reviewer ≠ proposer; recorder ≠ proposer and ≠ approver; revoker ≠
--       proposer and ≠ approver (CHECKs over FK-guaranteed copies).
--
-- Immutability without triggers (as FR.12A.3): CHECK-computed digests, and
-- composite FKs with ON UPDATE RESTRICT from decisions / liabilities to the
-- exact proposer, digest and amounts they bind. Every FK is ON DELETE
-- RESTRICT. Money is NUMERIC(14,2). Safe to re-run: every object is guarded.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'HistoricalOwnershipOutcome' AND n.nspname = 'public') THEN
    CREATE TYPE public."HistoricalOwnershipOutcome" AS ENUM ('COMPANY_ASSUMED_LIABILITY');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'HistoricalCollectionVerification' AND n.nspname = 'public') THEN
    -- Only an approved, valid ledger reconciliation proves the collected
    -- amount and its handover in a historical settlement (review finding M2).
    CREATE TYPE public."HistoricalCollectionVerification" AS ENUM ('APPROVED_LEDGER_RECONCILIATION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'HistoricalOwnershipEvidenceKind' AND n.nspname = 'public') THEN
    CREATE TYPE public."HistoricalOwnershipEvidenceKind" AS ENUM (
      'INVESTIGATION_REPORT', 'FINANCE_MEMO', 'BACKUP_EXTRACT', 'ORDER_DOCUMENT', 'CUSTOMER_STATEMENT', 'CORRESPONDENCE', 'OTHER'
    );
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. historical_liability_policies (immutable, versioned)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_liability_policies (
  id                          UUID                                NOT NULL DEFAULT gen_random_uuid(),
  policy_code                 VARCHAR(60)                         NOT NULL,
  version                     INTEGER                             NOT NULL,
  outcome                     public."HistoricalOwnershipOutcome" NOT NULL,
  title                       TEXT                                NOT NULL,
  summary                     TEXT                                NOT NULL,
  -- The approved Finance policy document lives outside the database; only its
  -- SHA-256 and a reference to where it is stored.
  document_sha256             CHAR(64)                            NOT NULL,
  document_reference          TEXT                                NOT NULL,
  -- L7: periodic Finance review and unclaimed-funds handling are configured
  -- per policy version. No legal expiry is assumed: NULL = none configured.
  review_interval_days        INTEGER                             NULL,
  unclaimed_funds_handling    TEXT                                NOT NULL,
  unclaimed_review_after_days INTEGER                             NULL,
  -- SHA-256 (UTF-8) of the free-text fields, verified by the validity SQL.
  content_sha256              CHAR(64)                            NOT NULL,
  policy_digest               CHAR(64)                            NOT NULL,
  proposed_by_id              UUID                                NOT NULL,
  idempotency_key             VARCHAR(200)                        NOT NULL,
  created_at                  TIMESTAMPTZ(3)                      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_liability_policies_pkey PRIMARY KEY (id),
  CONSTRAINT hlp_policy_code_format_chk CHECK (policy_code ~ '^[A-Z][A-Z0-9_]{2,59}$'),
  CONSTRAINT hlp_version_positive_chk CHECK (version > 0),
  CONSTRAINT hlp_title_meaningful_chk CHECK (length(btrim(title)) >= 10),
  CONSTRAINT hlp_summary_meaningful_chk CHECK (length(btrim(summary)) >= 20),
  CONSTRAINT hlp_document_sha256_chk CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hlp_document_reference_chk CHECK (length(btrim(document_reference)) >= 3),
  CONSTRAINT hlp_review_interval_chk CHECK (review_interval_days IS NULL OR review_interval_days BETWEEN 1 AND 3660),
  CONSTRAINT hlp_unclaimed_handling_chk CHECK (length(btrim(unclaimed_funds_handling)) >= 20),
  CONSTRAINT hlp_unclaimed_review_after_chk CHECK (unclaimed_review_after_days IS NULL OR unclaimed_review_after_days BETWEEN 1 AND 36600),
  CONSTRAINT hlp_content_sha256_chk CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hlp_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),
  -- Canonical form hlp-policy-v1, mirrored by buildPolicyCanonicalString
  -- (historical-ownership.calculation.ts). ASCII fields only.
  CONSTRAINT hlp_policy_digest_chk CHECK (
    COALESCE(
      policy_digest = encode(sha256(decode(
        'hlp-policy-v1'
        || '|' || id::text
        || '|' || policy_code
        || '|' || version::text
        || '|' || (CASE outcome WHEN 'COMPANY_ASSUMED_LIABILITY' THEN 'COMPANY_ASSUMED_LIABILITY' END)
        || '|' || document_sha256
        || '|' || COALESCE(review_interval_days::text, '')
        || '|' || COALESCE(unclaimed_review_after_days::text, '')
        || '|' || content_sha256,
        'escape')), 'hex'),
      false
    )
  ),

  CONSTRAINT hlp_proposed_by_id_fkey
    FOREIGN KEY (proposed_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS hlp_policy_code_version_key ON public.historical_liability_policies (policy_code, version);
CREATE UNIQUE INDEX IF NOT EXISTS hlp_idempotency_key_key ON public.historical_liability_policies (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS hlp_id_proposed_by_id_policy_digest_key
  ON public.historical_liability_policies (id, proposed_by_id, policy_digest);
CREATE UNIQUE INDEX IF NOT EXISTS hlp_id_policy_digest_key ON public.historical_liability_policies (id, policy_digest);

-- ---------------------------------------------------------------------------
-- 3. historical_liability_policy_decisions (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_liability_policy_decisions (
  id                    UUID                                          NOT NULL DEFAULT gen_random_uuid(),
  policy_id             UUID                                          NOT NULL,
  decision              public."HistoricalReconciliationDecisionType" NOT NULL,
  is_terminal           BOOLEAN                                       NOT NULL,
  proposed_by_id        UUID                                          NOT NULL,
  policy_digest         CHAR(64)                                      NOT NULL,
  revokes_decision_id   UUID                                          NULL,
  revokes_decision_type public."HistoricalReconciliationDecisionType" NULL,
  revoked_approver_id   UUID                                          NULL,
  decided_by_id         UUID                                          NOT NULL,
  reason                TEXT                                          NULL,
  idempotency_key       VARCHAR(200)                                  NOT NULL,
  created_at            TIMESTAMPTZ(3)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_liability_policy_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT hlpd_is_terminal_chk CHECK (is_terminal = (decision <> 'APPROVED')),
  CONSTRAINT hlpd_independent_reviewer_chk CHECK (
    decision NOT IN ('APPROVED', 'REJECTED') OR decided_by_id <> proposed_by_id
  ),
  CONSTRAINT hlpd_revocation_shape_chk CHECK (
    ((decision = 'REVOKED') = (revokes_decision_id IS NOT NULL))
    AND ((revokes_decision_id IS NULL) = (revokes_decision_type IS NULL))
    AND ((revokes_decision_id IS NULL) = (revoked_approver_id IS NULL))
    AND (revokes_decision_type IS NULL OR revokes_decision_type = 'APPROVED')
  ),
  CONSTRAINT hlpd_independent_revoker_chk CHECK (
    decision <> 'REVOKED' OR (decided_by_id <> proposed_by_id AND decided_by_id <> revoked_approver_id)
  ),
  CONSTRAINT hlpd_reason_chk CHECK (
    (decision = 'APPROVED' AND (reason IS NULL OR length(btrim(reason)) > 0))
    OR (decision <> 'APPROVED' AND reason IS NOT NULL AND length(btrim(reason)) >= 20)
  ),
  CONSTRAINT hlpd_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),

  CONSTRAINT hlpd_policy_digest_fkey
    FOREIGN KEY (policy_id, proposed_by_id, policy_digest)
    REFERENCES public.historical_liability_policies(id, proposed_by_id, policy_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT hlpd_decided_by_id_fkey
    FOREIGN KEY (decided_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS hlpd_id_policy_decision_decider_key
  ON public.historical_liability_policy_decisions (id, policy_id, decision, decided_by_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hlpd_revokes_decision_fkey'
                   AND conrelid = 'public.historical_liability_policy_decisions'::regclass) THEN
    ALTER TABLE public.historical_liability_policy_decisions
      ADD CONSTRAINT hlpd_revokes_decision_fkey
      FOREIGN KEY (revokes_decision_id, policy_id, revokes_decision_type, revoked_approver_id)
      REFERENCES public.historical_liability_policy_decisions(id, policy_id, decision, decided_by_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS hlpd_idempotency_key_key ON public.historical_liability_policy_decisions (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS hlpd_one_outcome_per_policy_uq
  ON public.historical_liability_policy_decisions (policy_id) WHERE decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN');
CREATE UNIQUE INDEX IF NOT EXISTS hlpd_revokes_decision_id_key ON public.historical_liability_policy_decisions (revokes_decision_id);
CREATE INDEX IF NOT EXISTS hlpd_policy_id_created_at_idx ON public.historical_liability_policy_decisions (policy_id, created_at);

-- ---------------------------------------------------------------------------
-- 4. historical_ownership_resolutions (immutable proposal)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_ownership_resolutions (
  id                           UUID                                      NOT NULL DEFAULT gen_random_uuid(),
  incident_id                  UUID                                      NOT NULL,
  outcome                      public."HistoricalOwnershipOutcome"       NOT NULL,
  policy_id                    UUID                                      NOT NULL,
  policy_digest                CHAR(64)                                  NOT NULL,
  deleted_order_reference      UUID                                      NOT NULL,
  source_audit_log_id          UUID                                      NOT NULL,
  order_type                   public."OrderType"                        NOT NULL,
  expected_amount              NUMERIC(14,2)                             NOT NULL,
  collected_amount             NUMERIC(14,2)                             NOT NULL,
  collection_difference        NUMERIC(14,2)                             NOT NULL,
  verification                 public."HistoricalCollectionVerification" NOT NULL,
  ledger_reconciliation_id     UUID                                      NOT NULL,
  held_collection_amount       NUMERIC(14,2)                             NOT NULL,
  tracked_shortfall_amount     NUMERIC(14,2)                             NOT NULL,
  evidence_manifest_digest     CHAR(64)                                  NOT NULL,
  evidence_count               INTEGER                                   NOT NULL,
  rationale                    TEXT                                      NOT NULL,
  rationale_digest             CHAR(64)                                  NOT NULL,
  resolution_digest            CHAR(64)                                  NOT NULL,
  proposed_by_id               UUID                                      NOT NULL,
  idempotency_key              VARCHAR(200)                              NOT NULL,
  supersedes_resolution_id     UUID                                      NULL,
  supersedes_decision_id       UUID                                      NULL,
  supersedes_decision_is_terminal BOOLEAN                                NULL,
  created_at                   TIMESTAMPTZ(3)                            NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_ownership_resolutions_pkey PRIMARY KEY (id),
  -- Snapshot of the surviving COLLECTION_DIFFERENCE_RECORDED audit.
  CONSTRAINT hor_collected_positive_chk CHECK (collected_amount > 0),
  CONSTRAINT hor_expected_amount_chk CHECK (expected_amount >= 0),
  CONSTRAINT hor_collection_difference_chk CHECK (
    collection_difference = collected_amount - expected_amount AND collection_difference <> 0
  ),
  -- L1: the full verified collected amount is held as a liability.
  CONSTRAINT hor_l1_full_collection_held_chk CHECK (held_collection_amount = collected_amount),
  -- L2: the shortfall is tracked separately and is never recognized.
  CONSTRAINT hor_l2_shortfall_tracked_chk CHECK (tracked_shortfall_amount = GREATEST(expected_amount - collected_amount, 0)),
  CONSTRAINT hor_verification_ledger_only_chk CHECK (verification = 'APPROVED_LEDGER_RECONCILIATION'),
  CONSTRAINT hor_evidence_count_chk CHECK (evidence_count >= 1),
  CONSTRAINT hor_evidence_manifest_digest_chk CHECK (evidence_manifest_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hor_rationale_meaningful_chk CHECK (length(btrim(rationale)) >= 50),
  CONSTRAINT hor_rationale_digest_chk CHECK (rationale_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hor_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT hor_supersession_shape_chk CHECK (
    (supersedes_resolution_id IS NULL AND supersedes_decision_id IS NULL AND supersedes_decision_is_terminal IS NULL)
    OR (supersedes_resolution_id IS NOT NULL AND supersedes_decision_id IS NOT NULL
        AND supersedes_decision_is_terminal = true AND supersedes_resolution_id <> id)
  ),
  -- Canonical form hor-resolution-v1, mirrored by
  -- buildResolutionCanonicalString (historical-ownership.calculation.ts).
  CONSTRAINT hor_resolution_digest_chk CHECK (
    COALESCE(
      resolution_digest = encode(sha256(decode(
        'hor-resolution-v1'
        || '|' || id::text
        || '|' || incident_id::text
        || '|' || (CASE outcome WHEN 'COMPANY_ASSUMED_LIABILITY' THEN 'COMPANY_ASSUMED_LIABILITY' END)
        || '|' || policy_id::text
        || '|' || policy_digest
        || '|' || deleted_order_reference::text
        || '|' || source_audit_log_id::text
        || '|' || (CASE order_type WHEN 'COMPANY_ORDER' THEN 'COMPANY_ORDER' WHEN 'DELIVERY_ONLY' THEN 'DELIVERY_ONLY' END)
        || '|' || expected_amount::text
        || '|' || collected_amount::text
        || '|' || collection_difference::text
        || '|' || (CASE verification WHEN 'APPROVED_LEDGER_RECONCILIATION' THEN 'APPROVED_LEDGER_RECONCILIATION' END)
        || '|' || ledger_reconciliation_id::text
        || '|' || held_collection_amount::text
        || '|' || tracked_shortfall_amount::text
        || '|' || evidence_manifest_digest
        || '|' || evidence_count::text
        || '|' || rationale_digest,
        'escape')), 'hex'),
      false
    )
  ),

  CONSTRAINT hor_incident_id_fkey
    FOREIGN KEY (incident_id) REFERENCES public.financial_ledger_incidents(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- The proposal is bound to the exact policy version it cites.
  CONSTRAINT hor_policy_digest_fkey
    FOREIGN KEY (policy_id, policy_digest) REFERENCES public.historical_liability_policies(id, policy_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT hor_source_audit_log_id_fkey
    FOREIGN KEY (source_audit_log_id) REFERENCES public.audit_logs(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT hor_ledger_reconciliation_id_fkey
    FOREIGN KEY (ledger_reconciliation_id) REFERENCES public.driver_cash_historical_reconciliations(id)
    ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT hor_proposed_by_id_fkey
    FOREIGN KEY (proposed_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- FK targets: decisions (evidence binding), liabilities (amount binding),
-- supersession (same deleted order).
CREATE UNIQUE INDEX IF NOT EXISTS hor_id_proposed_by_id_resolution_digest_key
  ON public.historical_ownership_resolutions (id, proposed_by_id, resolution_digest);
CREATE UNIQUE INDEX IF NOT EXISTS hor_id_liability_binding_key
  ON public.historical_ownership_resolutions (id, proposed_by_id, resolution_digest, held_collection_amount, tracked_shortfall_amount);
CREATE UNIQUE INDEX IF NOT EXISTS hor_id_deleted_order_reference_key
  ON public.historical_ownership_resolutions (id, deleted_order_reference);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hor_supersedes_resolution_fkey'
                   AND conrelid = 'public.historical_ownership_resolutions'::regclass) THEN
    ALTER TABLE public.historical_ownership_resolutions
      ADD CONSTRAINT hor_supersedes_resolution_fkey
      FOREIGN KEY (supersedes_resolution_id, deleted_order_reference)
      REFERENCES public.historical_ownership_resolutions(id, deleted_order_reference)
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS hor_idempotency_key_key ON public.historical_ownership_resolutions (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS hor_supersedes_resolution_id_key ON public.historical_ownership_resolutions (supersedes_resolution_id);
-- One resolution chain per deleted order: only a chain ROOT has no predecessor.
CREATE UNIQUE INDEX IF NOT EXISTS hor_root_deleted_order_uq
  ON public.historical_ownership_resolutions (deleted_order_reference) WHERE supersedes_resolution_id IS NULL;
CREATE INDEX IF NOT EXISTS hor_incident_id_idx ON public.historical_ownership_resolutions (incident_id);
CREATE INDEX IF NOT EXISTS hor_policy_id_idx ON public.historical_ownership_resolutions (policy_id);
CREATE INDEX IF NOT EXISTS hor_supersedes_decision_id_idx ON public.historical_ownership_resolutions (supersedes_decision_id);

-- ---------------------------------------------------------------------------
-- 5. historical_ownership_resolution_evidence (immutable fingerprints)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_ownership_resolution_evidence (
  id              UUID                                     NOT NULL DEFAULT gen_random_uuid(),
  resolution_id   UUID                                     NOT NULL,
  ordinal         INTEGER                                  NOT NULL,
  kind            public."HistoricalOwnershipEvidenceKind" NOT NULL,
  document_sha256 CHAR(64)                                 NOT NULL,
  reference       TEXT                                     NOT NULL,
  description     TEXT                                     NOT NULL,
  created_at      TIMESTAMPTZ(3)                           NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_ownership_resolution_evidence_pkey PRIMARY KEY (id),
  CONSTRAINT hore_ordinal_positive_chk CHECK (ordinal >= 1),
  CONSTRAINT hore_document_sha256_chk CHECK (document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT hore_reference_chk CHECK (length(btrim(reference)) >= 3),
  CONSTRAINT hore_description_chk CHECK (length(btrim(description)) >= 10),
  CONSTRAINT hore_resolution_id_fkey
    FOREIGN KEY (resolution_id) REFERENCES public.historical_ownership_resolutions(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS hore_resolution_ordinal_key ON public.historical_ownership_resolution_evidence (resolution_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS hore_resolution_document_key ON public.historical_ownership_resolution_evidence (resolution_id, document_sha256);

-- ---------------------------------------------------------------------------
-- 6. historical_ownership_resolution_decisions (append-only)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_ownership_resolution_decisions (
  id                    UUID                                          NOT NULL DEFAULT gen_random_uuid(),
  resolution_id         UUID                                          NOT NULL,
  decision              public."HistoricalReconciliationDecisionType" NOT NULL,
  is_terminal           BOOLEAN                                       NOT NULL,
  proposed_by_id        UUID                                          NOT NULL,
  resolution_digest     CHAR(64)                                      NOT NULL,
  revokes_decision_id   UUID                                          NULL,
  revokes_decision_type public."HistoricalReconciliationDecisionType" NULL,
  revoked_approver_id   UUID                                          NULL,
  decided_by_id         UUID                                          NOT NULL,
  reason                TEXT                                          NULL,
  idempotency_key       VARCHAR(200)                                  NOT NULL,
  created_at            TIMESTAMPTZ(3)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_ownership_resolution_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT hord_is_terminal_chk CHECK (is_terminal = (decision <> 'APPROVED')),
  CONSTRAINT hord_independent_reviewer_chk CHECK (
    decision NOT IN ('APPROVED', 'REJECTED') OR decided_by_id <> proposed_by_id
  ),
  CONSTRAINT hord_revocation_shape_chk CHECK (
    ((decision = 'REVOKED') = (revokes_decision_id IS NOT NULL))
    AND ((revokes_decision_id IS NULL) = (revokes_decision_type IS NULL))
    AND ((revokes_decision_id IS NULL) = (revoked_approver_id IS NULL))
    AND (revokes_decision_type IS NULL OR revokes_decision_type = 'APPROVED')
  ),
  CONSTRAINT hord_independent_revoker_chk CHECK (
    decision <> 'REVOKED' OR (decided_by_id <> proposed_by_id AND decided_by_id <> revoked_approver_id)
  ),
  CONSTRAINT hord_reason_chk CHECK (
    (decision = 'APPROVED' AND (reason IS NULL OR length(btrim(reason)) > 0))
    OR (decision <> 'APPROVED' AND reason IS NOT NULL AND length(btrim(reason)) >= 20)
  ),
  CONSTRAINT hord_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),

  CONSTRAINT hord_resolution_digest_fkey
    FOREIGN KEY (resolution_id, proposed_by_id, resolution_digest)
    REFERENCES public.historical_ownership_resolutions(id, proposed_by_id, resolution_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT hord_decided_by_id_fkey
    FOREIGN KEY (decided_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS hord_id_resolution_decision_decider_key
  ON public.historical_ownership_resolution_decisions (id, resolution_id, decision, decided_by_id);
CREATE UNIQUE INDEX IF NOT EXISTS hord_id_resolution_id_is_terminal_key
  ON public.historical_ownership_resolution_decisions (id, resolution_id, is_terminal);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hord_revokes_decision_fkey'
                   AND conrelid = 'public.historical_ownership_resolution_decisions'::regclass) THEN
    ALTER TABLE public.historical_ownership_resolution_decisions
      ADD CONSTRAINT hord_revokes_decision_fkey
      FOREIGN KEY (revokes_decision_id, resolution_id, revokes_decision_type, revoked_approver_id)
      REFERENCES public.historical_ownership_resolution_decisions(id, resolution_id, decision, decided_by_id)
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
  -- A re-proposal must cite a TERMINAL decision of the record it supersedes.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hor_supersedes_terminal_decision_fkey'
                   AND conrelid = 'public.historical_ownership_resolutions'::regclass) THEN
    ALTER TABLE public.historical_ownership_resolutions
      ADD CONSTRAINT hor_supersedes_terminal_decision_fkey
      FOREIGN KEY (supersedes_decision_id, supersedes_resolution_id, supersedes_decision_is_terminal)
      REFERENCES public.historical_ownership_resolution_decisions(id, resolution_id, is_terminal)
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS hord_idempotency_key_key ON public.historical_ownership_resolution_decisions (idempotency_key);
CREATE UNIQUE INDEX IF NOT EXISTS hord_one_outcome_per_resolution_uq
  ON public.historical_ownership_resolution_decisions (resolution_id) WHERE decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN');
CREATE UNIQUE INDEX IF NOT EXISTS hord_revokes_decision_id_key ON public.historical_ownership_resolution_decisions (revokes_decision_id);
CREATE INDEX IF NOT EXISTS hord_resolution_id_created_at_idx ON public.historical_ownership_resolution_decisions (resolution_id, created_at);

-- ---------------------------------------------------------------------------
-- 7. historical_liabilities (the liability register)
--
-- One row per approved resolution, recorded separately from approval. The
-- amounts are pinned by composite FKs to the approved resolution, the
-- approval to its decision row and approver; recognized = held (L1);
-- the tracked shortfall is carried but never recognized (L2). No wallet,
-- driver cash, payout, settlement or company row is ever linked or created.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_liabilities (
  id                       UUID                                          NOT NULL DEFAULT gen_random_uuid(),
  resolution_id            UUID                                          NOT NULL,
  proposed_by_id           UUID                                          NOT NULL,
  resolution_digest        CHAR(64)                                      NOT NULL,
  approval_decision_id     UUID                                          NOT NULL,
  approval_decision_type   public."HistoricalReconciliationDecisionType" NOT NULL,
  approved_by_id           UUID                                          NOT NULL,
  held_collection_amount   NUMERIC(14,2)                                 NOT NULL,
  tracked_shortfall_amount NUMERIC(14,2)                                 NOT NULL,
  recognized_amount        NUMERIC(14,2)                                 NOT NULL,
  liability_digest         CHAR(64)                                      NOT NULL,
  recorded_by_id           UUID                                          NOT NULL,
  idempotency_key          VARCHAR(200)                                  NOT NULL,
  created_at               TIMESTAMPTZ(3)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_liabilities_pkey PRIMARY KEY (id),
  CONSTRAINT hl_approval_type_chk CHECK (approval_decision_type = 'APPROVED'),
  CONSTRAINT hl_recognized_equals_held_chk CHECK (recognized_amount = held_collection_amount AND recognized_amount > 0),
  CONSTRAINT hl_shortfall_non_negative_chk CHECK (tracked_shortfall_amount >= 0),
  -- D8: recording is a third, independent step.
  CONSTRAINT hl_independent_recorder_chk CHECK (recorded_by_id <> proposed_by_id AND recorded_by_id <> approved_by_id),
  CONSTRAINT hl_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),
  -- Canonical form hl-liability-v1, mirrored by buildLiabilityCanonicalString.
  CONSTRAINT hl_liability_digest_chk CHECK (
    COALESCE(
      liability_digest = encode(sha256(decode(
        'hl-liability-v1'
        || '|' || id::text
        || '|' || resolution_id::text
        || '|' || resolution_digest
        || '|' || approval_decision_id::text
        || '|' || approved_by_id::text
        || '|' || held_collection_amount::text
        || '|' || tracked_shortfall_amount::text
        || '|' || recognized_amount::text
        || '|' || recorded_by_id::text,
        'escape')), 'hex'),
      false
    )
  ),

  CONSTRAINT hl_resolution_binding_fkey
    FOREIGN KEY (resolution_id, proposed_by_id, resolution_digest, held_collection_amount, tracked_shortfall_amount)
    REFERENCES public.historical_ownership_resolutions(id, proposed_by_id, resolution_digest, held_collection_amount, tracked_shortfall_amount)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT hl_approval_decision_fkey
    FOREIGN KEY (approval_decision_id, resolution_id, approval_decision_type, approved_by_id)
    REFERENCES public.historical_ownership_resolution_decisions(id, resolution_id, decision, decided_by_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT hl_recorded_by_id_fkey
    FOREIGN KEY (recorded_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS hl_resolution_id_key ON public.historical_liabilities (resolution_id);
CREATE UNIQUE INDEX IF NOT EXISTS hl_idempotency_key_key ON public.historical_liabilities (idempotency_key);
CREATE INDEX IF NOT EXISTS hl_created_at_idx ON public.historical_liabilities (created_at);

-- ---------------------------------------------------------------------------
-- 8. historical_liability_reviews (append-only periodic Finance review, L7)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.historical_liability_reviews (
  id              UUID           NOT NULL DEFAULT gen_random_uuid(),
  liability_id    UUID           NOT NULL,
  reviewed_by_id  UUID           NOT NULL,
  note            TEXT           NOT NULL,
  idempotency_key VARCHAR(200)   NOT NULL,
  created_at      TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT historical_liability_reviews_pkey PRIMARY KEY (id),
  CONSTRAINT hlr_note_meaningful_chk CHECK (length(btrim(note)) >= 20),
  CONSTRAINT hlr_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT hlr_liability_id_fkey
    FOREIGN KEY (liability_id) REFERENCES public.historical_liabilities(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT hlr_reviewed_by_id_fkey
    FOREIGN KEY (reviewed_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS hlr_idempotency_key_key ON public.historical_liability_reviews (idempotency_key);
CREATE INDEX IF NOT EXISTS hlr_liability_id_created_at_idx ON public.historical_liability_reviews (liability_id, created_at);

COMMIT;
