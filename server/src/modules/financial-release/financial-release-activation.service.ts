// ============================================================
// Settlement-Based Financial Release — activation (FR.11A)
//
// GET  /api/v1/admin/financial-release             state
// GET  /api/v1/admin/financial-release/readiness   dry-run gate report
// POST /api/v1/admin/financial-release/activate
// POST /api/v1/admin/financial-release/deactivate
//
// ADMIN only (requireRole, decision A7). Contract:
// docs/settlement-financial-release-contract.md §10 (gates G0–G7).
//
// Activation is impossible unless the server environment carries
// FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED=true (G0) — unset by default and
// set only for an explicitly authorized production cutover. The gates only
// READ: they never modify balances or records. Deactivation is always
// allowed and affects future deliveries only — existing ON_SETTLEMENT
// orders keep their persisted mode and are processed as normal.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY, PENDING_RELEASE_HOLDS_CASH, isActivationValueEnabled } from "./financial-release.service";
import { runReconciliationChecks } from "./financial-release-reconciliation.service";
import { MAX_ALLOCATIONS_PER_SETTLEMENT } from "../settlements/settlement.schema";
import {
  ACCOUNT_COMPONENTS_TEXT,
  ACCOUNT_RESIDUAL_FAILS,
  INVALID_RECONCILIATIONS_WHERE,
  driverCashReconciliationWith,
} from "../historical-reconciliation/historical-reconciliation.sql";
import { getDriverCashHistoricalReconciliationSummary } from "../historical-reconciliation/historical-reconciliation.service";
import type { DriverCashHistoricalReconciliationSummary } from "../historical-reconciliation/historical-reconciliation.types";
import { unresolvedHistoricalOwnershipSql } from "../historical-ownership/historical-ownership.sql";
import { getHistoricalDispositions } from "../historical-ownership/historical-ownership.service";
import type { HistoricalDisposition } from "../historical-ownership/historical-ownership.types";

export const ACTIVATION_AUTHORIZATION_ENV = "FINANCIAL_RELEASE_ACTIVATION_AUTHORIZED";

// G7 handshake. The server build declares the contract it implements; the
// deployed client build must serve `/version.json` declaring the same one
// (client/public/version.json). An older client has no such file.
export const FINANCIAL_RELEASE_CONTRACT_VERSION = "FR.11";
export const CLIENT_VERSION_PATH = "/version.json";
const CLIENT_VERSION_TIMEOUT_MS = 3_000;

// The gate scans whole ledgers while holding the activation row (FOR
// UPDATE) and every driver cash account (FOR SHARE). That blocks deliveries
// and settlements, but only for this one-time Admin operation; the bound
// keeps a slow scan from holding them indefinitely. Measured in FR.11A.
export const ACTIVATION_TRANSACTION_TIMEOUT_MS = 30_000;
const ACTIVATION_TRANSACTION_MAX_WAIT_MS = 5_000;

const GATE_SAMPLE_LIMIT = 20;

export type GateId = "G0" | "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";

export interface GateFinding {
  entityType: string;
  entityId: string;
  detail: string;
}

export interface GateResult {
  id: GateId;
  title: string;
  passed: boolean;
  detail: string;
  affectedCount: number;
  findings: GateFinding[];
}

export interface ReadinessReport {
  evaluatedAt: string;
  ready: boolean;
  failedGates: GateId[];
  gates: GateResult[];
  // Legacy anomalies outside R1–R14 (H*). They do not block activation
  // (contract §11) but are always reported, never hidden.
  historicalFindings: { id: string; title: string; affectedCount: number }[];
  // FR.12A.4 — raw discrepancy, approved historical reconciliation, residual
  // and invalid evidence per account, always shown (null when G1 failed).
  driverCashHistoricalReconciliation: DriverCashHistoricalReconciliationSummary | null;
  // FR.12A.10 — deleted orders whose historical ownership G5 treats as
  // resolved by a recorded company-assumed liability, with the outstanding
  // amount. Always reported separately; never hidden inside a passing gate.
  historicalDispositions: HistoricalDisposition[];
}

export interface FinancialReleaseActivationState {
  enabled: boolean;
  environmentAuthorized: boolean;
  serverContractVersion: string;
  settingUpdatedAt: string | null;
}

export interface ActivationChangeResult {
  changed: boolean;
  state: FinancialReleaseActivationState;
  readiness: ReadinessReport | null;
}

export interface ClientContractProbe {
  url: string | null;
  contract: string | null;
  problem: string | null;
}

// ------------------------------------------------------------ G0 / G7 inputs

export function isActivationAuthorizedByEnvironment(): boolean {
  return process.env[ACTIVATION_AUTHORIZATION_ENV] === "true";
}

// Fetched BEFORE any transaction opens — no network I/O while locks are held.
export async function probeClientContract(): Promise<ClientContractProbe> {
  const base = process.env.CLIENT_URL?.trim();
  if (!base) return { url: null, contract: null, problem: "CLIENT_URL is not configured on the server" };
  let url: URL;
  try {
    url = new URL(CLIENT_VERSION_PATH, base.endsWith("/") ? base : `${base}/`);
  } catch {
    return { url: null, contract: null, problem: "CLIENT_URL is not a valid URL" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { url: url.toString(), contract: null, problem: "CLIENT_URL must use http or https" };
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(CLIENT_VERSION_TIMEOUT_MS), headers: { accept: "application/json", "cache-control": "no-cache" } });
    if (!res.ok) return { url: url.toString(), contract: null, problem: `client version endpoint returned HTTP ${res.status}` };
    const body = (await res.json()) as { financialReleaseContract?: unknown };
    const contract = typeof body?.financialReleaseContract === "string" ? body.financialReleaseContract : null;
    return { url: url.toString(), contract, problem: contract ? null : "client version endpoint does not declare financialReleaseContract" };
  } catch {
    return { url: url.toString(), contract: null, problem: "client version endpoint is unreachable or did not return JSON" };
  }
}

// ------------------------------------------------------------ gate queries

type CountedRow = { entity_type: string; entity_id: string; detail: string; total: number };

async function sampled(tx: Prisma.TransactionClient, sql: Prisma.Sql): Promise<{ affectedCount: number; findings: GateFinding[] }> {
  const rows = await tx.$queryRaw<CountedRow[]>`
    SELECT f.entity_type, f.entity_id, f.detail, (COUNT(*) OVER ())::int AS total
    FROM (${sql}) f
    ORDER BY f.entity_type, f.entity_id
    LIMIT ${GATE_SAMPLE_LIMIT}
  `;
  return {
    affectedCount: rows[0]?.total ?? 0,
    findings: rows.map((r) => ({ entityType: r.entity_type, entityId: r.entity_id, detail: r.detail })),
  };
}

function gate(id: GateId, title: string, result: { affectedCount: number; findings: GateFinding[] }, passDetail: string, failDetail: string): GateResult {
  const passed = result.affectedCount === 0;
  return { id, title, passed, detail: passed ? passDetail : failDetail, ...result };
}

// Every schema object settlement-based release depends on (contract §3),
// plus the ledger idempotency keys the release reuses.
const REQUIRED_SCHEMA: [kind: string, name: string][] = [
  ["type", "FinancialReleaseMode"],
  ["type", "FinancialReleaseStatus"],
  ["type", "FinancialReleaseReviewStatus"],
  ["type", "DriverSettlementCorrectionType"],
  ["type", "OrderFinancialReleaseCorrectionType"],
  ["enum", "AWAITING_SETTLEMENT"],
  ["enum", "COLLECTION_VOIDED"],
  ["enum", "RELEASE_REVERSED"],
  ["column", "orders.financial_release_mode"],
  ["column", "driver_settlements.allocated_total"],
  ["column", "driver_settlements.unattributed_amount"],
  ["column", "driver_settlements.unattributed_reason"],
  ["table", "order_financial_releases"],
  ["table", "driver_settlement_allocations"],
  ["table", "driver_settlement_corrections"],
  ["table", "order_financial_release_corrections"],
  ["constraint", "ofr_collection_amount_positive_chk"],
  ["constraint", "ofr_allocated_amount_range_chk"],
  ["constraint", "ofr_planned_presence_chk"],
  ["constraint", "ofr_planned_values_chk"],
  ["constraint", "ofr_order_type_buckets_chk"],
  ["constraint", "ofr_release_state_chk"],
  ["constraint", "ofr_posted_transactions_chk"],
  ["constraint", "orders_financial_release_mode_delivered_chk"],
  ["constraint", "driver_settlements_allocation_metadata_presence_chk"],
  ["constraint", "driver_settlements_allocation_metadata_values_chk"],
  ["constraint", "driver_settlements_unattributed_reason_chk"],
  ["constraint", "dsa_amount_positive_chk"],
  ["constraint", "driver_settlement_allocations_release_id_driver_id_fkey"],
  ["constraint", "driver_settlement_allocations_settlement_id_driver_id_fkey"],
  ["constraint", "ofrc_type_shape_chk"],
  ["constraint", "ofrc_reason_meaningful_chk"],
  ["unique_index", "order_financial_releases_order_id_key"],
  ["unique_index", "order_financial_releases_collection_transaction_id_key"],
  ["unique_index", "order_financial_releases_wallet_transaction_id_key"],
  ["unique_index", "order_financial_releases_company_product_transaction_id_key"],
  ["unique_index", "order_financial_releases_company_fee_transaction_id_key"],
  ["unique_index", "order_financial_releases_id_driver_id_key"],
  ["unique_index", "driver_settlements_id_driver_id_key"],
  ["unique_index", "driver_settlement_allocations_settlement_id_release_id_key"],
  ["unique_index", "dsc_one_reversal_per_settlement_uq"],
  ["unique_index", "order_financial_release_corrections_release_id_key"],
  ["unique_index", "wallet_transactions_idempotency_key_key"],
  ["unique_index", "company_financial_transactions_idempotency_key_key"],
  ["unique_index", "driver_cash_transactions_idempotency_key_key"],
  ["unique_index", "driver_settlement_corrections_idempotency_key_key"],
  ["unique_index", "order_financial_release_corrections_idempotency_key_key"],
  ["setting", FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY],
  // FR.12A.3 historical reconciliation schema — G3 and G5 read it (FR.12A.4).
  ["type", "FinancialLedgerIncidentCause"],
  ["type", "DriverCashHistoricalReconciliationKind"],
  ["type", "HistoricalReconciliationAccountingTreatment"],
  ["type", "HistoricalOwnershipStatus"],
  ["type", "HistoricalReconciliationDecisionType"],
  ["table", "financial_ledger_incidents"],
  ["table", "driver_cash_historical_reconciliations"],
  ["table", "driver_cash_historical_reconciliation_decisions"],
  ["constraint", "dchr_evidence_digest_chk"],
  ["constraint", "dchr_ownership_unresolved_chk"],
  ["constraint", "dchr_account_id_driver_id_fkey"],
  ["constraint", "dchr_anchor_transaction_fkey"],
  ["constraint", "dchr_predecessor_transaction_fkey"],
  ["constraint", "dchr_source_audit_log_id_fkey"],
  ["constraint", "dchrd_independent_reviewer_chk"],
  ["constraint", "dchrd_reconciliation_evidence_fkey"],
  ["constraint", "dchrd_revokes_decision_fkey"],
  ["unique_index", "dchr_root_anchor_uq"],
  ["unique_index", "dchr_root_missing_transaction_uq"],
  ["unique_index", "dchr_root_source_audit_uq"],
  ["unique_index", "dchrd_one_outcome_per_reconciliation_uq"],
  // FR.12A.9 historical ownership / liability schema — G5 and R14 read it (FR.12A.10).
  ["type", "HistoricalOwnershipOutcome"],
  ["type", "HistoricalCollectionVerification"],
  ["type", "HistoricalOwnershipEvidenceKind"],
  ["table", "historical_liability_policies"],
  ["table", "historical_liability_policy_decisions"],
  ["table", "historical_ownership_resolutions"],
  ["table", "historical_ownership_resolution_evidence"],
  ["table", "historical_ownership_resolution_decisions"],
  ["table", "historical_liabilities"],
  ["table", "historical_liability_reviews"],
  ["constraint", "hlp_policy_digest_chk"],
  ["constraint", "hlpd_independent_reviewer_chk"],
  ["constraint", "hlpd_independent_revoker_chk"],
  ["constraint", "hor_resolution_digest_chk"],
  ["constraint", "hor_l1_full_collection_held_chk"],
  ["constraint", "hor_l2_shortfall_tracked_chk"],
  ["constraint", "hord_independent_reviewer_chk"],
  ["constraint", "hord_independent_revoker_chk"],
  ["constraint", "hord_resolution_digest_fkey"],
  ["constraint", "hl_independent_recorder_chk"],
  ["constraint", "hl_liability_digest_chk"],
  ["constraint", "hl_resolution_binding_fkey"],
  ["constraint", "hl_approval_decision_fkey"],
  ["unique_index", "hor_root_deleted_order_uq"],
  ["unique_index", "hord_one_outcome_per_resolution_uq"],
  ["unique_index", "hl_resolution_id_key"],
];

async function schemaGate(tx: Prisma.TransactionClient): Promise<GateResult> {
  const values = Prisma.join(REQUIRED_SCHEMA.map(([kind, name]) => Prisma.sql`(${kind}, ${name})`));
  const result = await sampled(
    tx,
    Prisma.sql`
      SELECT 'SCHEMA_' || upper(x.kind) AS entity_type, x.name AS entity_id, 'required object is missing' AS detail
      FROM (VALUES ${values}) AS x(kind, name)
      WHERE NOT CASE x.kind
        WHEN 'type' THEN EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = x.name)
        WHEN 'enum' THEN EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'OrderFinancialStatus' AND e.enumlabel = x.name)
        WHEN 'column' THEN EXISTS (SELECT 1 FROM information_schema.columns c WHERE c.table_schema = 'public'
                                     AND c.table_name = split_part(x.name, '.', 1) AND c.column_name = split_part(x.name, '.', 2))
        WHEN 'table' THEN to_regclass('public.' || x.name) IS NOT NULL
        WHEN 'constraint' THEN EXISTS (SELECT 1 FROM pg_constraint k JOIN pg_namespace n ON n.oid = k.connamespace WHERE n.nspname = 'public' AND k.conname = x.name)
        WHEN 'unique_index' THEN EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_namespace n ON n.oid = c.relnamespace
                                         WHERE n.nspname = 'public' AND c.relname = x.name AND i.indisunique)
        WHEN 'setting' THEN EXISTS (SELECT 1 FROM system_settings s WHERE s.key = x.name AND jsonb_typeof(s.value::jsonb) = 'boolean')
        ELSE false END
    `
  );
  return gate(
    "G1",
    "Schema readiness",
    result,
    `All ${REQUIRED_SCHEMA.length} required schema objects and the seeded activation setting exist`,
    "Required schema objects are missing — apply the financial release and historical reconciliation migrations first"
  );
}

async function evaluateGates(tx: Prisma.TransactionClient, client: ClientContractProbe): Promise<ReadinessReport> {
  const authorized = isActivationAuthorizedByEnvironment();
  const g0: GateResult = {
    id: "G0",
    title: "Cutover authorization",
    passed: authorized,
    detail: authorized
      ? `${ACTIVATION_AUTHORIZATION_ENV}=true is set on the server`
      : `${ACTIVATION_AUTHORIZATION_ENV} is not set to true — activation has not been authorized for this environment`,
    affectedCount: authorized ? 0 : 1,
    findings: [],
  };

  const g1 = await schemaGate(tx);
  // G2–G6 query objects G1 verifies; without them they cannot run.
  if (!g1.passed) {
    const skipped = (id: GateId, title: string): GateResult => ({
      id,
      title,
      passed: false,
      detail: "Not evaluated — schema readiness (G1) failed",
      affectedCount: 0,
      findings: [],
    });
    const gates = [
      g0,
      g1,
      skipped("G2", "Zero unattributed driver cash"),
      skipped("G3", "Driver cash ledger integrity"),
      skipped("G4", "Customer wallet ledger integrity"),
      skipped("G5", "No outstanding legacy obligations"),
      skipped("G6", "Reconciliation R1–R14"),
      clientGate(client),
    ];
    return report(gates, [], null, []);
  }

  const g2 = gate(
    "G2",
    "Zero unattributed driver cash",
    await sampled(
      tx,
      Prisma.sql`
        SELECT 'DRIVER' AS entity_type, a.driver_id::text AS entity_id,
               'unattributed cash ' || (a.current_balance - COALESCE(o.outstanding, 0))::text AS detail
        FROM driver_cash_accounts a
        LEFT JOIN (SELECT r.driver_id, SUM(r.collection_amount - r.allocated_amount) AS outstanding
                   FROM order_financial_releases r WHERE ${PENDING_RELEASE_HOLDS_CASH} GROUP BY r.driver_id) o
          ON o.driver_id = a.driver_id
        WHERE a.current_balance - COALESCE(o.outstanding, 0) <> 0
      `
    ),
    "No driver holds unattributed (legacy, adjustment or correction) cash",
    "Drivers hold unattributed cash — settle it to zero through normal settlements before activation"
  );

  // FR.12A.4 residual rule (historical-reconciliation.sql.ts, shared with R1):
  // an account fails when stored − ledger net − approved valid historical
  // reconciliation ≠ 0, when it carries an invalid historical approval, or
  // (unchanged) when its latest row does not end at the stored balance. An
  // account without reconciliation records yields exactly the previous finding.
  const g3 = gate(
    "G3",
    "Driver cash ledger integrity",
    await sampled(
      tx,
      Prisma.sql`
        ${Prisma.raw(driverCashReconciliationWith(true))}
        SELECT 'DRIVER_CASH_ACCOUNT' AS entity_type, d.driver_id::text AS entity_id,
               CASE WHEN d.reconciliation_count = 0
                    THEN 'cached ' || d.stored_balance::text || ', ledger net ' || d.raw_ledger_net::text
                    ELSE ${Prisma.raw(ACCOUNT_COMPONENTS_TEXT)}
                         || CASE WHEN d.latest_balance_matches THEN '' ELSE '; the latest ledger row does not end at the stored balance' END
               END AS detail
        FROM dc_accounts d
        WHERE ${Prisma.raw(ACCOUNT_RESIDUAL_FAILS)} OR NOT d.latest_balance_matches
        UNION ALL
        SELECT 'DRIVER_CASH_HISTORICAL_RECONCILIATION', e.id::text,
               'approved historical reconciliation is not valid evidence: ' || array_to_string(e.failures, ', ')
        FROM hr_evaluated e
        WHERE ${Prisma.raw(INVALID_RECONCILIATIONS_WHERE)}
      `
    ),
    "Every driver cash account equals its ledger net plus any approved, valid historical reconciliation, and its latest balance_after",
    "Driver cash accounts disagree with their ledger (after approved historical reconciliation), or historical evidence is invalid"
  );

  const g4 = gate(
    "G4",
    "Customer wallet ledger integrity",
    await sampled(
      tx,
      Prisma.sql`
        SELECT 'CUSTOMER_WALLET' AS entity_type, w.customer_id::text AS entity_id,
               'cached ' || w.available_balance::text || ', ledger net ' || COALESCE(t.net, 0)::text AS detail
        FROM customer_wallets w
        LEFT JOIN (SELECT wallet_id, SUM(credit - debit) AS net FROM wallet_transactions GROUP BY wallet_id) t ON t.wallet_id = w.id
        WHERE w.available_balance <> COALESCE(t.net, 0)
      `
    ),
    "Every customer wallet equals its ledger net",
    "Customer wallets disagree with their ledger"
  );

  const g5 = gate(
    "G5",
    "No outstanding legacy obligations",
    await sampled(
      tx,
      Prisma.sql`
        SELECT 'ORDER' AS entity_type, o.id::text AS entity_id, 'legacy delivered order awaiting collection-difference review' AS detail
        FROM orders o
        WHERE o.financial_release_mode IS NULL AND o.status = 'DELIVERED' AND o.financial_status = 'REVIEW_REQUIRED'
        UNION ALL
        SELECT 'DRIVER_SETTLEMENT', d.id::text, 'settlement has no linked driver cash SETTLEMENT transaction'
        FROM driver_settlements d
        WHERE NOT EXISTS (SELECT 1 FROM driver_cash_transactions x WHERE x.settlement_id = d.id)
        UNION ALL
        -- FR.12A.4: a deleted order whose collection difference was never
        -- resolved, and every historical reconciliation whose ownership is
        -- UNRESOLVED (whatever its decision status). Approving a ledger
        -- reconciliation never decides who owns the money.
        SELECT 'DELETED_ORDER', u.order_ref,
               'order deleted while its collection difference was unresolved — ownership of the collected amount is undetermined ('
                 || u.sources || ')'
        FROM (${Prisma.raw(unresolvedHistoricalOwnershipSql(true, true))}) u
      `
    ),
    "No legacy collection difference awaits review, no historical ownership is unresolved (a deleted order counts as resolved only by an approved, valid, recorded historical liability) and every settlement is linked to its cash debit",
    "Legacy obligations are outstanding — resolve them before activation"
  );

  // FR.12A.10 — dispositions G5 accepted, reported beside it (never hidden).
  const historicalDispositions = await getHistoricalDispositions(tx);
  if (g5.passed && historicalDispositions.length > 0) {
    const outstanding = historicalDispositions.reduce((sum, d) => sum.plus(d.outstandingAmount), new Prisma.Decimal(0));
    g5.detail += ` (${historicalDispositions.length} deleted order(s) resolved by recorded historical liabilities; outstanding ${outstanding.toFixed(2)})`;
  }

  const checks = await runReconciliationChecks(tx);
  const failing = checks.filter((c) => c.kind === "INVARIANT" && c.status === "FAIL");
  const g6: GateResult = {
    id: "G6",
    title: "Reconciliation R1–R14",
    passed: failing.length === 0,
    detail:
      failing.length === 0
        ? "Every reconciliation invariant (R1–R14) holds"
        : `Reconciliation invariants fail: ${failing.map((c) => `${c.id} (${c.affectedCount})`).join(", ")}`,
    affectedCount: failing.reduce((s, c) => s + c.affectedCount, 0),
    findings: failing.flatMap((c) =>
      c.findings.slice(0, 5).map((f) => ({ entityType: f.entityType, entityId: f.entityId, detail: `${c.id}: ${f.detail} (${f.classification})` }))
    ),
  };
  const historical = checks
    .filter((c) => c.kind === "HISTORICAL")
    .map((c) => ({ id: c.id, title: c.title, affectedCount: c.affectedCount }));

  const reconciliation = await getDriverCashHistoricalReconciliationSummary(tx, true);
  if (g3.passed && reconciliation.totals.approvedHistoricalAmount !== "0.00") {
    g3.detail += ` (raw discrepancy ${reconciliation.totals.rawDiscrepancy} explained by approved historical reconciliation ${reconciliation.totals.approvedHistoricalAmount})`;
  }

  return report([g0, g1, g2, g3, g4, g5, g6, clientGate(client)], historical, reconciliation, historicalDispositions);
}

function clientGate(client: ClientContractProbe): GateResult {
  const passed = client.problem === null && client.contract === FINANCIAL_RELEASE_CONTRACT_VERSION;
  return {
    id: "G7",
    title: "Deployment readiness (client/server contract)",
    passed,
    detail: passed
      ? `Server and deployed client both implement ${FINANCIAL_RELEASE_CONTRACT_VERSION}`
      : client.problem ??
        `Deployed client declares ${client.contract}; the server requires ${FINANCIAL_RELEASE_CONTRACT_VERSION}`,
    affectedCount: passed ? 0 : 1,
    findings: client.url ? [{ entityType: "CLIENT_BUILD", entityId: client.url, detail: `financialReleaseContract=${client.contract ?? "none"}` }] : [],
  };
}

function report(
  gates: GateResult[],
  historicalFindings: ReadinessReport["historicalFindings"],
  driverCashHistoricalReconciliation: DriverCashHistoricalReconciliationSummary | null,
  historicalDispositions: HistoricalDisposition[]
): ReadinessReport {
  const failedGates = gates.filter((g) => !g.passed).map((g) => g.id);
  return {
    evaluatedAt: new Date().toISOString(),
    ready: failedGates.length === 0,
    failedGates,
    gates,
    historicalFindings,
    driverCashHistoricalReconciliation,
    historicalDispositions,
  };
}

// ------------------------------------------------------------ state

async function readState(db: Prisma.TransactionClient | typeof prisma): Promise<FinancialReleaseActivationState> {
  const setting = await db.system_settings.findUnique({ where: { key: FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY } });
  return {
    enabled: isActivationValueEnabled(setting?.value),
    environmentAuthorized: isActivationAuthorizedByEnvironment(),
    serverContractVersion: FINANCIAL_RELEASE_CONTRACT_VERSION,
    settingUpdatedAt: setting ? setting.updated_at.toISOString() : null,
  };
}

export async function getFinancialReleaseActivationState(): Promise<FinancialReleaseActivationState> {
  return readState(prisma);
}

// Dry run: the same gates in one read-only snapshot, without the
// activation locks. Nothing is written.
export async function getFinancialReleaseReadiness(): Promise<ReadinessReport> {
  const client = await probeClientContract();
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      return evaluateGates(tx, client);
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: ACTIVATION_TRANSACTION_TIMEOUT_MS,
      maxWait: ACTIVATION_TRANSACTION_MAX_WAIT_MS,
    }
  );
}

// ------------------------------------------------------------ activate / deactivate

async function lockActivationSetting(tx: Prisma.TransactionClient): Promise<{ id: string; value: unknown } | null> {
  const rows = await tx.$queryRaw<{ id: string; value: unknown }[]>`
    SELECT id, value FROM system_settings WHERE key = ${FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY} FOR UPDATE
  `;
  return rows[0] ?? null;
}

export async function activateFinancialRelease(actorUserId: string): Promise<ActivationChangeResult> {
  // G0 first and without touching the database: an unauthorized environment
  // never takes the activation locks or scans the ledgers.
  if (!isActivationAuthorizedByEnvironment()) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "Financial release activation is not authorized for this environment",
      details: { reason: "ACTIVATION_GATE_FAILED", failedGates: ["G0"] },
    });
  }
  const client = await probeClientContract();

  return prisma.$transaction(
    async (tx) => {
      // Lock order (contract §6 / §10): activation row -> every driver cash
      // account. In-flight deliveries hold the row FOR SHARE, so this waits
      // for them and then blocks new ones until the decision commits.
      const setting = await lockActivationSetting(tx);
      if (setting && isActivationValueEnabled(setting.value)) {
        return { changed: false, state: await readState(tx), readiness: null };
      }
      await tx.$executeRaw`SELECT id FROM driver_cash_accounts ORDER BY id FOR SHARE`;

      const readiness = await evaluateGates(tx, client);
      if (!readiness.ready || !setting) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Financial release activation gates failed — nothing was changed",
          details: { reason: "ACTIVATION_GATE_FAILED", failedGates: readiness.failedGates, gates: readiness.gates },
        });
      }

      const now = new Date();
      await tx.system_settings.update({
        where: { key: FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY },
        data: { value: true, updated_by_id: actorUserId, updated_at: now },
      });
      await createAuditLog(tx, {
        actorUserId,
        action: "FINANCIAL_RELEASE_ACTIVATED",
        entityType: "SYSTEM_SETTING",
        entityId: setting.id,
        previousValues: { enabled: false },
        newValues: { enabled: true },
        metadata: {
          key: FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY,
          serverContractVersion: FINANCIAL_RELEASE_CONTRACT_VERSION,
          gates: readiness.gates.map((g) => ({ id: g.id, passed: g.passed, detail: g.detail })),
          historicalFindings: readiness.historicalFindings,
        },
      });
      return { changed: true, state: await readState(tx), readiness };
    },
    { timeout: ACTIVATION_TRANSACTION_TIMEOUT_MS, maxWait: ACTIVATION_TRANSACTION_MAX_WAIT_MS }
  );
}

// Always allowed (no gates, no environment authorization): turning the
// feature off only changes how FUTURE deliveries are recorded.
export async function deactivateFinancialRelease(actorUserId: string): Promise<ActivationChangeResult> {
  return prisma.$transaction(async (tx) => {
    const setting = await lockActivationSetting(tx);
    if (!setting) {
      console.error("[financial-release-activation] activation setting row is missing — nothing to deactivate");
      throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Financial release activation setting is missing" });
    }
    if (!isActivationValueEnabled(setting.value) && setting.value === false) {
      return { changed: false, state: await readState(tx), readiness: null };
    }
    const now = new Date();
    await tx.system_settings.update({
      where: { key: FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY },
      data: { value: false, updated_by_id: actorUserId, updated_at: now },
    });
    await createAuditLog(tx, {
      actorUserId,
      action: "FINANCIAL_RELEASE_DEACTIVATED",
      entityType: "SYSTEM_SETTING",
      entityId: setting.id,
      previousValues: { enabled: isActivationValueEnabled(setting.value) },
      newValues: { enabled: false },
      metadata: { key: FINANCIAL_RELEASE_ACTIVATION_SETTING_KEY },
    });
    return { changed: true, state: await readState(tx), readiness: null };
  });
}

// ------------------------------------------------------------ latency probe (FR.11B)
//
// GET /api/v1/admin/financial-release/latency-probe — read-only. Measures the
// database round-trip time from wherever THIS server runs (in production: the
// deployed function region -> the database pooler), which decides the
// settlement allocation limit (docs/fr11a-release-readiness.md §1.6). It only
// runs `SELECT 1`; it never writes and never touches financial rows.

// Settlement cost model measured in FR.11A: in-transaction round trips
// ≈ 28 + 3 × (Delivery Only allocations). Budget: 40 % of Prisma's 5 s
// interactive-transaction timeout, which is NOT raised.
export const SETTLEMENT_FIXED_ROUND_TRIPS = 28;
export const SETTLEMENT_ROUND_TRIPS_PER_ALLOCATION = 3;
export const SETTLEMENT_TRANSACTION_BUDGET_MS = 2_000;
export const CURRENT_MAX_ALLOCATIONS = MAX_ALLOCATIONS_PER_SETTLEMENT;

export const LATENCY_PROBE_DEFAULT_SAMPLES = 200;
export const LATENCY_PROBE_MIN_SAMPLES = 50;
export const LATENCY_PROBE_MAX_SAMPLES = 500;
const LATENCY_PROBE_STATEMENTS_PER_TRANSACTION = 20;

export interface LatencyStats {
  samples: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
}

export type AllocationLimitVerdict = "LIMIT_CONFIRMED" | "REDUCE_LIMIT" | "DO_NOT_ACTIVATE";

export interface LatencyProbeReport {
  measuredAt: string;
  singleStatement: LatencyStats;
  inTransaction: LatencyStats | null;
  inTransactionError: string | null;
  // The larger p95 of the two series — the conservative input.
  decisionP95Ms: number;
  recommendedMaxAllocations: number;
  currentMaxAllocations: number;
  verdict: AllocationLimitVerdict;
  model: string;
}

// Nearest-rank percentile: the smallest value with at least p % of the
// samples at or below it.
export function percentile(sortedAscending: number[], p: number): number {
  if (sortedAscending.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sortedAscending.length);
  return sortedAscending[Math.min(Math.max(rank, 1), sortedAscending.length) - 1];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function latencyStats(samplesMs: number[]): LatencyStats {
  const s = [...samplesMs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / (s.length || 1);
  return {
    samples: s.length,
    minMs: round2(s[0] ?? 0),
    p50Ms: round2(percentile(s, 50)),
    p95Ms: round2(percentile(s, 95)),
    p99Ms: round2(percentile(s, 99)),
    maxMs: round2(s[s.length - 1] ?? 0),
    meanMs: round2(mean),
  };
}

// Largest allocation count whose worst case (all Delivery Only) stays within
// the transaction budget at this RTT, never above the current limit.
export function recommendedAllocationLimit(p95Ms: number): number {
  if (!(p95Ms > 0)) return CURRENT_MAX_ALLOCATIONS;
  const fit = Math.floor((SETTLEMENT_TRANSACTION_BUDGET_MS / p95Ms - SETTLEMENT_FIXED_ROUND_TRIPS) / SETTLEMENT_ROUND_TRIPS_PER_ALLOCATION);
  return Math.max(0, Math.min(CURRENT_MAX_ALLOCATIONS, fit));
}

export function allocationLimitVerdict(limit: number): AllocationLimitVerdict {
  if (limit >= CURRENT_MAX_ALLOCATIONS) return "LIMIT_CONFIRMED";
  if (limit >= 1) return "REDUCE_LIMIT";
  return "DO_NOT_ACTIVATE";
}

export async function probeDatabaseLatency(samples = LATENCY_PROBE_DEFAULT_SAMPLES): Promise<LatencyProbeReport> {
  const n = Math.min(Math.max(Math.trunc(samples), LATENCY_PROBE_MIN_SAMPLES), LATENCY_PROBE_MAX_SAMPLES);
  // Warm-up: open pooled connections before measuring.
  for (let i = 0; i < 5; i++) await prisma.$queryRaw`SELECT 1`;

  const single: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await prisma.$queryRaw`SELECT 1`;
    single.push(performance.now() - t0);
  }

  // Settlements run on ONE connection inside a transaction; measure that too,
  // in short read-only transactions so the default timeout is never stretched.
  const inTx: number[] = [];
  let inTransactionError: string | null = null;
  try {
    while (inTx.length < n) {
      const batch = Math.min(LATENCY_PROBE_STATEMENTS_PER_TRANSACTION, n - inTx.length);
      await prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        for (let i = 0; i < batch; i++) {
          const t0 = performance.now();
          await tx.$queryRaw`SELECT 1`;
          inTx.push(performance.now() - t0);
        }
      });
    }
  } catch (error) {
    inTransactionError =
      error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2028"
        ? `a ${LATENCY_PROBE_STATEMENTS_PER_TRANSACTION}-statement read-only transaction exceeded the 5 s timeout`
        : "the in-transaction measurement failed";
    console.error("[financial-release-activation] latency probe in-transaction measurement failed:", error);
  }

  const singleStatement = latencyStats(single);
  const inTransaction = inTx.length > 0 ? latencyStats(inTx) : null;
  const decisionP95Ms = inTransactionError ? Number.POSITIVE_INFINITY : Math.max(singleStatement.p95Ms, inTransaction?.p95Ms ?? 0);
  const recommendedMaxAllocations = Number.isFinite(decisionP95Ms) ? recommendedAllocationLimit(decisionP95Ms) : 0;
  return {
    measuredAt: new Date().toISOString(),
    singleStatement,
    inTransaction,
    inTransactionError,
    decisionP95Ms: Number.isFinite(decisionP95Ms) ? decisionP95Ms : -1,
    recommendedMaxAllocations,
    currentMaxAllocations: CURRENT_MAX_ALLOCATIONS,
    verdict: allocationLimitVerdict(recommendedMaxAllocations),
    model: `worst case ≈ (${SETTLEMENT_FIXED_ROUND_TRIPS} + ${SETTLEMENT_ROUND_TRIPS_PER_ALLOCATION} × allocations) round trips × p95 RTT ≤ ${SETTLEMENT_TRANSACTION_BUDGET_MS} ms (40 % of the unchanged 5 s transaction timeout)`,
  };
}
