import { Link } from 'react-router-dom';

import { Badge } from '../../../components/ui/Badge';
import { Card } from '../../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { OrderTypeBadge } from '../../../components/orders/OrderTypeBadge';
import { paths } from '../../../routes/paths';
import { formatDate, formatMoney } from '../../../lib/format';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import {
  useGetOutstandingCollectionsQuery,
  type OutstandingCollection,
} from '../../../services/settlementsApi';
import { collectionStateLabel, reviewStatusLabel } from '../../../components/finance/financialRelease';

const PAGE_SIZE = 20;

/**
 * FR.10 — Driver Detail › Cash: the attributed / unattributed split of the
 * cash this driver holds and the outstanding settlement-mode collections
 * (GET /finance/driver-cash/:driverId/outstanding-collections, finance.read —
 * the Cash tab is already finance.read-gated). Read-only: settling happens in
 * the Process Settlement dialog on Driver Settlements, never here. Paginated
 * by the server; refreshed by the driver's cash tag (settlements, adjustments,
 * reversals).
 */
export function OutstandingCollectionsSection({
  driverId,
  page,
  onPageChange,
  canViewOrders,
  canSettle,
}: {
  driverId: string;
  page: number;
  onPageChange: (page: number) => void;
  canViewOrders: boolean;
  canSettle: boolean;
}) {
  const isDesktop = useMediaQuery(MD_QUERY);
  const query = useGetOutstandingCollectionsQuery({ driverId, page, limit: PAGE_SIZE });
  const data = query.data;
  const items = data?.items ?? [];

  const orderRef = (c: OutstandingCollection) =>
    canViewOrders ? (
      <Link to={paths.management.orderDetail(c.order.id)} className="font-medium text-brand-600 hover:underline">
        {c.order.orderNumber}
      </Link>
    ) : (
      <span className="font-medium">{c.order.orderNumber}</span>
    );

  const badges = (c: OutstandingCollection) => {
    const state = collectionStateLabel(c.settlementState);
    const review = reviewStatusLabel(c.reviewStatus);
    return (
      <span className="flex flex-wrap gap-1">
        <Badge tone={state.tone}>{state.label}</Badge>
        {review && <Badge tone={review.tone}>{review.label}</Badge>}
      </span>
    );
  };

  const columns: DataTableColumn<OutstandingCollection>[] = [
    { id: 'order', header: 'Order', cell: (c) => orderRef(c) },
    {
      id: 'customer',
      header: 'Customer',
      cell: (c) => (
        <span className="flex flex-col gap-0.5">
          <span>{c.customer.name}</span>
          <OrderTypeBadge orderType={c.orderType} />
        </span>
      ),
    },
    { id: 'delivered', header: 'Delivered', hideBelow: 'lg', cell: (c) => formatDate(c.deliveredAt) },
    { id: 'collection', header: 'Collected', align: 'right', cell: (c) => <span className="tabular-nums">{formatMoney(c.collectionAmount)}</span> },
    { id: 'settled', header: 'Settled', align: 'right', hideBelow: 'lg', cell: (c) => <span className="tabular-nums">{formatMoney(c.allocatedAmount)}</span> },
    { id: 'outstanding', header: 'Outstanding', align: 'right', cell: (c) => <span className="font-semibold tabular-nums">{formatMoney(c.outstandingAmount)}</span> },
    { id: 'state', header: 'State', cell: (c) => badges(c) },
  ];

  return (
    <Card className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-ink">Outstanding collections</h3>
          <p className="text-xs text-ink-muted">
            Settlement-mode deliveries whose cash this driver has not fully handed over. They release to the customer
            and company only when fully settled.
          </p>
        </div>
        {canSettle && (data?.outstandingCollectionCount ?? 0) > 0 && (
          <Link
            to={`${paths.management.driverSettlements}?driverId=${driverId}`}
            className="inline-flex h-9 items-center rounded-control border border-line bg-card px-3 text-sm font-medium text-ink-secondary hover:bg-sunken"
          >
            Go to settlements
          </Link>
        )}
      </div>

      {data && (
        <dl className="grid grid-cols-1 gap-2 rounded-control border border-line-subtle bg-sunken px-3 py-2.5 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs text-ink-muted">Cash held</dt>
            <dd className="font-semibold tabular-nums">{formatMoney(data.cashBalance)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Attributed to collections</dt>
            <dd className="tabular-nums">{formatMoney(data.attributedOutstanding)}</dd>
          </div>
          <div>
            <dt className="text-xs text-ink-muted">Unattributed</dt>
            <dd className="tabular-nums">{formatMoney(data.unattributedBalance)}</dd>
            <dd className="text-[11px] text-ink-subtle">Legacy collections, adjustments, corrections</dd>
          </div>
        </dl>
      )}

      {query.isLoading ? (
        <LoadingState className="py-6" label="Loading outstanding collections…" />
      ) : query.isError ? (
        <ErrorState className="py-6" message={getApiErrorMessage(query.error as UnknownApiError)} onRetry={() => void query.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState
          className="py-6"
          title="No outstanding collections"
          description="Every settlement-mode collection of this driver is fully settled (or none exists)."
        />
      ) : isDesktop ? (
        <DataTable columns={columns} rows={items} getRowId={(c) => c.releaseId} caption="Outstanding collections" />
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li key={c.releaseId} className="rounded-card border border-line bg-card p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  {orderRef(c)}
                  <p className="text-xs text-ink-muted">
                    {c.customer.name} · Delivered {formatDate(c.deliveredAt)}
                  </p>
                </div>
                <span className="font-semibold tabular-nums">{formatMoney(c.outstandingAmount)}</span>
              </div>
              <p className="mt-1 text-xs text-ink-muted">
                Settled {formatMoney(c.allocatedAmount)} of {formatMoney(c.collectionAmount)}
              </p>
              <div className="mt-2">{badges(c)}</div>
            </li>
          ))}
        </ul>
      )}

      {data?.meta && data.meta.totalPages > 1 && (
        <Pagination page={page} totalPages={data.meta.totalPages} total={data.meta.total} onPageChange={onPageChange} />
      )}
    </Card>
  );
}
