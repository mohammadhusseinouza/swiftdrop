import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { History } from 'lucide-react';

import {
  useGetDriverWorkHistoryQuery,
  type ListDriverHistoryParams,
} from '../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { DriverHistoryJobType, DriverHistoryResult } from '../../services/domain.types';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Pagination } from '../../components/data-display/Pagination';
import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { DriverHistoryCard } from '../../components/driver/DriverHistoryCard';

const JOB_TYPE_TABS: ReadonlyArray<{ id: 'ALL' | DriverHistoryJobType; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'COLLECTION', label: 'Collection' },
  { id: 'DELIVERY', label: 'Delivery' },
];

function parseJobTypeTab(sp: URLSearchParams): 'ALL' | DriverHistoryJobType {
  const raw = sp.get('jobType');
  return raw === 'COLLECTION' || raw === 'DELIVERY' ? raw : 'ALL';
}

function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

export interface DriverHistoryPageProps {
  result: DriverHistoryResult;
  title: string;
  description: string;
  /** Empty-state copy when this Driver has no history of this result at all. */
  emptyTitle: string;
  /** Noun for the work-summary line, e.g. "completed" / "failed". */
  summaryNoun: string;
}

/**
 * Phase 12.5 — shared body for the two READ-ONLY Driver history surfaces
 * ("Completed" and "Failed / Returned"). One `GET /driver/history` call with
 * a fixed `result` filter and an optional All / Collection / Delivery
 * job-type filter. Filter + page state live in the URL (same convention as
 * My Jobs) so a refresh or shared link keeps the view. No workflow actions,
 * no links into the current-job detail route (task §33).
 */
export function DriverHistoryPage({
  result,
  title,
  description,
  emptyTitle,
  summaryNoun,
}: DriverHistoryPageProps) {
  const [sp, setSp] = useSearchParams();
  const activeTab = parseJobTypeTab(sp);
  const page = parsePage(sp);

  const params = useMemo<ListDriverHistoryParams>(
    () => ({
      page,
      result,
      jobType: activeTab === 'ALL' ? undefined : activeTab,
    }),
    [page, result, activeTab],
  );

  const query = useGetDriverWorkHistoryQuery(params);
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const selectTab = (id: 'ALL' | DriverHistoryJobType) => {
    const next = new URLSearchParams(sp);
    if (id === 'ALL') next.delete('jobType');
    else next.set('jobType', id);
    next.delete('page');
    setSp(next);
  };

  const setPage = (next: number) => {
    const nextSp = new URLSearchParams(sp);
    if (next <= 1) nextSp.delete('page');
    else nextSp.set('page', String(next));
    setSp(nextSp);
  };

  const filteredEmptyDescription =
    activeTab === 'ALL'
      ? undefined
      : `No ${summaryNoun} ${activeTab === 'COLLECTION' ? 'Collection' : 'Delivery'} jobs. Try the "All" tab.`;

  return (
    <div className="space-y-4">
      <PageHeader size="lg" title={title} description={description} />

      <div
        role="tablist"
        aria-label="Job type"
        className="flex gap-1.5 overflow-x-auto pb-1"
      >
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

      {!query.isLoading && !query.isError && meta && meta.total > 0 && (
        <p className="text-sm text-ink-muted">
          <span className="font-medium text-ink">{meta.total}</span> {summaryNoun}{' '}
          {meta.total === 1 ? 'job' : 'jobs'}
        </p>
      )}

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading your history…" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-16"
            icon={<History />}
            title={activeTab === 'ALL' ? emptyTitle : `No ${summaryNoun} jobs in this filter.`}
            description={filteredEmptyDescription}
          />
        </Card>
      ) : (
        <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {rows.map((item) => (
            <li key={item.id}>
              <DriverHistoryCard item={item} />
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <Pagination
          page={meta.page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
