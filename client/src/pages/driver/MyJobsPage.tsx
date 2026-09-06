import { useMemo, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { PackageSearch } from 'lucide-react';

import { useGetDriverJobsQuery } from '../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Pagination } from '../../components/data-display/Pagination';
import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { DriverJobCard } from '../../components/driver/DriverJobCard';
import type { DriverJobType } from '../../services/domain.types';

const JOB_TYPE_TABS: ReadonlyArray<{ id: 'ALL' | DriverJobType; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'COLLECTION', label: 'Collection' },
  { id: 'DELIVERY', label: 'Delivery' },
];

function parseJobTypeTab(sp: URLSearchParams): 'ALL' | DriverJobType {
  const raw = sp.get('jobType');
  return raw === 'COLLECTION' || raw === 'DELIVERY' ? raw : 'ALL';
}

function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Phase 12.1 — My Jobs. The Driver Portal landing page: current Collection
 * (Sender -> Company) and current Delivery (Company -> Receiver)
 * responsibilities, combined and server-sorted. READ-ONLY — no workflow
 * actions yet (later Phase 12 sub-phases).
 *
 * Filter/page state lives in the URL (same convention as the Management
 * list pages) so a refresh or a shared link keeps the same view.
 */
export default function MyJobsPage() {
  const [sp, setSp] = useSearchParams();
  const location = useLocation();
  const activeTab = parseJobTypeTab(sp);
  const page = parsePage(sp);

  // Phase 12.3 — a successful "Report Collection Failed" navigates here with
  // a one-shot notice in router state (no toast system exists in this
  // project; this matches the existing dismissible-banner convention used
  // by the Management Order Detail page's `actionNotice`).
  const [notice, setNotice] = useState<string | null>(
    (location.state as { notice?: string } | null)?.notice ?? null,
  );

  const params = useMemo(
    () => ({
      page,
      jobType: activeTab === 'ALL' ? undefined : activeTab,
    }),
    [page, activeTab],
  );

  const query = useGetDriverJobsQuery(params);
  const jobs = query.data?.items ?? [];
  const meta = query.data?.meta;

  const selectTab = (id: 'ALL' | DriverJobType) => {
    const next = new URLSearchParams(sp);
    if (id === 'ALL') next.delete('jobType');
    else next.set('jobType', id);
    next.delete('page');
    setSp(next);
  };

  const setPage = (next: number) => {
    const params = new URLSearchParams(sp);
    if (next <= 1) params.delete('page');
    else params.set('page', String(next));
    setSp(params);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        size="lg"
        title="My Jobs"
        description="Your current Collection and Delivery work."
      />

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-card border border-line bg-card px-4 py-2.5 text-sm text-ink-secondary"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs font-medium text-ink-muted hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      <div role="tablist" aria-label="Job type" className="flex gap-1.5 overflow-x-auto pb-1">
        {JOB_TYPE_TABS.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectTab(tab.id)}
              className={cn(
                'inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[0.5rem] border px-3.5 text-sm transition-colors',
                active
                  ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                  : 'border-line bg-card font-medium text-ink-secondary hover:bg-sunken',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading your jobs…" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : jobs.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-16"
            icon={<PackageSearch />}
            title="No active jobs assigned."
            description={
              activeTab === 'ALL'
                ? 'New Collection and Delivery jobs will show up here as soon as they are assigned to you.'
                : 'Try the "All" tab to see your other current work.'
            }
          />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {jobs.map((job) => (
            <li key={`${job.jobType}:${job.orderId}`}>
              <DriverJobCard job={job} />
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <Pagination page={meta.page} totalPages={meta.totalPages} total={meta.total} onPageChange={setPage} />
      )}
    </div>
  );
}
