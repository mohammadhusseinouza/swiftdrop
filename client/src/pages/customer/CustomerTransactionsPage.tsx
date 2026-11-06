import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Receipt } from 'lucide-react';

import { useGetCustomerWalletTransactionsQuery } from '../../services/customerWalletApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatDateTime, formatMoney } from '../../lib/format';
import type {
  CustomerWalletTransactionFilter,
  CustomerWalletTransactionSummary,
} from '../../services/domain.types';

import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../components/ui/cn';
import { CustomerPageHeader } from '../../components/customer/CustomerPageHeader';
import { FilterChips } from '../../components/customer/FilterChips';
import { CustomerPagination } from '../../components/customer/CustomerPagination';
import { getTransactionRowView } from '../../components/customer/customerWalletPresentation';

const FILTERS: ReadonlyArray<{ value: CustomerWalletTransactionFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'order_credit', label: 'Order credits' },
  { value: 'payout', label: 'Payouts' },
  { value: 'adjustment', label: 'Adjustments' },
  { value: 'reversal', label: 'Reversals' },
];
const FILTER_IDS = new Set<string>(FILTERS.map((f) => f.value));

function parseType(sp: URLSearchParams): CustomerWalletTransactionFilter {
  const raw = sp.get('type');
  return raw && FILTER_IDS.has(raw) ? (raw as CustomerWalletTransactionFilter) : 'all';
}
function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * /customer/transactions — Transactions (Customer Portal Redesign Step 5,
 * handoff §3.4, D1-A standalone page).
 *
 * READ-ONLY view of the authenticated Customer's own append-only wallet
 * ledger (GET /customer/me/wallet/transactions). `type` + `page` live in the
 * URL exactly as before (All drops `type`; changing the filter resets `page`).
 * Direction is given in text (Added / Deducted); debits are ink, not red.
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
    <div className="flex flex-col gap-7">
      <CustomerPageHeader
        eyebrow="Wallet"
        title="Transactions"
        lead="Every change to your wallet balance, newest first."
      />

      <section aria-label="Wallet transactions" className="flex flex-col gap-5 rounded-panel border border-line bg-card p-5 sm:p-8">
        <FilterChips label="Transaction type" options={FILTERS} value={type} onChange={selectType} />

        {query.isLoading ? (
          <LoadingState className="py-16" label="Loading transactions…" />
        ) : query.isError ? (
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        ) : rows.length === 0 ? (
          <EmptyState
            className="py-16"
            icon={<Receipt />}
            title={type === 'all' ? 'No wallet transactions yet.' : 'No transactions of this type.'}
            description={
              type === 'all'
                ? 'Credits from delivered orders, payouts, and adjustments will appear here.'
                : 'Try the "All" filter.'
            }
          />
        ) : (
          <>
            {/* Phone (below sm): stacked rows — no scrolling table (handoff §3.4). */}
            <ul className="divide-y divide-line-subtle sm:hidden">
              {rows.map((tx) => (
                <TransactionStackedRow key={tx.id} tx={tx} />
              ))}
            </ul>

            {/* sm and up: the table. */}
            <div className="hidden overflow-x-auto rounded-[14px] border border-line-subtle sm:block">
              <table className="w-full min-w-[640px] table-fixed border-collapse text-left text-sm">
                <colgroup>
                  <col className="w-[120px]" />
                  <col />
                  <col className="w-[150px]" />
                  <col className="w-[150px]" />
                </colgroup>
                <thead className="bg-sunken">
                  <tr className="text-xs font-bold uppercase tracking-[0.08em] text-ink-muted">
                    <Th>Date</Th>
                    <Th>Description</Th>
                    <Th>Type</Th>
                    <Th className="text-right">Amount</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {rows.map((tx) => (
                    <TransactionRow key={tx.id} tx={tx} />
                  ))}
                </tbody>
              </table>
            </div>

            {meta && meta.totalPages > 1 && (
              <CustomerPagination
                page={meta.page}
                totalPages={meta.totalPages}
                total={meta.total}
                noun={meta.total === 1 ? 'transaction' : 'transactions'}
                onPageChange={setPage}
              />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Th({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <th scope="col" className={cn('px-4 py-3', className)}>
      {children}
    </th>
  );
}

function TransactionRow({ tx }: { tx: CustomerWalletTransactionSummary }) {
  const view = getTransactionRowView(tx, formatMoney);

  return (
    <tr className="align-top">
      <td className="px-4 py-3.5 text-[0.8125rem] text-ink-secondary">
        <time dateTime={tx.occurredAt}>{formatDateTime(tx.occurredAt)}</time>
      </td>
      <td className="px-4 py-3.5">
        <p className="font-semibold text-ink [overflow-wrap:anywhere]">{view.description}</p>
        <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{view.balanceAfter}</p>
      </td>
      <td className="px-4 py-3.5">
        <Badge tone={view.typeTone}>{view.typeLabel}</Badge>
      </td>
      <td className="px-4 py-3.5 text-right">
        <p className={cn('font-bold tabular-nums', view.amountClass)}>{view.amount}</p>
        {view.directionWord && <p className="text-xs text-ink-muted">{view.directionWord}</p>}
      </td>
    </tr>
  );
}

function TransactionStackedRow({ tx }: { tx: CustomerWalletTransactionSummary }) {
  const view = getTransactionRowView(tx, formatMoney);

  return (
    <li className="py-3.5 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink [overflow-wrap:anywhere]">{view.description}</p>
          <p className="mt-0.5 text-xs text-ink-muted tabular-nums">{view.balanceAfter}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className={cn('text-sm font-bold tabular-nums', view.amountClass)}>{view.amount}</p>
          {view.directionWord && <p className="text-xs text-ink-muted">{view.directionWord}</p>}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <time dateTime={tx.occurredAt}>{formatDateTime(tx.occurredAt)}</time>
        <Badge tone={view.typeTone}>{view.typeLabel}</Badge>
      </div>
    </li>
  );
}
