import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { paths } from '../../../routes/paths';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetDashboardQuery } from '../../../services/dashboardApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { StatusBadge } from '../../../components/orders/StatusBadge';
import { formatDateTime, formatMoney } from '../../../lib/format';

import {
  EMPTY_ORDERS_STATE,
  serializeOrdersListParams,
  type OrdersListState,
} from '../orders/ordersListParams';
import {
  EMPTY_DRIVERS_STATE,
  serializeDriversListParams,
} from '../drivers/driversListParams';

import { MetricTile } from './MetricTile';
import {
  activityLabel,
  activityReference,
  attentionTypeLabel,
  attentionTypeTone,
} from './dashboardPresentation';

/* ---------------------------- link builders --------------------------- */

/** Exact Orders-list URL for a filter patch — reuses the list's own serializer
 *  so param names can never drift. */
function ordersLink(patch: Partial<OrdersListState>): string {
  const qs = serializeOrdersListParams({
    ...EMPTY_ORDERS_STATE,
    ...patch,
  }).toString();
  return qs ? `${paths.management.orders}?${qs}` : paths.management.orders;
}

const driversActiveLink = `${paths.management.drivers}?${serializeDriversListParams(
  { ...EMPTY_DRIVERS_STATE, status: 'active' },
).toString()}`;

/** UTC calendar day — matches the backend's "today" boundary exactly. */
const utcToday = new Date().toISOString().slice(0, 10);

/* -------------------------------- page -------------------------------- */

export default function ManagementDashboardPage() {
  const canCreateOrder = useHasPermission(PERMISSIONS.ORDERS_CREATE);
  const canViewOrders = useHasPermission(PERMISSIONS.ORDERS_READ);
  const canViewCustomers = useHasPermission(PERMISSIONS.CUSTOMERS_READ);
  const canViewDrivers = useHasPermission(PERMISSIONS.DRIVERS_READ);
  const canViewWallets = useHasPermission(PERMISSIONS.WALLETS_READ);
  const canCreatePayout = useHasPermission(PERMISSIONS.PAYOUTS_CREATE);
  const canCreateSettlement = useHasPermission(PERMISSIONS.SETTLEMENTS_CREATE);

  const query = useGetDashboardQuery();
  const data = query.data;

  const quickActions = useMemo<{ label: string; to: string }[]>(() => {
    const entries: { label: string; to: string; show: boolean }[] = [
      { label: 'Create order', to: paths.management.orderNew, show: canCreateOrder },
      { label: 'View orders', to: paths.management.orders, show: canViewOrders },
      { label: 'Customers', to: paths.management.customers, show: canViewCustomers },
      { label: 'Drivers', to: paths.management.drivers, show: canViewDrivers },
      { label: 'Customer wallets', to: paths.management.wallets, show: canViewWallets },
      { label: 'Process payout', to: paths.management.payouts, show: canCreatePayout },
      {
        label: 'Record settlement',
        to: paths.management.driverSettlements,
        show: canCreateSettlement,
      },
    ];
    return entries
      .filter((e) => e.show)
      .map(({ label, to }) => ({ label, to }));
  }, [
      canCreateOrder,
      canViewOrders,
      canViewCustomers,
      canViewDrivers,
      canViewWallets,
      canCreatePayout,
      canCreateSettlement,
    ],
  );

  /* ---------- first load / hard error ---------- */
  if (query.isLoading && !data) {
    return (
      <div className="space-y-5">
        <PageHeader size="lg" title="Dashboard" />
        <LoadingState className="py-20" label="Loading dashboard…" />
      </div>
    );
  }
  if (query.isError && !data) {
    return (
      <div className="space-y-5">
        <PageHeader size="lg" title="Dashboard" />
        <Card flush>
          <ErrorState
            className="py-20"
            title="Could not load the dashboard"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      </div>
    );
  }
  if (!data) return null;

  const { orders, drivers, finance, attention, recentActivity, parcelCollection } = data;

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <Button
        variant="secondary"
        icon={<RefreshCw className={query.isFetching ? 'animate-spin' : ''} />}
        onClick={() => void query.refetch()}
        disabled={query.isFetching}
      >
        Refresh
      </Button>
      {canCreateOrder && (
        <Link
          to={paths.management.orderNew}
          className="inline-flex h-10 items-center rounded-control bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
        >
          Create order
        </Link>
      )}
    </div>
  );

  return (
    <div className="space-y-6 pb-6">
      <PageHeader
        size="lg"
        title="Dashboard"
        description={`Operational overview · ${formatDateTime(data.generatedAt)}`}
        actions={headerActions}
      />

      {query.isError && data && (
        <div
          role="alert"
          className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-ink-secondary"
        >
          Showing the last loaded data — the latest refresh failed.{' '}
          <button
            type="button"
            className="font-medium text-brand-700 underline"
            onClick={() => void query.refetch()}
          >
            Try again
          </button>
        </div>
      )}

      {/* quick actions */}
      {quickActions.length > 0 && (
        <nav aria-label="Quick actions" className="flex flex-wrap gap-2">
          {quickActions.map((a) => (
            <Link
              key={a.to}
              to={a.to}
              className="inline-flex h-9 items-center rounded-control border border-line bg-card px-3 text-sm font-medium text-ink-secondary hover:border-brand-600 hover:text-brand-700"
            >
              {a.label}
            </Link>
          ))}
        </nav>
      )}

      {/* primary operational metrics */}
      <section aria-labelledby="orders-heading" className="space-y-3">
        <h2 id="orders-heading" className="text-sm font-semibold text-ink">
          Orders
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Orders today"
            value={orders.ordersToday}
            emphasis
            to={
              canViewOrders
                ? ordersLink({ createdFrom: utcToday, createdTo: utcToday })
                : undefined
            }
          />
          {/* Phase 11.17.6 — authoritative replacement for the deprecated
              `orders.unassigned` metric: parcel received at company AND no
              current delivery driver AND otherwise assignment-eligible.
              Server-backed via the same workflowQueue the Orders List quick
              tab uses. */}
          <MetricTile
            label="Ready for Delivery"
            value={parcelCollection.readyForDeliveryAssignment}
            emphasis
            hint="Received at company, no delivery driver yet"
            to={
              canViewOrders
                ? ordersLink({ workflowQueue: 'READY_FOR_DELIVERY_ASSIGNMENT' })
                : undefined
            }
          />
          <MetricTile
            label="Out for delivery"
            value={orders.outForDelivery}
            emphasis
            to={
              canViewOrders
                ? ordersLink({ status: 'OUT_FOR_DELIVERY' })
                : undefined
            }
          />
          <MetricTile
            label="Delivered today"
            value={orders.deliveredToday}
            emphasis
            hint="By delivery time (UTC)"
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <MetricTile
            label="Ready for pickup"
            value={orders.readyForPickup}
            to={
              canViewOrders
                ? ordersLink({ status: 'READY_FOR_PICKUP' })
                : undefined
            }
          />
          <MetricTile
            label="Assigned"
            value={orders.assigned}
            to={canViewOrders ? ordersLink({ status: 'ASSIGNED' }) : undefined}
          />
          <MetricTile
            label="Failed today"
            value={orders.failedToday}
            hint="Failed at least once today"
          />
          <MetricTile
            label="Returned"
            value={orders.returned}
            hint="To company or customer"
          />
          <MetricTile
            label="Cancelled"
            value={orders.cancelled}
            to={canViewOrders ? ordersLink({ status: 'CANCELLED' }) : undefined}
          />
        </div>
      </section>

      {/* Parcel Collection — secondary operational panel (Phase 11.17.6).
          Kept visually secondary (smaller, non-emphasis tiles) per the
          approved Dashboard density budget — never a fifth+ giant primary
          card row. */}
      <section aria-labelledby="parcel-collection-heading" className="space-y-3">
        <h2 id="parcel-collection-heading" className="text-sm font-semibold text-ink">
          Parcel Collection
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Awaiting Collection"
            value={parcelCollection.awaitingCollectionAssignment}
            to={
              canViewOrders
                ? ordersLink({ workflowQueue: 'AWAITING_COLLECTION_ASSIGNMENT' })
                : undefined
            }
          />
          <MetricTile
            label="Collection In Progress"
            value={parcelCollection.collectionInProgress}
            to={
              canViewOrders
                ? ordersLink({ workflowQueue: 'COLLECTION_IN_PROGRESS' })
                : undefined
            }
          />
          <MetricTile
            label="Awaiting Company Receipt"
            value={parcelCollection.awaitingCompanyReceipt}
            to={
              canViewOrders
                ? ordersLink({ workflowQueue: 'AWAITING_COMPANY_RECEIPT' })
                : undefined
            }
          />
          <MetricTile
            label="Needs Collection Attention"
            value={parcelCollection.collectionAttention}
            hint="Collection failed — needs reassign/reschedule"
            to={
              canViewOrders
                ? ordersLink({ workflowQueue: 'COLLECTION_ATTENTION' })
                : undefined
            }
          />
        </div>
      </section>

      {/* attention + activity */}
      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="attention-heading" className="space-y-3">
          <h2 id="attention-heading" className="text-sm font-semibold text-ink">
            Needs attention
          </h2>
          <Card className="space-y-4">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              {/* Phase 11.17.6 correction — now backed by the exact same
                  shared workflowQueue predicate as the Orders List /
                  parcelCollection metric (requires parcel received at
                  company), so it is now safely clickable. */}
              <AttentionCount
                label="Ready for delivery"
                count={attention.counts.readyForDeliveryAssignment}
                to={
                  canViewOrders
                    ? ordersLink({ workflowQueue: 'READY_FOR_DELIVERY_ASSIGNMENT' })
                    : undefined
                }
              />
              <AttentionCount
                label="Failed"
                count={attention.counts.failedDeliveries}
                tone="danger"
                to={
                  canViewOrders
                    ? ordersLink({ status: 'FAILED_DELIVERY' })
                    : undefined
                }
              />
              <AttentionCount
                label="Collection"
                count={attention.counts.collectionAttention}
                tone="danger"
                to={
                  canViewOrders
                    ? ordersLink({ workflowQueue: 'COLLECTION_ATTENTION' })
                    : undefined
                }
              />
              <AttentionCount
                label="Review"
                count={attention.counts.collectionDifferences}
                tone="warning"
                to={
                  canViewOrders
                    ? ordersLink({
                        financialStatus: 'REVIEW_REQUIRED',
                        needsFinancialReview: true,
                      })
                    : undefined
                }
              />
              <AttentionCount
                label="Returned"
                count={attention.counts.returned}
              />
            </div>

            {attention.items.length === 0 ? (
              <EmptyState
                className="py-6"
                title="Nothing needs attention"
                description="Ready-for-delivery, failed, returned and review-required orders show up here."
              />
            ) : (
              <ul className="divide-y divide-line-subtle">
                {attention.items.map((item) => {
                  const row = (
                    <>
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={attentionTypeTone(item.type)}>
                          {attentionTypeLabel(item.type)}
                        </Badge>
                        <span className="font-medium text-ink">
                          {item.order.orderNumber}
                        </span>
                        <StatusBadge status={item.order.status} />
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">
                        {item.customer.name} · {item.customer.customerNumber}
                        {item.driver ? ` · ${item.driver.name}` : ''} ·{' '}
                        {formatDateTime(item.occurredAt)}
                      </p>
                    </>
                  );
                  return (
                    <li key={`${item.type}-${item.order.id}`} className="py-2.5">
                      {canViewOrders ? (
                        <Link
                          to={paths.management.orderDetail(item.order.id)}
                          className="block rounded-control -mx-2 px-2 py-1 hover:bg-sunken focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
                        >
                          {row}
                        </Link>
                      ) : (
                        <div>{row}</div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </section>

        <section aria-labelledby="activity-heading" className="space-y-3">
          <h2 id="activity-heading" className="text-sm font-semibold text-ink">
            Recent activity
          </h2>
          <Card>
            {recentActivity.length === 0 ? (
              <EmptyState
                className="py-6"
                title="No recent activity."
                description="Order finalizations, payouts and settlements appear here."
              />
            ) : (
              <ol className="divide-y divide-line-subtle">
                {recentActivity.map((item) => {
                  const ref = activityReference(item.context);
                  const orderLink =
                    item.entityType === 'ORDER' &&
                    item.context.orderNumber &&
                    canViewOrders
                      ? paths.management.orderDetail(item.entityId)
                      : null;
                  return (
                    <li
                      key={item.id}
                      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 py-2.5 first:pt-0 last:pb-0"
                    >
                      <div className="min-w-0">
                        <p className="text-sm text-ink">
                          {activityLabel(item.action)}
                          {ref && (
                            <>
                              {' · '}
                              {orderLink ? (
                                <Link
                                  to={orderLink}
                                  className="font-medium text-brand-600 hover:underline"
                                >
                                  {ref}
                                </Link>
                              ) : (
                                <span className="font-medium text-ink-secondary">
                                  {ref}
                                </span>
                              )}
                            </>
                          )}
                        </p>
                        {item.actor && (
                          <p className="text-xs text-ink-muted">
                            by {item.actor.firstName} {item.actor.lastName}
                          </p>
                        )}
                      </div>
                      <span className="shrink-0 text-xs text-ink-muted">
                        {formatDateTime(item.occurredAt)}
                      </span>
                    </li>
                  );
                })}
              </ol>
            )}
          </Card>
        </section>
      </div>

      {/* driver metrics */}
      <section aria-labelledby="drivers-heading" className="space-y-3">
        <h2 id="drivers-heading" className="text-sm font-semibold text-ink">
          Drivers
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <MetricTile
            label="Active drivers"
            value={drivers.activeDrivers}
            to={canViewDrivers ? driversActiveLink : undefined}
          />
          <MetricTile
            label="Currently delivering"
            value={drivers.driversCurrentlyDelivering}
          />
          <MetricTile
            label="Active assignments"
            value={drivers.ordersAssigned}
            hint="Orders held by a driver"
          />
          <MetricTile
            label="Deliveries completed today"
            value={drivers.deliveriesCompletedToday}
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <MetricTile
            label="Active collection jobs"
            value={drivers.activeCollectionJobs}
            hint="Separate from delivery assignments"
          />
          <MetricTile
            label="Collections completed today"
            value={drivers.collectionsCompletedToday}
          />
        </div>
        {(drivers.driversWithUnsettledCash !== null ||
          drivers.totalDriverCashHeld !== null) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {drivers.driversWithUnsettledCash !== null && (
              <MetricTile
                label="Drivers holding cash"
                value={drivers.driversWithUnsettledCash}
                hint="Have an unsettled balance"
              />
            )}
            {drivers.totalDriverCashHeld !== null && (
              <MetricTile
                label="Total driver cash held"
                value={formatMoney(drivers.totalDriverCashHeld)}
                hint="Collected, not yet settled"
              />
            )}
          </div>
        )}
      </section>

      {/* financial summary — only when the API returns it (finance.read) */}
      {finance ? (
        <section aria-labelledby="finance-heading" className="space-y-3">
          <h2 id="finance-heading" className="text-sm font-semibold text-ink">
            Financial summary
          </h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <MetricTile
              label="Delivery fee revenue"
              value={formatMoney(finance.deliveryFeeRevenue)}
            />
            <MetricTile
              label="Company order revenue"
              value={formatMoney(finance.companyOrderRevenue)}
            />
            <MetricTile
              label="Total collected"
              value={formatMoney(finance.totalCollected)}
            />
            <MetricTile
              label="Customer wallet liability"
              value={formatMoney(finance.customerWalletLiability)}
            />
            <MetricTile
              label="Customer payouts"
              value={formatMoney(finance.customerPayouts)}
            />
            <MetricTile
              label="Driver unsettled cash"
              value={formatMoney(finance.driverCashOutstanding)}
            />
          </div>
          <p className="text-xs text-ink-muted">
            Approved system-wide summary (all-time). Detailed date-ranged
            figures, transactions and corrections live in Finance.
          </p>
        </section>
      ) : (
        <section aria-labelledby="finance-heading" className="space-y-3">
          <h2 id="finance-heading" className="text-sm font-semibold text-ink">
            Financial summary
          </h2>
          <Card className="text-sm text-ink-muted">
            The financial summary requires finance access.
          </Card>
        </section>
      )}
    </div>
  );
}

/* --------------------------- attention count -------------------------- */

function AttentionCount({
  label,
  count,
  tone = 'neutral',
  to,
}: {
  label: string;
  count: number;
  tone?: 'neutral' | 'warning' | 'danger';
  to?: string;
}) {
  const toneCls =
    count === 0
      ? 'text-ink-muted'
      : tone === 'danger'
        ? 'text-danger-700'
        : tone === 'warning'
          ? 'text-warning-700'
          : 'text-ink';
  const inner = (
    <>
      <p className={`text-xl font-semibold tabular-nums ${toneCls}`}>{count}</p>
      <p className="text-xs text-ink-muted">{label}</p>
    </>
  );
  if (to && count > 0) {
    return (
      <Link
        to={to}
        className="rounded-control border border-line-subtle bg-sunken/40 px-3 py-2 hover:border-brand-600 focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand-600"
      >
        {inner}
      </Link>
    );
  }
  return (
    <div className="rounded-control border border-line-subtle bg-sunken/40 px-3 py-2">
      {inner}
    </div>
  );
}
