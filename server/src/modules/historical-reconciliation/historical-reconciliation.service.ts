// ============================================================
// FR.12A.4 — Driver cash historical reconciliation: READ-ONLY evaluation.
//
// Runs the shared SQL (historical-reconciliation.sql.ts) in the CALLER's
// transaction, so G3 / R1 / G5 and the reports read one consistent snapshot.
// Nothing here writes: no balance, ledger row, wallet, revenue, settlement or
// reconciliation record is ever changed, and no endpoint creates or decides
// a reconciliation (FR.12A.5).
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import {
  driverCashReconciliationWith,
  HISTORICAL_RECONCILIATION_SCHEMA_PRESENT_SQL,
  INVALID_RECONCILIATIONS_WHERE,
} from "./historical-reconciliation.sql";
import type {
  DriverCashAccountReconciliationEntry,
  DriverCashHistoricalReconciliationSummary,
  EvidenceValidityFailure,
  HistoricalReconciliationEvaluatedStatus,
  HistoricalReconciliationEvaluationEntry,
} from "./historical-reconciliation.types";
import type { HistoricalOwnershipStatus } from "../../generated/prisma/client";

export const HISTORICAL_RECONCILIATION_SUMMARY_LIMIT = 50;

type Db = Pick<Prisma.TransactionClient, "$queryRaw" | "$queryRawUnsafe">;

export async function isHistoricalReconciliationSchemaPresent(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ present: boolean }[]>(Prisma.raw(HISTORICAL_RECONCILIATION_SCHEMA_PRESENT_SQL));
  return rows[0]?.present === true;
}

type AccountRow = {
  account_id: string;
  driver_id: string;
  stored_balance: Prisma.Decimal;
  raw_ledger_net: Prisma.Decimal;
  raw_discrepancy: Prisma.Decimal;
  approved_historical_amount: Prisma.Decimal;
  unexplained_residual: Prisma.Decimal;
  invalid_approved_count: number;
  reconciliation_count: number;
  latest_balance_matches: boolean;
  total: number;
};

type EvaluationRow = {
  id: string;
  incident_id: string;
  account_id: string;
  driver_id: string;
  status: HistoricalReconciliationEvaluatedStatus;
  amount: Prisma.Decimal;
  ownership_status: HistoricalOwnershipStatus;
  deleted_order_reference: string;
  failures: EvidenceValidityFailure[];
  blocking: boolean;
  total: number;
};

const dec = (v: Prisma.Decimal | string | number) => new Prisma.Decimal(v.toString());

function toAccountEntry(r: AccountRow): DriverCashAccountReconciliationEntry {
  return {
    accountId: r.account_id,
    driverId: r.driver_id,
    storedBalance: dec(r.stored_balance).toFixed(2),
    rawLedgerNet: dec(r.raw_ledger_net).toFixed(2),
    rawDiscrepancy: dec(r.raw_discrepancy).toFixed(2),
    approvedHistoricalAmount: dec(r.approved_historical_amount).toFixed(2),
    unexplainedResidual: dec(r.unexplained_residual).toFixed(2),
    invalidApprovedCount: Number(r.invalid_approved_count),
    reconciliationCount: Number(r.reconciliation_count),
    latestBalanceMatches: r.latest_balance_matches,
  };
}

function toEvaluationEntry(r: EvaluationRow): HistoricalReconciliationEvaluationEntry {
  const evidenceValid = r.failures.length === 0;
  return {
    reconciliationId: r.id,
    incidentId: r.incident_id,
    accountId: r.account_id,
    driverId: r.driver_id,
    status: r.status,
    amount: dec(r.amount).toFixed(2),
    ownershipStatus: r.ownership_status,
    deletedOrderReference: r.deleted_order_reference,
    evidenceValid,
    failures: r.failures,
    contributes: r.status === "APPROVED" && evidenceValid,
    blocking: r.blocking,
  };
}

// Per-account S / N / D / A / R / X. `accountIds` narrows to those accounts;
// `notableOnly` keeps accounts with a raw discrepancy or any reconciliation.
export async function getDriverCashAccountReconciliations(
  db: Db,
  opts: { schemaPresent?: boolean; accountIds?: string[]; notableOnly?: boolean; limit?: number } = {}
): Promise<{ entries: DriverCashAccountReconciliationEntry[]; total: number }> {
  const schemaPresent = opts.schemaPresent ?? (await isHistoricalReconciliationSchemaPresent(db));
  const conditions: Prisma.Sql[] = [Prisma.sql`true`];
  if (opts.accountIds) conditions.push(Prisma.sql`d.account_id = ANY(${opts.accountIds}::uuid[])`);
  if (opts.notableOnly) conditions.push(Prisma.sql`(d.raw_discrepancy <> 0 OR d.reconciliation_count > 0)`);
  const limit = opts.limit ?? 100_000;
  const rows = await db.$queryRaw<AccountRow[]>`
    ${Prisma.raw(driverCashReconciliationWith(schemaPresent))}
    SELECT d.*, (COUNT(*) OVER ())::int AS total
    FROM dc_accounts d
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY d.driver_id
    LIMIT ${limit}
  `;
  return { entries: rows.map(toAccountEntry), total: rows[0]?.total ?? 0 };
}

// Every reconciliation record with its derived status and V1–V7 failures.
export async function evaluateHistoricalReconciliations(
  db: Db,
  opts: {
    accountIds?: string[];
    driverIds?: string[];
    reconciliationIds?: string[];
    incidentIds?: string[];
    statuses?: HistoricalReconciliationEvaluatedStatus[];
    limit?: number;
    offset?: number;
  } = {}
): Promise<{ entries: HistoricalReconciliationEvaluationEntry[]; total: number }> {
  if (!(await isHistoricalReconciliationSchemaPresent(db))) return { entries: [], total: 0 };
  const conditions: Prisma.Sql[] = [Prisma.sql`true`];
  if (opts.accountIds) conditions.push(Prisma.sql`e.account_id = ANY(${opts.accountIds}::uuid[])`);
  if (opts.driverIds) conditions.push(Prisma.sql`e.driver_id = ANY(${opts.driverIds}::uuid[])`);
  if (opts.reconciliationIds) conditions.push(Prisma.sql`e.id = ANY(${opts.reconciliationIds}::uuid[])`);
  if (opts.incidentIds) conditions.push(Prisma.sql`e.incident_id = ANY(${opts.incidentIds}::uuid[])`);
  if (opts.statuses) conditions.push(Prisma.sql`e.status = ANY(${opts.statuses}::text[])`);
  const limit = opts.limit ?? 100_000;
  const offset = opts.offset ?? 0;
  const rows = await db.$queryRaw<EvaluationRow[]>`
    ${Prisma.raw(driverCashReconciliationWith(true))}
    SELECT e.id, e.incident_id, e.account_id, e.driver_id, e.status, e.amount, e.ownership_status::text AS ownership_status,
           e.deleted_order_reference, e.failures, ${Prisma.raw(INVALID_RECONCILIATIONS_WHERE)} AS blocking,
           (COUNT(*) OVER ())::int AS total
    FROM hr_evaluated e
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY e.driver_id, e.id
    LIMIT ${limit} OFFSET ${offset}
  `;
  return { entries: rows.map(toEvaluationEntry), total: rows[0]?.total ?? 0 };
}

// The bounded, always-visible summary attached to the readiness report and
// the reconciliation report: raw discrepancy, approved amount, residual and
// invalid evidence, side by side.
export async function getDriverCashHistoricalReconciliationSummary(
  db: Db,
  schemaPresent?: boolean
): Promise<DriverCashHistoricalReconciliationSummary> {
  const present = schemaPresent ?? (await isHistoricalReconciliationSchemaPresent(db));
  const accounts = await getDriverCashAccountReconciliations(db, {
    schemaPresent: present,
    notableOnly: true,
    limit: HISTORICAL_RECONCILIATION_SUMMARY_LIMIT,
  });
  const reconciliations = present
    ? await evaluateHistoricalReconciliations(db, { limit: HISTORICAL_RECONCILIATION_SUMMARY_LIMIT })
    : { entries: [], total: 0 };
  const [totals] = await db.$queryRaw<
    { raw: Prisma.Decimal; approved: Prisma.Decimal; residual: Prisma.Decimal; invalid: number }[]
  >`
    ${Prisma.raw(driverCashReconciliationWith(present))}
    SELECT COALESCE(SUM(d.raw_discrepancy), 0) AS raw, COALESCE(SUM(d.approved_historical_amount), 0) AS approved,
           COALESCE(SUM(d.unexplained_residual), 0) AS residual, COALESCE(SUM(d.invalid_approved_count), 0)::int AS invalid
    FROM dc_accounts d
  `;
  return {
    schemaPresent: present,
    accounts: accounts.entries,
    accountsTruncated: accounts.total > accounts.entries.length,
    reconciliations: reconciliations.entries,
    reconciliationsTruncated: reconciliations.total > reconciliations.entries.length,
    totals: {
      rawDiscrepancy: dec(totals.raw).toFixed(2),
      approvedHistoricalAmount: dec(totals.approved).toFixed(2),
      unexplainedResidual: dec(totals.residual).toFixed(2),
      invalidApprovedCount: Number(totals.invalid),
    },
  };
}

// Σ amount of APPROVED, currently valid reconciliations whose evidence time
// (the cited audit's stored created_at) is before `endExclusive` — the
// explanatory component of an as-of driver cash figure (design D6). Never a
// collection, never revenue.
export async function getApprovedHistoricalReconciliationAsOf(db: Db, endExclusive?: Date): Promise<Prisma.Decimal> {
  if (!(await isHistoricalReconciliationSchemaPresent(db))) return new Prisma.Decimal(0);
  const before = endExclusive ? Prisma.sql`AND e.evidence_at < ${endExclusive}` : Prisma.empty;
  const rows = await db.$queryRaw<{ total: Prisma.Decimal }[]>`
    ${Prisma.raw(driverCashReconciliationWith(true))}
    SELECT COALESCE(SUM(e.amount), 0) AS total
    FROM hr_evaluated e
    WHERE e.status = 'APPROVED' AND cardinality(e.failures) = 0 ${before}
  `;
  return dec(rows[0]?.total ?? 0);
}
