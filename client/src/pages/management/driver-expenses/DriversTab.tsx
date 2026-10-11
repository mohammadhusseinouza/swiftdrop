import { useEffect, useState } from 'react';

import {
  useGetExpenseDriversQuery,
  useUpsertExpenseProfileMutation,
} from '../../../services/driverExpensesApi';
import type { ExpenseDriverSummary, ExpenseVehicleType } from '../../../services/domain.types';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { SearchInput } from '../../../components/filters/SearchInput';
import { DataTable, type DataTableColumn } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { EmptyState } from '../../../components/feedback/EmptyState';

import { describeDriverExpenseError } from './dailyExpenseGrid';
import { VEHICLE_LABEL, VEHICLE_OPTIONS } from './driverExpenseFormat';

const PAGE_SIZE = 20;
type StatusFilter = '' | 'active' | 'inactive';

/**
 * Drivers tab — existing company drivers (names from the backend's
 * drivers -> users join; never created or duplicated here) and their default
 * vehicle. Changing the default affects only FUTURE entries' pre-selection —
 * recorded daily expenses keep the vehicle they were saved with.
 */
export function DriversTab() {
  const isDesktop = useMediaQuery(MD_QUERY);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [status, setStatus] = useState<StatusFilter>('');
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [search, status]);

  const query = useGetExpenseDriversQuery({
    page,
    limit: PAGE_SIZE,
    search: search.trim() || undefined,
    isActive: status === '' ? undefined : status === 'active',
  });
  const rows = query.data?.items ?? [];

  const [selection, setSelection] = useState<Record<string, ExpenseVehicleType>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [rowMessage, setRowMessage] = useState<Record<string, { tone: 'success' | 'danger'; text: string }>>({});
  const [upsert] = useUpsertExpenseProfileMutation();

  const save = async (driver: ExpenseDriverSummary) => {
    const choice = selection[driver.driverId];
    if (!choice || saving) return;
    setSaving(driver.driverId);
    try {
      await upsert({ driverId: driver.driverId, defaultVehicleType: choice }).unwrap();
      setSelection(({ [driver.driverId]: _done, ...rest }) => rest);
      setRowMessage((m) => ({ ...m, [driver.driverId]: { tone: 'success', text: `Saved: ${VEHICLE_LABEL[choice]}` } }));
    } catch (e) {
      setRowMessage((m) => ({
        ...m,
        [driver.driverId]: { tone: 'danger', text: describeDriverExpenseError(e as UnknownApiError).message },
      }));
    } finally {
      setSaving(null);
    }
  };

  const vehicleControl = (d: ExpenseDriverSummary) => {
    const value = selection[d.driverId] ?? d.defaultVehicleType ?? '';
    const changed = selection[d.driverId] !== undefined && selection[d.driverId] !== d.defaultVehicleType;
    const msg = rowMessage[d.driverId];
    return (
      <div className="flex flex-wrap items-center gap-2">
        <label className="sr-only" htmlFor={`vehicle-${d.driverId}`}>
          Default vehicle for {d.displayName}
        </label>
        <select
          id={`vehicle-${d.driverId}`}
          value={value}
          onChange={(e) => {
            const v = e.target.value as ExpenseVehicleType;
            setSelection((s) => ({ ...s, [d.driverId]: v }));
            setRowMessage(({ [d.driverId]: _cleared, ...rest }) => rest);
          }}
          className="h-10 min-w-36 rounded-control border border-line bg-card px-2 text-sm text-ink"
        >
          {!d.defaultVehicleType && <option value="">Select vehicle…</option>}
          {VEHICLE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          size="sm"
          className="h-10"
          disabled={!changed || (saving !== null && saving !== d.driverId)}
          loading={saving === d.driverId}
          onClick={() => void save(d)}
        >
          Save
        </Button>
        {msg && (
          <span role={msg.tone === 'danger' ? 'alert' : 'status'} className={msg.tone === 'danger' ? 'text-xs text-danger-700' : 'text-xs text-success-700'}>
            {msg.text}
          </span>
        )}
      </div>
    );
  };

  const configBadge = (d: ExpenseDriverSummary) =>
    d.profileConfigured ? <Badge tone="success">Configured</Badge> : <Badge tone="warning">Not configured</Badge>;

  const columns: DataTableColumn<ExpenseDriverSummary>[] = [
    { id: 'name', header: 'Driver', cell: (d) => <span className="font-medium text-ink">{d.displayName}</span> },
    { id: 'status', header: 'Status', cell: (d) => <ActiveBadge isActive={d.isActive} /> },
    { id: 'vehicle', header: 'Default vehicle', cell: (d) => (d.defaultVehicleType ? VEHICLE_LABEL[d.defaultVehicleType] : '—') },
    { id: 'config', header: 'Configuration', cell: configBadge },
    { id: 'action', header: 'Set default vehicle', cell: vehicleControl },
  ];

  return (
    <div className="space-y-4">
      <Card flush className="space-y-3 p-4 sm:p-5">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          placeholder="Search drivers by name or number…"
          className="w-full"
        />
        <label className="flex max-w-xs flex-col gap-1 text-xs font-medium text-ink-muted">
          Status
          <select
            className="h-9 rounded-control border border-line bg-card px-2 text-sm text-ink"
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="">Any status</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </label>
      </Card>

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading drivers…" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState className="py-16" message={getApiErrorMessage(query.error as UnknownApiError)} onRetry={() => void query.refetch()} />
        </Card>
      ) : rows.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-16"
            title={search || status ? 'No drivers match these filters' : 'No drivers yet'}
            description={search || status ? 'Try adjusting the search or status.' : 'Drivers are managed on the Drivers page.'}
          />
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable columns={columns} rows={rows} getRowId={(d) => d.driverId} caption="Driver vehicle configuration" />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li key={d.driverId}>
              <Card className="space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{d.displayName}</p>
                    <div className="mt-1 flex flex-wrap gap-1.5">
                      <ActiveBadge isActive={d.isActive} />
                      {configBadge(d)}
                    </div>
                  </div>
                </div>
                {vehicleControl(d)}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {query.data && query.data.meta.totalPages > 1 && (
        <Pagination page={query.data.meta.page} totalPages={query.data.meta.totalPages} total={query.data.meta.total} onPageChange={setPage} />
      )}
    </div>
  );
}
