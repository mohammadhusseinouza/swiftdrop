import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetDriverCashSummariesQuery,
  useGetDriversQuery,
} from '../../../services/driversApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Pagination } from '../../../components/data-display/Pagination';
import { DataTable } from '../../../components/data-display/DataTable';
import { SearchInput } from '../../../components/filters/SearchInput';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';

import { buildDriverColumns } from './driverColumns';
import { MobileDriverCard } from './MobileDriverCard';
import { DriverFormDialog } from './DriverFormDialog';
import {
  EMPTY_DRIVERS_STATE,
  hasActiveDriverFilters,
  parseDriversListParams,
  serializeDriversListParams,
  toListDriversParams,
  type DriversListState,
} from './driversListParams';

/**
 * Phase 11.7 (+ correction) — Management Drivers list.
 *
 * URL search params are the source of truth for search / status / page. All
 * querying is backend-side via `useGetDriversQuery`; nothing is filtered,
 * sorted or sliced client-side.
 *
 * Operational metrics come from the authoritative server `operationalSummary`
 * on each row. Cash Held is `finance.read`-only and is filled from ONE batched
 * `/finance/driver-cash/summaries` request per page (never per row); Dispatcher
 * issues no cash request and sees no cash column.
 */
export default function DriversListPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canManage = useHasPermission(PERMISSIONS.DRIVERS_MANAGE);
  const canViewCash = useHasPermission(PERMISSIONS.FINANCE_READ);

  const state = useMemo(() => parseDriversListParams(sp), [sp]);
  const filtersActive = hasActiveDriverFilters(state);

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: DriversListState) => setSp(serializeDriversListParams(next)),
    [setSp],
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const patch = useCallback(
    (p: Partial<DriversListState>) => commit({ ...state, ...p, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_DRIVERS_STATE });
  }, [commit]);

  const query = useGetDriversQuery(toListDriversParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const driverIds = useMemo(() => rows.map((d) => d.id), [rows]);
  const cashQuery = useGetDriverCashSummariesQuery(driverIds, {
    skip: !canViewCash || driverIds.length === 0,
  });
  const cashByDriver = useMemo(() => {
    const map = new Map<string, string>();
    for (const s of cashQuery.data ?? []) map.set(s.driverId, s.currentBalance);
    return map;
  }, [cashQuery.data]);

  const columns = useMemo(
    () =>
      buildDriverColumns({
        showCash: canViewCash,
        cashByDriver,
        cashLoading: cashQuery.isFetching,
      }),
    [canViewCash, cashByDriver, cashQuery.isFetching],
  );

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Drivers"
        description="Manage drivers and monitor delivery operations."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>Add driver</Button>
          ) : undefined
        }
      />

      <Card flush className="space-y-4 p-4 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search by driver number, name, phone or email…"
          className="w-full"
        />
        <div role="search" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
            Status
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.status}
              onChange={(e) =>
                patch({ status: e.target.value as DriversListState['status'] })
              }
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          {filtersActive && (
            <button
              type="button"
              onClick={clearAll}
              className="self-end pb-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card flush>
          {filtersActive ? (
            <EmptyState
              className="py-16"
              title="No drivers match these filters"
              description="Try adjusting or clearing the filters."
              action={
                <Button variant="secondary" size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              className="py-16"
              title="No drivers yet"
              description="Add a driver to get started."
              action={
                canManage ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    Add driver
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(d) => d.id}
            caption="Drivers"
            onRowClick={(d) => navigate(`/management/drivers/${d.id}`)}
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((d) => (
            <li key={d.id}>
              <MobileDriverCard
                driver={d}
                cashHeld={canViewCash ? (cashByDriver.get(d.id) ?? null) : null}
                showCash={canViewCash}
              />
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <Pagination
          page={state.page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={setPage}
        />
      )}

      {meta && rows.length > 0 && (
        <p className="sr-only" aria-live="polite">
          Showing {rows.length} of {meta.total} drivers.
        </p>
      )}

      <DriverFormDialog
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onCreated={(driver) => {
          setCreateOpen(false);
          navigate(`/management/drivers/${driver.id}`);
        }}
        onSaved={() => setCreateOpen(false)}
      />
    </div>
  );
}
