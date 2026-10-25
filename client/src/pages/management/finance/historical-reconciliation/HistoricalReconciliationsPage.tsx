import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { useCurrentUser } from '../../../../features/auth/usePermissions';
import { paths } from '../../../../routes/paths';
import { formatDate, formatMoney } from '../../../../lib/format';
import { MD_QUERY, useMediaQuery } from '../../../../lib/useMediaQuery';
import { getApiErrorMessage, type UnknownApiError } from '../../../../services/apiError';
import {
  useGetLedgerIncidentsQuery,
  useGetReconciliationSummaryQuery,
  useGetReconciliationsQuery,
  useProposeReconciliationMutation,
} from '../../../../services/historicalReconciliationApi';
import type { ReconciliationListItem } from '../../../../services/historicalReconciliation.types';

import { PageHeader } from '../../../../components/data-display/PageHeader';
import { Pagination } from '../../../../components/data-display/Pagination';
import { DataTable, type DataTableColumn } from '../../../../components/data-display/DataTable';
import { StatisticCard } from '../../../../components/data-display/StatisticCard';
import { FilterBar } from '../../../../components/filters/FilterBar';
import { SelectField } from '../../../../components/forms/Field';
import { Badge } from '../../../../components/ui/Badge';
import { Button } from '../../../../components/ui/Button';
import { Card } from '../../../../components/ui/Card';
import { EmptyState } from '../../../../components/feedback/EmptyState';
import { ErrorState } from '../../../../components/feedback/ErrorState';
import { LoadingState } from '../../../../components/feedback/LoadingState';

import {
  EVIDENCE_ONLY_NOTICE,
  LIST_COLUMN_LAYOUT,
  OWNERSHIP_NOTICE,
  STATUS_FILTER_OPTIONS,
  driverLabel,
  evidencePresentation,
  ownershipPresentation,
  parseListParams,
  serializeListParams,
  statusPresentation,
} from './historicalReconciliationModel';
import { ProposeReconciliationDialog } from './ProposeReconciliationDialog';
import { OwnershipTab } from './ownership/OwnershipTab';
import { liabilityResolutionPresentation } from './ownership/ownershipModel';
import { useGetOwnershipSummaryQuery } from '../../../../services/historicalOwnershipApi';
import { cn } from '../../../../components/ui/cn';

/**
 * FR.12A.6 — Historical driver cash reconciliations (ADMIN / FINANCE by
 * role; route RequireRole + backend requireRole). Filters and pagination are
 * server-side; the list API has no free-text search, so only its structured
 * filters are offered (never a local filter over one page).
 */
export default function HistoricalReconciliationsPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(MD_QUERY);
  const user = useCurrentUser();
  const isAdmin = user?.role.code === 'ADMIN';
  // FR.12A.11 — Ledger reconciliation (evidence only) vs Ownership (company-assumed liabilities).
  const view = sp.get('view') === 'ownership' ? 'ownership' : 'ledger';

  const params = useMemo(() => parseListParams(sp), [sp]);
  // Review L4 — no ledger requests while the Ownership tab is selected.
  const onOwnership = sp.get('view') === 'ownership';
  const query = useGetReconciliationsQuery(params, { skip: onOwnership });
  const summary = useGetReconciliationSummaryQuery(undefined, { skip: onOwnership });
  const incidents = useGetLedgerIncidentsQuery({ page: 1, limit: 100 }, { skip: onOwnership });
  // Review L3 — the liability resolution shown beside the ledger record's ownership.
  const ownershipSummary = useGetOwnershipSummaryQuery(undefined, { skip: onOwnership });
  const dispositions = ownershipSummary.data?.dispositions;
  const [propose] = useProposeReconciliationMutation();
  const [proposeOpen, setProposeOpen] = useState(false);

  const commit = (next: Partial<typeof params>) => setSp(serializeListParams({ ...params, page: 1, ...next }));
  const filtersActive = !!(params.status || params.incidentId);
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;
  const toDetail = (r: ReconciliationListItem) => paths.management.historicalReconciliationDetail(r.reconciliationId);

  const cells: Record<string, Omit<DataTableColumn<ReconciliationListItem>, 'id' | 'hideBelow'>> = {
    incident: {
      header: 'Incident',
      cell: (r) => (
        <Link to={toDetail(r)} className="font-medium text-brand-600 hover:underline" onClick={(e) => e.stopPropagation()}>
          {r.incidentNumber}
        </Link>
      ),
    },
    driver: { header: 'Driver', cell: (r) => driverLabel(r.driver) },
    amount: { header: 'Amount', align: 'right', cell: (r) => <span className="tabular-nums">{formatMoney(r.amount)}</span> },
    rawDiscrepancy: { header: 'Raw discrepancy', align: 'right', cell: (r) => <span className="tabular-nums">{formatMoney(r.account.rawDiscrepancy)}</span> },
    approved: { header: 'Approved explanation', align: 'right', cell: (r) => <span className="tabular-nums">{formatMoney(r.account.approvedHistoricalAmount)}</span> },
    residual: { header: 'Unexplained residual', align: 'right', cell: (r) => <span className="tabular-nums font-medium">{formatMoney(r.account.unexplainedResidual)}</span> },
    status: { header: 'Status', cell: (r) => <Badge tone={statusPresentation(r.status).tone}>{statusPresentation(r.status).label}</Badge> },
    ownership: { header: 'Ledger record', cell: (r) => <Badge tone={ownershipPresentation(r.ownershipStatus).tone}>{ownershipPresentation(r.ownershipStatus).label}</Badge> },
    liability: {
      header: 'Liability resolution',
      cell: (r) => {
        const p = liabilityResolutionPresentation(r.deletedOrderReference, dispositions);
        return <Badge tone={p.tone}>{p.label}</Badge>;
      },
    },
    evidence: { header: 'Evidence', cell: (r) => <Badge tone={evidencePresentation(r).tone}>{evidencePresentation(r).label}</Badge> },
    proposed: { header: 'Proposed', cell: (r) => formatDate(r.proposedAt) },
  };
  const columns: DataTableColumn<ReconciliationListItem>[] = LIST_COLUMN_LAYOUT.map((c) => ({ id: c.id, hideBelow: c.hideBelow, ...cells[c.id] }));

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        eyebrow={<Link to={paths.management.finance} className="hover:underline">Finance</Link>}
        title="Historical ledger reconciliation"
        description="Evidence that explains documented gaps in driver cash ledgers. Admins propose; an independent Finance reviewer approves."
        actions={isAdmin && view === 'ledger' ? <Button onClick={() => setProposeOpen(true)}>Propose reconciliation</Button> : undefined}
      />

      <div role="tablist" aria-label="Historical ledger view" className="flex gap-1.5 overflow-x-auto pb-1">
        {([['ledger', 'Ledger reconciliation'], ['ownership', 'Ownership']] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={view === id}
            onClick={() => setSp(id === 'ownership' ? new URLSearchParams({ view: 'ownership' }) : new URLSearchParams())}
            className={cn(
              'inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[0.5rem] border px-3.5 text-sm transition-colors',
              view === id ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700' : 'border-line bg-card font-medium text-ink-secondary hover:bg-sunken',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {view === 'ownership' ? (
        <OwnershipTab />
      ) : (
      <>

      <div className="space-y-2">
        <p className="rounded-card border border-line bg-sunken px-4 py-2.5 text-sm text-ink-secondary">{EVIDENCE_ONLY_NOTICE}</p>
        <p className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-warning-700">{OWNERSHIP_NOTICE}</p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatisticCard label="Raw ledger discrepancy" value={summary.data ? formatMoney(summary.data.totals.rawDiscrepancy) : '—'} supportingText="Stored minus ledger net, all accounts" />
        <StatisticCard label="Approved explanation" value={summary.data ? formatMoney(summary.data.totals.approvedHistoricalAmount) : '—'} supportingText="Approved and currently valid only" />
        <StatisticCard label="Unexplained residual" value={summary.data ? formatMoney(summary.data.totals.unexplainedResidual) : '—'} supportingText="Must be zero for G3 / R1" />
        <StatisticCard label="Invalid approvals" value={summary.data ? String(summary.data.totals.invalidApprovedCount) : '—'} supportingText="Each one blocks G3 / R1" />
      </div>

      <FilterBar active={filtersActive} onClear={() => setSp(new URLSearchParams())}>
        <div className="w-full sm:w-56">
          <SelectField
            label="Status"
            placeholder="All statuses"
            value={params.status ?? ''}
            onChange={(e) => commit({ status: (e.target.value || undefined) as typeof params.status })}
            options={STATUS_FILTER_OPTIONS}
          />
        </div>
        <div className="w-full sm:w-72">
          <SelectField
            label="Incident"
            placeholder="All incidents"
            value={params.incidentId ?? ''}
            onChange={(e) => commit({ incidentId: e.target.value || undefined })}
            options={(incidents.data?.items ?? []).map((i) => ({ value: i.id, label: i.incidentNumber }))}
          />
        </div>
      </FilterBar>

      {query.isError && !query.data ? (
        <ErrorState title="Could not load historical reconciliations" message={getApiErrorMessage(query.error as UnknownApiError)} onRetry={() => void query.refetch()} />
      ) : query.isLoading ? (
        <LoadingState className="py-16" label="Loading historical reconciliations…" />
      ) : rows.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-12"
            title={filtersActive ? 'No reconciliations match these filters.' : 'No historical reconciliations yet.'}
            description={filtersActive ? 'Clear the filters to see every record.' : 'A reconciliation is proposed by an Admin for a documented ledger incident.'}
          />
        </Card>
      ) : isDesktop ? (
        <Card flush className="overflow-x-auto">
          <DataTable columns={columns} rows={rows} getRowId={(r) => r.reconciliationId} caption="Historical reconciliations" onRowClick={(r) => navigate(toDetail(r))} loading={query.isFetching} />
        </Card>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.reconciliationId}>
              <Link to={toDetail(r)} className="block rounded-card border border-line bg-card p-4 shadow-card hover:border-brand-200">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-ink">{r.incidentNumber}</p>
                    <p className="truncate text-sm text-ink-secondary">{driverLabel(r.driver)}</p>
                  </div>
                  <span className="font-semibold tabular-nums">{formatMoney(r.amount)}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Badge tone={statusPresentation(r.status).tone}>{statusPresentation(r.status).label}</Badge>
                  <Badge tone={ownershipPresentation(r.ownershipStatus).tone}>{ownershipPresentation(r.ownershipStatus).label}</Badge>
                  <Badge tone={liabilityResolutionPresentation(r.deletedOrderReference, dispositions).tone}>
                    {liabilityResolutionPresentation(r.deletedOrderReference, dispositions).label}
                  </Badge>
                  <Badge tone={evidencePresentation(r).tone}>{evidencePresentation(r).label}</Badge>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-ink-muted">Raw</dt>
                    <dd className="tabular-nums text-ink">{formatMoney(r.account.rawDiscrepancy)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Approved</dt>
                    <dd className="tabular-nums text-ink">{formatMoney(r.account.approvedHistoricalAmount)}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-muted">Residual</dt>
                    <dd className="tabular-nums text-ink">{formatMoney(r.account.unexplainedResidual)}</dd>
                  </div>
                </dl>
                <p className="mt-2 text-xs text-ink-muted">Proposed {formatDate(r.proposedAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} onPageChange={(page) => setSp(serializeListParams({ ...params, page }))} />
      )}
      </>
      )}

      {isAdmin && (
        <ProposeReconciliationDialog
          open={proposeOpen}
          onClose={() => setProposeOpen(false)}
          onSubmit={(body, idempotencyKey) => propose({ body, idempotencyKey }).unwrap()}
          onCreated={(d) => {
            setProposeOpen(false);
            navigate(paths.management.historicalReconciliationDetail(d.reconciliationId));
          }}
        />
      )}
    </div>
  );
}
