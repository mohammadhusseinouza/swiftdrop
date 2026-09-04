import { useCallback, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { paths } from '../../../routes/paths';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetCustomerReportQuery } from '../../../services/reportsApi';
import {
  useGetCustomersQuery,
  useGetCustomerQuery,
} from '../../../services/customersApi';
import { useGetAreasQuery } from '../../../services/settingsApi';
import type { CustomerReportRow } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { formatMoney } from '../../../lib/format';

import { ReportResult, ReportSection } from './reportShared';
import { FilterSelect } from './OrdersReport';
import {
  parseCustomersReportState,
  parseDateRange,
  patchReportParams,
} from './reportsParams';

const num = (n: number) => n.toLocaleString();

export function CustomersReport() {
  const [sp, setSp] = useSearchParams();
  const { from, to } = parseDateRange(sp);
  const state = parseCustomersReportState(sp);

  const canViewCustomers = useHasPermission(PERMISSIONS.CUSTOMERS_READ);

  const patch = useCallback(
    (p: Record<string, string | undefined>) => setSp(patchReportParams(sp, p)),
    [sp, setSp],
  );

  const [term, setTerm] = useState('');
  const debounced = useDebouncedValue(term, 300);
  const customers = useGetCustomersQuery({
    search: debounced.trim() || undefined,
    limit: 20,
  });
  const selected = useGetCustomerQuery(state.customerId, {
    skip: !state.customerId,
  });
  const selectedLabel = selected.data
    ? `${selected.data.customerNumber} · ${selected.data.name}`
    : undefined;

  const areas = useGetAreasQuery({ isActive: true, limit: 100 });

  const query = useGetCustomerReportQuery({
    from: from || undefined,
    to: to || undefined,
    customerId: state.customerId || undefined,
    areaId: state.areaId || undefined,
    isActive:
      state.isActive === 'true'
        ? true
        : state.isActive === 'false'
          ? false
          : undefined,
  });
  const rows = query.data?.rows ?? [];

  const columns: DataTableColumn<CustomerReportRow>[] = [
    {
      id: 'customer',
      header: 'Customer',
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          {canViewCustomers ? (
            <Link
              to={paths.management.customerDetail(r.customer.id)}
              className="font-medium text-brand-600 hover:underline"
            >
              {r.customer.name}
            </Link>
          ) : (
            <span className="font-medium">{r.customer.name}</span>
          )}
          <span className="flex items-center gap-1.5 text-xs text-ink-muted">
            {r.customer.customerNumber}
            {!r.customer.isActive && <Badge tone="neutral">Inactive</Badge>}
          </span>
        </span>
      ),
    },
    { id: 'created', header: 'Orders created', align: 'right', cell: (r) => num(r.ordersCreated) },
    { id: 'delivered', header: 'Delivered', align: 'right', cell: (r) => num(r.deliveredOrders) },
    {
      id: 'credits',
      header: 'Wallet credits',
      align: 'right',
      hideBelow: 'lg',
      cell: (r) => formatMoney(r.walletCredits),
    },
    {
      id: 'payouts',
      header: 'Payouts',
      align: 'right',
      hideBelow: 'lg',
      cell: (r) => formatMoney(r.walletPayouts),
    },
    {
      id: 'balance',
      header: 'Wallet balance now',
      align: 'right',
      cell: (r) => (
        <span className="font-semibold tabular-nums text-ink">
          {formatMoney(r.currentWalletBalance)}
        </span>
      ),
    },
    {
      id: 'pending',
      header: 'Pending value',
      align: 'right',
      hideBelow: 'md',
      cell: (r) => (
        <span className="tabular-nums text-ink-muted">
          {formatMoney(r.pendingOrderValue)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-5">
      <Card flush className="p-4 sm:p-5">
        <div role="search" className="flex flex-wrap items-end gap-2">
          <ServerSearchSelect
            label="Customer"
            anyLabel="All customers"
            searchPlaceholder="Search customers…"
            value={state.customerId}
            onChange={(id) => patch({ customerId: id || undefined })}
            searchTerm={term}
            onSearchTermChange={setTerm}
            loading={customers.isFetching}
            total={customers.data?.meta.total}
            options={(customers.data?.items ?? []).map((c) => ({
              id: c.id,
              label: `${c.customerNumber} · ${c.name}`,
            }))}
            selectedLabel={selectedLabel}
          />
          <FilterSelect
            label="Area"
            value={state.areaId}
            onChange={(v) => patch({ areaId: v || undefined })}
            disabled={areas.isLoading}
            options={[
              { value: '', label: areas.isLoading ? 'Loading…' : 'Any default area' },
              ...(areas.data?.items ?? []).map((a) => ({ value: a.id, label: a.name })),
            ]}
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
          Orders created / wallet credits (delivery-generated ORDER_CREDIT, net
          of reversals) / payouts (net of reversals) are flow within the range.
          Delivered counts orders <strong>delivered</strong> in the range.
          <strong> Wallet balance now</strong> and <strong>pending value</strong>{' '}
          are live figures — the date range does not affect them. Pending is not
          withdrawable.
        </p>
      </Card>

      <ReportSection
        title="Customers"
        action={
          query.data && rows.length > 0 ? (
            <span className="text-xs text-ink-muted">{rows.length} customer(s)</span>
          ) : undefined
        }
      >
        <ReportResult
          isLoading={query.isLoading && !query.data}
          isError={query.isError && !query.data}
          error={query.error}
          onRetry={() => void query.refetch()}
          isEmpty={!query.isLoading && !query.isError && rows.length === 0}
          emptyTitle="No customer report data for this period."
          emptyDescription="Adjust the date range or customer filter."
        >
          <Card flush className="overflow-x-auto">
            <DataTable
              columns={columns}
              rows={rows}
              getRowId={(r) => r.customer.id}
              caption="Customer report"
            />
          </Card>
        </ReportResult>
      </ReportSection>
    </div>
  );
}
