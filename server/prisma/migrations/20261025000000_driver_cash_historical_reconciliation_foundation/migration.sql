-- IDEMPOTENT
-- ============================================================================
-- FR.12A.3 — Driver cash historical reconciliation: database foundation
--
-- Design: docs/fr12a2-historical-ledger-reconciliation-design.md (option B,
--         refined in FR.12A.3 — see docs/fr12a3-historical-reconciliation-foundation.md)
--
-- ADDITIVE ONLY. No existing row is inserted, updated, backfilled or removed.
--   * driver_cash_accounts.current_balance, every driver_cash_transactions row,
--     every settlement, wallet and company financial row are untouched.
--   * A reconciliation is EVIDENCE ONLY: it never moves cash, never posts a
--     wallet credit or company revenue, and never decides who owns the money.
--   * Nothing here changes G3 / R1 or any activation gate (FR.12A.4).
--
-- Objects:
--   1. Enums FinancialLedgerIncidentCause, DriverCashHistoricalReconciliationKind,
--      HistoricalReconciliationAccountingTreatment, HistoricalOwnershipStatus,
--      HistoricalReconciliationDecisionType.
--   2. Composite-FK targets on existing tables (UNIQUE (id, x); id is already
--      unique, so every existing row satisfies them):
--        driver_cash_accounts     (id, driver_id)
--        driver_cash_transactions (id, account_id)
--   3. financial_ledger_incidents                       (immutable)
--   4. driver_cash_historical_reconciliations            (immutable evidence)
--   5. driver_cash_historical_reconciliation_decisions   (append-only lifecycle)
--   6. Supersession FK (reconciliation -> terminal decision), added last
--      because the two tables reference each other.
--
-- Immutability without triggers (the project has none):
--   * evidence_digest is recomputed by a CHECK from the evidence columns, so an
--     evidence column cannot change without the digest changing;
--   * every decision row carries (reconciliation_id, proposed_by_id,
--     evidence_digest) as a composite FK with ON UPDATE RESTRICT, so once any
--     decision exists (approval included) neither the evidence, the digest nor
--     the proposer of that reconciliation can be updated;
--   * lifecycle = append-only decision rows; status is derived, never stored.
--
-- Every FK is ON DELETE RESTRICT. Money columns are NUMERIC(14,2), the
-- driver cash ledger precision. Safe to re-run: every object is guarded.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'FinancialLedgerIncidentCause' AND n.nspname = 'public') THEN
    CREATE TYPE public."FinancialLedgerIncidentCause" AS ENUM ('MANUAL_DATABASE_DELETION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'DriverCashHistoricalReconciliationKind' AND n.nspname = 'public') THEN
    CREATE TYPE public."DriverCashHistoricalReconciliationKind" AS ENUM ('MISSING_COLLECTION');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'HistoricalReconciliationAccountingTreatment' AND n.nspname = 'public') THEN
    CREATE TYPE public."HistoricalReconciliationAccountingTreatment" AS ENUM ('EVIDENCE_ONLY_NO_CASH_EFFECT');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'HistoricalOwnershipStatus' AND n.nspname = 'public') THEN
    CREATE TYPE public."HistoricalOwnershipStatus" AS ENUM ('UNRESOLVED');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE t.typname = 'HistoricalReconciliationDecisionType' AND n.nspname = 'public') THEN
    CREATE TYPE public."HistoricalReconciliationDecisionType" AS ENUM ('APPROVED', 'REJECTED', 'WITHDRAWN', 'REVOKED');
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Composite-FK targets on existing tables
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS driver_cash_accounts_id_driver_id_key
  ON public.driver_cash_accounts (id, driver_id);
CREATE UNIQUE INDEX IF NOT EXISTS driver_cash_transactions_id_account_id_key
  ON public.driver_cash_transactions (id, account_id);

-- ---------------------------------------------------------------------------
-- 3. financial_ledger_incidents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.financial_ledger_incidents (
  id                      UUID                                  NOT NULL DEFAULT gen_random_uuid(),
  incident_number         VARCHAR(30)                           NOT NULL,
  cause                   public."FinancialLedgerIncidentCause" NOT NULL,
  summary                 TEXT                                  NOT NULL,
  discovered_at           TIMESTAMPTZ(3)                        NOT NULL,
  occurred_not_before     TIMESTAMPTZ(3)                        NULL,
  occurred_not_after      TIMESTAMPTZ(3)                        NULL,
  missing_records         JSONB                                 NOT NULL,
  remaining_uncertainties TEXT                                  NOT NULL,
  evidence                JSONB                                 NOT NULL,
  reported_by_id          UUID                                  NOT NULL,
  created_at              TIMESTAMPTZ(3)                        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT financial_ledger_incidents_pkey PRIMARY KEY (id),
  CONSTRAINT fli_incident_number_format_chk CHECK (incident_number ~ '^LI-[0-9]{4}-[0-9]{4}$'),
  CONSTRAINT fli_summary_meaningful_chk CHECK (length(btrim(summary)) >= 20),
  CONSTRAINT fli_uncertainties_not_blank_chk CHECK (length(btrim(remaining_uncertainties)) > 0),
  CONSTRAINT fli_occurrence_window_chk CHECK (
    occurred_not_before IS NULL OR occurred_not_after IS NULL OR occurred_not_before <= occurred_not_after
  ),
  CONSTRAINT fli_missing_records_object_chk CHECK (jsonb_typeof(missing_records) = 'object'),
  CONSTRAINT fli_evidence_object_chk CHECK (jsonb_typeof(evidence) = 'object'),

  CONSTRAINT financial_ledger_incidents_reported_by_id_fkey
    FOREIGN KEY (reported_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS financial_ledger_incidents_incident_number_key
  ON public.financial_ledger_incidents (incident_number);

-- ---------------------------------------------------------------------------
-- 4. driver_cash_historical_reconciliations (immutable evidence + proposal)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_cash_historical_reconciliations (
  id                              UUID                                                  NOT NULL DEFAULT gen_random_uuid(),
  incident_id                     UUID                                                  NOT NULL,
  account_id                      UUID                                                  NOT NULL,
  driver_id                       UUID                                                  NOT NULL,
  kind                            public."DriverCashHistoricalReconciliationKind"       NOT NULL,
  accounting_treatment            public."HistoricalReconciliationAccountingTreatment" NOT NULL,
  ownership_status                public."HistoricalOwnershipStatus"                   NOT NULL,
  amount                          NUMERIC(14,2)                                         NOT NULL,
  observed_jump                   NUMERIC(14,2)                                         NOT NULL,
  predecessor_transaction_id      UUID                                                  NULL,
  anchor_transaction_id           UUID                                                  NOT NULL,
  missing_transaction_id          UUID                                                  NOT NULL,
  source_audit_log_id             UUID                                                  NOT NULL,
  deleted_order_reference         UUID                                                  NOT NULL,
  order_type                      public."OrderType"                                    NOT NULL,
  expected_amount                 NUMERIC(14,2)                                         NOT NULL,
  actual_amount                   NUMERIC(14,2)                                         NOT NULL,
  collection_difference           NUMERIC(14,2)                                         NOT NULL,
  related_settlement_id           UUID                                                  NULL,
  evidence_digest                 CHAR(64)                                              NOT NULL,
  reason                          TEXT                                                  NOT NULL,
  proposed_by_id                  UUID                                                  NOT NULL,
  idempotency_key                 VARCHAR(200)                                          NOT NULL,
  supersedes_reconciliation_id    UUID                                                  NULL,
  supersedes_decision_id          UUID                                                  NULL,
  supersedes_decision_is_terminal BOOLEAN                                               NULL,
  created_at                      TIMESTAMPTZ(3)                                        NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT driver_cash_historical_reconciliations_pkey PRIMARY KEY (id),

  -- A missing collection is a positive movement whose amount is exactly the
  -- located balance-chain jump and the audit's recorded actual collection.
  CONSTRAINT dchr_amount_positive_chk CHECK (amount > 0),
  CONSTRAINT dchr_observed_jump_matches_chk CHECK (observed_jump = amount),
  CONSTRAINT dchr_actual_amount_matches_chk CHECK (kind <> 'MISSING_COLLECTION' OR actual_amount = amount),
  -- Snapshot of the surviving COLLECTION_DIFFERENCE_RECORDED audit
  -- (difference = actual - expected, calculateCollectionDifference). The
  -- difference is non-zero: the order's ownership split was never resolved.
  CONSTRAINT dchr_expected_amount_chk CHECK (expected_amount >= 0),
  CONSTRAINT dchr_collection_difference_chk CHECK (
    collection_difference = actual_amount - expected_amount AND collection_difference <> 0
  ),
  CONSTRAINT dchr_anchor_not_predecessor_chk CHECK (
    predecessor_transaction_id IS NULL OR predecessor_transaction_id <> anchor_transaction_id
  ),
  -- Ownership of the money is NOT decided by a ledger reconciliation. Only a
  -- separately approved ownership design (FR.12A.2 D4) may relax this.
  CONSTRAINT dchr_ownership_unresolved_chk CHECK (ownership_status = 'UNRESOLVED'),
  CONSTRAINT dchr_reason_meaningful_chk CHECK (length(btrim(reason)) >= 20),
  CONSTRAINT dchr_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),
  CONSTRAINT dchr_supersession_shape_chk CHECK (
    (supersedes_reconciliation_id IS NULL AND supersedes_decision_id IS NULL AND supersedes_decision_is_terminal IS NULL)
    OR (supersedes_reconciliation_id IS NOT NULL AND supersedes_decision_id IS NOT NULL
        AND supersedes_decision_is_terminal = true AND supersedes_reconciliation_id <> id)
  ),
  -- Evidence integrity. Canonical form v1 (mirrored exactly by
  -- buildEvidenceCanonicalString in historical-reconciliation.calculation.ts):
  -- ASCII only, '|'-separated, lowercase UUIDs, NUMERIC(14,2) text, '' for a
  -- NULL optional id. Every function used is IMMUTABLE. COALESCE(.., false)
  -- makes an unknown enum label fail closed. No timestamp is stored or digested:
  -- the evidence time is the cited audit's created_at (FK-pinned), because
  -- application-bound timestamps are shifted by a non-UTC session time zone
  -- (docs/timezone-investigation.md) and could never match an application digest.
  CONSTRAINT dchr_evidence_digest_chk CHECK (
    COALESCE(
      evidence_digest = encode(sha256(decode(
        'dchr-evidence-v1'
        || '|' || incident_id::text
        || '|' || account_id::text
        || '|' || driver_id::text
        || '|' || (CASE kind WHEN 'MISSING_COLLECTION' THEN 'MISSING_COLLECTION' END)
        || '|' || (CASE accounting_treatment WHEN 'EVIDENCE_ONLY_NO_CASH_EFFECT' THEN 'EVIDENCE_ONLY_NO_CASH_EFFECT' END)
        || '|' || amount::text
        || '|' || observed_jump::text
        || '|' || COALESCE(predecessor_transaction_id::text, '')
        || '|' || anchor_transaction_id::text
        || '|' || missing_transaction_id::text
        || '|' || source_audit_log_id::text
        || '|' || deleted_order_reference::text
        || '|' || (CASE order_type WHEN 'COMPANY_ORDER' THEN 'COMPANY_ORDER' WHEN 'DELIVERY_ONLY' THEN 'DELIVERY_ONLY' END)
        || '|' || expected_amount::text
        || '|' || actual_amount::text
        || '|' || collection_difference::text
        || '|' || COALESCE(related_settlement_id::text, ''),
        'escape')), 'hex'),
      false
    )
  ),

  CONSTRAINT dchr_incident_id_fkey
    FOREIGN KEY (incident_id) REFERENCES public.financial_ledger_incidents(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  -- (account_id, driver_id) must be a real account of that driver; every other
  -- evidence row is tied to the same account / driver through composite FKs.
  CONSTRAINT dchr_account_id_driver_id_fkey
    FOREIGN KEY (account_id, driver_id) REFERENCES public.driver_cash_accounts(id, driver_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dchr_predecessor_transaction_fkey
    FOREIGN KEY (predecessor_transaction_id, account_id) REFERENCES public.driver_cash_transactions(id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dchr_anchor_transaction_fkey
    FOREIGN KEY (anchor_transaction_id, account_id) REFERENCES public.driver_cash_transactions(id, account_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dchr_source_audit_log_id_fkey
    FOREIGN KEY (source_audit_log_id) REFERENCES public.audit_logs(id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dchr_related_settlement_fkey
    FOREIGN KEY (related_settlement_id, driver_id) REFERENCES public.driver_settlements(id, driver_id) ON DELETE RESTRICT ON UPDATE NO ACTION,
  CONSTRAINT dchr_proposed_by_id_fkey
    FOREIGN KEY (proposed_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- FK targets for decisions (evidence binding) and for supersession.
CREATE UNIQUE INDEX IF NOT EXISTS dchr_id_proposed_by_id_evidence_digest_key
  ON public.driver_cash_historical_reconciliations (id, proposed_by_id, evidence_digest);
CREATE UNIQUE INDEX IF NOT EXISTS dchr_id_evidence_keys_key
  ON public.driver_cash_historical_reconciliations (id, account_id, anchor_transaction_id, missing_transaction_id, source_audit_log_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dchr_supersedes_reconciliation_fkey'
                   AND conrelid = 'public.driver_cash_historical_reconciliations'::regclass) THEN
    -- A re-proposal explains exactly the same gap, missing row and audit.
    ALTER TABLE public.driver_cash_historical_reconciliations
      ADD CONSTRAINT dchr_supersedes_reconciliation_fkey
      FOREIGN KEY (supersedes_reconciliation_id, account_id, anchor_transaction_id, missing_transaction_id, source_audit_log_id)
      REFERENCES public.driver_cash_historical_reconciliations(id, account_id, anchor_transaction_id, missing_transaction_id, source_audit_log_id)
      ON DELETE RESTRICT ON UPDATE NO ACTION;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS dchr_idempotency_key_key
  ON public.driver_cash_historical_reconciliations (idempotency_key);
-- A record is superseded at most once, so each evidence chain is linear and
-- only its head can be live.
CREATE UNIQUE INDEX IF NOT EXISTS dchr_supersedes_reconciliation_id_key
  ON public.driver_cash_historical_reconciliations (supersedes_reconciliation_id);
-- One chain per gap / missing row / source audit: only a chain ROOT has
-- supersedes_reconciliation_id NULL.
CREATE UNIQUE INDEX IF NOT EXISTS dchr_root_anchor_uq
  ON public.driver_cash_historical_reconciliations (anchor_transaction_id)
  WHERE supersedes_reconciliation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dchr_root_missing_transaction_uq
  ON public.driver_cash_historical_reconciliations (missing_transaction_id)
  WHERE supersedes_reconciliation_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS dchr_root_source_audit_uq
  ON public.driver_cash_historical_reconciliations (source_audit_log_id)
  WHERE supersedes_reconciliation_id IS NULL;
CREATE INDEX IF NOT EXISTS dchr_account_id_created_at_idx
  ON public.driver_cash_historical_reconciliations (account_id, created_at);
CREATE INDEX IF NOT EXISTS dchr_incident_id_idx
  ON public.driver_cash_historical_reconciliations (incident_id);
CREATE INDEX IF NOT EXISTS dchr_supersedes_decision_id_idx
  ON public.driver_cash_historical_reconciliations (supersedes_decision_id);

-- ---------------------------------------------------------------------------
-- 5. driver_cash_historical_reconciliation_decisions (append-only lifecycle)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.driver_cash_historical_reconciliation_decisions (
  id                    UUID                                          NOT NULL DEFAULT gen_random_uuid(),
  reconciliation_id     UUID                                          NOT NULL,
  decision              public."HistoricalReconciliationDecisionType" NOT NULL,
  is_terminal           BOOLEAN                                       NOT NULL,
  proposed_by_id        UUID                                          NOT NULL,
  evidence_digest       CHAR(64)                                      NOT NULL,
  revokes_decision_id   UUID                                          NULL,
  revokes_decision_type public."HistoricalReconciliationDecisionType" NULL,
  decided_by_id         UUID                                          NOT NULL,
  reason                TEXT                                          NULL,
  idempotency_key       VARCHAR(200)                                  NOT NULL,
  created_at            TIMESTAMPTZ(3)                                NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT driver_cash_historical_reconciliation_decisions_pkey PRIMARY KEY (id),
  CONSTRAINT dchrd_is_terminal_chk CHECK (is_terminal = (decision <> 'APPROVED')),
  -- Review decisions need a second person (the copy of proposed_by_id is
  -- guaranteed correct by the composite FK below).
  CONSTRAINT dchrd_independent_reviewer_chk CHECK (
    decision NOT IN ('APPROVED', 'REJECTED') OR decided_by_id <> proposed_by_id
  ),
  -- REVOKED, and only REVOKED, names the APPROVED decision it ends.
  CONSTRAINT dchrd_revocation_shape_chk CHECK (
    ((decision = 'REVOKED') = (revokes_decision_id IS NOT NULL))
    AND ((revokes_decision_id IS NULL) = (revokes_decision_type IS NULL))
    AND (revokes_decision_type IS NULL OR revokes_decision_type = 'APPROVED')
  ),
  CONSTRAINT dchrd_reason_chk CHECK (
    (decision = 'APPROVED' AND (reason IS NULL OR length(btrim(reason)) > 0))
    OR (decision <> 'APPROVED' AND reason IS NOT NULL AND length(btrim(reason)) >= 20)
  ),
  CONSTRAINT dchrd_idempotency_key_not_blank_chk CHECK (length(btrim(idempotency_key)) > 0),

  -- Binds the decision to the reconciliation's exact proposer and evidence.
  -- ON UPDATE RESTRICT: once a decision exists those values are frozen.
  CONSTRAINT dchrd_reconciliation_evidence_fkey
    FOREIGN KEY (reconciliation_id, proposed_by_id, evidence_digest)
    REFERENCES public.driver_cash_historical_reconciliations(id, proposed_by_id, evidence_digest)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT dchrd_decided_by_id_fkey
    FOREIGN KEY (decided_by_id) REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE NO ACTION
);

-- FK targets: (id, reconciliation_id, decision) for revocation and
-- (id, reconciliation_id, is_terminal) for supersession.
CREATE UNIQUE INDEX IF NOT EXISTS dchrd_id_reconciliation_id_decision_key
  ON public.driver_cash_historical_reconciliation_decisions (id, reconciliation_id, decision);
CREATE UNIQUE INDEX IF NOT EXISTS dchrd_id_reconciliation_id_is_terminal_key
  ON public.driver_cash_historical_reconciliation_decisions (id, reconciliation_id, is_terminal);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dchrd_revokes_decision_fkey'
                   AND conrelid = 'public.driver_cash_historical_reconciliation_decisions'::regclass) THEN
    -- A revocation ends an APPROVED decision of the SAME reconciliation.
    ALTER TABLE public.driver_cash_historical_reconciliation_decisions
      ADD CONSTRAINT dchrd_revokes_decision_fkey
      FOREIGN KEY (revokes_decision_id, reconciliation_id, revokes_decision_type)
      REFERENCES public.driver_cash_historical_reconciliation_decisions(id, reconciliation_id, decision)
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS dchrd_idempotency_key_key
  ON public.driver_cash_historical_reconciliation_decisions (idempotency_key);
-- At most one review outcome per reconciliation: APPROVED, REJECTED or
-- WITHDRAWN. (REVOKED needs the APPROVED one, and at most one per approval.)
CREATE UNIQUE INDEX IF NOT EXISTS dchrd_one_outcome_per_reconciliation_uq
  ON public.driver_cash_historical_reconciliation_decisions (reconciliation_id)
  WHERE decision IN ('APPROVED', 'REJECTED', 'WITHDRAWN');
CREATE UNIQUE INDEX IF NOT EXISTS dchrd_revokes_decision_id_key
  ON public.driver_cash_historical_reconciliation_decisions (revokes_decision_id);
CREATE INDEX IF NOT EXISTS dchrd_reconciliation_id_created_at_idx
  ON public.driver_cash_historical_reconciliation_decisions (reconciliation_id, created_at);
CREATE INDEX IF NOT EXISTS dchrd_decided_by_id_idx
  ON public.driver_cash_historical_reconciliation_decisions (decided_by_id);

-- ---------------------------------------------------------------------------
-- 6. Supersession: a re-proposal must cite a TERMINAL decision
--    (REJECTED / WITHDRAWN / REVOKED) of the record it supersedes, so a live
--    PROPOSED or APPROVED record can never gain a sibling.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'dchr_supersedes_terminal_decision_fkey'
                   AND conrelid = 'public.driver_cash_historical_reconciliations'::regclass) THEN
    ALTER TABLE public.driver_cash_historical_reconciliations
      ADD CONSTRAINT dchr_supersedes_terminal_decision_fkey
      FOREIGN KEY (supersedes_decision_id, supersedes_reconciliation_id, supersedes_decision_is_terminal)
      REFERENCES public.driver_cash_historical_reconciliation_decisions(id, reconciliation_id, is_terminal)
      ON DELETE RESTRICT ON UPDATE RESTRICT;
  END IF;
END
$$;

COMMIT;
