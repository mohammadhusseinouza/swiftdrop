import { useEffect, useMemo, useState } from 'react';
import { ChartColumn } from 'lucide-react';

import {
  useGetAllExpenseDriversQuery,
  useGetDriverExpenseDailyTrendQuery,
  useGetDriverExpenseReportByDriverQuery,
  useGetDriverExpenseReportByVehicleQuery,
  useGetDriverExpenseReportSummaryQuery,
  type DriverExpenseDriverReportParams,
} from '../../../services/driverExpensesApi';
import type {
  DriverExpenseDriverReportRow,
  DriverExpenseTrendRow,
  ExpenseVehicleType,
} from '../../../services/domain.types';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';

import { Card } from '../../../components/ui/Card';
import { cn } from '../../../components/ui/cn';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { DataTable, type DataTableColumn, type SortState } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { EmptyState } from '../../../components/feedback/EmptyState';

import {
  MAX_TREND_RANGE_DAYS,
  REPORT_PERIODS,
  rangeDays,
  resolveReportRange,
  toReportParams,
  type ReportFiltersState,
} from './reportPeriods';
import { VEHICLE_LABEL, VEHICLE_OPTIONS, displayCalendarDate, displayKm, displayMoney, displayRate } from './driverExpenseFormat';

const DRIVER_PAGE_SIZE = 20;
type DriverSortBy = NonNullable<DriverExpenseDriverReportParams['sortBy']>;

export interface ReportsTabProps {
  today: string;
  filters: ReportFiltersState;
  onFiltersChange: (update: (prev: ReportFiltersState) => ReportFiltersState) => void;
}

/**
 * Reports tab — read-only summaries of the SAVED daily records (server-side
 * aggregation; figures are estimated fuel expenses, never payments). One
 * filter (period + driver + saved vehicle type) drives every section.
 * Filters are owned by the page, so they survive switching tabs.
 */
export function ReportsTab({ today, filters, onFiltersChange }: ReportsTabProps) {
  const isDesktop = useMediaQuery(MD_QUERY);
  const drivers = useGetAllExpenseDriversQuery();

  const range = resolveReportRange(filters, today);
  const params = range.ok ? toReportParams(range, filters) : null;
  const trendTooLong = range.ok && rangeDays(range.from, range.to) > MAX_TREND_RANGE_DAYS;

  const [sort, setSort] = useState<SortState>({ columnId: 'expense', direction: 'desc' });
  const [page, setPage] = useState(1);
  const paramsKey = params ? JSON.stringify(params) : '';
  useEffect(() => setPage(1), [paramsKey, sort.columnId, sort.direction]);

  const skip = !params;
  const summary = useGetDriverExpenseReportSummaryQuery(params ?? { from: today, to: today }, { skip });
  const byVehicle = useGetDriverExpenseReportByVehicleQuery(params ?? { from: today, to: today }, { skip });
  const byDriver = useGetDriverExpenseReportByDriverQuery(
    {
      ...(params ?? { from: today, to: today }),
      sortBy: sort.columnId as DriverSortBy,
      sortOrder: sort.direction,
      page,
      limit: DRIVER_PAGE_SIZE,
    },
    { skip },
  );
  const trend = useGetDriverExpenseDailyTrendQuery(params ?? { from: today, to: today }, { skip: skip || trendTooLong });

  const set = (patch: Partial<ReportFiltersState>) => onFiltersChange((prev) => ({ ...prev, ...patch }));

  const driverOptions = useMemo(
    () =>
      [...(drivers.data ?? [])].sort((a, b) => a.displayName.localeCompare(b.displayName) || a.driverId.localeCompare(b.driverId)),
    [drivers.data],
  );

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink">Reports</h2>
        <p className="text-sm text-ink-muted">
          Estimated fuel expenses from saved daily entries — not payments or reimbursements. Each entry keeps the fuel price and vehicle
          it was recorded with.
        </p>
      </div>

      {/* filters */}
      <Card className="space-y-3">
        <div role="group" aria-label="Report period" className="flex flex-wrap gap-1.5">
          {REPORT_PERIODS.map((p) => (
            <button
              key={p.id}
              type="button"
              aria-pressed={filters.period === p.id}
              onClick={() => set({ period: p.id })}
              className={cn(
                'inline-flex h-10 items-center rounded-control border px-3.5 text-sm transition-colors',
                filters.period === p.id
                  ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                  : 'border-line bg-card font-medium text-ink-secondary hover:bg-sunken',
              )}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {filters.period === 'custom' && (
            <>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                Start date
                <input
                  type="date"
                  value={filters.customFrom}
                  onChange={(e) => set({ customFrom: e.target.value })}
                  className="h-10 rounded-control border border-line bg-card px-2 text-sm text-ink"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
                End date
                <input
                  type="date"
                  value={filters.customTo}
                  onChange={(e) => set({ customTo: e.target.value })}
                  className="h-10 rounded-control border border-line bg-card px-2 text-sm text-ink"
                />
              </label>
            </>
          )}
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
            Driver
            <select
              value={filters.driverId}
              onChange={(e) => set({ driverId: e.target.value })}
              className="h-10 rounded-control border border-line bg-card px-2 text-sm text-ink"
            >
              <option value="">All drivers</option>
              {driverOptions.map((d) => (
                <option key={d.driverId} value={d.driverId}>
                  {d.displayName}
                  {d.isActive ? '' : ' (inactive)'}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted">
            Vehicle used
            <select
              value={filters.vehicleType}
              onChange={(e) => set({ vehicleType: e.target.value as '' | ExpenseVehicleType })}
              className="h-10 rounded-control border border-line bg-card px-2 text-sm text-ink"
            >
              <option value="">All vehicles</option>
              {VEHICLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        {range.ok ? (
          <p className="text-xs text-ink-muted">
            {range.from === range.to
              ? displayCalendarDate(range.from)
              : `${displayCalendarDate(range.from)} – ${displayCalendarDate(range.to)}`}{' '}
            (UTC)
          </p>
        ) : (
          <p role="alert" className="text-sm text-danger-700">
            {range.message}
          </p>
        )}
      </Card>

      {!params ? null : (
        <>
          {/* summary */}
          {summary.isError ? (
            <Card flush>
              <ErrorState className="py-10" message={getApiErrorMessage(summary.error as UnknownApiError)} onRetry={() => void summary.refetch()} />
            </Card>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <StatisticCard
                label="Est. fuel expense"
                value={summary.data ? displayMoney(summary.data.totalEstimatedExpense) : '…'}
                supportingText="Estimate, not a payment"
              />
              <StatisticCard label="Total distance" value={summary.data ? displayKm(summary.data.totalDistanceKm) : '…'} />
              <StatisticCard label="Drivers with records" value={summary.data ? String(summary.data.driversWithRecords) : '…'} />
              <StatisticCard
                label="Daily entries"
                value={summary.data ? String(summary.data.entries) : '…'}
                supportingText="Saved days, including 0 km"
              />
              <StatisticCard
                label="Avg. cost per km"
                value={summary.data ? displayRate(summary.data.averageCostPerKm) : '…'}
                supportingText="Total expense ÷ total distance"
              />
            </div>
          )}

          {/* vehicle breakdown */}
          <Card flush>
            <SectionHeader title="By vehicle used" subtitle="Classified by the vehicle saved on each day." />
            {byVehicle.isLoading ? (
              <LoadingState className="py-8" />
            ) : byVehicle.isError ? (
              <ErrorState className="py-8" message={getApiErrorMessage(byVehicle.error as UnknownApiError)} onRetry={() => void byVehicle.refetch()} />
            ) : (
              <div className={cn('grid grid-cols-1 gap-3 p-4', (byVehicle.data?.length ?? 0) > 1 && 'sm:grid-cols-2')}>
                {(byVehicle.data ?? []).map((v) => (
                  <div key={v.vehicleType} className="rounded-control border border-line bg-sunken px-3 py-2.5">
                    <p className="text-sm font-semibold text-ink">{VEHICLE_LABEL[v.vehicleType]}</p>
                    <dl className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                      <dt className="text-ink-muted">Entries</dt>
                      <dd className="text-end font-medium text-ink">{v.entries}</dd>
                      <dt className="text-ink-muted">Distance</dt>
                      <dd className="text-end font-medium text-ink">{displayKm(v.totalDistanceKm)}</dd>
                      <dt className="text-ink-muted">Est. expense</dt>
                      <dd className="text-end font-medium text-ink">{displayMoney(v.totalEstimatedExpense)}</dd>
                      <dt className="text-ink-muted">Avg. cost / km</dt>
                      <dd className="text-end font-medium text-ink">{displayRate(v.averageCostPerKm)}</dd>
                    </dl>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* per driver */}
          <Card flush>
            <SectionHeader title="By driver" subtitle="Drivers with saved entries in this period (inactive drivers included)." />
            {byDriver.isLoading ? (
              <LoadingState className="py-10" />
            ) : byDriver.isError ? (
              <ErrorState className="py-10" message={getApiErrorMessage(byDriver.error as UnknownApiError)} onRetry={() => void byDriver.refetch()} />
            ) : (byDriver.data?.items.length ?? 0) === 0 ? (
              <EmptyState className="py-10" icon={<ChartColumn />} title="No entries in this period" description="Try a wider period or other filters." />
            ) : isDesktop ? (
              <DataTable
                columns={driverColumns}
                rows={byDriver.data?.items ?? []}
                getRowId={(r) => r.driverId}
                sort={sort}
                onSortChange={setSort}
                caption="Estimated fuel expense by driver"
              />
            ) : (
              <div className="space-y-2 p-3">
                <label className="flex items-center gap-2 text-xs font-medium text-ink-muted">
                  Sort by
                  <select
                    value={`${sort.columnId}:${sort.direction}`}
                    onChange={(e) => {
                      const [columnId, direction] = e.target.value.split(':') as [DriverSortBy, 'asc' | 'desc'];
                      setSort({ columnId, direction });
                    }}
                    className="h-10 flex-1 rounded-control border border-line bg-card px-2 text-sm text-ink"
                  >
                    <option value="expense:desc">Highest expense</option>
                    <option value="distance:desc">Longest distance</option>
                    <option value="name:asc">Name (A–Z)</option>
                  </select>
                </label>
                <ul className="space-y-2">
                  {(byDriver.data?.items ?? []).map((r) => (
                    <li key={r.driverId} className="rounded-control border border-line px-3 py-2.5">
                      <div className="flex items-start justify-between gap-2">
                        <p className="min-w-0 break-words font-medium text-ink">{r.displayName}</p>
                        <span className="shrink-0 font-semibold text-ink">{displayMoney(r.totalEstimatedExpense)}</span>
                      </div>
                      <p className="mt-1 text-xs text-ink-muted">
                        {r.entries} {r.entries === 1 ? 'day' : 'days'} · {displayKm(r.totalDistanceKm)} · {displayRate(r.averageCostPerKm)}/km
                        {!r.isActive && ' · Inactive'}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {byDriver.data && byDriver.data.meta.totalPages > 1 && (
              <div className="border-t border-line px-4 py-3">
                <Pagination page={byDriver.data.meta.page} totalPages={byDriver.data.meta.totalPages} total={byDriver.data.meta.total} onPageChange={setPage} />
              </div>
            )}
          </Card>

          {/* daily trend */}
          <Card flush>
            <SectionHeader title="Daily trend" subtitle="Only days with saved entries are listed; a day saved at 0 km is included." />
            {trendTooLong ? (
              <p className="px-4 py-6 text-sm text-ink-muted">
                The daily trend covers at most {MAX_TREND_RANGE_DAYS} days. Narrow the period to see it — the summary and tables above still
                cover the full range.
              </p>
            ) : trend.isLoading ? (
              <LoadingState className="py-10" />
            ) : trend.isError ? (
              <ErrorState className="py-10" message={getApiErrorMessage(trend.error as UnknownApiError)} onRetry={() => void trend.refetch()} />
            ) : (trend.data?.length ?? 0) === 0 ? (
              <EmptyState className="py-10" title="No entries in this period" />
            ) : (
              <DataTable columns={trendColumns} rows={trend.data ?? []} getRowId={(r) => r.date} caption="Daily estimated fuel expense" />
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="border-b border-line px-4 py-3 sm:px-5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      <p className="text-xs text-ink-muted">{subtitle}</p>
    </div>
  );
}

const driverColumns: DataTableColumn<DriverExpenseDriverReportRow>[] = [
  {
    id: 'name',
    header: 'Driver',
    sortable: true,
    cell: (r) => (
      <div className="min-w-0">
        <p className="font-medium text-ink">{r.displayName}</p>
        <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-muted">
          {!r.isActive && <ActiveBadge isActive={false} />}
          {r.currentDefaultVehicleType ? `Current default: ${VEHICLE_LABEL[r.currentDefaultVehicleType]}` : 'No default vehicle'}
        </p>
      </div>
    ),
  },
  { id: 'days', header: 'Recorded days', align: 'right', cell: (r) => r.entries },
  { id: 'distance', header: 'Total distance', align: 'right', sortable: true, cell: (r) => displayKm(r.totalDistanceKm) },
  { id: 'expense', header: 'Est. fuel expense', align: 'right', sortable: true, cell: (r) => displayMoney(r.totalEstimatedExpense) },
  { id: 'avg', header: 'Avg. cost / km', align: 'right', cell: (r) => displayRate(r.averageCostPerKm) },
];

const trendColumns: DataTableColumn<DriverExpenseTrendRow>[] = [
  { id: 'date', header: 'Date', cell: (r) => <span className="whitespace-nowrap">{displayCalendarDate(r.date)}</span> },
  { id: 'entries', header: 'Entries', align: 'right', cell: (r) => r.entries },
  { id: 'distance', header: 'Distance', align: 'right', cell: (r) => displayKm(r.totalDistanceKm) },
  { id: 'expense', header: 'Est. fuel expense', align: 'right', cell: (r) => displayMoney(r.totalEstimatedExpense) },
];
