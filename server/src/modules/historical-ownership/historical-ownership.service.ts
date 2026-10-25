// ============================================================
// FR.12A.10 — Historical ownership evaluation (read-only). Every figure comes
// from the shared validity SQL (historical-ownership.sql.ts) so gate G5,
// reconciliation R14, the read APIs and the finance summary agree.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { HISTORICAL_OWNERSHIP_SCHEMA_PRESENT_SQL, OUTSTANDING_LIABILITY_WHERE, historicalOwnershipWith } from "./historical-ownership.sql";
import type {
  HistoricalDisposition,
  HistoricalLiabilitySnapshot,
  HistoricalOwnershipStatus,
  LiabilityPolicyEvaluation,
  ResolutionEvaluation,
} from "./historical-ownership.types";

type Db = Prisma.TransactionClient | typeof prisma;

const money = (v: Prisma.Decimal | string | null | undefined) => new Prisma.Decimal(v ?? 0).toFixed(2);

export async function isHistoricalOwnershipSchemaPresent(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ present: boolean }[]>(Prisma.raw(HISTORICAL_OWNERSHIP_SCHEMA_PRESENT_SQL));
  return rows[0]?.present === true;
}

type ResolutionRow = {
  id: string;
  deleted_order_reference: string;
  policy_id: string;
  status: HistoricalOwnershipStatus;
  asserts_approval: boolean;
  failures: string[];
  liability_id: string | null;
  recognized_amount: Prisma.Decimal | null;
  released: boolean;
};

export async function evaluateResolutions(db: Db, opts: { resolutionIds?: string[]; deletedOrderReference?: string } = {}): Promise<ResolutionEvaluation[]> {
  const conditions: Prisma.Sql[] = [Prisma.sql`true`];
  if (opts.resolutionIds) conditions.push(Prisma.sql`h.id = ANY(${opts.resolutionIds}::uuid[])`);
  if (opts.deletedOrderReference) conditions.push(Prisma.sql`h.deleted_order_reference = ${opts.deletedOrderReference}::uuid`);
  const rows = await db.$queryRaw<ResolutionRow[]>`
    ${Prisma.raw(historicalOwnershipWith())}
    SELECT h.id, h.deleted_order_reference::text AS deleted_order_reference, h.policy_id, h.status, h.asserts_approval, h.failures,
           h.liability_id, h.recognized_amount,
           EXISTS (SELECT 1 FROM ho_released x WHERE x.resolution_id = h.id) AS released
    FROM ho_evaluated h
    WHERE ${Prisma.join(conditions, " AND ")}
    ORDER BY h.created_at, h.id
  `;
  return rows.map((r) => ({
    resolutionId: r.id,
    deletedOrderReference: r.deleted_order_reference,
    policyId: r.policy_id,
    status: r.status,
    assertsApproval: r.asserts_approval,
    failures: r.failures,
    liabilityId: r.liability_id,
    recognizedAmount: r.recognized_amount === null ? null : money(r.recognized_amount),
    releasesG5: r.released,
  }));
}

type PolicyRow = { id: string; status: HistoricalOwnershipStatus; asserts_approval: boolean; failures: string[]; approved_by_id: string | null };

export async function evaluatePolicies(db: Db, policyIds?: string[]): Promise<LiabilityPolicyEvaluation[]> {
  const rows = await db.$queryRaw<PolicyRow[]>`
    ${Prisma.raw(historicalOwnershipWith())}
    SELECT p.id, p.status, p.asserts_approval, p.failures, p.approved_by_id
    FROM hop_evaluated p
    WHERE ${policyIds ? Prisma.sql`p.id = ANY(${policyIds}::uuid[])` : Prisma.sql`true`}
    ORDER BY p.policy_code, p.version
  `;
  return rows.map((r) => ({ policyId: r.id, status: r.status, assertsApproval: r.asserts_approval, failures: r.failures, approvedById: r.approved_by_id }));
}

type DispositionRow = {
  deleted_order_reference: string;
  resolution_id: string;
  liability_id: string;
  recognized_amount: Prisma.Decimal;
  tracked_shortfall_amount: Prisma.Decimal;
  policy_code: string;
  policy_version: number;
};

// Deleted orders whose historical ownership is resolved by a recorded
// liability (they no longer block G5) — always reported, never hidden.
export async function getHistoricalDispositions(db: Db): Promise<HistoricalDisposition[]> {
  if (!(await isHistoricalOwnershipSchemaPresent(db))) return [];
  const rows = await db.$queryRaw<DispositionRow[]>`
    ${Prisma.raw(historicalOwnershipWith())}
    SELECT x.deleted_order_reference::text AS deleted_order_reference, x.resolution_id, x.liability_id, x.recognized_amount,
           x.tracked_shortfall_amount, p.policy_code, p.version AS policy_version
    FROM ho_released x
    JOIN historical_liability_policies p ON p.id = x.policy_id
    ORDER BY x.deleted_order_reference
  `;
  return rows.map((r) => ({
    deletedOrderReference: r.deleted_order_reference,
    resolutionId: r.resolution_id,
    liabilityId: r.liability_id,
    outcome: "COMPANY_ASSUMED_LIABILITY" as const,
    recognizedAmount: money(r.recognized_amount),
    outstandingAmount: money(r.recognized_amount),
    trackedShortfallAmount: money(r.tracked_shortfall_amount),
    policyCode: r.policy_code,
    policyVersion: r.policy_version,
  }));
}

type SnapshotRow = {
  outstanding: Prisma.Decimal;
  tracked_shortfall: Prisma.Decimal;
  liability_count: number;
  invalid_count: number;
  review_overdue_count: number;
  unclaimed_review_due_count: number;
};

// Current snapshot of the historical liability register. Separate from
// customer wallets, driver cash and company revenue (approved policy L3).
export async function getHistoricalLiabilitySnapshot(db: Db): Promise<HistoricalLiabilitySnapshot> {
  if (!(await isHistoricalOwnershipSchemaPresent(db))) {
    return { outstanding: "0.00", trackedShortfall: "0.00", liabilityCount: 0, invalidCount: 0, reviewOverdueCount: 0, unclaimedReviewDueCount: 0 };
  }
  const [row] = await db.$queryRaw<SnapshotRow[]>`
    ${Prisma.raw(historicalOwnershipWith())}
    SELECT COALESCE(SUM(h.recognized_amount), 0) AS outstanding,
           COALESCE(SUM(h.tracked_shortfall_amount), 0) AS tracked_shortfall,
           COUNT(*)::int AS liability_count,
           COUNT(*) FILTER (WHERE cardinality(h.failures) > 0)::int AS invalid_count,
           COUNT(*) FILTER (WHERE p.review_interval_days IS NOT NULL
                              AND COALESCE((SELECT MAX(v.created_at) FROM historical_liability_reviews v WHERE v.liability_id = h.liability_id), h.recorded_at)
                                  + make_interval(days => p.review_interval_days) < now())::int AS review_overdue_count,
           COUNT(*) FILTER (WHERE p.unclaimed_review_after_days IS NOT NULL
                              AND h.recorded_at + make_interval(days => p.unclaimed_review_after_days) < now())::int AS unclaimed_review_due_count
    FROM ho_evaluated h
    JOIN historical_liability_policies p ON p.id = h.policy_id
    WHERE ${Prisma.raw(OUTSTANDING_LIABILITY_WHERE)}
  `;
  return {
    outstanding: money(row?.outstanding),
    trackedShortfall: money(row?.tracked_shortfall),
    liabilityCount: row?.liability_count ?? 0,
    invalidCount: row?.invalid_count ?? 0,
    reviewOverdueCount: row?.review_overdue_count ?? 0,
    unclaimedReviewDueCount: row?.unclaimed_review_due_count ?? 0,
  };
}
