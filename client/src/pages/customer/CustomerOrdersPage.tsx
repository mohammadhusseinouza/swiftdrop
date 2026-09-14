import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Package } from 'lucide-react';

import { useGetCustomerOrdersQuery } from '../../services/customerOrdersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { CustomerOrderView } from '../../services/domain.types';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Pagination } from '../../components/data-display/Pagination';
import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Card } from '../../components/ui/Card';
import { cn } from '../../components/ui/cn';
import { CustomerOrderCard } from '../../components/customer/CustomerOrderCard';

const VIEW_TABS: ReadonlyArray<{ id: CustomerOrderView; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'delivered', label: 'Delivered' },
];

const VIEW_IDS = new Set<string>(VIEW_TABS.map((t) => t.id));

const EMPTY_COPY: Record<CustomerOrderView, { title: string; description: string }> = {
  all: {
    title: 'No orders yet.',
    description: 'Orders created for you will appear here.',
  },
  active: {
    title: 'No active orders.',
    description: 'Orders still in progress will appear here.',
  },
  delivered: {
    title: 'No delivered orders yet.',
    description: 'Orders delivered to the receiver will appear here.',
  },
};

function parseView(sp: URLSearchParams): CustomerOrderView {
  const raw = sp.get('view');
  return raw && VIEW_IDS.has(raw) ? (raw as CustomerOrderView) : 'all';
}
function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Phase 13.2 — /customer/orders ("My Orders").
 *
 * READ-ONLY self-scoped list from GET /api/v1/customer/me/orders. View +
 * page state live in the URL (same convention as the Driver history pages).
 * No mutation controls; no link to Order Detail yet (Phase 13.3 — task §31).
 */
export default function CustomerOrdersPage() {
  const [sp, setSp] = useSearchParams();
  const view = parseView(sp);
  const page = parsePage(sp);

  const params = useMemo(() => ({ page, view }), [page, view]);
  const query = useGetCustomerOrdersQuery(params);
  const orders = query.data?.items ?? [];
  const meta = query.data?.meta;

  const selectView = (id: CustomerOrderView) => {
    const next = new URLSearchParams(sp);
    if (id === 'all') next.delete('view');
    else next.set('view', id);
    next.delete('page');
    setSp(next);
  };
  const setPage = (next: number) => {
    const nextSp = new URLSearchParams(sp);
    if (next <= 1) nextSp.delete('page');
    else nextSp.set('page', String(next));
    setSp(nextSp);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        size="lg"
        title="My Orders"
        description="Track your active and past orders."
      />

      <div
        role="tablist"
        aria-label="Order view"
        className="flex gap-1.5 overflow-x-auto pb-1"
      >
        {VIEW_TABS.map((tab) => {
          const active = tab.id === view;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectView(tab.id)}
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
          <LoadingState className="py-16" label="Loading your orders…" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : orders.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-16"
            icon={<Package />}
            title={EMPTY_COPY[view].title}
            description={EMPTY_COPY[view].description}
          />
        </Card>
      ) : (
        <>
          <ul className="space-y-3">
            {orders.map((order) => (
              <li key={order.id}>
                <CustomerOrderCard order={order} />
              </li>
            ))}
          </ul>

          {meta && meta.totalPages > 1 && (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </div>
  );
}
