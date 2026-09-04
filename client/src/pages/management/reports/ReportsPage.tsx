import { useSearchParams } from 'react-router-dom';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Card } from '../../../components/ui/Card';
import { DateRangeFilter } from '../../../components/filters/DateRangeFilter';
import { cn } from '../../../components/ui/cn';

import { OrdersReport } from './OrdersReport';
import { DriversReport } from './DriversReport';
import { CustomersReport } from './CustomersReport';
import { FinancialReport } from './FinancialReport';
import {
  REPORT_GROUPS,
  parseDateRange,
  parseReportGroup,
  switchReportParams,
  type ReportGroup,
} from './reportsParams';

const TAB_LABEL: Record<ReportGroup, string> = {
  orders: 'Orders',
  drivers: 'Drivers',
  customers: 'Customers',
  financial: 'Financial',
};

/**
 * Phase 11.13 — Management Reports. ONE route, four report groups selected by
 * `?report=`. Each group calls its own `reports.read`-gated backend endpoint
 * (`/reports/{orders,drivers,customers,finance}`) — never `/finance/*` or
 * `/audit-logs`, and never aggregates client-side. Read-only: no mutations,
 * no export.
 */
export default function ReportsPage() {
  const [sp, setSp] = useSearchParams();
  const group = parseReportGroup(sp);
  const { from, to } = parseDateRange(sp);

  const selectGroup = (next: ReportGroup) => {
    if (next === group) return;
    setSp(switchReportParams(sp, next));
  };

  const setRange = (range: { from: string; to: string }) => {
    const next = new URLSearchParams(sp);
    if (range.from) next.set('from', range.from);
    else next.delete('from');
    if (range.to) next.set('to', range.to);
    else next.delete('to');
    setSp(next);
  };

  return (
    <div className="space-y-5 pb-6">
      <PageHeader
        size="lg"
        title="Reports"
        description="Operational and financial reporting across orders, drivers, customers, and company finance."
      />

      {/* report group tabs */}
      <div className="border-b border-line">
        <div
          role="tablist"
          aria-label="Report groups"
          className="-mb-px flex gap-1 overflow-x-auto"
        >
          {REPORT_GROUPS.map((g) => {
            const active = g === group;
            return (
              <button
                key={g}
                type="button"
                role="tab"
                id={`report-tab-${g}`}
                aria-selected={active}
                aria-controls={`report-panel-${g}`}
                onClick={() => selectGroup(g)}
                className={cn(
                  'shrink-0 border-b-2 px-3 py-2 text-sm font-medium transition-colors',
                  active
                    ? 'border-brand-600 text-brand-700'
                    : 'border-transparent text-ink-muted hover:text-ink',
                )}
              >
                {TAB_LABEL[g]}
              </button>
            );
          })}
        </div>
      </div>

      {/* shared date range */}
      <Card flush className="space-y-3 p-4 sm:p-5">
        <DateRangeFilter
          value={{ from, to }}
          onChange={setRange}
          fromLabel="From"
          toLabel="To (inclusive)"
        />
        {(from || to) && (
          <button
            type="button"
            onClick={() => setRange({ from: '', to: '' })}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            Clear date range
          </button>
        )}
        <p className="text-xs text-ink-muted">
          Dates are whole UTC calendar days. An empty range means all time.
          &ldquo;Current&rdquo; balances (wallet liability, driver cash held) are
          always live and ignore this range.
        </p>
      </Card>

      <div
        role="tabpanel"
        id={`report-panel-${group}`}
        aria-labelledby={`report-tab-${group}`}
      >
        {group === 'orders' && <OrdersReport />}
        {group === 'drivers' && <DriversReport />}
        {group === 'customers' && <CustomersReport />}
        {group === 'financial' && <FinancialReport />}
      </div>
    </div>
  );
}
