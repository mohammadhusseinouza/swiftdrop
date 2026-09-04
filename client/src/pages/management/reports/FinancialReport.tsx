import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useGetFinanceReportQuery } from '../../../services/reportsApi';
import type {
  FinanceReportCategoryRow,
  FinanceReportPeriodRow,
} from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { formatMoney } from '../../../lib/format';

import { MetricTile } from '../dashboard/MetricTile';
import { ReportResult, ReportSection, periodLabel } from './reportShared';
import { FilterSelect } from './OrdersReport';
import {
  FINANCE_REPORT_GROUP_BY,
  parseDateRange,
  parseFinancialReportGroupBy,
  patchReportParams,
} from './reportsParams';

const num = (n: number) => n.toLocaleString();

const CATEGORY_LABEL: Record<string, string> = {
  DELIVERY_FEE_REVENUE: 'Delivery fee revenue',
  COMPANY_ORDER_REVENUE: 'Company order revenue',
  TOTAL_COLLECTED: 'Total collected',
  CUSTOMER_PAYOUTS: 'Customer payouts',
  DRIVER_SETTLEMENTS: 'Driver settlements',
};

export function FinancialReport() {
  const [sp, setSp] = useSearchParams();
  const { from, to } = parseDateRange(sp);
  const groupBy = parseFinancialReportGroupBy(sp);

  const patch = useCallback(
    (p: Record<string, string | undefined>) => setSp(patchReportParams(sp, p)),
    [sp, setSp],
  );

  const query = useGetFinanceReportQuery({
    from: from || undefined,
    to: to || undefined,
    groupBy,
  });
  const data = query.data;
  const isCategory = groupBy === 'category';
  const rows = data?.rows ?? [];

  const flowLabel = from || to ? 'in the selected range' : 'all time';
  const asOfLabel = 'as of now';

  return (
    <div className="space-y-5">
      <Card flush className="p-4 sm:p-5">
        <div role="search" className="flex flex-wrap items-end gap-2">
          <FilterSelect
            label="Group by"
            value={groupBy}
            onChange={(v) => patch({ groupBy: v })}
            options={FINANCE_REPORT_GROUP_BY.map((g) => ({
              value: g,
              label: g === 'category' ? 'By category' : `By ${g}`,
            }))}
          />
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Aggregate figures only (no ledger detail). Revenue / collected / payout
          / settlement figures are <strong>flow</strong> ({flowLabel}), net of
          reversals — negative net values are shown as-is. Customer wallet
          liability and driver unsettled cash are a <strong>point-in-time
          balance</strong> ({asOfLabel}); the date range does not affect them.
          The three ledgers (customer wallet, driver cash, company finance) are
          kept separate — there is no combined total.
        </p>
      </Card>

      {/* summary */}
      <ReportSection title="Summary">
        {query.isLoading && !data ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <div
                key={i}
                className="h-24 rounded-card border border-line bg-card shadow-card motion-safe:animate-pulse"
              />
            ))}
          </div>
        ) : data ? (
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Company finance · flow {flowLabel}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MetricTile
                label="Delivery fee revenue"
                value={formatMoney(data.summary.deliveryFeeRevenue)}
              />
              <MetricTile
                label="Company order revenue"
                value={formatMoney(data.summary.companyOrderRevenue)}
              />
              <MetricTile
                label="Company revenue (net)"
                value={formatMoney(data.summary.companyRevenue)}
                hint="Signed net of every company-finance row incl. adjustments"
              />
            </div>

            <p className="pt-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Cash movement · flow {flowLabel}
            </p>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MetricTile
                label="Total collected"
                value={formatMoney(data.summary.totalCollected)}
                hint="Collected on delivery, net of reversals"
              />
              <MetricTile
                label="Customer payouts"
                value={formatMoney(data.summary.customerPayouts)}
                hint="Paid out to customers, net of reversals"
              />
              <MetricTile
                label="Driver settlements"
                value={formatMoney(data.summary.settlementAmount)}
                hint={`${num(data.summary.settlementCount)} settlement(s)`}
              />
            </div>

            <p className="pt-1 text-xs font-medium uppercase tracking-wide text-ink-subtle">
              Balances · {asOfLabel}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <MetricTile
                label="Customer wallet liability"
                value={formatMoney(data.summary.currentCustomerWalletLiability)}
                hint="Owed to customers (customer-wallet ledger)"
              />
              <MetricTile
                label="Driver unsettled cash"
                value={formatMoney(data.summary.currentDriverCashOutstanding)}
                hint="Held by drivers (driver-cash ledger)"
              />
            </div>
            {query.isError && (
              <p role="alert" className="text-xs text-warning-700">
                Showing the last loaded figures — the latest refresh failed.
              </p>
            )}
          </div>
        ) : null}
      </ReportSection>

      {/* grouped rows */}
      <ReportSection title={isCategory ? 'By category' : 'By period'}>
        <ReportResult
          isLoading={query.isLoading && !data}
          isError={query.isError && !data}
          error={query.error}
          onRetry={() => void query.refetch()}
          isEmpty={!query.isLoading && !query.isError && rows.length === 0}
          emptyTitle="No financial report data for this period."
          emptyDescription={
            isCategory
              ? 'There was no financial activity in the selected range.'
              : 'No period had financial activity in the selected range.'
          }
        >
          <Card flush className="overflow-x-auto">
            {isCategory ? (
              <DataTable
                columns={CATEGORY_COLS}
                rows={rows as FinanceReportCategoryRow[]}
                getRowId={(r) => r.category}
                caption="Financial report by category"
              />
            ) : (
              <DataTable
                columns={PERIOD_COLS}
                rows={rows as FinanceReportPeriodRow[]}
                getRowId={(r) => r.period}
                caption="Financial report by period"
              />
            )}
          </Card>
        </ReportResult>
      </ReportSection>
    </div>
  );
}

const money = (v: string) => (
  <span className="tabular-nums">{formatMoney(v)}</span>
);

const CATEGORY_COLS: DataTableColumn<FinanceReportCategoryRow>[] = [
  {
    id: 'category',
    header: 'Category',
    cell: (r) => CATEGORY_LABEL[r.category] ?? r.category,
  },
  { id: 'amount', header: 'Amount', align: 'right', cell: (r) => money(r.amount) },
  {
    id: 'count',
    header: 'Count',
    align: 'right',
    cell: (r) =>
      r.count === null ? (
        <span className="text-ink-subtle">—</span>
      ) : (
        num(r.count)
      ),
  },
];

const PERIOD_COLS: DataTableColumn<FinanceReportPeriodRow>[] = [
  { id: 'period', header: 'Period', cell: (r) => periodLabel(r.period) },
  { id: 'fee', header: 'Delivery fee rev.', align: 'right', cell: (r) => money(r.deliveryFeeRevenue) },
  { id: 'company', header: 'Company order rev.', align: 'right', hideBelow: 'lg', cell: (r) => money(r.companyOrderRevenue) },
  { id: 'net', header: 'Company net', align: 'right', hideBelow: 'xl', cell: (r) => money(r.companyRevenue) },
  { id: 'collected', header: 'Collected', align: 'right', cell: (r) => money(r.totalCollected) },
  { id: 'payouts', header: 'Payouts', align: 'right', hideBelow: 'lg', cell: (r) => money(r.customerPayouts) },
  { id: 'settlements', header: 'Settlements', align: 'right', hideBelow: 'md', cell: (r) => money(r.settlementAmount) },
];
