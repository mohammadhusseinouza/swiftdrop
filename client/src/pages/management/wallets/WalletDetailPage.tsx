import { useMemo } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { paths } from '../../../routes/paths';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetWalletQuery,
  useGetWalletTransactionsQuery,
  type ListWalletTransactionsParams,
} from '../../../services/walletsApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import {
  DataTable,
} from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { formatMoney, isZeroMoney } from '../../../lib/format';

import { buildWalletTransactionColumns } from './walletTransactionColumns';

const PAGE_SIZE = 20;

type TxType = NonNullable<ListWalletTransactionsParams['type']>;
const TX_TYPES: TxType[] = ['ORDER_CREDIT', 'PAYOUT', 'ADJUSTMENT', 'REVERSAL'];
const TX_TYPE_LABEL: Record<TxType, string> = {
  ORDER_CREDIT: 'Order Credit',
  PAYOUT: 'Payout',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
};

export default function WalletDetailPage() {
  const { customerId } = useParams<{ customerId: string }>();
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();

  const canViewOrders = useHasPermission(PERMISSIONS.ORDERS_READ);
  const canViewCustomer = useHasPermission(PERMISSIONS.CUSTOMERS_READ);
  const canProcessPayout = useHasPermission(PERMISSIONS.PAYOUTS_CREATE);

  const query = useGetWalletQuery(customerId ?? '', { skip: !customerId });
  const wallet = query.data;

  /* ---- transaction ledger URL state ---- */
  const rawType = sp.get('type');
  const activeType: TxType | undefined =
    rawType && (TX_TYPES as string[]).includes(rawType)
      ? (rawType as TxType)
      : undefined;
  const pageRaw = Number(sp.get('transactionsPage'));
  const txPage = Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1;

  const setType = (type: TxType | '') => {
    const next = new URLSearchParams(sp);
    if (type) next.set('type', type);
    else next.delete('type');
    next.delete('transactionsPage');
    setSp(next);
  };
  const setTxPage = (page: number) => {
    const next = new URLSearchParams(sp);
    if (page > 1) next.set('transactionsPage', String(page));
    else next.delete('transactionsPage');
    setSp(next, { replace: true });
  };

  const txns = useGetWalletTransactionsQuery(
    {
      customerId: customerId ?? '',
      params: { page: txPage, limit: PAGE_SIZE, type: activeType },
    },
    { skip: !customerId },
  );
  const txRows = txns.data?.items ?? [];
  const txMeta = txns.data?.meta;

  const columns = useMemo(
    () => buildWalletTransactionColumns({ canViewOrders }),
    [canViewOrders],
  );

  /* ------------------------------ error states --------------------------- */

  if (!customerId || query.isError || (query.isSuccess && !wallet)) {
    const status = getApiErrorStatus(query.error);
    const code = getApiErrorCode(query.error);
    const notFound = !customerId || status === 404 || code === 'NOT_FOUND';
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Wallet not found' : 'Could not load this wallet'}
          message={
            notFound
              ? 'This customer does not exist or the reference is not valid.'
              : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
          action={
            <Link
              to={paths.management.wallets}
              className="inline-flex h-8 items-center rounded-control border border-line bg-card px-3 text-xs font-medium text-ink-secondary hover:bg-sunken"
            >
              Back to Customer Wallets
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isLoading || !wallet) {
    return (
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Wallet" size="lg" />
        <LoadingState className="py-16" label="Loading wallet…" />
      </div>
    );
  }

  /* -------------------------------- ready -------------------------------- */

  const { customer } = wallet;
  const zeroAvailable = isZeroMoney(wallet.wallet.availableBalance);

  const payoutEntry = canProcessPayout ? (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        disabled={zeroAvailable}
        onClick={() =>
          navigate(`${paths.management.payouts}?customerId=${customer.id}`)
        }
      >
        Process payout
      </Button>
      {zeroAvailable && (
        <span className="text-xs text-ink-muted">
          No available balance to pay out.
        </span>
      )}
    </div>
  ) : undefined;

  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      {canViewCustomer && (
        <Link
          to={paths.management.customerDetail(customer.id)}
          className="inline-flex h-9 items-center rounded-control border border-line bg-card px-3 text-sm font-medium text-ink-secondary hover:bg-sunken"
        >
          View customer
        </Link>
      )}
      {payoutEntry}
    </div>
  );

  return (
    <div className="space-y-5 pb-6">
      <BackLink />

      <PageHeader
        size="lg"
        title={`${customer.name} · Wallet`}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ink-muted">
            <span>{customer.customerNumber}</span>
            <span className="text-ink-subtle" aria-hidden="true">
              ·
            </span>
            <span>{customer.primaryPhone}</span>
            {customer.email && (
              <>
                <span className="text-ink-subtle" aria-hidden="true">
                  ·
                </span>
                <span>{customer.email}</span>
              </>
            )}
          </span>
        }
        actions={headerActions}
      />

      {!customer.isActive && (
        <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-ink-secondary">
          This customer is inactive. Wallet history remains fully readable.
        </div>
      )}

      {/* summary cards */}
      <div className="grid gap-3 sm:grid-cols-2">
        <StatisticCard
          label="Available balance"
          value={
            <span className="tabular-nums">
              {formatMoney(wallet.wallet.availableBalance)}
            </span>
          }
          supportingText="Finalized money the company owes this customer — withdrawable via payout."
        />
        <Card className="flex flex-col justify-between gap-2 bg-sunken/40">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
              Pending amount
            </p>
            <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink-secondary tabular-nums">
              {formatMoney(wallet.wallet.pendingAmount)}
            </p>
          </div>
          <p className="text-xs text-ink-muted">
            Potential money from active delivery-only orders (order value only,
            excludes delivery fee). Server-derived, <strong>not</strong>{' '}
            withdrawable until an order is delivered and finalized.
          </p>
        </Card>
      </div>

      {/* ledger */}
      <section aria-labelledby="ledger-heading" className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="ledger-heading" className="text-sm font-semibold text-ink">
            Wallet transactions
          </h2>
          <label className="flex items-center gap-2 text-xs font-medium text-ink-muted">
            Type
            <select
              className="h-9 rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={activeType ?? ''}
              onChange={(e) => setType(e.target.value as TxType | '')}
            >
              <option value="">All types</option>
              {TX_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TX_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {txns.isLoading ? (
          <Card flush>
            <LoadingState className="py-12" />
          </Card>
        ) : txns.isError ? (
          <Card flush>
            <ErrorState
              className="py-12"
              message={getApiErrorMessage(txns.error as UnknownApiError)}
              onRetry={() => void txns.refetch()}
            />
          </Card>
        ) : txRows.length === 0 ? (
          <Card flush>
            <EmptyState
              className="py-12"
              title={
                activeType
                  ? 'No transactions match this type.'
                  : 'No wallet transactions yet.'
              }
              description={
                activeType
                  ? 'Try a different transaction type.'
                  : 'Order credits, payouts, adjustments and reversals will appear here.'
              }
            />
          </Card>
        ) : (
          <>
            <Card flush>
              <DataTable
                columns={columns}
                rows={txRows}
                getRowId={(t) => t.id}
                caption="Wallet transactions"
              />
            </Card>
            {txMeta && txMeta.totalPages > 1 && (
              <Pagination
                page={txPage}
                totalPages={txMeta.totalPages}
                total={txMeta.total}
                onPageChange={setTxPage}
              />
            )}
          </>
        )}

        <p className="text-xs text-ink-muted">
          Append-only ledger. A correction posts a new adjustment or reversal
          transaction — existing rows are never edited or removed.
        </p>
      </section>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.management.wallets}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to Customer Wallets
    </Link>
  );
}
