import { useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from '../../../routes/paths';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetOrderReportQuery } from '../../../services/reportsApi';
import { useGetAreasQuery } from '../../../services/settingsApi';
import type {
  OrderReportAreaRow,
  OrderReportCustomerRow,
  OrderReportDateRow,
  OrderReportDriverRow,
  OrderReportStatusRow,
  OrderReportTypeRow,
} from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import {
  EMPTY_ORDERS_STATE,
  serializeOrdersListParams,
  type OrdersListState,
} from '../orders/ordersListParams';
import {
  ORDER_STATUSES,
  ORDER_TYPES,
  getOrderStatusPresentation,
  getOrderTypeLabel,
} from '../../../components/orders/orderStatus';
import {
  PARCEL_COLLECTION_STATUSES,
  PARCEL_INTAKE_METHODS,
  getParcelCollectionStatusPresentation,
  getParcelIntakeMethodLabel,
} from '../../../components/orders/parcelCollection';
import { formatMoney } from '../../../lib/format';

import { MetricTile } from '../dashboard/MetricTile';
import { ReportResult, ReportSection, periodLabel } from './reportShared';
import {
  ORDER_REPORT_BUCKET,
  ORDER_REPORT_GROUP_BY,
  parseDateRange,
  parseOrdersReportState,
  patchReportParams,
  type OrderReportGroupByOpt,
} from './reportsParams';

const GROUP_BY_LABEL: Record<OrderReportGroupByOpt, string> = {
  date: 'By date',
  customer: 'By customer',
  driver: 'By driver',
  area: 'By area',
  status: 'By status',
  type: 'By type',
  outcome: 'Delivered vs failed',
};

const num = (n: number) => n.toLocaleString();

export function OrdersReport() {
  const [sp, setSp] = useSearchParams();
  const { from, to } = parseDateRange(sp);
  const state = parseOrdersReportState(sp);

  const canViewOrders = useHasPermission(PERMISSIONS.ORDERS_READ);
  const canViewCustomers = useHasPermission(PERMISSIONS.CUSTOMERS_READ);
  const canViewDrivers = useHasPermission(PERMISSIONS.DRIVERS_READ);

  const areas = useGetAreasQuery({ isActive: true, limit: 100 });

  const patch = useCallback(
    (p: Record<string, string | undefined>) => setSp(patchReportParams(sp, p)),
    [sp, setSp],
  );

  const query = useGetOrderReportQuery({
    from: from || undefined,
    to: to || undefined,
    groupBy: state.groupBy,
    bucket: state.groupBy === 'date' ? state.bucket : undefined,
    status: state.status || undefined,
    orderType: state.orderType || undefined,
    areaId: state.areaId || undefined,
    parcelIntakeMethod: state.parcelIntakeMethod || undefined,
    parcelCollectionStatus: state.parcelCollectionStatus || undefined,
    parcelCollectionDriverId: state.parcelCollectionDriverId || undefined,
  });
  const data = query.data;

  /** An orders-list link carrying the report's own date range + one dimension. */
  const ordersLink = useCallback(
    (dim: Partial<OrdersListState>) => {
      const qs = serializeOrdersListParams({
        ...EMPTY_ORDERS_STATE,
        ...dim,
        createdFrom: from,
        createdTo: to,
      }).toString();
      return qs ? `${paths.management.orders}?${qs}` : paths.management.orders;
    },
    [from, to],
  );

  const rowsEmpty =
    !data ||
    (state.groupBy === 'outcome'
      ? !data.outcome
      : data.rows.length === 0);

  return (
    <div className="space-y-5">
      {/* filters */}
      <Card flush className="p-4 sm:p-5">
        <div role="search" className="flex flex-wrap items-end gap-2">
          <FilterSelect
            label="Group by"
            value={state.groupBy}
            onChange={(v) => patch({ groupBy: v, bucket: undefined })}
            options={ORDER_REPORT_GROUP_BY.map((g) => ({
              value: g,
              label: GROUP_BY_LABEL[g],
            }))}
          />
          {state.groupBy === 'date' && (
            <FilterSelect
              label="Bucket"
              value={state.bucket}
              onChange={(v) => patch({ bucket: v })}
              options={ORDER_REPORT_BUCKET.map((b) => ({
                value: b,
                label: b[0].toUpperCase() + b.slice(1),
              }))}
            />
          )}
          <FilterSelect
            label="Status"
            value={state.status}
            onChange={(v) => patch({ status: v || undefined })}
            options={[
              { value: '', label: 'Any status' },
              ...ORDER_STATUSES.map((s) => ({
                value: s,
                label: getOrderStatusPresentation(s).label,
              })),
            ]}
          />
          <FilterSelect
            label="Order type"
            value={state.orderType}
            onChange={(v) => patch({ orderType: v || undefined })}
            options={[
              { value: '', label: 'Any type' },
              ...ORDER_TYPES.map((t) => ({ value: t, label: getOrderTypeLabel(t) })),
            ]}
          />
          <FilterSelect
            label="Area"
            value={state.areaId}
            onChange={(v) => patch({ areaId: v || undefined })}
            disabled={areas.isLoading}
            options={[
              { value: '', label: areas.isLoading ? 'Loading…' : 'Any area' },
              ...(areas.data?.items ?? []).map((a) => ({
                value: a.id,
                label: a.name,
              })),
            ]}
          />
          <FilterSelect
            label="Parcel intake"
            value={state.parcelIntakeMethod}
            onChange={(v) => patch({ parcelIntakeMethod: v || undefined })}
            options={[
              { value: '', label: 'Any intake method' },
              ...PARCEL_INTAKE_METHODS.map((m) => ({
                value: m,
                label: getParcelIntakeMethodLabel(m),
              })),
            ]}
          />
          <FilterSelect
            label="Collection status"
            value={state.parcelCollectionStatus}
            onChange={(v) => patch({ parcelCollectionStatus: v || undefined })}
            options={[
              { value: '', label: 'Any collection status' },
              ...PARCEL_COLLECTION_STATUSES.map((s) => ({
                value: s,
                label: getParcelCollectionStatusPresentation(s).label,
              })),
            ]}
          />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Population: orders <strong>created</strong> in the date range (whole UTC
          days). Delivered / failed counts use each order&rsquo;s current status,
          except <em>by driver</em>, which uses historical delivery attempts.
        </p>
      </Card>

      {/* summary */}
      <ReportSection title="Summary">
        {query.isLoading && !data ? (
          <SkeletonGrid />
        ) : data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="Total orders" value={num(data.summary.totalOrders)} emphasis />
              <MetricTile label="Delivered" value={num(data.summary.deliveredOrders)} emphasis />
              <MetricTile label="Failed" value={num(data.summary.failedOrders)} emphasis />
              <MetricTile label="Cancelled" value={num(data.summary.cancelledOrders)} emphasis />
              <MetricTile label="Company orders" value={num(data.summary.companyOrders)} />
              <MetricTile label="Delivery-only orders" value={num(data.summary.deliveryOnlyOrders)} />
              <MetricTile label="Total order amount" value={formatMoney(data.summary.totalOrderAmount)} />
              <MetricTile label="Total delivery fee" value={formatMoney(data.summary.totalDeliveryFee)} />
              <MetricTile
                label="Expected collection"
                value={formatMoney(data.summary.totalExpectedCollection)}
              />
              <MetricTile
                label="Actual collected"
                value={formatMoney(data.summary.totalActualCollection)}
              />
            </div>
            {data.outcome && state.groupBy === 'outcome' && (
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <MetricTile label="Delivered orders" value={num(data.outcome.deliveredOrders)} />
                <MetricTile
                  label="Currently failed"
                  value={num(data.outcome.failedCurrent)}
                  hint="Orders whose current status is failed"
                />
                <MetricTile
                  label="Failed attempts"
                  value={num(data.outcome.failedAttempts)}
                  hint="Historical event count — can exceed 'currently failed'"
                />
              </div>
            )}
          </>
        ) : null}
      </ReportSection>

      {/* Parcel Intake / Collection summary (Phase 11.17.6) — financially
          neutral dimensions over the same population as the summary above. */}
      <ReportSection title="Parcel Intake &amp; Collection">
        {data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricTile label="Already at company" value={num(data.parcel.alreadyAtCompanyOrders)} />
            <MetricTile label="Driver collection" value={num(data.parcel.driverCollectionOrders)} />
            <MetricTile label="Awaiting collection" value={num(data.parcel.awaitingCollectionAssignment)} />
            <MetricTile label="Collection in progress" value={num(data.parcel.collectionInProgress)} />
            <MetricTile label="Collection attention" value={num(data.parcel.collectionAttention)} />
            <MetricTile label="Awaiting company receipt" value={num(data.parcel.awaitingCompanyReceipt)} />
            <MetricTile label="Ready for delivery assignment" value={num(data.parcel.readyForDeliveryAssignment)} />
          </div>
        ) : (
          <SkeletonGrid />
        )}
      </ReportSection>

      {/* grouped results */}
      <ReportSection title={GROUP_BY_LABEL[state.groupBy]}>
        <ReportResult
          isLoading={query.isLoading && !data}
          isError={query.isError && !data}
          error={query.error}
          onRetry={() => void query.refetch()}
          isEmpty={!query.isLoading && !query.isError && rowsEmpty}
          emptyTitle="No order report data for this period."
          emptyDescription="Adjust the date range or grouping."
        >
          {data && state.groupBy !== 'outcome' && (
            <Card flush className="overflow-x-auto">
              <OrdersRows
                data={data}
                canViewCustomers={canViewCustomers}
                canViewDrivers={canViewDrivers}
                canViewOrders={canViewOrders}
                ordersLink={ordersLink}
              />
            </Card>
          )}
          {data && state.groupBy === 'outcome' && (
            <Card className="text-sm text-ink-muted">
              Delivered vs failed totals are shown in the summary above.
            </Card>
          )}
        </ReportResult>
      </ReportSection>
    </div>
  );
}

/* ------------------------------- rows ------------------------------- */

function OrdersRows({
  data,
  canViewCustomers,
  canViewDrivers,
  canViewOrders,
  ordersLink,
}: {
  data: NonNullable<ReturnType<typeof useGetOrderReportQuery>['data']>;
  canViewCustomers: boolean;
  canViewDrivers: boolean;
  canViewOrders: boolean;
  ordersLink: (dim: Partial<OrdersListState>) => string;
}) {
  const gb = data.groupBy;

  if (gb === 'date') {
    const rows = data.rows as OrderReportDateRow[];
    const cols: DataTableColumn<OrderReportDateRow>[] = [
      { id: 'period', header: 'Period', cell: (r) => periodLabel(r.period) },
      { id: 'orders', header: 'Orders', align: 'right', cell: (r) => num(r.orders) },
      { id: 'delivered', header: 'Delivered', align: 'right', cell: (r) => num(r.delivered) },
      { id: 'failed', header: 'Failed', align: 'right', cell: (r) => num(r.failed) },
      { id: 'cancelled', header: 'Cancelled', align: 'right', cell: (r) => num(r.cancelled) },
    ];
    return <DataTable columns={cols} rows={rows} getRowId={(r) => r.period} caption="Orders by date" />;
  }

  if (gb === 'customer') {
    const rows = data.rows as OrderReportCustomerRow[];
    const cols: DataTableColumn<OrderReportCustomerRow>[] = [
      {
        id: 'customer',
        header: 'Customer',
        cell: (r) =>
          canViewCustomers ? (
            <Link to={paths.management.customerDetail(r.customer.id)} className="text-brand-600 hover:underline">
              {r.customer.name}
              <span className="block text-xs font-normal text-ink-muted">{r.customer.customerNumber}</span>
            </Link>
          ) : (
            <span>
              {r.customer.name}
              <span className="block text-xs text-ink-muted">{r.customer.customerNumber}</span>
            </span>
          ),
      },
      { id: 'created', header: 'Created', align: 'right', cell: (r) => num(r.ordersCreated) },
      { id: 'delivered', header: 'Delivered', align: 'right', cell: (r) => num(r.deliveredOrders) },
      { id: 'failed', header: 'Failed', align: 'right', cell: (r) => num(r.failedOrders) },
      { id: 'amount', header: 'Order amount', align: 'right', hideBelow: 'lg', cell: (r) => formatMoney(r.totalOrderAmount) },
      { id: 'fee', header: 'Delivery fee', align: 'right', hideBelow: 'xl', cell: (r) => formatMoney(r.totalDeliveryFee) },
      { id: 'collected', header: 'Collected', align: 'right', cell: (r) => formatMoney(r.actualCollected) },
      {
        id: 'go',
        header: '',
        align: 'right',
        cell: (r) =>
          canViewOrders ? (
            <Link to={ordersLink({ customerId: r.customer.id })} className="text-xs font-medium text-brand-600 hover:underline">
              Orders →
            </Link>
          ) : null,
      },
    ];
    return <DataTable columns={cols} rows={rows} getRowId={(r) => r.customer.id} caption="Orders by customer" />;
  }

  if (gb === 'driver') {
    const rows = data.rows as OrderReportDriverRow[];
    const cols: DataTableColumn<OrderReportDriverRow>[] = [
      {
        id: 'driver',
        header: 'Driver',
        cell: (r) =>
          canViewDrivers ? (
            <Link to={paths.management.driverDetail(r.driver.id)} className="text-brand-600 hover:underline">
              {r.driver.name}
              <span className="block text-xs font-normal text-ink-muted">{r.driver.driverNumber}</span>
            </Link>
          ) : (
            <span>
              {r.driver.name}
              <span className="block text-xs text-ink-muted">{r.driver.driverNumber}</span>
            </span>
          ),
      },
      {
        id: 'portfolio',
        header: 'In portfolio',
        align: 'right',
        cell: (r) => num(r.ordersInPortfolio),
      },
      { id: 'delivered', header: 'Delivered', align: 'right', cell: (r) => num(r.delivered) },
      { id: 'failed', header: 'Failed', align: 'right', cell: (r) => num(r.failed) },
      { id: 'collected', header: 'Collected', align: 'right', cell: (r) => formatMoney(r.actualCollected) },
    ];
    return (
      <>
        <DataTable columns={cols} rows={rows} getRowId={(r) => r.driver.id} caption="Orders by driver" />
        <p className="px-3 py-2 text-xs text-ink-muted">
          &ldquo;In portfolio&rdquo; = orders currently assigned to the driver and created in range.
          Delivered / failed are historical delivery attempts and are not re-attributed by a later reassignment.
        </p>
      </>
    );
  }

  if (gb === 'area') {
    const rows = data.rows as OrderReportAreaRow[];
    const cols: DataTableColumn<OrderReportAreaRow>[] = [
      { id: 'area', header: 'Area', cell: (r) => r.area?.name ?? 'No area' },
      { id: 'orders', header: 'Orders', align: 'right', cell: (r) => num(r.orders) },
      { id: 'delivered', header: 'Delivered', align: 'right', cell: (r) => num(r.delivered) },
      { id: 'failed', header: 'Failed', align: 'right', cell: (r) => num(r.failed) },
      {
        id: 'go',
        header: '',
        align: 'right',
        cell: (r) =>
          canViewOrders && r.area ? (
            <Link to={ordersLink({ areaId: r.area.id })} className="text-xs font-medium text-brand-600 hover:underline">
              Orders →
            </Link>
          ) : null,
      },
    ];
    return <DataTable columns={cols} rows={rows} getRowId={(r) => r.area?.id ?? 'none'} caption="Orders by area" />;
  }

  if (gb === 'status') {
    const rows = data.rows as OrderReportStatusRow[];
    const cols: DataTableColumn<OrderReportStatusRow>[] = [
      { id: 'status', header: 'Status', cell: (r) => getOrderStatusPresentation(r.status).label },
      { id: 'orders', header: 'Orders', align: 'right', cell: (r) => num(r.orders) },
      {
        id: 'go',
        header: '',
        align: 'right',
        cell: (r) =>
          canViewOrders ? (
            <Link to={ordersLink({ status: r.status })} className="text-xs font-medium text-brand-600 hover:underline">
              Orders →
            </Link>
          ) : null,
      },
    ];
    return <DataTable columns={cols} rows={rows} getRowId={(r) => r.status} caption="Orders by status" />;
  }

  // type
  const rows = data.rows as OrderReportTypeRow[];
  const cols: DataTableColumn<OrderReportTypeRow>[] = [
    { id: 'type', header: 'Order type', cell: (r) => getOrderTypeLabel(r.orderType) },
    { id: 'count', header: 'Orders', align: 'right', cell: (r) => num(r.count) },
    { id: 'amount', header: 'Order amount', align: 'right', hideBelow: 'lg', cell: (r) => formatMoney(r.totalOrderAmount) },
    { id: 'fee', header: 'Delivery fee', align: 'right', hideBelow: 'lg', cell: (r) => formatMoney(r.totalDeliveryFee) },
    { id: 'collected', header: 'Collected', align: 'right', cell: (r) => formatMoney(r.actualCollected) },
    {
      id: 'go',
      header: '',
      align: 'right',
      cell: (r) =>
        canViewOrders ? (
          <Link to={ordersLink({ orderType: r.orderType })} className="text-xs font-medium text-brand-600 hover:underline">
            Orders →
          </Link>
        ) : null,
    },
  ];
  return <DataTable columns={cols} rows={rows} getRowId={(r) => r.orderType} caption="Orders by type" />;
}

/* ---------------------------- small bits --------------------------- */

export function FilterSelect({
  label,
  value,
  onChange,
  options,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
      {label}
      <select
        className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink disabled:opacity-50"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="h-20 rounded-card border border-line bg-card shadow-card motion-safe:animate-pulse"
        />
      ))}
    </div>
  );
}

export { SkeletonGrid };
