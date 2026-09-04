import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetPayoutsQuery } from '../../../services/payoutsApi';
import { useGetWalletQuery } from '../../../services/walletsApi';
import { useGetPaymentMethodsQuery } from '../../../services/settingsApi';
import { useGetCustomersQuery } from '../../../services/customersApi';
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

import { buildPayoutColumns } from './payoutColumns';
import { MobilePayoutCard } from './MobilePayoutCard';
import { ProcessPayoutDialog } from './ProcessPayoutDialog';
import {
  EMPTY_PAYOUTS_STATE,
  PAYOUT_STATUSES,
  hasActivePayoutFilters,
  parsePayoutsListParams,
  serializePayoutsListParams,
  toListPayoutsParams,
  type PayoutsListState,
} from './payoutsListParams';
import { payoutStatusLabel } from './payoutPresentation';

/**
 * Phase 11.9 — Management Customer Payouts.
 *
 * URL search params own search / customer / payment method / status / page.
 * Every query is server-backed via `useGetPayoutsQuery` — nothing is filtered,
 * sorted or sliced client-side (`GET /payouts` has no sort contract, so no
 * sortable headers). Route guarded by `payouts.read`; the Process Payout
 * action is gated by `payouts.create`.
 *
 * `?customerId=<uuid>` (from Wallet Detail) both scopes the list to that
 * customer AND preselects them in the Process Payout dialog. The dialog is
 * NOT auto-opened — the user clicks "Process payout" — so it can never
 * re-open after a success or back-navigation.
 */
export default function PayoutsListPage() {
  const [sp, setSp] = useSearchParams();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canCreate = useHasPermission(PERMISSIONS.PAYOUTS_CREATE);
  const canViewCustomer = useHasPermission(PERMISSIONS.CUSTOMERS_READ);

  const state = useMemo(() => parsePayoutsListParams(sp), [sp]);
  const filtersActive = hasActivePayoutFilters(state);

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: PayoutsListState) => setSp(serializePayoutsListParams(next)),
    [setSp],
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const patch = useCallback(
    (p: Partial<PayoutsListState>) => commit({ ...state, ...p, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_PAYOUTS_STATE });
  }, [commit]);

  /* --------------------------- filter reference data --------------------- */
  const [customerTerm, setCustomerTerm] = useState('');
  const debouncedCustomerTerm = useDebouncedValue(customerTerm, 300);
  const customers = useGetCustomersQuery({
    search: debouncedCustomerTerm.trim() || undefined,
    limit: 20,
  });
  const filterCustomerWallet = useGetWalletQuery(state.customerId, {
    skip: !state.customerId,
  });
  const paymentMethods = useGetPaymentMethodsQuery();

  const selectedCustomerLabel = filterCustomerWallet.data
    ? `${filterCustomerWallet.data.customer.customerNumber} · ${filterCustomerWallet.data.customer.name}`
    : undefined;

  /* ------------------------------- data --------------------------------- */
  const query = useGetPayoutsQuery(toListPayoutsParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const columns = useMemo(
    () => buildPayoutColumns({ canViewCustomer }),
    [canViewCustomer],
  );

  /* ----------------------------- dialog --------------------------------- */
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Customer Payouts"
        description="Review and process payments from customer wallet balances."
        actions={
          canCreate ? (
            <Button onClick={() => setDialogOpen(true)}>Process payout</Button>
          ) : undefined
        }
      />

      {state.customerId && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-brand-100 bg-brand-50 px-4 py-2.5 text-sm text-brand-700">
          <span>
            Showing payouts for{' '}
            <strong>{selectedCustomerLabel ?? 'the selected customer'}</strong>.
          </span>
          <button
            type="button"
            onClick={() => patch({ customerId: '' })}
            className="font-medium underline hover:text-brand-800"
          >
            Clear customer filter
          </button>
        </div>
      )}

      <Card flush className="space-y-4 p-4 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search by payout number, customer number or name…"
          className="w-full"
        />

        <div role="search" className="flex flex-wrap items-end gap-2">
          <ServerSearchSelect
            label="Customer"
            anyLabel="Any customer"
            searchPlaceholder="Search customers…"
            value={state.customerId}
            onChange={(id) => patch({ customerId: id })}
            searchTerm={customerTerm}
            onSearchTermChange={setCustomerTerm}
            loading={customers.isFetching}
            total={customers.data?.meta.total}
            options={(customers.data?.items ?? []).map((c) => ({
              id: c.id,
              label: `${c.customerNumber} · ${c.name}`,
            }))}
            selectedLabel={selectedCustomerLabel}
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

          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
            Status
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.status}
              onChange={(e) =>
                patch({ status: e.target.value as PayoutsListState['status'] })
              }
            >
              <option value="">Any status</option>
              {PAYOUT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {payoutStatusLabel(s)}
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
              title="No payouts match these filters."
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
              title="No customer payouts yet."
              description="Process a payout to pay a customer from their available wallet balance."
              action={
                canCreate ? (
                  <Button size="sm" onClick={() => setDialogOpen(true)}>
                    Process payout
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
            getRowId={(p) => p.id}
            caption="Customer payouts"
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((p) => (
            <li key={p.id}>
              <MobilePayoutCard payout={p} canViewCustomer={canViewCustomer} />
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
          Showing {rows.length} of {meta.total} payouts.
        </p>
      )}

      {canCreate && (
        <ProcessPayoutDialog
          open={dialogOpen}
          initialCustomerId={state.customerId || undefined}
          onClose={() => setDialogOpen(false)}
          onProcessed={() => {
            /* RTK Query tag invalidation refreshes the list, wallet and
               finance caches — no manual row insertion. */
          }}
        />
      )}
    </div>
  );
}
