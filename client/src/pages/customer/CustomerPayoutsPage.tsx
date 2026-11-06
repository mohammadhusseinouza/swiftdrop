import { useMemo, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Banknote } from 'lucide-react';

import { useGetCustomerPayoutsQuery } from '../../services/customerPayoutsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import { formatDate, formatMoney } from '../../lib/format';
import type { CustomerPayoutSummary } from '../../services/domain.types';

import { LoadingState } from '../../components/feedback/LoadingState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { Badge } from '../../components/ui/Badge';
import { CustomerPageHeader } from '../../components/customer/CustomerPageHeader';
import { CustomerPagination } from '../../components/customer/CustomerPagination';
import {
  getPayoutStatusLabel,
  getPayoutStatusTone,
} from '../../components/customer/customerPayoutPresentation';

function parsePage(sp: URLSearchParams): number {
  const raw = Number(sp.get('page'));
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

/**
 * /customer/payouts — Payout History (Customer Portal Redesign Step 5,
 * handoff §3.4, D1-A standalone page).
 *
 * READ-ONLY self-scoped list from GET /customer/me/payouts (the
 * customer_payouts business record). Page state lives in the URL. Status
 * wording from getPayoutStatusLabel ("Completed", never "Paid"). No reference
 * field exists, so none is shown. Deliberately NO Request Payout / Withdraw /
 * Create Payout control — V1 payouts are made by company staff.
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
    <div className="flex flex-col gap-7">
      <CustomerPageHeader
        eyebrow="Wallet"
        title="Payouts"
        lead="Payouts Spring Delivery has made to you."
      />

      {query.isLoading ? (
        <StatePanel>
          <LoadingState className="py-16" label="Loading payouts…" />
        </StatePanel>
      ) : query.isError ? (
        <StatePanel>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </StatePanel>
      ) : rows.length === 0 ? (
        <StatePanel>
          <EmptyState
            className="py-16"
            icon={<Banknote />}
            title="No payouts yet."
            description="Payouts made to you by the company will appear here."
          />
        </StatePanel>
      ) : (
        <div className="flex flex-col gap-6">
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-5">
            {rows.map((payout) => (
              <li key={payout.id} className="min-w-0">
                <PayoutCard payout={payout} />
              </li>
            ))}
          </ul>
          {meta && meta.totalPages > 1 && (
            <CustomerPagination
              page={meta.page}
              totalPages={meta.totalPages}
              total={meta.total}
              noun={meta.total === 1 ? 'payout' : 'payouts'}
              onPageChange={setPage}
            />
          )}
        </div>
      )}
    </div>
  );
}

function StatePanel({ children }: { children: ReactNode }) {
  return <div className="rounded-panel border border-line bg-card">{children}</div>;
}

function PayoutCard({ payout }: { payout: CustomerPayoutSummary }) {
  return (
    <article
      aria-label={`Payout ${payout.payoutNumber}`}
      className="flex h-full flex-col gap-4 rounded-panel border border-line bg-card p-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 text-sm font-bold text-ink [overflow-wrap:anywhere]">{payout.payoutNumber}</p>
        <Badge tone={getPayoutStatusTone(payout.status)} dot>
          {getPayoutStatusLabel(payout.status)}
        </Badge>
      </div>
      <p className="text-[1.875rem] leading-none font-bold tracking-[-0.035em] tabular-nums text-ink">
        {formatMoney(payout.amount, { fallback: '$0.00' })}
      </p>
      <p className="mt-auto text-[0.8125rem] text-ink-muted">
        {formatDate(payout.createdAt)} · {payout.paymentMethod.name}
      </p>
    </article>
  );
}
