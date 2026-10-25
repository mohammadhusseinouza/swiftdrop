// ============================================================
// FR.12A.5 — Historical reconciliation READ APIs (ADMIN / FINANCE by role).
//
// Every response is built from ONE read-only snapshot (readSnapshot), with
// the derived status, V1–V7 failures and the account's raw discrepancy /
// approved amount / residual computed by the shared SQL. Actor names and
// incident numbers are loaded in one batched query per response (no N+1).
// Ids, amounts and codes only — no customer or receiver details exist here.
// ============================================================

import { Prisma } from "../../generated/prisma/client";
import { readSnapshot } from "../../db/read-snapshot";
import { AppError } from "../../shared/errors/app-error";
import { isUnresolvedHistoricalOwnership } from "./historical-reconciliation.calculation";
import {
  evaluateHistoricalReconciliations,
  getDriverCashAccountReconciliations,
  getDriverCashHistoricalReconciliationSummary,
} from "./historical-reconciliation.service";
import type { ListHistoricalReconciliationsQuery, ListIncidentsQuery } from "./historical-reconciliation.schema";
import type {
  DriverCashHistoricalReconciliationSummary,
  HistoricalReconciliationActor,
  HistoricalReconciliationDriver,
  HistoricalReconciliationEvidenceContext,
  HistoricalReconciliationDetail,
  HistoricalReconciliationListEntry,
  LedgerIncidentDetail,
  LedgerIncidentEntry,
} from "./historical-reconciliation.types";

type Tx = Prisma.TransactionClient;

const actorSelect = { id: true, first_name: true, last_name: true } as const;
const toActor = (u: { id: string; first_name: string; last_name: string }): HistoricalReconciliationActor => ({
  id: u.id,
  firstName: u.first_name,
  lastName: u.last_name,
});

// The affected driver (staff-facing identity only: number and name).
const driverSelect = { id: true, driver_number: true, users: { select: { first_name: true, last_name: true } } } as const;
const toDriver = (d: { id: string; driver_number: string; users: { first_name: string; last_name: string } }): HistoricalReconciliationDriver => ({
  id: d.id,
  driverNumber: d.driver_number,
  firstName: d.users.first_name,
  lastName: d.users.last_name,
});

function notFound(what: string): AppError {
  return new AppError({ statusCode: 404, code: "NOT_FOUND", message: `${what} not found` });
}

// Records -> list entries: incident number, proposer and driver in one
// query, the accounts' raw discrepancy / approved amount / residual in one
// more (no N+1).
async function toListEntries(tx: Tx, ids: string[]): Promise<HistoricalReconciliationListEntry[]> {
  if (ids.length === 0) return [];
  const { entries } = await evaluateHistoricalReconciliations(tx, { reconciliationIds: ids });
  const rows = await tx.driver_cash_historical_reconciliations.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      account_id: true,
      created_at: true,
      incident: { select: { incident_number: true } },
      proposed_by: { select: actorSelect },
      account: { select: { drivers: { select: driverSelect } } },
    },
  });
  const accounts = await getDriverCashAccountReconciliations(tx, {
    schemaPresent: true,
    accountIds: [...new Set(rows.map((r) => r.account_id))],
  });
  const accountById = new Map(accounts.entries.map((a) => [a.accountId, a]));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const evaluated = new Map(entries.map((e) => [e.reconciliationId, e]));
  return ids.map((id) => {
    const row = byId.get(id)!;
    return {
      ...evaluated.get(id)!,
      incidentNumber: row.incident.incident_number,
      proposedBy: toActor(row.proposed_by),
      proposedAt: row.created_at.toISOString(),
      driver: toDriver(row.account.drivers),
      account: accountById.get(row.account_id)!,
    };
  });
}

// The surviving rows, the audit and the settlement the evidence cites — what
// an independent reviewer inspects before approving. Ids, amounts, balances,
// types and stored times only (no customer data; no audit free text).
async function evidenceContext(
  tx: Tx,
  row: { anchor_transaction_id: string; predecessor_transaction_id: string | null; source_audit_log_id: string; related_settlement_id: string | null }
): Promise<HistoricalReconciliationEvidenceContext> {
  const ledgerIds = [row.anchor_transaction_id, row.predecessor_transaction_id].filter((x): x is string => x !== null);
  const [ledger, audit, settlement] = [
    await tx.driver_cash_transactions.findMany({
      where: { id: { in: ledgerIds } },
      select: { id: true, type: true, amount: true, balance_before: true, balance_after: true, settlement_id: true, created_at: true },
    }),
    await tx.audit_logs.findUnique({
      where: { id: row.source_audit_log_id },
      select: { id: true, action: true, entity_type: true, entity_id: true, created_at: true },
    }),
    row.related_settlement_id
      ? await tx.driver_settlements.findUnique({
          where: { id: row.related_settlement_id },
          select: { id: true, settlement_number: true, amount_received: true, balance_before: true, balance_after: true, created_at: true },
        })
      : null,
  ];
  const ledgerRow = (id: string | null) => {
    const t = id ? ledger.find((x) => x.id === id) : undefined;
    return t
      ? {
          id: t.id,
          type: t.type,
          amount: t.amount.toFixed(2),
          balanceBefore: t.balance_before.toFixed(2),
          balanceAfter: t.balance_after.toFixed(2),
          settlementId: t.settlement_id,
          recordedAt: t.created_at.toISOString(),
        }
      : null;
  };
  return {
    predecessorTransaction: ledgerRow(row.predecessor_transaction_id),
    anchorTransaction: ledgerRow(row.anchor_transaction_id),
    sourceAudit: audit
      ? { id: audit.id, action: audit.action, entityType: audit.entity_type, entityId: audit.entity_id, recordedAt: audit.created_at.toISOString() }
      : null,
    relatedSettlement: settlement
      ? {
          id: settlement.id,
          settlementNumber: settlement.settlement_number,
          amountReceived: settlement.amount_received.toFixed(2),
          balanceBefore: settlement.balance_before.toFixed(2),
          balanceAfter: settlement.balance_after.toFixed(2),
          recordedAt: settlement.created_at.toISOString(),
        }
      : null,
  };
}

export async function listHistoricalReconciliations(query: ListHistoricalReconciliationsQuery) {
  return readSnapshot(async (tx) => {
    const filters = {
      statuses: query.status ? [query.status] : undefined,
      driverIds: query.driverId ? [query.driverId] : undefined,
      incidentIds: query.incidentId ? [query.incidentId] : undefined,
    };
    const page = await evaluateHistoricalReconciliations(tx, { ...filters, limit: query.limit, offset: (query.page - 1) * query.limit });
    const total = page.entries.length > 0 ? page.total : (await evaluateHistoricalReconciliations(tx, { ...filters, limit: 1 })).total;
    return {
      data: await toListEntries(tx, page.entries.map((e) => e.reconciliationId)),
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  });
}

export async function getHistoricalReconciliationDetail(id: string): Promise<HistoricalReconciliationDetail> {
  return readSnapshot(async (tx) => {
    const row = await tx.driver_cash_historical_reconciliations.findUnique({
      where: { id },
      include: {
        incident: { select: { id: true, incident_number: true, cause: true } },
        proposed_by: { select: actorSelect },
        account: { select: { drivers: { select: driverSelect } } },
        decisions: { orderBy: [{ created_at: "asc" }, { id: "asc" }], include: { decided_by: { select: actorSelect } } },
      },
    });
    if (!row) throw notFound("Historical reconciliation");
    const [{ entries }, account] = [
      await evaluateHistoricalReconciliations(tx, { reconciliationIds: [id] }),
      (await getDriverCashAccountReconciliations(tx, { schemaPresent: true, accountIds: [row.account_id] })).entries[0],
    ];
    const e = entries[0];
    const context = await evidenceContext(tx, row);
    return {
      reconciliationId: row.id,
      status: e.status,
      evidenceValid: e.evidenceValid,
      failures: e.failures,
      contributes: e.contributes,
      blocking: e.blocking,
      incident: { id: row.incident.id, incidentNumber: row.incident.incident_number, cause: row.incident.cause },
      evidence: {
        kind: row.kind,
        accountingTreatment: row.accounting_treatment,
        accountId: row.account_id,
        driverId: row.driver_id,
        amount: row.amount.toFixed(2),
        observedJump: row.observed_jump.toFixed(2),
        predecessorTransactionId: row.predecessor_transaction_id,
        anchorTransactionId: row.anchor_transaction_id,
        missingTransactionId: row.missing_transaction_id,
        sourceAuditLogId: row.source_audit_log_id,
        deletedOrderReference: row.deleted_order_reference,
        orderType: row.order_type,
        expectedAmount: row.expected_amount.toFixed(2),
        actualAmount: row.actual_amount.toFixed(2),
        collectionDifference: row.collection_difference.toFixed(2),
        relatedSettlementId: row.related_settlement_id,
        evidenceDigest: row.evidence_digest,
      },
      evidenceContext: context,
      driver: toDriver(row.account.drivers),
      reason: row.reason,
      proposedBy: toActor(row.proposed_by),
      proposedAt: row.created_at.toISOString(),
      supersedesReconciliationId: row.supersedes_reconciliation_id,
      decisions: row.decisions.map((d) => ({
        id: d.id,
        decision: d.decision,
        decidedBy: toActor(d.decided_by),
        reason: d.reason,
        revokesDecisionId: d.revokes_decision_id,
        decidedAt: d.created_at.toISOString(),
      })),
      account,
      ownership: {
        status: row.ownership_status,
        // Never cleared by a ledger reconciliation decision (G5).
        blocksActivation: isUnresolvedHistoricalOwnership({ reconciliationId: row.id, status: e.status, ownershipStatus: row.ownership_status }),
      },
    };
  });
}

type IncidentRow = Prisma.financial_ledger_incidentsGetPayload<{
  include: { reported_by: { select: typeof actorSelect }; _count: { select: { reconciliations: true } } };
}>;

function toIncidentEntry(r: IncidentRow): LedgerIncidentEntry {
  return {
    id: r.id,
    incidentNumber: r.incident_number,
    cause: r.cause,
    summary: r.summary,
    discoveredAt: r.discovered_at.toISOString(),
    occurredNotBefore: r.occurred_not_before?.toISOString() ?? null,
    occurredNotAfter: r.occurred_not_after?.toISOString() ?? null,
    missingRecords: r.missing_records,
    remainingUncertainties: r.remaining_uncertainties,
    evidence: r.evidence,
    reportedBy: toActor(r.reported_by),
    recordedAt: r.created_at.toISOString(),
    reconciliationCount: r._count.reconciliations,
  };
}

const incidentInclude = { reported_by: { select: actorSelect }, _count: { select: { reconciliations: true } } } as const;

export async function listLedgerIncidents(query: ListIncidentsQuery) {
  return readSnapshot(async (tx) => {
    const [rows, total] = [
      await tx.financial_ledger_incidents.findMany({
        include: incidentInclude,
        orderBy: [{ created_at: "desc" }, { id: "asc" }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      await tx.financial_ledger_incidents.count(),
    ];
    return {
      data: rows.map(toIncidentEntry),
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    };
  });
}

export async function getLedgerIncidentDetail(id: string): Promise<LedgerIncidentDetail> {
  return readSnapshot(async (tx) => {
    const row = await tx.financial_ledger_incidents.findUnique({ where: { id }, include: incidentInclude });
    if (!row) throw notFound("Ledger incident");
    const { entries } = await evaluateHistoricalReconciliations(tx, { incidentIds: [id] });
    return { ...toIncidentEntry(row), reconciliations: await toListEntries(tx, entries.map((e) => e.reconciliationId)) };
  });
}

export async function getHistoricalReconciliationSummary(): Promise<DriverCashHistoricalReconciliationSummary> {
  return readSnapshot((tx) => getDriverCashHistoricalReconciliationSummary(tx));
}
