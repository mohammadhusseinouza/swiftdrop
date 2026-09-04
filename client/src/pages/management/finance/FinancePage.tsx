import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetFinanceSummaryQuery,
  useGetFinanceTransactionsQuery,
  useAdjustCompanyFinanceMutation,
  useReverseCompanyTransactionMutation,
  useReverseDriverCashTransactionMutation,
} from '../../../services/financeApi';
import { useReverseWalletTransactionMutation } from '../../../services/walletsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import type { FinanceTransactionEntry } from '../../../services/domain.types';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { DataTable } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { DateRangeFilter } from '../../../components/filters/DateRangeFilter';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { formatDate, formatMoney } from '../../../lib/format';

import { LedgerAdjustDialog } from '../../../components/finance/LedgerAdjustDialog';
import { LedgerReverseDialog } from '../../../components/finance/LedgerReverseDialog';
import {
  LEDGER_LABEL,
  isReversibleType,
  ledgerTypeLabel,
} from '../../../components/finance/ledgerCorrection';
import { MetricTile } from '../dashboard/MetricTile';

import { buildFinanceColumns } from './financeTransactionColumns';
import { MobileFinanceTransactionCard } from './MobileFinanceTransactionCard';
import {
  EMPTY_FINANCE_STATE,
  LEDGERS,
  LEDGER_TYPES,
  hasActiveFinanceFilters,
  parseFinanceListParams,
  serializeFinanceListParams,
  toSummaryParams,
  toTransactionParams,
  type FinanceListState,
} from './financeListParams';

/**
 * Phase 11.12 — Management Finance.
 *
 * ONE data source per section: `GET /finance/summary` for the six+one
 * authoritative totals (never recomputed in React), `GET /finance/transactions`
 * for the unified append-only feed over all three ledgers. Date range + ledger
 * + type filters + page live in the URL; nothing is filtered/sorted/sliced
 * client-side. Corrections route to the ledger-specific backend endpoints.
 */
export default function FinancePage() {
  const [sp, setSp] = useSearchParams();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canAdjustFinance = useHasPermission(PERMISSIONS.FINANCE_ADJUST);
  const canAdjustWallet = useHasPermission(PERMISSIONS.WALLETS_ADJUST);
  const canViewOrders = useHasPermission(PERMISSIONS.ORDERS_READ);
  const canViewCustomers = useHasPermission(PERMISSIONS.CUSTOMERS_READ);
  const canViewDrivers = useHasPermission(PERMISSIONS.DRIVERS_READ);

  const state = useMemo(() => parseFinanceListParams(sp), [sp]);
  const filtersActive = hasActiveFinanceFilters(state);

  const commit = useCallback(
    (next: FinanceListState) => setSp(serializeFinanceListParams(next)),
    [setSp],
  );
  const setRange = useCallback(
    (range: { from: string; to: string }) =>
      commit({ ...state, from: range.from, to: range.to, page: 1 }),
    [commit, state],
  );
  const setLedger = useCallback(
    (ledger: FinanceListState['ledger']) => {
      const typeStillValid =
        state.type !== '' &&
        (!ledger ||
          (LEDGER_TYPES[ledger] as string[]).includes(state.type));
      commit({
        ...state,
        ledger,
        type: typeStillValid ? state.type : '',
        page: 1,
      });
    },
    [commit, state],
  );
  const setType = useCallback(
    (type: string) => commit({ ...state, type, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearFilters = useCallback(
    () => commit({ ...EMPTY_FINANCE_STATE }),
    [commit],
  );

  const summary = useGetFinanceSummaryQuery(toSummaryParams(state));
  const txns = useGetFinanceTransactionsQuery(toTransactionParams(state));
  const rows = txns.data?.items ?? [];
  const meta = txns.data?.meta;

  const refetchAll = useCallback(() => {
    void summary.refetch();
    void txns.refetch();
  }, [summary, txns]);

  /* -------------------------- corrections -------------------------- */
  const [companyAdjustOpen, setCompanyAdjustOpen] = useState(false);
  const [reverseTarget, setReverseTarget] =
    useState<FinanceTransactionEntry | null>(null);

  const [adjustCompany, adjustCompanyState] = useAdjustCompanyFinanceMutation();
  const [reverseCompany, reverseCompanyState] =
    useReverseCompanyTransactionMutation();
  const [reverseDriverCash, reverseDriverCashState] =
    useReverseDriverCashTransactionMutation();
  const [reverseWallet, reverseWalletState] =
    useReverseWalletTransactionMutation();

  const reverseSubmitting =
    reverseCompanyState.isLoading ||
    reverseDriverCashState.isLoading ||
    reverseWalletState.isLoading;

  const runReverse = async (reason: string) => {
    const t = reverseTarget;
    if (!t) return;
    if (t.ledger === 'WALLET') {
      await reverseWallet({
        transactionId: t.id,
        reason,
        customerId: t.customer?.id,
        orderId: t.order?.id,
        payoutLinked: !!t.payout,
      }).unwrap();
    } else if (t.ledger === 'DRIVER_CASH') {
      await reverseDriverCash({
        transactionId: t.id,
        reason,
        driverId: t.driver?.id,
        orderId: t.order?.id,
        settlementLinked: !!t.settlement,
      }).unwrap();
    } else {
      await reverseCompany({
        transactionId: t.id,
        reason,
        orderId: t.order?.id,
      }).unwrap();
    }
  };

  const canReverseRow = (t: FinanceTransactionEntry) =>
    isReversibleType(t.type) &&
    (t.ledger === 'WALLET' ? canAdjustWallet : canAdjustFinance);

  const renderRowActions = (t: FinanceTransactionEntry) =>
    canReverseRow(t) ? (
      <Button
        size="sm"
        variant="ghost"
        onClick={() => setReverseTarget(t)}
        className="text-danger-700 hover:bg-danger-50"
      >
        Reverse
      </Button>
    ) : null;

  const anyRowReversible = rows.some(canReverseRow);
  const columns = useMemo(
    () =>
      buildFinanceColumns({
        canViewOrders,
        canViewCustomers,
        canViewDrivers,
        renderActions: anyRowReversible ? renderRowActions : undefined,
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canViewOrders, canViewCustomers, canViewDrivers, anyRowReversible],
  );

  const typeOptions = state.ledger
    ? LEDGER_TYPES[state.ledger]
    : Array.from(
        new Set(Object.values(LEDGER_TYPES).flatMap((t) => [...t])),
      );

  const s = summary.data;
  const rangeLabel = state.to
    ? `as of ${formatDate(state.to)}`
    : 'current';

  return (
    <div className="space-y-6 pb-6">
      <PageHeader
        size="lg"
        title="Finance"
        description="Revenue, liabilities, payouts, driver cash, and financial activity."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              icon={
                <RefreshCw
                  className={
                    summary.isFetching || txns.isFetching ? 'animate-spin' : ''
                  }
                />
              }
              onClick={refetchAll}
              disabled={summary.isFetching || txns.isFetching}
            >
              Refresh
            </Button>
            {canAdjustFinance && (
              <Button onClick={() => setCompanyAdjustOpen(true)}>
                Adjust company finance
              </Button>
            )}
          </div>
        }
      />

      {/* date range */}
      <Card flush className="space-y-3 p-4 sm:p-5">
        <DateRangeFilter
          value={{ from: state.from, to: state.to }}
          onChange={setRange}
          fromLabel="From"
          toLabel="To (inclusive)"
        />
        {(state.from || state.to) && (
          <button
            type="button"
            onClick={() => setRange({ from: '', to: '' })}
            className="text-sm font-medium text-brand-600 hover:text-brand-700"
          >
            Clear date range
          </button>
        )}
        <p className="text-xs text-ink-muted">
          Dates are whole UTC calendar days. Revenue / collected / payout figures
          are <strong>flow</strong> within the range. Wallet liability and driver
          cash are a <strong>point-in-time balance</strong> ({rangeLabel}) — the{' '}
          <em>From</em> date does not affect them.
        </p>
      </Card>

      {/* summary cards */}
      <section aria-labelledby="summary-heading" className="space-y-3">
        <h2 id="summary-heading" className="text-sm font-semibold text-ink">
          Summary
        </h2>
        {summary.isLoading && !s ? (
          <Card flush>
            <LoadingState className="py-12" />
          </Card>
        ) : summary.isError && !s ? (
          <Card flush>
            <ErrorState
              className="py-12"
              message={getApiErrorMessage(summary.error as UnknownApiError)}
              onRetry={() => void summary.refetch()}
            />
          </Card>
        ) : s ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <MetricTile
                label="Delivery fee revenue"
                value={formatMoney(s.deliveryFeeRevenue)}
                hint="Flow · net of reversals"
              />
              <MetricTile
                label="Company order revenue"
                value={formatMoney(s.companyOrderRevenue)}
                hint="Flow · net of reversals"
              />
              <MetricTile
                label="Total collected"
                value={formatMoney(s.totalCollected)}
                hint="Flow · cash collected on delivery"
              />
              <MetricTile
                label="Customer payouts"
                value={formatMoney(s.customerPayouts)}
                hint="Flow · paid out to customers"
              />
              <MetricTile
                label="Customer wallet liability"
                value={formatMoney(s.customerWalletLiability)}
                hint={`Balance ${rangeLabel} · owed to customers`}
              />
              <MetricTile
                label="Driver unsettled cash"
                value={formatMoney(s.driverCashOutstanding)}
                hint={`Balance ${rangeLabel} · held by drivers`}
              />
            </div>
            <MetricTile
              className="sm:max-w-sm"
              label="Company revenue (net)"
              value={formatMoney(s.companyRevenue)}
              hint="Flow · signed net of every company-finance row incl. adjustments"
            />
            {summary.isError && (
              <p role="alert" className="text-xs text-warning-700">
                Showing the last loaded summary — the latest refresh failed.
              </p>
            )}
          </>
        ) : null}
      </section>

      {/* transaction feed */}
      <section aria-labelledby="activity-heading" className="space-y-3">
        <h2 id="activity-heading" className="text-sm font-semibold text-ink">
          Financial activity
        </h2>

        <Card flush className="space-y-3 p-4 sm:p-5">
          <div role="search" className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-52">
              Ledger
              <select
                className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
                value={state.ledger}
                onChange={(e) =>
                  setLedger(e.target.value as FinanceListState['ledger'])
                }
              >
                <option value="">All ledgers</option>
                {LEDGERS.map((l) => (
                  <option key={l} value={l}>
                    {LEDGER_LABEL[l]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-52">
              Type
              <select
                className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
                value={state.type}
                onChange={(e) => setType(e.target.value)}
              >
                <option value="">All types</option>
                {typeOptions.map((t) => (
                  <option key={t} value={t}>
                    {ledgerTypeLabel(t)}
                  </option>
                ))}
              </select>
            </label>
            {filtersActive && (
              <button
                type="button"
                onClick={clearFilters}
                className="self-end pb-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
              >
                Clear filters
              </button>
            )}
          </div>
        </Card>

        {txns.isLoading ? (
          <Card flush>
            <LoadingState className="py-16" />
          </Card>
        ) : txns.isError ? (
          <Card flush>
            <ErrorState
              className="py-16"
              message={getApiErrorMessage(txns.error as UnknownApiError)}
              onRetry={() => void txns.refetch()}
            />
          </Card>
        ) : rows.length === 0 ? (
          <Card flush>
            <EmptyState
              className="py-16"
              title={
                filtersActive
                  ? 'No transactions match these filters.'
                  : 'No financial transactions yet.'
              }
              description={
                filtersActive
                  ? 'Try a different ledger, type or date range.'
                  : 'Wallet credits, collections, payouts, settlements, revenue and corrections appear here.'
              }
              action={
                filtersActive ? (
                  <Button variant="secondary" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          </Card>
        ) : isDesktop ? (
          <Card flush>
            <DataTable
              columns={columns}
              rows={rows}
              getRowId={(t) => t.id}
              caption="Financial transactions"
            />
          </Card>
        ) : (
          <ul className="space-y-2">
            {rows.map((t) => (
              <li key={t.id}>
                <MobileFinanceTransactionCard
                  tx={t}
                  actions={renderRowActions(t)}
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
            Showing {rows.length} of {meta.total} financial transactions.
          </p>
        )}
      </section>

      {/* dialogs */}
      {canAdjustFinance && (
        <LedgerAdjustDialog
          open={companyAdjustOpen}
          ledger="COMPANY_FINANCE"
          entityLabel="Company finance"
          currentBalance={null}
          submitting={adjustCompanyState.isLoading}
          onRefetch={refetchAll}
          onClose={() => setCompanyAdjustOpen(false)}
          onSubmit={(body) => adjustCompany(body).unwrap()}
        />
      )}

      {reverseTarget && (
        <LedgerReverseDialog
          open
          submitting={reverseSubmitting}
          onRefetch={refetchAll}
          onClose={() => setReverseTarget(null)}
          onSubmit={runReverse}
          original={{
            ledgerLabel: LEDGER_LABEL[reverseTarget.ledger],
            typeLabel: ledgerTypeLabel(reverseTarget.type),
            amount: reverseTarget.amount,
            direction: reverseTarget.direction,
            date: reverseTarget.createdAt,
            reference:
              reverseTarget.order?.orderNumber ??
              reverseTarget.payout?.payoutNumber ??
              reverseTarget.settlement?.settlementNumber ??
              null,
            effectNote:
              reverseTarget.ledger === 'WALLET' && reverseTarget.payout
                ? 'The payout’s status becomes REVERSED and the wallet balance is restored. Driver cash and company revenue are unaffected.'
                : reverseTarget.ledger === 'WALLET'
                  ? 'The customer’s available wallet balance is restored. Driver cash and company revenue are unaffected.'
                  : reverseTarget.ledger === 'DRIVER_CASH' &&
                      reverseTarget.settlement
                    ? 'Driver cash is restored. The settlement’s historical record is preserved. Customer wallet and company revenue are unaffected.'
                    : reverseTarget.ledger === 'DRIVER_CASH'
                      ? 'Only driver cash changes. Customer wallet, company revenue and the order are unaffected.'
                      : 'Only company finance changes. Any linked order stays DELIVERED / FINALIZED. Customer wallet and driver cash are unaffected.',
          }}
        />
      )}
    </div>
  );
}
