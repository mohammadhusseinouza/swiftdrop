import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus } from 'lucide-react';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetCustomersQuery } from '../../../services/customersApi';
import { useGetWalletCustomerSummariesQuery } from '../../../services/walletsApi';
import { useGetAreasQuery } from '../../../services/settingsApi';
import type { WalletCustomerSummary } from '../../../services/domain.types';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import { paths } from '../../../routes/paths';

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

import { buildCustomerColumns } from './customerColumns';
import { MobileCustomerCard } from './MobileCustomerCard';
import { CustomerFormDialog } from './CustomerFormDialog';
import {
  EMPTY_CUSTOMERS_STATE,
  hasActiveCustomerFilters,
  parseCustomersListParams,
  serializeCustomersListParams,
  toListCustomersParams,
  type CustomersListState,
} from './customersListParams';

/**
 * Phase 11.6 — Management Customers list.
 *
 * URL search params are the source of truth for search / status / area / page.
 * All querying is backend-side via `useGetCustomersQuery` against the live
 * Phase 5.1 contract; nothing is filtered, sorted or sliced client-side, and
 * Customer data never leaves the RTK Query cache.
 *
 * `GET /customers` (CustomerSummary) carries no wallet balance, pending amount
 * or active-orders aggregate, so those columns are not shown (documented
 * backend list-DTO gap — never per-row N+1 or fabricated values). There is no
 * server sort param, so headers are not sortable.
 */
export default function CustomersListPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canCreate = useHasPermission(PERMISSIONS.CUSTOMERS_CREATE);
  const canViewWallet = useHasPermission(PERMISSIONS.WALLETS_READ);

  const state = useMemo(() => parseCustomersListParams(sp), [sp]);
  const filtersActive = hasActiveCustomerFilters(state);

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: CustomersListState) => setSp(serializeCustomersListParams(next)),
    [setSp],
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const patch = useCallback(
    (p: Partial<CustomersListState>) => commit({ ...state, ...p, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_CUSTOMERS_STATE });
  }, [commit]);

  const query = useGetCustomersQuery(toListCustomersParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  // wallets.read-gated financial summary for the current page — ONE request
  // per page (never per row). Never fired for a caller without wallets.read.
  const pageIds = useMemo(() => rows.map((r) => r.id), [rows]);
  const walletSummaries = useGetWalletCustomerSummariesQuery(
    { customerIds: pageIds },
    { skip: !canViewWallet || pageIds.length === 0 },
  );
  const walletByCustomer = useMemo(() => {
    const map = new Map<string, WalletCustomerSummary>();
    for (const w of walletSummaries.data ?? []) map.set(w.customerId, w);
    return map;
  }, [walletSummaries.data]);

  const columns = useMemo(
    () =>
      buildCustomerColumns({
        showFinancial: canViewWallet,
        walletByCustomer,
        financialLoading: walletSummaries.isFetching,
      }),
    [canViewWallet, walletByCustomer, walletSummaries.isFetching],
  );

  const areas = useGetAreasQuery({ isActive: true, limit: 100 });

  const [createOpen, setCreateOpen] = useState(false);

  const addButton = canCreate ? (
    <Button icon={<Plus />} onClick={() => setCreateOpen(true)}>
      Add customer
    </Button>
  ) : null;

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Customers"
        description="Manage customer accounts and delivery relationships."
        actions={addButton}
      />

      <Card flush className="space-y-4 p-4 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search by name, number, phone or email…"
          className="w-full"
        />
        <div role="search" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
            Status
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.status}
              onChange={(e) =>
                patch({
                  status: e.target.value as CustomersListState['status'],
                })
              }
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-56">
            Area
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink disabled:opacity-50"
              value={state.areaId}
              disabled={areas.isLoading || areas.isError}
              onChange={(e) => patch({ areaId: e.target.value })}
            >
              <option value="">
                {areas.isLoading
                  ? 'Loading areas…'
                  : areas.isError
                    ? 'Areas unavailable'
                    : 'Any area'}
              </option>
              {(areas.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
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
              title="No customers match these filters"
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
              title="No customers yet"
              description="Customer accounts will appear here once created."
              action={addButton ?? undefined}
            />
          )}
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(c) => c.id}
            caption="Customers"
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((c) => (
            <li key={c.id}>
              <MobileCustomerCard
                customer={c}
                wallet={canViewWallet ? walletByCustomer.get(c.id) : undefined}
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
          Showing {rows.length} of {meta.total} customers.
        </p>
      )}

      <CustomerFormDialog
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onCreated={(created) => {
          setCreateOpen(false);
          navigate(paths.management.customerDetail(created.id));
        }}
        onSaved={() => setCreateOpen(false)}
      />
    </div>
  );
}
