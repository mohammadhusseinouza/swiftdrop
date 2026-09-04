import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from '../../../routes/paths';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetDriverReportQuery } from '../../../services/reportsApi';
import { useGetDriversQuery, useGetDriverQuery } from '../../../services/driversApi';
import type { DriverReportRow } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { formatMoney } from '../../../lib/format';

import { ReportResult, ReportSection } from './reportShared';
import { FilterSelect } from './OrdersReport';
import {
  parseDateRange,
  parseDriversReportState,
  patchReportParams,
} from './reportsParams';

const num = (n: number) => n.toLocaleString();
const DASH = '—';

export function DriversReport() {
  const [sp, setSp] = useSearchParams();
  const { from, to } = parseDateRange(sp);
  const state = parseDriversReportState(sp);

  const canViewDrivers = useHasPermission(PERMISSIONS.DRIVERS_READ);

  const patch = useCallback(
    (p: Record<string, string | undefined>) => setSp(patchReportParams(sp, p)),
    [sp, setSp],
  );

  const [driverTerm, setDriverTerm] = useState('');
  const debouncedTerm = useDebouncedValue(driverTerm, 300);
  const drivers = useGetDriversQuery({
    search: debouncedTerm.trim() || undefined,
    limit: 20,
  });
  const selectedDriver = useGetDriverQuery(state.driverId, {
    skip: !state.driverId,
  });
  const selectedDriverLabel = selectedDriver.data
    ? `${selectedDriver.data.driverNumber} · ${selectedDriver.data.user.firstName} ${selectedDriver.data.user.lastName}`
    : undefined;

  const query = useGetDriverReportQuery({
    from: from || undefined,
    to: to || undefined,
    driverId: state.driverId || undefined,
    isActive:
      state.isActive === 'true' ? true : state.isActive === 'false' ? false : undefined,
  });
  const rows = query.data?.rows ?? [];

  const columns: DataTableColumn<DriverReportRow>[] = [
    {
      id: 'driver',
      header: 'Driver',
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          {canViewDrivers ? (
            <Link
              to={paths.management.driverDetail(r.driver.id)}
              className="font-medium text-brand-600 hover:underline"
            >
              {r.driver.name}
            </Link>
          ) : (
            <span className="font-medium">{r.driver.name}</span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-ink-muted">
            {r.driver.driverNumber}
            {!r.driver.isActive && <Badge tone="neutral">Inactive</Badge>}
          </span>
        </span>
      ),
    },
    { id: 'assigned', header: 'Assigned', align: 'right', cell: (r) => num(r.ordersAssigned) },
    { id: 'delivered', header: 'Delivered', align: 'right', cell: (r) => num(r.ordersDelivered) },
    { id: 'failed', header: 'Failed attempts', align: 'right', hideBelow: 'lg', cell: (r) => num(r.failedAttempts) },
    { id: 'attempts', header: 'Attempts', align: 'right', hideBelow: 'xl', cell: (r) => num(r.deliveryAttempts) },
    {
      id: 'rate',
      header: 'Success rate',
      align: 'right',
      cell: (r) =>
        r.successRate === null ? (
          <span className="text-ink-subtle">{DASH}</span>
        ) : (
          <span className="tabular-nums">{r.successRate}%</span>
        ),
    },
    { id: 'collected', header: 'Collected', align: 'right', hideBelow: 'lg', cell: (r) => formatMoney(r.moneyCollected) },
    {
      id: 'settlements',
      header: 'Settled',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => (
        <span className="tabular-nums">
          {formatMoney(r.settlementAmount)}
          <span className="block text-xs text-ink-muted">{num(r.settlementCount)} settlement(s)</span>
        </span>
      ),
    },
    {
      id: 'cash',
      header: 'Cash held now',
      align: 'right',
      cell: (r) => <span className="tabular-nums">{formatMoney(r.currentCashHeld)}</span>,
    },
    {
      id: 'collectionAssignments',
      header: 'Collection assignments',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => num(r.collectionAssignments),
    },
    {
      id: 'collectionsCompleted',
      header: 'Collections completed',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => num(r.collectionsCompleted),
    },
    {
      id: 'failedCollections',
      header: 'Failed collections',
      align: 'right',
      hideBelow: 'xl',
      cell: (r) => num(r.failedCollectionAttempts),
    },
  ];

  return (
    <div className="space-y-5">
      <Card flush className="p-4 sm:p-5">
        <div role="search" className="flex flex-wrap items-end gap-2">
          <ServerSearchSelect
            label="Driver"
            anyLabel="All drivers"
            searchPlaceholder="Search drivers…"
            value={state.driverId}
            onChange={(id) => patch({ driverId: id || undefined })}
            searchTerm={driverTerm}
            onSearchTermChange={setDriverTerm}
            loading={drivers.isFetching}
            total={drivers.data?.meta.total}
            options={(drivers.data?.items ?? []).map((d) => ({
              id: d.id,
              label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}`,
            }))}
            selectedLabel={selectedDriverLabel}
          />
          <FilterSelect
            label="Active"
            value={state.isActive}
            onChange={(v) => patch({ isActive: v || undefined })}
            options={[
              { value: '', label: 'Active & inactive' },
              { value: 'true', label: 'Active only' },
              { value: 'false', label: 'Inactive only' },
            ]}
          />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Assigned = assignments made in range. Delivered / failed = historical
          delivery <strong>attempts</strong> in range (survive a later
          reassignment). Success rate = delivered ÷ attempts. Collected /
          settled are flow within the range. <strong>Cash held now</strong> is a
          live balance — the date range does not affect it, and it means cash
          currently in the driver&rsquo;s custody, not earnings. Collection
          assignments / completed / failed are separate Parcel Collection
          dimensions (financially neutral) — never merged into the Delivery
          figures above.
        </p>
      </Card>

      <ReportSection
        title="Drivers"
        action={
          query.data && rows.length > 0 ? (
            <span className="text-xs text-ink-muted">{rows.length} driver(s)</span>
          ) : undefined
        }
      >
        <ReportResult
          isLoading={query.isLoading && !query.data}
          isError={query.isError && !query.data}
          error={query.error}
          onRetry={() => void query.refetch()}
          isEmpty={!query.isLoading && !query.isError && rows.length === 0}
          emptyTitle="No driver report data for this period."
          emptyDescription="Adjust the date range or driver filter."
        >
          <Card flush className="overflow-x-auto">
            <DataTable
              columns={columns}
              rows={rows}
              getRowId={(r) => r.driver.id}
              caption="Driver report"
            />
          </Card>
        </ReportResult>
      </ReportSection>
    </div>
  );
}
