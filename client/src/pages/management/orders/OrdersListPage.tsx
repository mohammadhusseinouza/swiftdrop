import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';

import { useAppDispatch, useAppSelector } from '../../../app/hooks';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  clearOrderSelection,
  selectSelectedOrderIds,
  setSelectedOrderIds,
} from '../../../features/orders/ordersUiSlice';
import { useGetOrdersQuery } from '../../../services/ordersApi';
import { getApiErrorMessage } from '../../../services/apiError';
import type { UnknownApiError } from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Pagination } from '../../../components/data-display/Pagination';
import { DataTable } from '../../../components/data-display/DataTable';
import { SearchInput } from '../../../components/filters/SearchInput';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { MobileOrderCard } from '../../../components/orders/MobileOrderCard';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { formatDateTime, formatMoney } from '../../../lib/format';

import { OrdersFilterBar } from './OrdersFilterBar';
import { OrdersQuickTabs } from './OrdersQuickTabs';
import { BulkAssignDialog } from './BulkAssignDialog';
import { orderColumns } from './orderColumns';
import {
  EMPTY_ORDERS_STATE,
  applyQuickTab,
  applySort,
  getActiveQuickTab,
  getSortState,
  hasActiveFilters,
  parseOrdersListParams,
  serializeOrdersListParams,
  toListOrdersParams,
  type OrdersListState,
  type QuickTab,
} from './ordersListParams';

/**
 * Phase 11.3 — Operational Orders list.
 *
 * URL search params are the source of truth for search / filters / sort / page.
 * ALL querying (search, every filter, sorting, pagination) is backend-side via
 * `useGetOrdersQuery` against the completed Phase 6.3 contract — Orders data
 * stays in the RTK Query cache and is never copied into Redux; nothing is
 * filtered or sorted client-side. `ordersUi.selectedOrderIds` holds only the
 * current bulk selection; it is scrubbed to the visible page and cleared on
 * mount / any URL change (incl. sort) / unmount / successful bulk assign.
 *
 * Remaining Orders workflow gap: no atomic bulk "mark ready" endpoint exists,
 * so no bulk Mark Ready control (single-order ready is Order Detail, 11.5).
 */
export default function OrdersListPage() {
  const [sp, setSp] = useSearchParams();
  const spString = sp.toString();
  const navigate = useNavigate();
  const dispatch = useAppDispatch();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canCreate = useHasPermission(PERMISSIONS.ORDERS_CREATE);
  const canAssign = useHasPermission(PERMISSIONS.ORDERS_ASSIGN);

  const state = useMemo(() => parseOrdersListParams(sp), [sp]);
  const activeTab = getActiveQuickTab(state);
  const filtersActive = hasActiveFilters(state);

  // Local search box value (debounced before it commits to the URL).
  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  // Keep the box in sync when the URL changes elsewhere (Back/Forward, Clear).
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: OrdersListState) => setSp(serializeOrdersListParams(next)),
    [setSp],
  );

  // Commit debounced search (reset to page 1) once it diverges from the URL.
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const patchFilters = useCallback(
    (patch: Partial<OrdersListState>) =>
      commit({ ...state, ...patch, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const applyTab = useCallback(
    (tab: QuickTab) => commit(applyQuickTab(state, tab)),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_ORDERS_STATE });
  }, [commit]);

  // ---- server state ----
  const query = useGetOrdersQuery(toListOrdersParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  // ---- selection (current visible page only) ----
  const selectedIds = useAppSelector(selectSelectedOrderIds);
  const pageIds = useMemo(() => new Set(rows.map((r) => r.id)), [rows]);
  const selectedOnPage = useMemo(
    () => selectedIds.filter((id) => pageIds.has(id)),
    [selectedIds, pageIds],
  );
  const alreadyAssignedCount = useMemo(
    () =>
      rows.filter((r) => pageIds.has(r.id) && selectedOnPage.includes(r.id) && r.currentDriver)
        .length,
    [rows, pageIds, selectedOnPage],
  );

  // Clear selection on mount + whenever query/filter/page state changes.
  useEffect(() => {
    dispatch(clearOrderSelection());
  }, [dispatch, spString]);
  // Clear selection on unmount.
  useEffect(() => () => void dispatch(clearOrderSelection()), [dispatch]);

  const [assignOpen, setAssignOpen] = useState(false);

  const createOrderLink = (
    <Link
      to="/management/orders/new"
      className="inline-flex h-10 items-center gap-2 rounded-control bg-brand-600 px-4 text-sm font-medium text-white hover:bg-brand-700"
    >
      <Plus className="size-4" aria-hidden="true" />
      Create order
    </Link>
  );

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Orders"
        description="Manage and track all delivery operations"
        actions={
          <>
            <Button
              variant="secondary"
              size="md"
              icon={<RefreshCw />}
              onClick={() => void query.refetch()}
              loading={query.isFetching && !query.isLoading}
            >
              Refresh
            </Button>
            {canCreate && createOrderLink}
          </>
        }
      />

      {/* One controls surface: search, then quick tabs, then filters. */}
      <Card flush className="space-y-4 p-4 sm:space-y-5 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search order, tracking code, customer, receiver or phone…"
          className="w-full"
        />
        <OrdersQuickTabs activeId={activeTab} onSelect={applyTab} />
        <OrdersFilterBar
          state={state}
          onPatch={patchFilters}
          onClear={clearAll}
          hasActive={filtersActive}
        />
      </Card>

      {/* Bulk action bar */}
      {canAssign && selectedOnPage.length > 0 && (
        <div
          role="region"
          aria-label="Bulk actions"
          className="flex flex-wrap items-center gap-3 rounded-card border border-brand-100 bg-brand-50 px-3 py-2 text-sm"
        >
          <span className="font-medium text-brand-700" aria-live="polite">
            {selectedOnPage.length} order
            {selectedOnPage.length === 1 ? '' : 's'} selected
          </span>
          <Button size="sm" onClick={() => setAssignOpen(true)}>
            Assign driver
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => dispatch(clearOrderSelection())}
          >
            Clear
          </Button>
        </div>
      )}

      {/* Content — a single results surface below the controls card. */}
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
              title="No orders match these filters"
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
              title="No orders yet"
              description="Delivery orders will appear here once created."
              action={canCreate ? createOrderLink : undefined}
            />
          )}
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={orderColumns}
            rows={rows}
            getRowId={(o) => o.id}
            caption="Orders"
            sort={getSortState(state)}
            onSortChange={(next) => commit(applySort(state, next))}
            selectedIds={canAssign ? selectedOnPage : undefined}
            onSelectionChange={
              canAssign
                ? (ids) => dispatch(setSelectedOrderIds(ids))
                : undefined
            }
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((o) => (
            <li key={o.id}>
              <MobileOrderCard
                order={{
                  orderNumber: o.orderNumber,
                  status: o.status,
                  orderType: o.orderType,
                  receiverName: o.receiverName,
                  receiverPhone: o.receiverPhone,
                  area: o.receiverArea,
                  amountToCollect: formatMoney(o.amountToCollect),
                  driverName: o.currentDriver
                    ? `${o.currentDriver.user.firstName} ${o.currentDriver.user.lastName}`
                    : undefined,
                  createdAt: formatDateTime(o.createdAt),
                }}
                onClick={() => navigate(`/management/orders/${o.id}`)}
                selected={
                  canAssign ? selectedOnPage.includes(o.id) : undefined
                }
                onSelectedChange={
                  canAssign
                    ? (next) =>
                        dispatch(
                          setSelectedOrderIds(
                            next
                              ? [...selectedOnPage, o.id]
                              : selectedOnPage.filter((id) => id !== o.id),
                          ),
                        )
                    : undefined
                }
                selectLabel={`Select order ${o.orderNumber}`}
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

      {/* Tiny status footer so screen readers get a summary */}
      {meta && rows.length > 0 && (
        <p className="sr-only" aria-live="polite">
          Showing {rows.length} of {meta.total} orders.
        </p>
      )}

      <BulkAssignDialog
        open={assignOpen}
        orderIds={selectedOnPage}
        alreadyAssignedCount={alreadyAssignedCount}
        onClose={() => setAssignOpen(false)}
        onAssigned={() => {
          setAssignOpen(false);
          dispatch(clearOrderSelection());
          // RTK Query tag invalidation (Order:LIST) refetches the list.
        }}
      />
    </div>
  );
}
