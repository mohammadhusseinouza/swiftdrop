import { Outlet, useLocation } from 'react-router-dom';

import { useGetCustomerWalletQuery } from '../../services/customerWalletApi';
import { useGetCustomerPayoutsQuery } from '../../services/customerPayoutsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { CustomerWalletSummary } from '../../services/domain.types';
import { formatMoney } from '../../lib/format';
import { paths } from '../../routes/paths';
import { pendingBreakdown, type PendingBreakdown } from '../../components/finance/financialRelease';

import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { CustomerPageHeader } from '../../components/customer/CustomerPageHeader';
import { BalanceHeroCard, HeroMoney } from '../../components/customer/BalanceHeroCard';
import { ReviewNotice } from '../../components/customer/ReviewNotice';
import { DetailPanel } from '../../components/customer/DetailPanel';
import { SegmentedLinkTabs } from '../../components/customer/SegmentedTabs';
import { getLatestPayoutChipText } from '../../components/customer/customerOverviewPresentation';
import { getPendingBarWeights, getWalletHistoryTab } from '../../components/customer/customerWalletPresentation';

/**
 * Wallet layout — /customer/wallet, /customer/transactions, /customer/payouts
 * (Customer Portal Redesign, handoff §3.4, decision D1-B).
 *
 * One Wallet page with a History panel whose Transactions / Payouts tabs are
 * route links. Routes are unchanged: /customer/wallet and
 * /customer/transactions show Transactions, /customer/payouts shows Payouts.
 * Because this is a layout route, the balance panels stay mounted (and their
 * queries cached) while switching tabs.
 *
 * READ-ONLY. GET /customer/me/wallet supplies the balance and the pending
 * breakdown (shown via pendingBreakdown(), never recomputed);
 * GET /customer/me/payouts?limit=1 supplies the "Latest payout" chip (D3-A),
 * which has its own loading / error state and never blocks the balance.
 * Deliberately NO Withdraw / Request Payout control; under-review orders are a
 * COUNT only; no driver cash or company revenue.
 */
const PAYOUTS_PARAMS = { page: 1, limit: 1 } as const;
const PANEL = 'rounded-panel border border-line bg-card';

export default function CustomerWalletLayout() {
  const query = useGetCustomerWalletQuery();
  const data = query.data;
  const { pathname } = useLocation();
  const tab = getWalletHistoryTab(pathname);

  return (
    <div className="flex flex-col gap-7">
      <CustomerPageHeader
        eyebrow="Wallet"
        title="Your money, clearly accounted."
        lead="What is available for payout now, what is still on its way, and every change to your balance."
      />

      {query.isLoading ? (
        <div className={PANEL}>
          <LoadingState className="py-16" label="Loading your wallet…" />
        </div>
      ) : query.isError || !data ? (
        <div className={PANEL}>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </div>
      ) : (
        <div className="flex flex-wrap gap-5">
          <AvailablePanel data={data} />
          <PendingPanel breakdown={pendingBreakdown(data)} />
        </div>
      )}

      {/* History never depends on the wallet summary query — it loads on its own. */}
      <DetailPanel
        title={tab === 'payouts' ? 'Payout history' : 'Transaction history'}
        titleStyle="title"
        action={
          <SegmentedLinkTabs
            label="Wallet history"
            items={[
              { to: paths.customer.transactions, label: 'Transactions', current: tab === 'transactions' },
              { to: paths.customer.payouts, label: 'Payouts', current: tab === 'payouts' },
            ]}
          />
        }
      >
        <Outlet />
      </DetailPanel>

      <AboutAmounts />
    </div>
  );
}

/* ---------------------------- Available balance --------------------------- */

function AvailablePanel({ data }: { data: CustomerWalletSummary }) {
  const payouts = useGetCustomerPayoutsQuery(PAYOUTS_PARAMS);
  const chip = getLatestPayoutChipText(payouts.data?.items[0]);

  return (
    <BalanceHeroCard className="flex min-w-0 flex-[1_1_420px] flex-col">
      <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-chrome-ink">Available balance</h2>
      <HeroMoney value={data.availableBalance} className="mt-5" />
      <p className="mt-4 max-w-md text-sm text-chrome-ink">
        Money from your completed eligible Delivery Only orders. Spring Delivery arranges and sends your payouts —
        there is nothing you need to request.
      </p>

      <div className="mt-auto pt-7">
        {payouts.isLoading ? (
          <span className="text-xs text-chrome-ink-soft">Loading latest payout…</span>
        ) : payouts.isError ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 text-xs text-chrome-ink">
            Latest payout unavailable.
            <button
              type="button"
              onClick={() => void payouts.refetch()}
              className="font-semibold text-white underline underline-offset-2"
            >
              Try again
            </button>
          </span>
        ) : chip ? (
          <span className="inline-flex min-h-7 max-w-full items-center rounded-full bg-white/10 px-3 py-1 text-xs font-semibold text-white">
            {chip}
          </span>
        ) : null}
      </div>
    </BalanceHeroCard>
  );
}

/* --------------------------------- Pending -------------------------------- */

function PendingPanel({ breakdown }: { breakdown: PendingBreakdown }) {
  const weights = getPendingBarWeights(breakdown);
  const reviewCount = breakdown.underReviewOrderCount;

  return (
    <section aria-label="Pending amount" className={`${PANEL} flex min-w-0 flex-[1_1_420px] flex-col gap-5 p-6 sm:p-8`}>
      <div>
        <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-ink-muted">Pending · not yet withdrawable</h2>
        <p className="mt-4 text-[2.75rem] leading-none font-bold tracking-[-0.04em] tabular-nums text-ink">
          {formatMoney(breakdown.totalPending, { fallback: '$0.00' })}
        </p>
      </div>

      {weights && (
        <div className="flex h-2.5 gap-1" aria-hidden="true">
          {weights.delivery > 0 && (
            <span className="rounded-full bg-ink" style={{ flexGrow: weights.delivery, flexBasis: 0 }} />
          )}
          {weights.settlement > 0 && (
            <span className="rounded-full bg-brand-600" style={{ flexGrow: weights.settlement, flexBasis: 0 }} />
          )}
        </div>
      )}

      {breakdown.hasBreakdown && (
        <ul className="divide-y divide-line-subtle">
          <LegendRow
            swatch="bg-ink"
            label="Pending delivery"
            explanation="Your share of orders that are still on the way."
            value={breakdown.pendingDelivery}
          />
          <LegendRow
            swatch="bg-brand-600"
            label="Pending settlement"
            explanation="Your share of delivered orders. It becomes available once the courier hands the collected cash to the company."
            value={breakdown.pendingSettlement}
          />
        </ul>
      )}

      {reviewCount > 0 && (
        <ReviewNotice compact>
          {reviewCount} delivered {reviewCount === 1 ? 'order is' : 'orders are'} being reviewed because the amount
          collected differed from the expected amount. {reviewCount === 1 ? 'Its' : 'Their'} value is not included
          above until the review is complete.
        </ReviewNotice>
      )}
    </section>
  );
}

function LegendRow({
  swatch,
  label,
  explanation,
  value,
}: {
  swatch: string;
  label: string;
  explanation: string;
  value: string | null;
}) {
  return (
    <li className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-full ${swatch}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-ink">{label}</p>
        <p className="mt-0.5 text-[0.8125rem] text-ink-muted">{explanation}</p>
      </div>
      <p className="shrink-0 text-sm font-bold tabular-nums text-ink">{formatMoney(value)}</p>
    </li>
  );
}

/* --------------------------- About these amounts -------------------------- */

const DEFINITIONS = [
  {
    term: 'Available Balance',
    text: 'Money from completed eligible Delivery Only orders that is currently available for the company to pay out to you.',
  },
  {
    term: 'Pending Delivery',
    text: 'Your share of Delivery Only orders that are still on the way. It moves on once the order is delivered.',
  },
  {
    term: 'Pending Settlement',
    text: 'Your share of orders that were already delivered. The courier collected the money but has not yet handed it to the company; it becomes available once they do.',
  },
  {
    term: 'Total Pending',
    text: 'Pending Delivery plus Pending Settlement. None of it can be paid out yet.',
  },
] as const;

function AboutAmounts() {
  return (
    <DetailPanel title="About these amounts">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-8 gap-y-5">
        {DEFINITIONS.map((d) => (
          <div key={d.term} className="min-w-0">
            <dt className="text-sm font-bold text-ink">{d.term}</dt>
            <dd className="mt-1 text-sm text-ink-muted">{d.text}</dd>
          </div>
        ))}
      </dl>
    </DetailPanel>
  );
}
