import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Wallet } from 'lucide-react';

import { useGetDriverCashQuery } from '../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatDateTime, formatMoney } from '../../lib/format';
import type { DriverCashTransactionEntry } from '../../services/domain.types';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Pagination } from '../../components/data-display/Pagination';
import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { cn } from '../../components/ui/cn';
import {
  cashDirection,
  cashSignPrefix,
  getCashTypePresentation,
} from '../../components/driver/driverCashPresentation';

const TYPE_TABS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'ALL', label: 'All' },
  { id: 'COLLECTION', label: 'Collections' },
  { id: 'SETTLEMENT', label: 'Settlements' },
  { id: 'ADJUSTMENT', label: 'Adjustments' },
  { id: 'REVERSAL', label: 'Reversals' },
];

const TYPE_IDS = new Set(TYPE_TABS.map((t) => t.id));

function parseType(sp: URLSearchParams): string {
  const raw = sp.get('type');
  return raw && TYPE_IDS.has(raw) && raw !== 'ALL' ? raw : 'ALL';
}
function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Phase 12.5 — /driver/cash ("My Cash"). READ-ONLY view of the authenticated
 * Driver's own cash account + ledger, straight from the existing
 * GET /api/v1/driver/me/cash contract (Phase 8.1) — no new endpoint.
 *
 * Shows ONLY: current cash held, and the append-only activity ledger with a
 * signed amount derived exactly from the balance movement. Deliberately NOT
 * shown (task §40/§46): any company-vs-customer ownership split of held cash,
 * and any settle / hand-over / adjust / reverse action — those are Finance /
 * Management operations.
 */
export default function DriverCashPage() {
  const [sp, setSp] = useSearchParams();
  const activeType = parseType(sp);
  const page = parsePage(sp);

  const params = useMemo(
    () => ({ page, type: activeType === 'ALL' ? undefined : activeType }),
    [page, activeType],
  );

  const query = useGetDriverCashQuery(params);
  const overview = query.data?.data;
  const meta = query.data?.meta;
  const transactions = overview?.transactions ?? [];

  const selectType = (id: string) => {
    const next = new URLSearchParams(sp);
    if (id === 'ALL') next.delete('type');
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
        title="My Cash"
        description="Money you have collected and not yet settled with the company."
      />

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading your cash…" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : (
        <>
          <Card className="bg-brand-50/60">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
              Current Cash Held
            </p>
            <p className="mt-1 text-3xl font-semibold tabular-nums text-ink">
              {formatMoney(overview?.account.currentBalance ?? '0', { fallback: '$0.00' })}
            </p>
            <p className="mt-2 text-sm text-ink-muted">
              Cash held is money you collected and have not yet settled with the
              company.
            </p>
          </Card>

          <div
            role="tablist"
            aria-label="Cash activity type"
            className="flex gap-1.5 overflow-x-auto pb-1"
          >
            {TYPE_TABS.map((tab) => {
              const active = tab.id === activeType;
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

          {transactions.length === 0 ? (
            <Card flush>
              <EmptyState
                className="py-16"
                icon={<Wallet />}
                title={
                  activeType === 'ALL'
                    ? 'No cash activity yet.'
                    : 'No activity of this type.'
                }
                description={
                  activeType === 'ALL'
                    ? 'Cash you collect on delivery, and settlements you hand over, will appear here.'
                    : 'Try the "All" tab.'
                }
              />
            </Card>
          ) : (
            <ul className="space-y-2.5">
              {transactions.map((tx) => (
                <li key={tx.id}>
                  <CashTransactionCard tx={tx} />
                </li>
              ))}
            </ul>
          )}

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

function CashTransactionCard({ tx }: { tx: DriverCashTransactionEntry }) {
  const { label, tone } = getCashTypePresentation(tx.type);
  const direction = cashDirection(tx.balanceBefore, tx.balanceAfter);
  const sign = cashSignPrefix(direction);
  // Sign + the words "in"/"out" carry the meaning — never colour alone (task §72).
  const directionWord =
    direction === 'CREDIT' ? 'in' : direction === 'DEBIT' ? 'out' : '';

  return (
    <div className="rounded-card border border-line bg-card p-3.5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <Badge tone={tone}>{label}</Badge>
          {tx.order && (
            <p className="mt-1.5 text-sm text-ink">Order {tx.order.orderNumber}</p>
          )}
          {tx.settlement && (
            <p className="mt-1.5 text-sm text-ink">
              Settlement {tx.settlement.settlementNumber}
            </p>
          )}
          <p className="mt-1 text-xs text-ink-subtle">{formatDateTime(tx.createdAt)}</p>
        </div>
        <div className="text-right">
          <p
            className={cn(
              'text-base font-semibold tabular-nums',
              direction === 'CREDIT'
                ? 'text-success-700'
                : direction === 'DEBIT'
                  ? 'text-danger-700'
                  : 'text-ink',
            )}
          >
            {sign}
            {formatMoney(tx.amount)}
            {directionWord && (
              <span className="ml-1 text-xs font-medium text-ink-subtle">
                ({directionWord})
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-ink-subtle tabular-nums">
            Balance {formatMoney(tx.balanceAfter)}
          </p>
        </div>
      </div>
    </div>
  );
}
