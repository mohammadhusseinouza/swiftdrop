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
import { BalanceHeroCard, HeroMoney } from '../../components/customer/BalanceHeroCard';
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
  getOverviewTitle,
  isReadyForPayout,
} from '../../components/customer/customerOverviewPresentation';

/**
 * /customer/dashboard — Overview (Customer Portal Redesign Step 2, handoff §3.1).
 *
 * READ-ONLY. Four self-scoped queries, each with its own loading / error
 * (retry) / empty state, so a failure in orders, wallet activity or payouts
 * never hides the balance panel:
 *   - GET /customer/me/dashboard                 balance, pending, counts
 *   - GET /customer/me/orders?view=active&limit=4  "Orders in motion"
 *   - GET /customer/me/wallet/transactions?limit=5 "Wallet activity"
 *   - GET /customer/me/payouts?limit=1             "Latest payout" (D3-A)
 *
 * Every figure is a server value shown through formatMoney — no client money
 * arithmetic. Deliberately absent: any Withdraw / Request Payout control,
 * driver identity, ETAs, and any financial-review amount (under-review is a
 * COUNT only).
 */
const ORDERS_PARAMS = { view: 'active', page: 1, limit: 4 } as const;
const TRANSACTIONS_PARAMS = { page: 1, limit: 5 } as const;
const PAYOUTS_PARAMS = { page: 1, limit: 1 } as const;

const PANEL = 'rounded-panel border border-line bg-card';

export default function CustomerDashboardPage() {
  const dashboard = useGetCustomerDashboardQuery();
  const now = useMemo(() => new Date(), []);
  const data = dashboard.data;

  return (
    <div className="flex flex-col gap-7">
      <CustomerPageHeader
        eyebrow={formatOverviewDate(now)}
        title={getOverviewTitle(data?.customer.name, now)}
        action={
          <Link
            to={paths.customer.orders}
            className="inline-flex h-11 items-center gap-2 rounded-control bg-ink px-5 text-sm font-semibold text-white transition-colors hover:bg-chrome"
          >
            View all orders
            <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        }
      />

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
        <>
          <div className="flex flex-wrap gap-5">
            <BalancePanel data={data} />
            <div className="flex min-w-0 flex-[1_1_300px] flex-col gap-5">
              <StatLinkCard
                to={`${paths.customer.orders}?view=active`}
                icon={Truck}
                iconClass="bg-brand-50 text-brand-600"
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
            </div>
          </div>

          {data.underReviewOrderCount > 0 && (
            <ReviewNotice>
              {data.underReviewOrderCount} delivered{' '}
              {data.underReviewOrderCount === 1 ? 'order is' : 'orders are'} being reviewed because the amount
              collected differed from the expected amount.{' '}
              {data.underReviewOrderCount === 1 ? 'Its' : 'Their'} value is not included in your pending amount
              until the review is complete.
            </ReviewNotice>
          )}
        </>
      )}

      <div className="flex flex-wrap gap-5">
        <OrdersInMotion />
        <WalletActivity />
      </div>
    </div>
  );
}

/* ------------------------------ Balance hero ------------------------------ */

function BalancePanel({ data }: { data: CustomerDashboardSummary }) {
  const payouts = useGetCustomerPayoutsQuery(PAYOUTS_PARAMS);
  const lastPayout = getLastPayoutPresentation(payouts.data?.items[0]);
  const showLastPayout = payouts.isLoading || payouts.isError || lastPayout !== null;

  return (
    <BalanceHeroCard className="min-w-0 flex-[2_1_560px]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-chrome-ink">Available balance</h2>
        {isReadyForPayout(data.availableWalletBalance) && (
          <span className="inline-flex h-7 items-center gap-2 rounded-full bg-white/10 px-3 text-xs font-semibold text-white">
            <span className="size-1.5 rounded-full bg-success-200" aria-hidden="true" />
            Ready for payout
          </span>
        )}
      </div>

      <HeroMoney value={data.availableWalletBalance} className="mt-5" />

      <p className="mt-4 max-w-md text-sm text-chrome-ink">
        Spring Delivery arranges and sends your payouts. There is nothing you need to request.
      </p>

      <dl className="mt-7 grid grid-cols-1 gap-x-6 gap-y-5 border-t border-white/10 pt-6 sm:grid-cols-3">
        <MiniStat label="Pending delivery" value={formatMoney(data.pendingDeliveryAmount, { fallback: '$0.00' })} />
        <MiniStat
          label="Pending settlement"
          value={formatMoney(data.pendingSettlementAmount, { fallback: '$0.00' })}
        />
        {showLastPayout && (
          <MiniStat
            label="Latest payout"
            value={
              payouts.isLoading ? (
                <span className="text-chrome-ink-soft">Loading…</span>
              ) : payouts.isError ? (
                <span className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium">
                  <span className="text-chrome-ink">Unavailable</span>
                  <button
                    type="button"
                    onClick={() => void payouts.refetch()}
                    className="font-semibold text-white underline underline-offset-2"
                  >
                    Try again
                  </button>
                </span>
              ) : (
                lastPayout?.amount
              )
            }
            detail={!payouts.isLoading && !payouts.isError ? lastPayout?.detail : undefined}
          />
        )}
      </dl>
    </BalanceHeroCard>
  );
}

function MiniStat({ label, value, detail }: { label: string; value: ReactNode; detail?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-chrome-ink-soft">{label}</dt>
      <dd className="mt-1.5 text-xl font-bold tracking-[-0.02em] tabular-nums text-white">{value}</dd>
      {detail && <dd className="mt-1 truncate text-xs text-chrome-ink">{detail}</dd>}
    </div>
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
    <Link
      to={to}
      className={cn(PANEL, 'group flex flex-1 flex-col justify-between gap-5 p-6 transition-colors hover:border-line-strong')}
    >
      <div className="flex items-center justify-between gap-3">
        <span className={cn('flex size-10 items-center justify-center rounded-xl', iconClass)} aria-hidden="true">
          <Icon className="size-[18px]" strokeWidth={2} />
        </span>
        <ChevronRight className="size-4 text-ink-muted transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
      </div>
      <div>
        <p className="text-[2.75rem] leading-none font-bold tracking-[-0.04em] tabular-nums text-ink">{value}</p>
        <p className="mt-2 text-sm font-semibold text-ink">{label}</p>
        <p className="text-[0.8125rem] text-ink-muted">{hint}</p>
      </div>
    </Link>
  );
}

/* ---------------------------- Orders in motion ---------------------------- */

function PanelLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="inline-flex shrink-0 items-center gap-1 text-sm font-semibold text-brand-600 hover:text-brand-700">
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
        <ul className="-my-1 divide-y divide-line-subtle">
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
        className="-mx-3 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-xl px-3 py-4 transition-colors hover:bg-sunken"
      >
        <div className="min-w-0 flex-[1_1_180px]">
          <p className="truncate text-[0.9375rem] font-bold text-ink">{order.receiverName}</p>
          <p className="truncate text-[0.8125rem] text-ink-muted">
            {order.orderNumber}
            {order.receiverArea ? ` · ${order.receiverArea}` : ''}
          </p>
        </div>
        <StageProgress status={order.status} className="flex-[2_1_220px]" />
        <div className="shrink-0 text-right">
          <p className="text-[0.9375rem] font-bold tabular-nums text-ink">{formatMoney(order.amountToCollect)}</p>
          <p className="text-xs text-ink-muted">to collect</p>
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
        <ul className="-my-1 divide-y divide-line-subtle">
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
        ? 'bg-brand-50 text-brand-600'
        : 'bg-canvas text-ink-secondary';
  // Debits are normal payouts — shown in ink, not red (handoff §3.1); the
  // direction word carries the meaning either way.
  const amountClass = tx.direction === 'CREDIT' ? 'text-success-700' : 'text-ink';
  const meta = [tx.reference?.label, formatDate(tx.occurredAt)].filter(Boolean).join(' · ');

  return (
    <li className="flex items-center gap-3 py-3.5">
      <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-xl', tileClass)} aria-hidden="true">
        {Icon ? <Icon className="size-4" strokeWidth={2} /> : <span className="size-1.5 rounded-full bg-current" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink">{getWalletTransactionTypeLabel(tx.type)}</p>
        <p className="truncate text-xs text-ink-muted">{meta}</p>
      </div>
      <div className="shrink-0 text-right">
        <p className={cn('text-sm font-bold tabular-nums', amountClass)}>
          {dir.sign}
          {formatMoney(tx.amount)}
        </p>
        {dir.word && <p className="text-xs text-ink-muted">{dir.word}</p>}
      </div>
    </li>
  );
}
