import { useState } from 'react';

import { useCurrentUser } from '../../../../../features/auth/usePermissions';
import { formatDate, formatDateTime, formatMoney } from '../../../../../lib/format';
import { MD_QUERY, useMediaQuery } from '../../../../../lib/useMediaQuery';
import { getApiErrorMessage, type UnknownApiError } from '../../../../../services/apiError';
import {
  useGetLiabilityPoliciesQuery,
  useGetOwnershipResolutionQuery,
  useGetOwnershipResolutionsQuery,
  useGetOwnershipSummaryQuery,
} from '../../../../../services/historicalOwnershipApi';
import type { OwnershipResolutionSummary } from '../../../../../services/historicalOwnership.types';

import { DataTable, type DataTableColumn } from '../../../../../components/data-display/DataTable';
import { Pagination } from '../../../../../components/data-display/Pagination';
import { StatisticCard } from '../../../../../components/data-display/StatisticCard';
import { EmptyState } from '../../../../../components/feedback/EmptyState';
import { ErrorState } from '../../../../../components/feedback/ErrorState';
import { LoadingState } from '../../../../../components/feedback/LoadingState';
import { Badge } from '../../../../../components/ui/Badge';
import { Button } from '../../../../../components/ui/Button';
import { Card } from '../../../../../components/ui/Card';

import { ReconciliationDialogShell } from '../ReconciliationDialogShell';
import { OwnershipActionDialog, type OwnershipDialogSpec } from './OwnershipActionDialog';
import {
  G5_NOTICE,
  NO_POSTING_NOTICE,
  failureMessage,
  liabilityStatePresentation,
  policyActions,
  resolutionActions,
  shortId,
  statusPresentation,
} from './ownershipModel';

const PAGE_SIZE = 20;

/**
 * FR.12A.11 — Ownership tab of Historical Ledger Reconciliation (ADMIN /
 * FINANCE by role; the server is the authority). Company-assumed historical
 * liabilities to unidentified beneficiaries: policy versions, resolutions,
 * the explicit recording step and periodic reviews. Nothing here posts money.
 */
export function OwnershipTab() {
  const user = useCurrentUser();
  const actor = user ? { id: user.id, roleCode: user.role.code } : null;
  const isAdmin = actor?.roleCode === 'ADMIN';
  const isDesktop = useMediaQuery(MD_QUERY);
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<OwnershipDialogSpec | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const summary = useGetOwnershipSummaryQuery();
  const policies = useGetLiabilityPoliciesQuery();
  const resolutions = useGetOwnershipResolutionsQuery({ page, limit: PAGE_SIZE });
  const detail = useGetOwnershipResolutionQuery(selected ?? '', { skip: !selected });

  const refetchAll = () => {
    void summary.refetch();
    void policies.refetch();
    void resolutions.refetch();
    if (selected) void detail.refetch();
  };

  const s = summary.data;
  const approvedPolicies = (policies.data ?? []).filter((p) => p.status === 'APPROVED' && p.failures.length === 0);

  const columns: DataTableColumn<OwnershipResolutionSummary>[] = [
    { id: 'incident', header: 'Incident', cell: (r) => <span className="font-medium">{r.incidentNumber}</span> },
    { id: 'order', header: 'Deleted order', cell: (r) => <code className="text-xs">{shortId(r.deletedOrderReference)}</code> },
    { id: 'held', header: 'Held liability', align: 'right', cell: (r) => <span className="tabular-nums">{formatMoney(r.heldCollectionAmount)}</span> },
    { id: 'shortfall', header: 'Tracked shortfall', align: 'right', cell: (r) => <span className="tabular-nums">{formatMoney(r.trackedShortfallAmount)}</span> },
    { id: 'status', header: 'Status', cell: (r) => <Badge tone={statusPresentation(r.status).tone}>{statusPresentation(r.status).label}</Badge> },
    {
      id: 'liability',
      header: 'Liability',
      cell: (r) => <Badge tone={liabilityStatePresentation(r.liabilityState).tone}>{liabilityStatePresentation(r.liabilityState).label}</Badge>,
    },
    {
      id: 'g5',
      header: 'G5',
      cell: (r) =>
        r.releasesG5 ? <Badge tone="success">Resolved</Badge> : r.failures.length ? <Badge tone="danger">Invalid</Badge> : <Badge tone="neutral">Blocking</Badge>,
    },
    { id: 'proposed', header: 'Proposed', cell: (r) => formatDate(r.createdAt) },
  ];

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="space-y-2">
        <p className="rounded-card border border-line bg-sunken px-4 py-2.5 text-sm text-ink-secondary">{NO_POSTING_NOTICE}</p>
        <p className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-warning-700">{G5_NOTICE}</p>
        {s && !s.writesEnabled && (
          <p className="rounded-card border border-line bg-sunken px-4 py-2.5 text-sm text-ink-secondary">
            Changes are disabled in this environment (read-only). They are enabled only during an authorized window.
          </p>
        )}
      </div>

      {summary.isError && !s ? (
        <ErrorState title="Could not load the historical liability summary" message={getApiErrorMessage(summary.error as UnknownApiError)} onRetry={() => void summary.refetch()} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatisticCard label="Outstanding historical liabilities" value={s ? formatMoney(s.liabilities.outstanding) : '—'} supportingText="Owed to unidentified beneficiaries — not wallet, revenue or driver cash" />
          <StatisticCard label="Tracked shortfall" value={s ? formatMoney(s.liabilities.trackedShortfall) : '—'} supportingText="Tracked separately; never recognized or posted" />
          <StatisticCard label="Recorded liabilities" value={s ? String(s.liabilities.liabilityCount) : '—'} supportingText={s ? `${s.liabilities.reviewOverdueCount} review(s) overdue · ${s.liabilities.unclaimedReviewDueCount} unclaimed-funds review(s) due` : undefined} />
          <StatisticCard label="Invalid liabilities" value={s ? String(s.liabilities.invalidCount) : '—'} supportingText="Each one fails R14 and blocks G5 / G6" />
        </div>
      )}

      <section aria-labelledby="ho-unresolved" className="space-y-2">
        <h2 id="ho-unresolved" className="text-sm font-semibold text-ink">
          Deleted orders with unresolved historical ownership (G5)
        </h2>
        {!s ? (
          summary.isLoading && <LoadingState className="py-8" label="Loading…" />
        ) : s.unresolvedCandidates.length === 0 ? (
          <Card flush>
            <EmptyState className="py-8" title="No unresolved historical ownership." description="G5 reports no deleted order with an unresolved collection difference." />
          </Card>
        ) : (
          <ul className="space-y-2">
            {s.unresolvedCandidates.map((c) => (
              <li key={c.deletedOrderReference}>
                <Card className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0 space-y-0.5 text-sm">
                    <p className="font-medium text-ink">
                      Deleted order <code className="text-xs">{shortId(c.deletedOrderReference)}</code>
                      {c.incidentNumber ? ` · ${c.incidentNumber}` : ''}
                    </p>
                    <p className="text-ink-secondary">
                      Recorded {c.recordedAt ? formatDateTime(c.recordedAt) : '—'} · expected {formatMoney(c.expectedAmount ?? '0')} · collected{' '}
                      {formatMoney(c.actualAmount ?? '0')} · difference {formatMoney(c.difference ?? '0')}
                    </p>
                    <p className="text-xs text-ink-muted">
                      {c.approvedLedgerReconciliationId ? 'Collected amount verified by an approved ledger reconciliation.' : 'No approved ledger reconciliation verifies the collected amount.'}
                      {c.activeResolutionId ? ' A resolution is already in progress.' : ''}
                    </p>
                  </div>
                  {isAdmin && (
                    <Button
                      size="sm"
                      disabled={!s.writesEnabled || !!c.activeResolutionId || !c.approvedLedgerReconciliationId || !c.incidentId || approvedPolicies.length === 0}
                      onClick={() => setDialog({ kind: 'resolution-propose', candidate: c, policies: approvedPolicies })}
                    >
                      Propose liability
                    </Button>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ho-policies" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="ho-policies" className="text-sm font-semibold text-ink">
            Liability policy versions
          </h2>
          {isAdmin && (
            <Button size="sm" variant="secondary" disabled={!s?.writesEnabled} onClick={() => setDialog({ kind: 'policy-propose' })}>
              Propose policy version
            </Button>
          )}
        </div>
        {policies.isError && !policies.data ? (
          <ErrorState title="Could not load policies" message={getApiErrorMessage(policies.error as UnknownApiError)} onRetry={() => void policies.refetch()} />
        ) : policies.isLoading ? (
          <LoadingState className="py-8" label="Loading policies…" />
        ) : (policies.data ?? []).length === 0 ? (
          <Card flush>
            <EmptyState className="py-8" title="No policy versions yet." description="An Admin proposes the Finance-approved policy; an independent Finance user approves it." />
          </Card>
        ) : (
          <ul className="space-y-2">
            {(policies.data ?? []).map((p) => (
              <li key={p.id}>
                <Card className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="font-medium text-ink">
                      {p.policyCode} v{p.version} · {p.title}
                    </p>
                    <Badge tone={statusPresentation(p.status).tone}>{statusPresentation(p.status).label}</Badge>
                  </div>
                  <p className="text-sm text-ink-secondary">{p.summary}</p>
                  <p className="text-xs text-ink-muted">
                    Document <code>{p.documentSha256.slice(0, 16)}…</code> · {p.documentReference} · review every {p.reviewIntervalDays ?? '—'} day(s) · proposed by {p.proposedBy.name}
                    {p.decisions
                      .filter((d) => d.decision === 'APPROVED')
                      .map((d) => ` · approved by ${d.decidedBy.name} on ${formatDate(d.createdAt)}`)
                      .join('')}
                  </p>
                  {p.failures.length > 0 && <p className="text-xs text-danger-700">{p.failures.map(failureMessage).join(' ')}</p>}
                  {s?.writesEnabled && policyActions(p, actor).length > 0 && (
                    <div className="flex flex-wrap gap-2">
                      {policyActions(p, actor).map((a) => (
                        <Button key={a} size="sm" variant={a === 'approve' ? 'primary' : a === 'revoke' ? 'danger' : 'secondary'} onClick={() => setDialog({ kind: 'policy-decide', action: a, policy: p })}>
                          {a[0].toUpperCase() + a.slice(1)}
                        </Button>
                      ))}
                    </div>
                  )}
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="ho-resolutions" className="space-y-2">
        <h2 id="ho-resolutions" className="text-sm font-semibold text-ink">
          Ownership resolutions
        </h2>
        {resolutions.isError && !resolutions.data ? (
          <ErrorState title="Could not load resolutions" message={getApiErrorMessage(resolutions.error as UnknownApiError)} onRetry={() => void resolutions.refetch()} />
        ) : resolutions.isLoading ? (
          <LoadingState className="py-8" label="Loading resolutions…" />
        ) : (resolutions.data?.items ?? []).length === 0 ? (
          <Card flush>
            <EmptyState className="py-8" title="No ownership resolutions yet." />
          </Card>
        ) : isDesktop ? (
          <Card flush className="overflow-x-auto">
            <DataTable columns={columns} rows={resolutions.data?.items ?? []} getRowId={(r) => r.id} caption="Ownership resolutions" onRowClick={(r) => setSelected(r.id)} loading={resolutions.isFetching} />
          </Card>
        ) : (
          // Review L4 — card layout below the desktop breakpoint.
          <ul className="space-y-3">
            {(resolutions.data?.items ?? []).map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => setSelected(r.id)}
                  className="block w-full rounded-card border border-line bg-card p-4 text-left shadow-card hover:border-brand-200"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-ink">{r.incidentNumber}</p>
                      <p className="truncate text-sm text-ink-secondary">
                        Deleted order <code className="text-xs">{shortId(r.deletedOrderReference)}</code>
                      </p>
                    </div>
                    <span className="font-semibold tabular-nums">{formatMoney(r.heldCollectionAmount)}</span>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge tone={statusPresentation(r.status).tone}>{statusPresentation(r.status).label}</Badge>
                    <Badge tone={liabilityStatePresentation(r.liabilityState).tone}>{liabilityStatePresentation(r.liabilityState).label}</Badge>
                    <Badge tone={r.releasesG5 ? 'success' : r.failures.length ? 'danger' : 'neutral'}>
                      {r.releasesG5 ? 'G5: resolved' : r.failures.length ? 'G5: invalid' : 'G5: blocking'}
                    </Badge>
                  </div>
                  <p className="mt-2 text-xs text-ink-muted">
                    Tracked shortfall {formatMoney(r.trackedShortfallAmount)} (not recognized) · proposed {formatDate(r.createdAt)}
                  </p>
                </button>
              </li>
            ))}
          </ul>
        )}
        {resolutions.data?.meta && resolutions.data.meta.totalPages > 1 && (
          <Pagination page={resolutions.data.meta.page} totalPages={resolutions.data.meta.totalPages} total={resolutions.data.meta.total} onPageChange={setPage} />
        )}
      </section>

      <ReconciliationDialogShell open={!!selected && !dialog} title="Ownership resolution" busy={false} wide onClose={() => setSelected(null)}>
        {detail.isLoading || !detail.data ? (
          detail.isError ? (
            <ErrorState title="Could not load the resolution" message={getApiErrorMessage(detail.error as UnknownApiError)} onRetry={() => void detail.refetch()} />
          ) : (
            <LoadingState className="py-8" label="Loading…" />
          )
        ) : (
          (() => {
            const d = detail.data;
            const actions = s?.writesEnabled ? resolutionActions(d, actor) : [];
            return (
              <div className="space-y-4 text-sm">
                <div className="flex flex-wrap gap-1.5">
                  <Badge tone={statusPresentation(d.status).tone}>{statusPresentation(d.status).label}</Badge>
                  <Badge tone={liabilityStatePresentation(d.liabilityState).tone}>{liabilityStatePresentation(d.liabilityState).label}</Badge>
                  <Badge tone={d.releasesG5 ? 'success' : 'neutral'}>{d.releasesG5 ? 'G5: resolved' : 'G5: blocking'}</Badge>
                </div>
                {d.failures.length > 0 && <p className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-danger-700">{d.failures.map(failureMessage).join(' ')}</p>}
                <dl className="grid gap-2 sm:grid-cols-2">
                  {[
                    ['Incident', d.incidentNumber],
                    ['Deleted order reference', d.deletedOrderReference],
                    ['Order type', d.orderType],
                    ['Expected / collected / difference', `${formatMoney(d.expectedAmount)} / ${formatMoney(d.collectedAmount)} / ${formatMoney(d.collectionDifference)}`],
                    ['Held as liability (L1)', formatMoney(d.heldCollectionAmount)],
                    ['Tracked shortfall (L2, not recognized)', formatMoney(d.trackedShortfallAmount)],
                    ['Collection verified by', 'Approved ledger reconciliation (settled in full)'],
                    ['Policy', `${d.policy.policyCode} v${d.policy.version}`],
                    ['Proposed by', `${d.proposedBy.name} · ${formatDateTime(d.createdAt)}`],
                    ['Resolution fingerprint', d.resolutionDigest],
                  ].map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-ink-muted">{k}</dt>
                      <dd className="break-all text-ink">{v}</dd>
                    </div>
                  ))}
                </dl>
                <div>
                  <h3 className="font-medium text-ink">Rationale</h3>
                  <p className="whitespace-pre-wrap text-ink-secondary">{d.rationale}</p>
                </div>
                <div>
                  <h3 className="font-medium text-ink">Evidence fingerprints</h3>
                  <ul className="space-y-1">
                    {d.evidence.map((e) => (
                      <li key={e.ordinal} className="text-ink-secondary">
                        {e.ordinal}. {e.kind} — {e.description} · {e.reference} · <code className="text-xs">{e.documentSha256}</code>
                      </li>
                    ))}
                  </ul>
                </div>
                <div>
                  <h3 className="font-medium text-ink">Decisions</h3>
                  <ul className="space-y-1">
                    {d.decisions.length === 0 && <li className="text-ink-muted">None yet.</li>}
                    {d.decisions.map((x) => (
                      <li key={x.id} className="text-ink-secondary">
                        {x.decision} by {x.decidedBy.name} ({x.decidedBy.role}) · {formatDateTime(x.createdAt)}
                        {x.reason ? ` — ${x.reason}` : ''}
                      </li>
                    ))}
                  </ul>
                </div>
                {d.liability && (
                  <div className="space-y-1 rounded-control border border-line-subtle p-3">
                    <h3 className="font-medium text-ink">Liability register</h3>
                    <p className="text-ink-secondary">
                      Recognized {formatMoney(d.liability.recognizedAmount)} · outstanding {formatMoney(d.liability.outstandingAmount)} · recorded by {d.liability.recordedBy.name} on{' '}
                      {formatDateTime(d.liability.createdAt)}
                    </p>
                    <p className="text-xs text-ink-muted">
                      Next review due {d.liability.nextReviewDueAt ? formatDate(d.liability.nextReviewDueAt) : '—'} · unclaimed-funds review{' '}
                      {d.liability.unclaimedReviewDueAt ? formatDate(d.liability.unclaimedReviewDueAt) : 'not configured'}
                    </p>
                    <ul className="space-y-1">
                      {d.liability.reviews.map((v) => (
                        <li key={v.id} className="text-xs text-ink-secondary">
                          Review by {v.reviewedBy.name} · {formatDateTime(v.createdAt)} — {v.note}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {actions.length > 0 && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {actions.map((a) =>
                      a === 'review' ? (
                        <Button key={a} variant="secondary" onClick={() => setDialog({ kind: 'review', detail: d })}>
                          Record review
                        </Button>
                      ) : (
                        <Button
                          key={a}
                          variant={a === 'approve' || a === 'record-liability' ? 'primary' : a === 'revoke' ? 'danger' : 'secondary'}
                          onClick={() => setDialog({ kind: 'resolution-act', action: a, detail: d })}
                        >
                          {a === 'record-liability' ? 'Record liability' : a[0].toUpperCase() + a.slice(1)}
                        </Button>
                      ),
                    )}
                  </div>
                )}
              </div>
            );
          })()
        )}
      </ReconciliationDialogShell>

      <OwnershipActionDialog spec={dialog} onClose={() => setDialog(null)} onDone={refetchAll} />
    </div>
  );
}
