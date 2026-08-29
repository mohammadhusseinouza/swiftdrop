import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useGetWalletsQuery } from '../../../services/walletsApi';
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

import { walletColumns } from './walletColumns';
import { MobileWalletCard } from './MobileWalletCard';
import {
  EMPTY_WALLETS_STATE,
  hasActiveWalletFilters,
  parseWalletsListParams,
  serializeWalletsListParams,
  toListWalletsParams,
  type WalletsListState,
} from './walletsListParams';

/**
 * Phase 11.8 — Management Customer Wallets list.
 *
 * URL search params own search / page. ONE `GET /wallets` request per page
 * feeds the whole table — balances, pending, last transaction and last payout
 * are all batched server-side (no N+1). No Create Wallet action: wallets are
 * initialised by the Customer domain. Route is guarded by `wallets.read`.
 */
export default function WalletsListPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(MD_QUERY);

  const state = useMemo(() => parseWalletsListParams(sp), [sp]);
  const filtersActive = hasActiveWalletFilters(state);

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: WalletsListState) => setSp(serializeWalletsListParams(next)),
    [setSp],
  );

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_WALLETS_STATE });
  }, [commit]);

  const query = useGetWalletsQuery(toListWalletsParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Customer Wallets"
        description="Monitor customer balances, pending deliveries, and wallet activity."
      />

      <Card flush className="space-y-4 p-4 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search by customer number, name or phone…"
          className="w-full"
        />
        {filtersActive && (
          <button
            type="button"
            onClick={clearAll}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            Clear search
          </button>
        )}
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
          <EmptyState
            className="py-16"
            title={
              filtersActive
                ? 'No wallets match your search.'
                : 'No customer wallets found.'
            }
            description={
              filtersActive
                ? 'Try a different customer number, name or phone.'
                : 'Customer wallets are created automatically with each customer.'
            }
            action={
              filtersActive ? (
                <Button variant="secondary" size="sm" onClick={clearAll}>
                  Clear search
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={walletColumns}
            rows={rows}
            getRowId={(w) => w.customer.id}
            caption="Customer wallets"
            onRowClick={(w) =>
              navigate(`/management/wallets/${w.customer.id}`)
            }
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((w) => (
            <li key={w.customer.id}>
              <MobileWalletCard wallet={w} />
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
          Showing {rows.length} of {meta.total} customer wallets.
        </p>
      )}
    </div>
  );
}
