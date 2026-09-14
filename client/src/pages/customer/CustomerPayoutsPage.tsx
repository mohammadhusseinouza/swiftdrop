import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banknote } from 'lucide-react';

import { useGetCustomerPayoutsQuery } from '../../services/customerPayoutsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatDate, formatMoney } from '../../lib/format';
import type { CustomerPayoutSummary } from '../../services/domain.types';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Pagination } from '../../components/data-display/Pagination';
import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import {
  getPayoutStatusLabel,
  getPayoutStatusTone,
} from '../../components/customer/customerPayoutPresentation';

function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * Phase 13.6 — /customer/payouts ("Payout History").
 *
 * READ-ONLY self-scoped list from GET /api/v1/customer/me/payouts — the
 * customer_payouts business record (distinct from the wallet-debit ledger
 * row on /customer/transactions). Page state lives in the URL. No status
 * filter (every payout is Completed in V1). Deliberately NO Request Payout /
 * Withdraw / Create Payout control — V1 payouts are made by company staff.
 */
export default function CustomerPayoutsPage() {
  const [sp, setSp] = useSearchParams();
  const page = parsePage(sp);

  const params = useMemo(() => ({ page }), [page]);
  const query = useGetCustomerPayoutsQuery(params);
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

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
        title="Payouts"
        description="View payouts made to you by the company."
      />

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" label="Loading payouts…" />
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
            icon={<Banknote />}
            title="No payouts yet."
            description="Payouts made to you by the company will appear here."
          />
        </Card>
      ) : (
        <>
          <ul className="space-y-2.5">
            {rows.map((payout) => (
              <li key={payout.id}>
                <PayoutRow payout={payout} />
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

function PayoutRow({ payout }: { payout: CustomerPayoutSummary }) {
  return (
    <article className="rounded-card border border-line bg-card p-3.5 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="break-all font-medium text-ink">{payout.payoutNumber}</p>
          <p className="mt-1 text-sm text-ink-secondary">{payout.paymentMethod.name}</p>
          <p className="mt-1 text-xs text-ink-subtle">{formatDate(payout.createdAt)}</p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <p className="text-base font-semibold tabular-nums text-ink">
            {formatMoney(payout.amount, { fallback: '$0.00' })}
          </p>
          <Badge tone={getPayoutStatusTone(payout.status)}>
            {getPayoutStatusLabel(payout.status)}
          </Badge>
        </div>
      </div>
    </article>
  );
}
