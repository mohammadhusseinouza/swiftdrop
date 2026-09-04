import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetSettlementsQuery } from '../../../services/settlementsApi';
import { useGetDriversQuery, useGetDriverQuery } from '../../../services/driversApi';
import { useGetPaymentMethodsQuery } from '../../../services/settingsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Pagination } from '../../../components/data-display/Pagination';
import { DataTable } from '../../../components/data-display/DataTable';
import { SearchInput } from '../../../components/filters/SearchInput';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';

import { buildSettlementColumns } from './settlementColumns';
import { MobileSettlementCard } from './MobileSettlementCard';
import { ProcessSettlementDialog } from './ProcessSettlementDialog';
import {
  EMPTY_SETTLEMENTS_STATE,
  hasActiveSettlementFilters,
  parseSettlementsListParams,
  serializeSettlementsListParams,
  toListSettlementsParams,
  type SettlementsListState,
} from './settlementsListParams';

/**
 * Phase 11.10 — Management Driver Settlements.
 *
 * URL search params own search / driver / payment method / page. Every query
 * is server-backed via `useGetSettlementsQuery` — nothing is filtered, sorted
 * or sliced client-side (`GET /driver-settlements` has no sort contract, so no
 * sortable headers, and no status/date fields). Route guarded by
 * `settlements.read`; the Process Settlement action is gated by
 * `settlements.create`.
 *
 * `?driverId=<uuid>` (from Driver Detail) both scopes the list to that driver
 * AND preselects them in the Process Settlement dialog. The dialog is NOT
 * auto-opened — the user clicks "Process settlement" — so it can never re-open
 * after a success or back-navigation.
 */
export default function SettlementsListPage() {
  const [sp, setSp] = useSearchParams();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canCreate = useHasPermission(PERMISSIONS.SETTLEMENTS_CREATE);
  const canViewDriver = useHasPermission(PERMISSIONS.DRIVERS_READ);

  const state = useMemo(() => parseSettlementsListParams(sp), [sp]);
  const filtersActive = hasActiveSettlementFilters(state);

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: SettlementsListState) => setSp(serializeSettlementsListParams(next)),
    [setSp],
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const patch = useCallback(
    (p: Partial<SettlementsListState>) => commit({ ...state, ...p, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_SETTLEMENTS_STATE });
  }, [commit]);

  /* --------------------------- filter reference data --------------------- */
  const [driverTerm, setDriverTerm] = useState('');
  const debouncedDriverTerm = useDebouncedValue(driverTerm, 300);
  // Not restricted to active drivers — a past settlement stays valid after a
  // driver is deactivated, so the history filter must resolve them too.
  const drivers = useGetDriversQuery({
    search: debouncedDriverTerm.trim() || undefined,
    limit: 20,
  });
  const filterDriver = useGetDriverQuery(state.driverId, {
    skip: !state.driverId,
  });
  const paymentMethods = useGetPaymentMethodsQuery();

  const selectedDriverLabel = filterDriver.data
    ? `${filterDriver.data.driverNumber} · ${filterDriver.data.user.firstName} ${filterDriver.data.user.lastName}`
    : undefined;

  /* ------------------------------- data --------------------------------- */
  const query = useGetSettlementsQuery(toListSettlementsParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const columns = useMemo(
    () => buildSettlementColumns({ canViewDriver }),
    [canViewDriver],
  );

  /* ----------------------------- dialog --------------------------------- */
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Driver Settlements"
        description="Record cash returned by drivers and review settlement history."
        actions={
          canCreate ? (
            <Button onClick={() => setDialogOpen(true)}>Process settlement</Button>
          ) : undefined
        }
      />

      {state.driverId && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-brand-100 bg-brand-50 px-4 py-2.5 text-sm text-brand-700">
          <span>
            Showing settlements for{' '}
            <strong>{selectedDriverLabel ?? 'the selected driver'}</strong>.
          </span>
          <button
            type="button"
            onClick={() => patch({ driverId: '' })}
            className="font-medium underline hover:text-brand-800"
          >
            Clear driver filter
          </button>
        </div>
      )}

      <Card flush className="space-y-4 p-4 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search by settlement number, driver number or name…"
          className="w-full"
        />

        <div role="search" className="flex flex-wrap items-end gap-2">
          <ServerSearchSelect
            label="Driver"
            anyLabel="Any driver"
            searchPlaceholder="Search drivers…"
            value={state.driverId}
            onChange={(id) => patch({ driverId: id })}
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

          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-52">
            Payment method
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.paymentMethodId}
              disabled={paymentMethods.isLoading}
              onChange={(e) => patch({ paymentMethodId: e.target.value })}
            >
              <option value="">
                {paymentMethods.isLoading
                  ? 'Loading methods…'
                  : 'Any payment method'}
              </option>
              {(paymentMethods.data ?? []).map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
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
              title="No settlements match these filters."
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
              title="No driver settlements yet."
              description="Process a settlement to record cash a driver has handed back to the company."
              action={
                canCreate ? (
                  <Button size="sm" onClick={() => setDialogOpen(true)}>
                    Process settlement
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
            getRowId={(s) => s.id}
            caption="Driver settlements"
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((s) => (
            <li key={s.id}>
              <MobileSettlementCard
                settlement={s}
                canViewDriver={canViewDriver}
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
          Showing {rows.length} of {meta.total} settlements.
        </p>
      )}

      {canCreate && (
        <ProcessSettlementDialog
          open={dialogOpen}
          initialDriverId={state.driverId || undefined}
          onClose={() => setDialogOpen(false)}
          onProcessed={() => {
            /* RTK Query tag invalidation refreshes the settlement list, the
               driver-cash detail/summaries caches and the finance/dashboard
               views — no manual row insertion. */
          }}
        />
      )}
    </div>
  );
}
