import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt } from 'lucide-react';

import { useGetCustomerWalletTransactionsQuery } from '../../services/customerWalletApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatDateTime, formatMoney } from '../../lib/format';
import type {
  CustomerWalletTransactionFilter,
  CustomerWalletTransactionSummary,
} from '../../services/domain.types';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Pagination } from '../../components/data-display/Pagination';
import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../components/ui/cn';
import {
  getDirectionPresentation,
  getWalletTransactionTypeLabel,
  getWalletTransactionTypeTone,
} from '../../components/customer/customerWalletPresentation';

const TABS: ReadonlyArray<{ id: CustomerWalletTransactionFilter; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'order_credit', label: 'Order Credits' },
  { id: 'payout', label: 'Payouts' },
  { id: 'adjustment', label: 'Adjustments' },
  { id: 'reversal', label: 'Reversals' },
];
const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function parseType(sp: URLSearchParams): CustomerWalletTransactionFilter {
  const raw = sp.get('type');
  return raw && TAB_IDS.has(raw) ? (raw as CustomerWalletTransactionFilter) : 'all';
}
function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Phase 13.5 — /customer/transactions.
 *
 * READ-ONLY view of the authenticated Customer's own append-only wallet
 * ledger (GET /api/v1/customer/me/wallet/transactions). Filter + page state
 * live in the URL. No mutation controls, no Request Payout / Withdraw.
 */
export default function CustomerTransactionsPage() {
  const [sp, setSp] = useSearchParams();
  const type = parseType(sp);
  const page = parsePage(sp);

  const params = useMemo(() => ({ page, type }), [page, type]);
  const query = useGetCustomerWalletTransactionsQuery(params);
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const selectType = (id: CustomerWalletTransactionFilter) => {
    const next = new URLSearchParams(sp);
    if (id === 'all') next.delete('type');
    else next.set('type', id);
    next.delete('page');
    setSp(next);
  };
  const setPage = (next: number) => {
    const nextSp = new URLSearchParams(sp);
    if (next <= 1) nextSp.delete('page');
    else nextSp.set('page', String(next));
    setSp(nextSp);
  };

  return (
    <div className="space-y-4">
      <PageHeader
        size="lg"
        title="Transactions"
        description="Changes to your wallet balance."
      />

      <div
        role="tablist"
        aria-label="Transaction type"
        className="flex gap-1.5 overflow-x-auto pb-1"
      >
        {TABS.map((tab) => {
          const active = tab.id === type;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => selectType(tab.id)}
              className={cn(
                'inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[0.5rem] border px-3.5 text-sm transition-colors',
                active
                  ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                  : 'border-line bg-card font-medium text-ink-secondary hover:bg-sunken',
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading transactions…" />
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
            icon={<Receipt />}
            title={type === 'all' ? 'No wallet transactions yet.' : 'No transactions of this type.'}
            description={
              type === 'all'
                ? 'Credits from delivered orders, payouts, and adjustments will appear here.'
                : 'Try the "All" tab.'
            }
          />
        </Card>
      ) : (
        <>
          <ul className="space-y-2.5">
            {rows.map((tx) => (
              <li key={tx.id}>
                <TransactionRow tx={tx} />
              </li>
            ))}
          </ul>
          {meta && meta.totalPages > 1 && (
            <Pagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              onPageChange={setPage}
            />
          )}
        </>
      )}
    </div>
  );
}

function TransactionRow({ tx }: { tx: CustomerWalletTransactionSummary }) {
  const dir = getDirectionPresentation(tx.direction);
  const referenceNoun = tx.reference?.kind === 'ORDER' ? 'Order' : 'Payout';

  return (
    <article className="rounded-card border border-line bg-card p-3.5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Badge tone={getWalletTransactionTypeTone(tx.type)}>
            {getWalletTransactionTypeLabel(tx.type)}
          </Badge>
          {tx.reference && (
            <p className="mt-1.5 truncate text-sm text-ink">
              {referenceNoun} {tx.reference.label}
            </p>
          )}
          <p className="mt-1 text-xs text-ink-subtle">{formatDateTime(tx.occurredAt)}</p>
        </div>
        <div className="text-right">
          <p className={cn('text-base font-semibold tabular-nums', dir.amountClass)}>
            {dir.sign}
            {formatMoney(tx.amount)}
            {dir.word && (
              <span className="ml-1 text-xs font-medium text-ink-subtle">({dir.word})</span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-ink-subtle tabular-nums">
            Balance after {formatMoney(tx.balanceAfter)}
          </p>
        </div>
      </div>
    </article>
  );
}
