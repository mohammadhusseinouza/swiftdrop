import { Outlet, useLocation } from 'react-router-dom';

import { useGetCustomerWalletQuery } from '../../services/customerWalletApi';
import { useGetCustomerPayoutsQuery } from '../../services/customerPayoutsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type { CustomerWalletSummary } from '../../services/domain.types';
import { formatMoney } from '../../lib/format';
import { paths } from '../../routes/paths';
import { pendingBreakdown, type PendingBreakdown } from '../../components/finance/financialRelease';

import { cn } from '../../components/ui/cn';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { CustomerPageHeader } from '../../components/customer/CustomerPageHeader';
import { CustomerHero } from '../../components/customer/CustomerHero';
import { BalanceHeroCard, HeroMoney } from '../../components/customer/BalanceHeroCard';
import { HeroStatTile } from '../../components/customer/HeroStatTile';
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
 *
 * Brand look (docs/brand-theme/brand-theme-handoff.md §4.4): ONE hero for all
 * three tabs — the red Available balance card and the translucent Pending
 * card sit in the charcoal band. The body holds the under-review notice, the
 * history panel with the red-active tab bar, and "About these amounts".
 */
const PAYOUTS_PARAMS = { page: 1, limit: 1 } as const;
const PANEL = 'rounded-2xl border border-sd-line bg-card shadow-sd-card';
const TILE_LABEL = 'font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.12em]';

export default function CustomerWalletLayout() {
  const query = useGetCustomerWalletQuery();
  const data = query.data;
  const { pathname } = useLocation();
  const tab = getWalletHistoryTab(pathname);
  const reviewCount = data ? pendingBreakdown(data).underReviewOrderCount : 0;

  return (
    <div className="flex flex-col gap-6">
      <CustomerHero speedLines>
        <CustomerPageHeader
          tone="dark"
          eyebrow="Wallet"
          title="Your money,"
          highlight="clearly accounted."
          lead="What is available for payout now, what is still on its way, and every change to your balance."
        />
        {data && (
          <div className="sd-stagger grid grid-cols-[repeat(auto-fit,minmax(min(100%,320px),1fr))] gap-3">
            <AvailablePanel data={data} />
            <PendingPanel breakdown={pendingBreakdown(data)} />
          </div>
        )}
      </CustomerHero>

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
        reviewCount > 0 && (
          <ReviewNotice>
            {reviewCount} delivered {reviewCount === 1 ? 'order is' : 'orders are'} being reviewed because the amount
            collected differed from the expected amount. {reviewCount === 1 ? 'Its' : 'Their'} value is not included
            above until the review is complete.
          </ReviewNotice>
        )
      )}

      {/* History never depends on the wallet summary query — it loads on its own. */}
      <DetailPanel
        title={tab === 'payouts' ? 'Payout history' : 'Transaction history'}
        titleStyle="title"
        tone="brand"
        action={
          <SegmentedLinkTabs
            label="Wallet history"
            tone="brand"
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
    <BalanceHeroCard tone="red" className="flex flex-col">
      <h2 className={cn(TILE_LABEL, 'text-sd-red-on')}>Available balance</h2>
      <div className="mt-4 [overflow-wrap:anywhere]">
        <HeroMoney value={data.availableBalance} tone="red" />
      </div>
      <p className="mt-3 max-w-md text-[0.8125rem] text-sd-red-on">
        Money from your completed eligible Delivery Only orders. Spring Delivery arranges and sends your payouts —
        there is nothing you need to request.
      </p>

      <div className="mt-auto pt-5">
        {payouts.isLoading ? (
          <span className="text-xs text-sd-red-on">Loading latest payout…</span>
        ) : payouts.isError ? (
          <span className="inline-flex flex-wrap items-center gap-x-2 text-xs text-sd-red-on">
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
          <span className="inline-flex min-h-7 max-w-full items-center rounded-[6px] bg-white/18 px-3 py-1 text-xs font-semibold text-white">
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

  return (
    <HeroStatTile className="flex flex-col gap-5">
      <div>
        <h2 className={cn(TILE_LABEL, 'text-sd-on-dark')}>Pending · not yet withdrawable</h2>
        <p className="mt-4 font-sd-display text-[2.75rem] leading-none font-bold tabular-nums text-white [overflow-wrap:anywhere]">
          {formatMoney(breakdown.totalPending, { fallback: '$0.00' })}
        </p>
      </div>

      {/* Proportions are LAYOUT ONLY (getPendingBarWeights) — never shown as money. */}
      {weights && (
        <div className="sd-grow flex h-2.5 gap-1" aria-hidden="true">
          {weights.delivery > 0 && (
            <span className="rounded-[2px] bg-sd-steel-light" style={{ flexGrow: weights.delivery, flexBasis: 0 }} />
          )}
          {weights.settlement > 0 && (
            <span className="rounded-[2px] bg-sd-red-logo" style={{ flexGrow: weights.settlement, flexBasis: 0 }} />
          )}
        </div>
      )}

      {breakdown.hasBreakdown && (
        <ul className="divide-y divide-white/8">
          <LegendRow
            swatch="bg-sd-steel-light"
            label="Pending delivery"
            explanation="Your share of orders that are still on the way."
            value={breakdown.pendingDelivery}
          />
          <LegendRow
            swatch="bg-sd-red-logo"
            label="Pending settlement"
            explanation="Your share of delivered orders. It becomes available once the courier hands the collected cash to the company."
            value={breakdown.pendingSettlement}
          />
        </ul>
      )}
    </HeroStatTile>
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
      <span className={`mt-1.5 size-2.5 shrink-0 rounded-[2px] ${swatch}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-white">{label}</p>
        <p className="mt-0.5 text-[0.8125rem] text-sd-on-dark">{explanation}</p>
      </div>
      <p className="shrink-0 font-sd-display text-base font-bold tabular-nums text-white">{formatMoney(value)}</p>
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
    <DetailPanel title="About these amounts" tone="brand">
      <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-8 gap-y-5">
        {DEFINITIONS.map((d) => (
          <div key={d.term} className="min-w-0">
            <dt className="font-sd-display text-base font-bold text-sd-ink">{d.term}</dt>
            <dd className="mt-1 text-sm text-sd-text-muted">{d.text}</dd>
          </div>
        ))}
      </dl>
    </DetailPanel>
  );
}
