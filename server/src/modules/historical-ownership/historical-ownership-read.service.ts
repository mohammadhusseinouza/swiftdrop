// ============================================================
// FR.12A.11 — Historical ownership read APIs (ADMIN + FINANCE). Statuses,
// failures and the G5 effect come from the shared validity SQL; nothing is
// derived differently here. No customer data exists for a deleted order and
// none is returned.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { evaluateHistoricalReconciliations } from "../historical-reconciliation/historical-reconciliation.service";
import { areHistoricalOwnershipWritesEnabled } from "./historical-ownership-workflow.service";
import { evaluatePolicies, evaluateResolutions, getHistoricalDispositions, getHistoricalLiabilitySnapshot } from "./historical-ownership.service";
import { unresolvedHistoricalOwnershipSql } from "./historical-ownership.sql";
import type { ListQuery } from "./historical-ownership.schema";
import type {
  DecisionDto,
  HistoricalLiabilityState,
  HistoricalOwnershipSummaryDto,
  LiabilityDto,
  LiabilityPolicyDto,
  ResolutionDetailDto,
  ResolutionEvaluation,
  ResolutionSummaryDto,
  UnresolvedOwnershipCandidateDto,
  UserRef,
} from "./historical-ownership.types";

const money = (v: Prisma.Decimal) => v.toFixed(2);
const DAY_MS = 24 * 60 * 60 * 1000;

type UserRow = { id: string; first_name: string; last_name: string; roles: { code: string } };
const userSelect = { id: true, first_name: true, last_name: true, roles: { select: { code: true } } } as const;
const userRef = (u: UserRow): UserRef => ({ id: u.id, name: `${u.first_name} ${u.last_name}`.trim(), role: u.roles.code });

type DecisionRow = {
  id: string;
  decision: DecisionDto["decision"];
  reason: string | null;
  revokes_decision_id: string | null;
  created_at: Date;
  decided_by: UserRow;
};
const decisionDto = (d: DecisionRow): DecisionDto => ({
  id: d.id,
  decision: d.decision,
  decidedBy: userRef(d.decided_by),
  reason: d.reason,
  revokesDecisionId: d.revokes_decision_id,
  createdAt: d.created_at.toISOString(),
});

function liabilityState(evaluation: ResolutionEvaluation): HistoricalLiabilityState {
  if (!evaluation.liabilityId) return "NOT_RECORDED";
  return evaluation.assertsApproval ? "OUTSTANDING" : "REVOKED";
}

// ------------------------------------------------------------ policies

export async function listLiabilityPolicies(): Promise<LiabilityPolicyDto[]> {
  const rows = await prisma.historical_liability_policies.findMany({
    orderBy: [{ policy_code: "asc" }, { version: "desc" }],
    include: {
      proposed_by: { select: userSelect },
      decisions: { orderBy: { created_at: "asc" }, include: { decided_by: { select: userSelect } } },
    },
  });
  const evaluations = new Map((await evaluatePolicies(prisma, rows.map((r) => r.id))).map((e) => [e.policyId, e]));
  return rows.map((r) => {
    const e = evaluations.get(r.id);
    return {
      id: r.id,
      policyCode: r.policy_code,
      version: r.version,
      outcome: r.outcome,
      title: r.title,
      summary: r.summary,
      documentSha256: r.document_sha256,
      documentReference: r.document_reference,
      reviewIntervalDays: r.review_interval_days,
      unclaimedFundsHandling: r.unclaimed_funds_handling,
      unclaimedReviewAfterDays: r.unclaimed_review_after_days,
      policyDigest: r.policy_digest,
      status: e?.status ?? "INVALID_HISTORY",
      failures: e?.failures ?? ["NOT_EVALUATED"],
      proposedBy: userRef(r.proposed_by),
      decisions: r.decisions.map(decisionDto),
      createdAt: r.created_at.toISOString(),
    };
  });
}

export async function getLiabilityPolicy(id: string): Promise<LiabilityPolicyDto> {
  const found = (await listLiabilityPolicies()).find((p) => p.id === id);
  if (!found) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Liability policy not found" });
  return found;
}

// ------------------------------------------------------------ resolutions

const resolutionInclude = {
  incident: { select: { incident_number: true } },
  policy: { select: { id: true, policy_code: true, version: true, review_interval_days: true, unclaimed_review_after_days: true } },
  proposed_by: { select: userSelect },
} as const;

type ResolutionRow = Prisma.historical_ownership_resolutionsGetPayload<{ include: typeof resolutionInclude }>;

function summaryDto(r: ResolutionRow, e: ResolutionEvaluation): ResolutionSummaryDto {
  const state = liabilityState(e);
  return {
    id: r.id,
    incidentId: r.incident_id,
    incidentNumber: r.incident.incident_number,
    outcome: r.outcome,
    deletedOrderReference: r.deleted_order_reference,
    orderType: r.order_type,
    expectedAmount: money(r.expected_amount),
    collectedAmount: money(r.collected_amount),
    collectionDifference: money(r.collection_difference),
    heldCollectionAmount: money(r.held_collection_amount),
    trackedShortfallAmount: money(r.tracked_shortfall_amount),
    status: e.status,
    failures: e.failures,
    releasesG5: e.releasesG5,
    liabilityState: state,
    outstandingAmount: state === "OUTSTANDING" ? (e.recognizedAmount ?? "0.00") : "0.00",
    policy: { id: r.policy.id, policyCode: r.policy.policy_code, version: r.policy.version },
    proposedBy: userRef(r.proposed_by),
    createdAt: r.created_at.toISOString(),
  };
}

export async function listOwnershipResolutions(query: ListQuery) {
  const [total, rows] = await Promise.all([
    prisma.historical_ownership_resolutions.count(),
    prisma.historical_ownership_resolutions.findMany({
      orderBy: [{ created_at: "desc" }, { id: "asc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
      include: resolutionInclude,
    }),
  ]);
  const evaluations = new Map((await evaluateResolutions(prisma, { resolutionIds: rows.map((r) => r.id) })).map((e) => [e.resolutionId, e]));
  return {
    data: rows.map((r) => summaryDto(r, evaluations.get(r.id)!)),
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  };
}

export async function getOwnershipResolutionDetail(id: string): Promise<ResolutionDetailDto> {
  const row = await prisma.historical_ownership_resolutions.findUnique({
    where: { id },
    include: {
      ...resolutionInclude,
      evidence: { orderBy: { ordinal: "asc" } },
      decisions: { orderBy: { created_at: "asc" }, include: { decided_by: { select: userSelect } } },
      superseded_by: { select: { id: true } },
      liabilities: {
        include: {
          recorded_by: { select: userSelect },
          reviews: { orderBy: { created_at: "asc" }, include: { reviewed_by: { select: userSelect } } },
        },
      },
    },
  });
  if (!row) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Historical ownership resolution not found" });
  const [evaluation] = await evaluateResolutions(prisma, { resolutionIds: [id] });
  const summary = summaryDto(row, evaluation);
  const l = row.liabilities[0];
  let liability: LiabilityDto | null = null;
  if (l) {
    const lastReview = l.reviews.at(-1)?.created_at ?? l.created_at;
    const outstanding = summary.liabilityState === "OUTSTANDING";
    liability = {
      id: l.id,
      state: summary.liabilityState,
      recognizedAmount: money(l.recognized_amount),
      outstandingAmount: summary.outstandingAmount,
      heldCollectionAmount: money(l.held_collection_amount),
      trackedShortfallAmount: money(l.tracked_shortfall_amount),
      liabilityDigest: l.liability_digest,
      recordedBy: userRef(l.recorded_by),
      createdAt: l.created_at.toISOString(),
      reviews: l.reviews.map((v) => ({ id: v.id, reviewedBy: userRef(v.reviewed_by), note: v.note, createdAt: v.created_at.toISOString() })),
      nextReviewDueAt:
        outstanding && row.policy.review_interval_days !== null
          ? new Date(lastReview.getTime() + row.policy.review_interval_days * DAY_MS).toISOString()
          : null,
      unclaimedReviewDueAt:
        outstanding && row.policy.unclaimed_review_after_days !== null
          ? new Date(l.created_at.getTime() + row.policy.unclaimed_review_after_days * DAY_MS).toISOString()
          : null,
    };
  }
  return {
    ...summary,
    sourceAuditLogId: row.source_audit_log_id,
    verification: row.verification,
    ledgerReconciliationId: row.ledger_reconciliation_id,
    evidenceManifestDigest: row.evidence_manifest_digest,
    resolutionDigest: row.resolution_digest,
    rationale: row.rationale,
    evidence: row.evidence.map((e) => ({
      ordinal: e.ordinal,
      kind: e.kind,
      documentSha256: e.document_sha256,
      reference: e.reference,
      description: e.description,
    })),
    decisions: row.decisions.map(decisionDto),
    liability,
    supersedesResolutionId: row.supersedes_resolution_id,
    supersededByResolutionId: row.superseded_by[0]?.id ?? null,
  };
}

export async function resolutionIdOfLiability(liabilityId: string): Promise<string> {
  const l = await prisma.historical_liabilities.findUnique({ where: { id: liabilityId }, select: { resolution_id: true } });
  if (!l) throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Historical liability not found" });
  return l.resolution_id;
}

// ------------------------------------------------------------ summary

async function unresolvedCandidates(): Promise<UnresolvedOwnershipCandidateDto[]> {
  const refs = await prisma.$queryRaw<{ order_ref: string }[]>(Prisma.raw(`SELECT u.order_ref FROM (${unresolvedHistoricalOwnershipSql(true, true)}) u`));
  if (refs.length === 0) return [];
  const ids = refs.map((r) => r.order_ref);
  const [audits, reconciliations, resolutions] = await Promise.all([
    prisma.audit_logs.findMany({
      where: { action: "COLLECTION_DIFFERENCE_RECORDED", entity_type: "ORDER", entity_id: { in: ids } },
      orderBy: { created_at: "asc" },
    }),
    prisma.driver_cash_historical_reconciliations.findMany({
      where: { deleted_order_reference: { in: ids } },
      select: { id: true, deleted_order_reference: true, incident_id: true, incident: { select: { incident_number: true } } },
    }),
    Promise.all(ids.map((ref) => evaluateResolutions(prisma, { deletedOrderReference: ref }))),
  ]);
  const valid = new Set(
    (await evaluateHistoricalReconciliations(prisma, { reconciliationIds: reconciliations.map((r) => r.id) })).entries
      .filter((e) => e.status === "APPROVED" && e.failures.length === 0)
      .map((e) => e.reconciliationId)
  );
  return ids.map((ref, i) => {
    const audit = audits.find((a) => a.entity_id === ref) ?? null;
    const metadata = (audit?.metadata ?? {}) as Record<string, unknown>;
    const text = (k: string) => (typeof metadata[k] === "string" ? (metadata[k] as string) : null);
    const rec = reconciliations.find((r) => r.deleted_order_reference === ref && valid.has(r.id)) ?? null;
    const live = resolutions[i].find((e) => ["PROPOSED", "APPROVED", "INVALID_HISTORY"].includes(e.status)) ?? null;
    return {
      deletedOrderReference: ref,
      sourceAuditLogId: audit?.id ?? null,
      orderType: text("orderType"),
      expectedAmount: text("expectedAmount"),
      actualAmount: text("actualAmount"),
      difference: text("difference"),
      recordedAt: audit?.created_at.toISOString() ?? null,
      approvedLedgerReconciliationId: rec?.id ?? null,
      incidentId: rec?.incident_id ?? null,
      incidentNumber: rec?.incident.incident_number ?? null,
      activeResolutionId: live?.resolutionId ?? null,
    };
  });
}

export async function getHistoricalOwnershipSummary(): Promise<HistoricalOwnershipSummaryDto> {
  const [liabilities, unresolved, dispositions] = await Promise.all([
    getHistoricalLiabilitySnapshot(prisma),
    unresolvedCandidates(),
    getHistoricalDispositions(prisma),
  ]);
  return { writesEnabled: areHistoricalOwnershipWritesEnabled(), liabilities, unresolvedCandidates: unresolved, dispositions };
}
