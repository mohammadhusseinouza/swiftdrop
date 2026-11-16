import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Check, ChevronRight, Truck, type LucideIcon } from 'lucide-react';

import { useGetCustomerDashboardQuery } from '../../services/customerDashboardApi';
import { useGetCustomerOrdersQuery } from '../../services/customerOrdersApi';
import { useGetCustomerWalletTransactionsQuery } from '../../services/customerWalletApi';
import { useGetCustomerPayoutsQuery } from '../../services/customerPayoutsApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';
import type {
  CustomerDashboardSummary,
  CustomerOrderSummary,
  CustomerWalletTransactionSummary,
} from '../../services/domain.types';
import { formatDate, formatMoney } from '../../lib/format';
import { paths } from '../../routes/paths';

import { cn } from '../../components/ui/cn';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { EmptyState } from '../../components/feedback/EmptyState';
import { CustomerPageHeader } from '../../components/customer/CustomerPageHeader';
import { CustomerHero } from '../../components/customer/CustomerHero';
import { BalanceHeroCard, HeroMoney } from '../../components/customer/BalanceHeroCard';
import { HeroStatTile } from '../../components/customer/HeroStatTile';
import { StageProgress } from '../../components/customer/StageProgress';
import { ReviewNotice } from '../../components/customer/ReviewNotice';
import { DetailPanel } from '../../components/customer/DetailPanel';
import {
  getDirectionPresentation,
  getWalletTransactionTypeLabel,
} from '../../components/customer/customerWalletPresentation';
import {
  formatOverviewDate,
  getLastPayoutPresentation,
  getOverviewTitleParts,
  isReadyForPayout,
} from '../../components/customer/customerOverviewPresentation';

/**
 * /customer/dashboard — Overview (Customer Portal Redesign Step 2, handoff §3.1).
 *
 * READ-ONLY. Four self-scoped queries, each with its own loading / error
 * (retry) / empty state, so a failure in orders, wallet activity or payouts
 * never hides the balance:
 *   - GET /customer/me/dashboard                 balance, pending, counts
 *   - GET /customer/me/orders?view=active&limit=4  "Orders in motion"
 *   - GET /customer/me/wallet/transactions?limit=5 "Wallet activity"
 *   - GET /customer/me/payouts?limit=1             "Latest payout" (D3-A)
 *
 * Every figure is a server value shown through formatMoney — no client money
 * arithmetic. Deliberately absent: any Withdraw / Request Payout control,
 * driver identity, ETAs, and any financial-review amount (under-review is a
 * COUNT only).
 *
 * Brand look (docs/brand-theme/brand-theme-handoff.md §4.1): the greeting, the
 * red Available balance tile and the translucent key-figure tiles live in the
 * charcoal hero band; the link cards, the under-review notice and the two
 * panels overlap it. While the dashboard query loads or fails, the hero shows
 * only the header and the body shows the existing loading / error panel.
 */
const ORDERS_PARAMS = { view: 'active', page: 1, limit: 4 } as const;
const TRANSACTIONS_PARAMS = { page: 1, limit: 5 } as const;
const PAYOUTS_PARAMS = { page: 1, limit: 1 } as const;

const PANEL = 'rounded-2xl border border-sd-line bg-card shadow-sd-card';
const TILE_LABEL = 'font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.12em]';
const TILE_VALUE =
  'mt-3 font-sd-display text-[1.75rem] leading-none font-bold tabular-nums text-white [overflow-wrap:anywhere]';

export default function CustomerDashboardPage() {
  const dashboard = useGetCustomerDashboardQuery();
  const now = useMemo(() => new Date(), []);
  const data = dashboard.data;
  const heading = getOverviewTitleParts(data?.customer.name, now);

  return (
    <div className="flex flex-col gap-6">
      <CustomerHero speedLines>
        <CustomerPageHeader
          tone="dark"
          eyebrow={formatOverviewDate(now)}
          title={heading.title}
          highlight={heading.highlight ?? undefined}
          lead="Here is where your orders and your money stand today."
          action={
            <Link
              to={paths.customer.orders}
              className="sd-press inline-flex h-11 items-center gap-2 rounded-[9px] bg-white px-5 text-sm font-semibold text-sd-ink hover:bg-[#EFF1F3]"
            >
              View all orders
              <ArrowRight className="size-4" aria-hidden="true" />
            </Link>
          }
        />
        {data && <KeyFigures data={data} />}
      </CustomerHero>

      {dashboard.isLoading ? (
        <div className={PANEL}>
          <LoadingState className="py-16" label="Loading your balance…" />
        </div>
      ) : dashboard.isError || !data ? (
        <div className={PANEL}>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(dashboard.error as UnknownApiError)}
            onRetry={() => void dashboard.refetch()}
          />
        </div>
      ) : (
        <div className="sd-stagger grid grid-cols-[repeat(auto-fit,minmax(min(100%,260px),1fr))] gap-5">
          <StatLinkCard
            to={`${paths.customer.orders}?view=active`}
            icon={Truck}
            iconClass="bg-sd-red-50 text-sd-red"
            label="Active orders"
            value={data.activeOrders}
            hint="Still on their way"
          />
          <StatLinkCard
            to={`${paths.customer.orders}?view=delivered`}
            icon={Check}
            iconClass="bg-success-50 text-success-700"
            label="Delivered orders"
            value={data.deliveredOrders}
            hint="Delivered to the receiver"
          />
          {data.underReviewOrderCount > 0 && (
            <ReviewNotice className="self-start">
              {data.underReviewOrderCount} delivered{' '}
              {data.underReviewOrderCount === 1 ? 'order is' : 'orders are'} being reviewed because the amount
              collected differed from the expected amount.{' '}
              {data.underReviewOrderCount === 1 ? 'Its' : 'Their'} value is not included in your pending amount
              until the review is complete.
            </ReviewNotice>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-5">
        <OrdersInMotion />
        <WalletActivity />
      </div>
    </div>
  );
}

/* ------------------------------- Key figures ------------------------------ */

function KeyFigures({ data }: { data: CustomerDashboardSummary }) {
  return (
    <div className="sd-stagger grid grid-cols-[repeat(auto-fit,minmax(min(100%,210px),1fr))] gap-3">
      <BalanceHeroCard tone="red">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className={cn(TILE_LABEL, 'text-sd-red-on')}>Available balance</h2>
          {isReadyForPayout(data.availableWalletBalance) && (
            <span className="inline-flex h-6 items-center gap-1.5 rounded-[6px] bg-white/18 px-2 text-xs font-semibold text-white">
              <span className="size-1.5 rounded-full bg-white" aria-hidden="true" />
              Ready for payout
            </span>
          )}
        </div>
        <div className="mt-4 [overflow-wrap:anywhere]">
          <HeroMoney value={data.availableWalletBalance} tone="red" />
        </div>
        <p className="mt-3 text-[0.8125rem] text-sd-red-on">Paid out to you by Spring Delivery. No request needed.</p>
      </BalanceHeroCard>

      <HeroStatTile label="Pending delivery">
        <p className={TILE_VALUE}>{formatMoney(data.pendingDeliveryAmount, { fallback: '$0.00' })}</p>
      </HeroStatTile>
      <HeroStatTile label="Pending settlement">
        <p className={TILE_VALUE}>{formatMoney(data.pendingSettlementAmount, { fallback: '$0.00' })}</p>
      </HeroStatTile>
      <LatestPayoutTile />
    </div>
  );
}

/**
 * "Latest payout" (D3-A): the newest payout record from page 1, with its own
 * loading / error state. Hidden when the customer has no payout. A
 * non-Completed newest payout shows its status word (getLastPayoutPresentation).
 */
function LatestPayoutTile() {
  const payouts = useGetCustomerPayoutsQuery(PAYOUTS_PARAMS);
  const lastPayout = getLastPayoutPresentation(payouts.data?.items[0]);
  if (!payouts.isLoading && !payouts.isError && lastPayout === null) return null;

  return (
    <HeroStatTile label="Latest payout">
      {payouts.isLoading ? (
        <p className="mt-3 text-sm text-sd-on-dark">Loading…</p>
      ) : payouts.isError ? (
        <p className="mt-3 flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
          <span className="text-sd-on-dark">Unavailable</span>
          <button
            type="button"
            onClick={() => void payouts.refetch()}
            className="font-semibold text-white underline underline-offset-2"
          >
            Try again
          </button>
        </p>
      ) : (
        <>
          <p className={TILE_VALUE}>{lastPayout?.amount}</p>
          <p className="mt-2 truncate text-xs text-sd-on-dark">{lastPayout?.detail}</p>
        </>
      )}
    </HeroStatTile>
  );
}

/* ------------------------------- Stat cards ------------------------------- */

function StatLinkCard({
  to,
  icon: Icon,
  iconClass,
  label,
  value,
  hint,
}: {
  to: string;
  icon: LucideIcon;
  iconClass: string;
  label: string;
  value: number;
  hint: string;
}) {
  return (
    <Link to={to} className={cn(PANEL, 'sd-lift group flex flex-col justify-between gap-5 p-6')}>
      <div className="flex items-center justify-between gap-3">
        <span className={cn('flex size-10 items-center justify-center rounded-[10px]', iconClass)} aria-hidden="true">
          <Icon className="size-[18px]" strokeWidth={2} />
        </span>
        <ChevronRight
          className="size-4 text-sd-text-muted transition-transform group-hover:translate-x-0.5 motion-reduce:transition-none"
          aria-hidden="true"
        />
      </div>
      <div>
        <p className="font-sd-display text-[2.75rem] leading-none font-bold tabular-nums text-sd-ink">{value}</p>
        <p className="mt-2 text-sm font-semibold text-sd-ink">{label}</p>
        <p className="text-[0.8125rem] text-sd-text-muted">{hint}</p>
      </div>
    </Link>
  );
}

/* ---------------------------- Orders in motion ---------------------------- */

function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link
      to={to}
      className="sd-press inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-sd-red-text hover:text-sd-red-hover"
    >
      {children}
      <ChevronRight className="size-4" aria-hidden="true" />
    </Link>
  );
}

function OrdersInMotion() {
  const orders = useGetCustomerOrdersQuery(ORDERS_PARAMS);
  const items = orders.data?.items ?? [];

  return (
    <DetailPanel
      title="Orders in motion"
      titleStyle="title"
      tone="brand"
      action={<PanelLink to={`${paths.customer.orders}?view=active`}>View all</PanelLink>}
      className="flex-[3_1_580px]"
    >
      {orders.isLoading ? (
        <LoadingState className="py-10" label="Loading active orders…" />
      ) : orders.isError ? (
        <ErrorState
          className="py-10"
          message={getApiErrorMessage(orders.error as UnknownApiError)}
          onRetry={() => void orders.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState className="py-10" title="No active orders." />
      ) : (
        <ul className="sd-stagger -my-1 divide-y divide-sd-line-subtle">
          {items.map((order) => (
            <OrderRow key={order.id} order={order} />
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}

function OrderRow({ order }: { order: CustomerOrderSummary }) {
  return (
    <li>
      <Link
        to={paths.customer.orderDetail(order.id)}
        className="sd-row -mx-3 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-[10px] px-3 py-4"
      >
        <div className="min-w-0 flex-[1_1_180px]">
          <p className="truncate text-[0.9375rem] font-bold text-sd-ink">{order.receiverName}</p>
          <p className="truncate text-[0.8125rem] text-sd-text-muted">
            {order.orderNumber}
            {order.receiverArea ? ` · ${order.receiverArea}` : ''}
          </p>
        </div>
        <StageProgress status={order.status} tone="brand" className="flex-[2_1_220px]" />
        <div className="shrink-0 text-right">
          <p className="font-sd-display text-base font-bold tabular-nums text-sd-ink">
            {formatMoney(order.amountToCollect)}
          </p>
          <p className="text-xs text-sd-text-muted">to collect</p>
        </div>
      </Link>
    </li>
  );
}

/* ----------------------------- Wallet activity ---------------------------- */

function WalletActivity() {
  const transactions = useGetCustomerWalletTransactionsQuery(TRANSACTIONS_PARAMS);
  const items = transactions.data?.items ?? [];

  return (
    <DetailPanel
      title="Wallet activity"
      titleStyle="title"
      tone="brand"
      action={<PanelLink to={paths.customer.wallet}>Open wallet</PanelLink>}
      className="flex-[2_1_340px]"
    >
      {transactions.isLoading ? (
        <LoadingState className="py-10" label="Loading wallet activity…" />
      ) : transactions.isError ? (
        <ErrorState
          className="py-10"
          message={getApiErrorMessage(transactions.error as UnknownApiError)}
          onRetry={() => void transactions.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState className="py-10" title="No wallet transactions yet." />
      ) : (
        <ul className="sd-stagger -my-1 divide-y divide-sd-line-subtle">
          {items.map((tx) => (
            <TransactionRow key={tx.id} tx={tx} />
          ))}
        </ul>
      )}
    </DetailPanel>
  );
}

function TransactionRow({ tx }: { tx: CustomerWalletTransactionSummary }) {
  const dir = getDirectionPresentation(tx.direction);
  const Icon = tx.direction === 'CREDIT' ? ArrowDownLeft : tx.direction === 'DEBIT' ? ArrowUpRight : null;
  const tileClass =
    tx.direction === 'CREDIT'
      ? 'bg-success-50 text-success-700'
      : tx.direction === 'DEBIT'
        ? 'bg-[#EEF0F2] text-sd-steel'
        : 'bg-sd-line-subtle text-sd-text-2';
  // Debits are normal payouts — shown in ink, not red (handoff §3.1); the
  // direction word carries the meaning either way.
  const amountClass = tx.direction === 'CREDIT' ? 'text-success-700' : 'text-sd-ink';
  const meta = [tx.reference?.label, formatDate(tx.occurredAt)].filter(Boolean).join(' · ');

  return (
    <li className="sd-row -mx-3 flex items-center gap-3 rounded-[10px] px-3 py-3.5">
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-[10px]', tileClass)} aria-hidden="true">
        {Icon ? <Icon className="size-4" strokeWidth={2} /> : <span className="size-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-sd-ink">{getWalletTransactionTypeLabel(tx.type)}</p>
        <p className="truncate text-xs text-sd-text-muted">{meta}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('font-sd-display text-[0.9375rem] font-bold tabular-nums', amountClass)}>
          {dir.sign}
          {formatMoney(tx.amount)}
        </p>
        {dir.word && <p className="text-xs text-sd-text-muted">{dir.word}</p>}
      </div>
    </li>
  );
}
