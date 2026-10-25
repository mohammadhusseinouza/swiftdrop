import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useGetFinanceReportQuery } from '../../../services/reportsApi';
import type {
  DeliveryDateFigures,
  DeliveryDateSummary,
  FinanceReportCategoryRow,
  FinanceReportPeriodRow,
} from '../../../services/domain.types';
import { REPORTING_BASES, REPORTING_BASIS_LABEL } from '../../../components/finance/financialRelease';
import { SettlementReleasePanel } from '../../../components/finance/SettlementReleasePanel';

import { Card } from '../../../components/ui/Card';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { formatMoney } from '../../../lib/format';

import { MetricTile } from '../dashboard/MetricTile';
import { ReportResult, ReportSection, periodLabel } from './reportShared';
import { FilterSelect } from './OrdersReport';
import {
  FINANCE_REPORT_GROUP_BY,
  parseDateRange,
  parseFinancialReportBasis,
  parseFinancialReportGroupBy,
  patchReportParams,
} from './reportsParams';

const num = (n: number) => n.toLocaleString();

const CATEGORY_LABEL: Record<string, string> = {
  DELIVERY_FEE_REVENUE: 'Delivery fee revenue',
  COMPANY_ORDER_REVENUE: 'Company order revenue',
  TOTAL_COLLECTED: 'Total collected',
  DRIVER_COLLECTED: 'Collected by drivers',
  DIRECT_COMPANY_COLLECTED: 'Received directly by company',
  CUSTOMER_PAYOUTS: 'Customer payouts',
  DRIVER_SETTLEMENTS: 'Driver settlements',
};

export function FinancialReport() {
  const [sp, setSp] = useSearchParams();
  const { from, to } = parseDateRange(sp);
  const groupBy = parseFinancialReportGroupBy(sp);
  const basis = parseFinancialReportBasis(sp);

  const patch = useCallback(
    (p: Record<string, string | undefined>) => setSp(patchReportParams(sp, p)),
    [sp, setSp],
  );

  const query = useGetFinanceReportQuery({
    from: from || undefined,
    to: to || undefined,
    groupBy,
    basis,
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
          <FilterSelect
            label="Date basis"
            value={basis}
            onChange={(v) => patch({ basis: v === 'delivered' ? 'delivered' : undefined })}
            options={REPORTING_BASES.map((b) => ({ value: b, label: REPORTING_BASIS_LABEL[b].label }))}
          />
        </div>
        <p
          className="mt-3 rounded-control border border-brand-100 bg-brand-50 px-3 py-2 text-xs text-brand-700"
          aria-live="polite"
        >
          <strong>Active basis: {REPORTING_BASIS_LABEL[basis].label}.</strong>{' '}
          {REPORTING_BASIS_LABEL[basis].description}
          {basis === 'delivered' &&
            ' The summary and period rows stay on posting dates; delivery-date figures are shown in their own sections.'}
        </p>
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
              Company finance · flow {flowLabel} · released basis (posting date)
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
                label="Collected by drivers"
                value={formatMoney(data.summary.driverCollected)}
                hint="Entered driver cash — settled via driver settlements"
              />
              <MetricTile
                label="Received directly by company"
                value={formatMoney(data.summary.directCompanyCollected)}
                hint="Bypass-driver-cash payment methods — never driver cash"
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

      {/* FR.10 — delivery-date basis (only when requested) */}
      {basis === 'delivered' && data?.summary.deliveryDate && (
        <ReportSection title="Delivery-date figures">
          <DeliveryDateSummaryView summary={data.summary.deliveryDate} flowLabel={flowLabel} />
        </ReportSection>
      )}

      {/* FR.10 — settlement-based release */}
      {data?.summary.settlementRelease && (
        <ReportSection title="Settlement-based release">
          <Card flush className="p-4 sm:p-5">
            <SettlementReleasePanel
              snapshot={data.summary.settlementRelease.current}
              activity={data.summary.settlementRelease.activity}
              activityLabel={flowLabel === 'all time' ? 'to date' : flowLabel}
            />
          </Card>
        </ReportSection>
      )}

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

      {basis === 'delivered' && !isCategory && (
        <ReportSection title="By period · delivery date">
          <ReportResult
            isLoading={query.isLoading && !data}
            isError={query.isError && !data}
            error={query.error}
            onRetry={() => void query.refetch()}
            isEmpty={!query.isLoading && !query.isError && (data?.deliveryDateRows ?? []).length === 0}
            emptyTitle="No deliveries in this period."
            emptyDescription="No order was delivered in the selected range."
          >
            <Card flush className="overflow-x-auto">
              <DataTable
                columns={DELIVERY_DATE_COLS}
                rows={data?.deliveryDateRows ?? []}
                getRowId={(r) => r.period}
                caption="Financial report by delivery date"
              />
            </Card>
          </ReportResult>
        </ReportSection>
      )}
    </div>
  );
}

function DeliveryDateSummaryView({ summary, flowLabel }: { summary: DeliveryDateSummary; flowLabel: string }) {
  const f = summary.figures;
  const o = summary.orderlessCategoryPostings;
  return (
    <div className="space-y-3">
      <p className="text-xs font-medium uppercase tracking-wide text-ink-subtle">
        Orders delivered {flowLabel} · posted vs still pending release
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Delivery fee revenue"
          value={formatMoney(f.deliveryFeeRevenue)}
          hint={`${formatMoney(f.postedDeliveryFeeRevenue)} posted · ${formatMoney(f.pendingDeliveryFeeRevenue)} pending release`}
        />
        <MetricTile
          label="Company order revenue"
          value={formatMoney(f.companyOrderRevenue)}
          hint={`${formatMoney(f.postedCompanyOrderRevenue)} posted · ${formatMoney(f.pendingCompanyOrderRevenue)} pending release`}
        />
        <MetricTile
          label="Customer wallet credits"
          value={formatMoney(f.customerWalletCredits)}
          hint={`${formatMoney(f.postedCustomerWalletCredits)} posted · ${formatMoney(f.pendingCustomerWalletCredits)} pending release`}
        />
        <MetricTile
          label="Under review"
          value={num(f.underReviewOrderCount)}
          hint={`${formatMoney(f.underReviewCollectionAmount)} collected · split not approved`}
        />
      </div>
      {o.rowCount > 0 && (
        <p className="rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
          {num(o.rowCount)} historical posting(s) have no order and therefore no delivery date (
          {formatMoney(o.deliveryFeeRevenue)} delivery fee · {formatMoney(o.companyOrderRevenue)} company order ·{' '}
          {formatMoney(o.customerWalletCredits)} wallet credits). They stay in the released totals and are shown here
          separately — never assigned to a delivery date.
        </p>
      )}
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

const DELIVERY_DATE_COLS: DataTableColumn<DeliveryDateFigures>[] = [
  { id: 'period', header: 'Delivered', cell: (r) => periodLabel(r.period) },
  { id: 'fee', header: 'Delivery fee', align: 'right', cell: (r) => money(r.deliveryFeeRevenue) },
  { id: 'feePending', header: 'Fee pending', align: 'right', hideBelow: 'lg', cell: (r) => money(r.pendingDeliveryFeeRevenue) },
  { id: 'company', header: 'Company order', align: 'right', hideBelow: 'md', cell: (r) => money(r.companyOrderRevenue) },
  { id: 'wallet', header: 'Wallet credits', align: 'right', cell: (r) => money(r.customerWalletCredits) },
  { id: 'walletPending', header: 'Credits pending', align: 'right', hideBelow: 'lg', cell: (r) => money(r.pendingCustomerWalletCredits) },
  { id: 'review', header: 'Under review', align: 'right', hideBelow: 'xl', cell: (r) => num(r.underReviewOrderCount) },
];

const PERIOD_COLS: DataTableColumn<FinanceReportPeriodRow>[] = [
  { id: 'period', header: 'Period', cell: (r) => periodLabel(r.period) },
  { id: 'fee', header: 'Delivery fee rev.', align: 'right', cell: (r) => money(r.deliveryFeeRevenue) },
  { id: 'company', header: 'Company order rev.', align: 'right', hideBelow: 'lg', cell: (r) => money(r.companyOrderRevenue) },
  { id: 'net', header: 'Company net', align: 'right', hideBelow: 'xl', cell: (r) => money(r.companyRevenue) },
  { id: 'collected', header: 'Collected', align: 'right', cell: (r) => money(r.totalCollected) },
  { id: 'direct', header: 'Direct to company', align: 'right', hideBelow: 'xl', cell: (r) => money(r.directCompanyCollected) },
  { id: 'payouts', header: 'Payouts', align: 'right', hideBelow: 'lg', cell: (r) => money(r.customerPayouts) },
  { id: 'settlements', header: 'Settlements', align: 'right', hideBelow: 'md', cell: (r) => money(r.settlementAmount) },
];
