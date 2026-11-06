import { useId, useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Package } from 'lucide-react';

import { useGetCustomerOrdersQuery } from '../../services/customerOrdersApi';
import { useGetCustomerDashboardQuery } from '../../services/customerDashboardApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { CustomerOrderView } from '../../services/domain.types';

import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { CustomerPageHeader } from '../../components/customer/CustomerPageHeader';
import { SegmentedTabs } from '../../components/customer/SegmentedTabs';
import { CustomerPagination } from '../../components/customer/CustomerPagination';
import { CustomerOrderCard } from '../../components/customer/CustomerOrderCard';
import { getCustomerOrderTabCounts } from '../../components/customer/customerOrderPresentation';

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
 * /customer/orders — My Orders (Customer Portal Redesign Step 3, handoff §3.2).
 *
 * READ-ONLY self-scoped list from GET /api/v1/customer/me/orders. `view` and
 * `page` live in the URL exactly as before (All drops `view`; changing view
 * resets `page`). Tab counts never come from the current page: Active /
 * Delivered from the cached self-scoped dashboard summary, All from the All
 * list's own `meta.total` (see getCustomerOrderTabCounts).
 */
export default function CustomerOrdersPage() {
  const [sp, setSp] = useSearchParams();
  const view = parseView(sp);
  const page = parsePage(sp);
  const panelId = useId();

  const params = useMemo(() => ({ page, view }), [page, view]);
  const query = useGetCustomerOrdersQuery(params);
  const summary = useGetCustomerDashboardQuery();
  const orders = query.data?.items ?? [];
  const meta = query.data?.meta;

  const counts = getCustomerOrderTabCounts({
    view,
    currentTotal: query.currentData?.meta.total,
    summary: summary.data,
  });

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
    <div className="flex flex-col gap-7">
      <CustomerPageHeader
        eyebrow="My orders"
        title="Every parcel, at a glance."
        lead="Follow each order from received to delivered."
        action={
          <SegmentedTabs
            label="Order view"
            panelId={panelId}
            value={view}
            onChange={selectView}
            items={VIEW_TABS.map((t) => ({ value: t.id, label: t.label, count: counts[t.id] }))}
          />
        }
      />

      <div id={panelId} role="tabpanel" aria-label={`${VIEW_TABS.find((t) => t.id === view)?.label} orders`}>
        {query.isLoading ? (
          <StatePanel>
            <LoadingState className="py-16" label="Loading your orders…" />
          </StatePanel>
        ) : query.isError ? (
          <StatePanel>
            <ErrorState
              className="py-16"
              message={getApiErrorMessage(query.error as UnknownApiError)}
              onRetry={() => void query.refetch()}
            />
          </StatePanel>
        ) : orders.length === 0 ? (
          <StatePanel>
            <EmptyState
              className="py-16"
              icon={<Package />}
              title={EMPTY_COPY[view].title}
              description={EMPTY_COPY[view].description}
            />
          </StatePanel>
        ) : (
          <div className="flex flex-col gap-6">
            <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,520px),1fr))] gap-5">
              {orders.map((order) => (
                <li key={order.id} className="min-w-0">
                  <CustomerOrderCard order={order} />
                </li>
              ))}
            </ul>

            {meta && meta.totalPages > 1 && (
              <CustomerPagination
                page={meta.page}
                totalPages={meta.totalPages}
                total={meta.total}
                noun={meta.total === 1 ? 'order' : 'orders'}
                onPageChange={setPage}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function StatePanel({ children }: { children: ReactNode }) {
  return <div className="rounded-panel border border-line bg-card">{children}</div>;
}
