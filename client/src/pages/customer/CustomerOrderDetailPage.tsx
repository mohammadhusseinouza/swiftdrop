import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Calendar, ChevronLeft, Copy, ExternalLink, MapPin, Phone } from 'lucide-react';

import { paths } from '../../routes/paths';
import { useGetCustomerOrderDetailQuery } from '../../services/customerOrdersApi';
import { getApiErrorMessage, getApiErrorStatus, type UnknownApiError } from '../../services/apiError';
import type { CustomerOrderDetail } from '../../services/domain.types';
import { formatDate, formatMoney } from '../../lib/format';
import { getOrderTypeLabel, getPaymentTypePresentation } from '../../components/orders/orderStatus';

import { Badge } from '../../components/ui/Badge';
import { cn } from '../../components/ui/cn';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { StatusPill } from '../../components/customer/StatusPill';
import { StageProgress } from '../../components/customer/StageProgress';
import { CustomerHero } from '../../components/customer/CustomerHero';
import { BalanceHeroCard } from '../../components/customer/BalanceHeroCard';
import { DetailPanel } from '../../components/customer/DetailPanel';
import { CustomerJourney } from '../../components/customer/CustomerJourney';
import {
  getCollectionStageTone,
  getCustomerParcelIntakeLabel,
} from '../../components/customer/customerOrderPresentation';
import {
  copyText,
  getCopyMessage,
  getJourneyLead,
  getPackageRows,
  getReceiverAddressParts,
  isSafeHttpUrl,
  type CopyResult,
} from '../../components/customer/customerOrderDetailPresentation';

const PANEL = 'rounded-2xl border border-sd-line bg-card shadow-sd-card';

/** "‹ All orders" — first line of the hero band (brand theme §4.3). */
function BackLink() {
  return (
    <Link
      to={paths.customer.orders}
      className="sd-press inline-flex items-center gap-1 self-start text-sm font-semibold text-sd-on-dark hover:text-white"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      All orders
    </Link>
  );
}

/**
 * /customer/orders/:id — Order Detail (Customer Portal Redesign Step 4,
 * handoff §3.3; brand look docs/brand-theme/brand-theme-handoff.md §4.3).
 *
 * READ-ONLY and deep-link safe (id from the route param). One request —
 * GET /customer/me/orders/:id returns the Customer-safe Order snapshot plus the
 * shared Customer-safe tracking stages. A not-owned or unknown id is a plain
 * 404 ("This order is not available."). No mutation controls, no driver
 * identity, no attempt / assignment history, no ETAs, no review amounts.
 *
 * The order's title block (status, type, number, tracking code, dates, the
 * red Amount to collect box and the 4-step bar) lives in the charcoal hero
 * band. While loading or on error the hero shows only "‹ All orders".
 */
export default function CustomerOrderDetailPage() {
  const { id = '' } = useParams();
  const query = useGetCustomerOrderDetailQuery(id, { skip: !id });
  const order = query.data;

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <CustomerHero>
          <BackLink />
        </CustomerHero>
        <div className={PANEL}>
          <LoadingState className="py-16" label="Loading order…" />
        </div>
      </div>
    );
  }

  if (query.isError || !order) {
    const notFound = getApiErrorStatus(query.error as UnknownApiError) === 404;
    return (
      <div className="flex flex-col gap-6">
        <CustomerHero>
          <BackLink />
        </CustomerHero>
        <div className={PANEL}>
          <ErrorState
            className="py-16"
            title={notFound ? 'Order not available' : 'Something went wrong'}
            message={notFound ? 'This order is not available.' : getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={notFound ? undefined : () => void query.refetch()}
            action={
              <Link
                to={paths.customer.orders}
                className="sd-press inline-flex h-8 items-center rounded-[8px] border border-sd-line px-3 text-sm font-medium text-sd-text-2 hover:border-sd-red hover:text-sd-red-text"
              >
                Back to My Orders
              </Link>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <CustomerHero>
        <BackLink />
        <OrderHero order={order} />
        <StageProgress status={order.status} variant="labelled" tone="dark" />
      </CustomerHero>

      <div className="sd-stagger flex flex-wrap items-start gap-5">
        <DetailPanel title="Journey" titleStyle="title" tone="brand" className="flex-[3_1_520px]">
          <p className="-mt-3 mb-6 text-sm text-sd-text-2">{getJourneyLead(order.status)}</p>
          <CustomerJourney tracking={order.tracking} status={order.status} />
        </DetailPanel>

        <div className="flex min-w-0 flex-[2_1_340px] flex-col gap-5">
          <DeliveringToPanel order={order} />
          <PaymentPanel order={order} />
          <PackagePanel order={order} />
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- Hero ---------------------------------- */

function OrderHero({ order }: { order: CustomerOrderDetail }) {
  return (
    <section aria-label="Order summary" className="flex flex-wrap items-end justify-between gap-x-8 gap-y-5">
      <div className="min-w-0 flex-[1_1_320px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={order.status} tone="dark" />
          <span className="inline-flex h-[26px] items-center whitespace-nowrap rounded-[6px] bg-white/10 px-2.5 text-xs font-semibold text-sd-on-dark-strong">
            {getOrderTypeLabel(order.orderType)}
          </span>
        </div>
        <h1 className="mt-4 font-sd-display text-[1.875rem] leading-[1.02] font-bold tracking-[-0.02em] text-white [overflow-wrap:anywhere] sm:text-[2.75rem]">
          {order.orderNumber}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 text-[0.8125rem] text-sd-on-dark">
          <TrackingCode code={order.trackingCode} />
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="size-3.5 shrink-0" aria-hidden="true" />
            Created {formatDate(order.createdAt)}
          </span>
          {order.deliveredAt && (
            <span className="font-semibold text-success-200">Delivered {formatDate(order.deliveredAt)}</span>
          )}
        </div>
      </div>

      <BalanceHeroCard tone="red" className="flex-[1_1_240px] sm:flex-[0_1_280px]">
        <p className="font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.12em] text-sd-red-on">
          Amount to collect
        </p>
        <p className="mt-2 font-sd-display text-[2.25rem] leading-none font-bold tabular-nums text-white [overflow-wrap:anywhere]">
          {formatMoney(order.payment.amountToCollect)}
        </p>
      </BalanceHeroCard>
    </section>
  );
}

function TrackingCode({ code }: { code: string }) {
  const [result, setResult] = useState<CopyResult | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const onCopy = async () => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    const next = await copyText(code, clipboard);
    setResult(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setResult(null), next === 'copied' ? 2000 : 5000);
  };

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <span>Tracking code</span>
      <span className="inline-flex items-center gap-1 rounded-[8px] bg-white/8 py-0.5 pr-0.5 pl-2.5 ring-1 ring-white/10 ring-inset">
        <code className="font-mono text-[0.8125rem] font-semibold text-white [overflow-wrap:anywhere]">{code}</code>
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label="Copy tracking code"
          className="sd-press inline-flex size-7 items-center justify-center rounded-[6px] text-sd-on-dark hover:bg-white/10 hover:text-white focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
      </span>
      {/* Polite live region: always mounted so the announcement is reliable. */}
      <span
        role="status"
        aria-live="polite"
        className={cn('text-xs font-semibold', result === 'copied' ? 'text-success-200' : 'text-warning-200')}
      >
        {result ? getCopyMessage(result) : ''}
      </span>
    </span>
  );
}

/* ------------------------------ Right column ------------------------------ */

function Row({ label, children, strong = false }: { label: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2.5">
      <dt className={cn('text-sm', strong ? 'font-bold text-sd-ink' : 'text-sd-text-muted')}>{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right tabular-nums [overflow-wrap:anywhere]',
          strong ? 'font-sd-display text-xl font-bold text-sd-red-text' : 'text-sm font-semibold text-sd-ink',
        )}
      >
        {children}
      </dd>
    </div>
  );
}

function PhoneLink({ phone, label }: { phone: string; label: string }) {
  return (
    <a
      href={`tel:${phone}`}
      aria-label={`${label} ${phone}`}
      className="inline-flex items-center gap-1.5 font-semibold text-sd-red-text hover:text-sd-red-hover hover:underline"
    >
      <Phone className="size-3.5 shrink-0 text-sd-red" aria-hidden="true" />
      {phone}
    </a>
  );
}

function DeliveringToPanel({ order }: { order: CustomerOrderDetail }) {
  const r = order.receiver;
  const addressParts = getReceiverAddressParts(r);
  return (
    <DetailPanel title="Delivering to" tone="brand">
      <p className="font-sd-display text-xl font-bold text-sd-ink [overflow-wrap:anywhere]">{r.name}</p>
      {addressParts.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-sd-text-2">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-sd-red" aria-hidden="true" />
          <span className="[overflow-wrap:anywhere]">{addressParts.join(' · ')}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        <PhoneLink phone={r.phone} label="Receiver phone" />
        {r.altPhone && <PhoneLink phone={r.altPhone} label="Receiver alternative phone" />}
        {isSafeHttpUrl(r.mapLink) && (
          <a
            href={r.mapLink.trim()}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 font-semibold text-sd-red-text hover:text-sd-red-hover hover:underline"
          >
            Open in maps
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
      {r.instructions && r.instructions.trim() !== '' && (
        <div className="mt-4 rounded-[10px] bg-sd-sunken p-4">
          <p className="font-sd-display text-xs font-semibold uppercase tracking-[0.12em] text-sd-text-muted">
            Delivery instructions
          </p>
          <p className="mt-1 text-sm whitespace-pre-line text-sd-text-2 [overflow-wrap:anywhere]">{r.instructions}</p>
        </div>
      )}
    </DetailPanel>
  );
}

function PaymentPanel({ order }: { order: CustomerOrderDetail }) {
  const p = order.payment;
  return (
    <DetailPanel title="Payment" tone="brand">
      <dl className="-my-2.5">
        <Row label="Payment type">{getPaymentTypePresentation(p.type).label}</Row>
        <Row label="Order amount">{formatMoney(p.orderAmount)}</Row>
        <Row label="Delivery fee">{formatMoney(p.deliveryFee)}</Row>
        <div className="my-1.5 border-t border-sd-line" aria-hidden="true" />
        <Row label="Amount to collect" strong>
          {formatMoney(p.amountToCollect)}
        </Row>
      </dl>
    </DetailPanel>
  );
}

function PackagePanel({ order }: { order: CustomerOrderDetail }) {
  return (
    <DetailPanel title="Package" tone="brand">
      <dl className="-my-2.5 divide-y divide-sd-line-subtle">
        {getPackageRows(order.package).map((row) => (
          <Row key={row.label} label={row.label}>
            {row.value}
          </Row>
        ))}
        <Row label="Parcel intake">
          <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
            {getCustomerParcelIntakeLabel(order.parcelIntakeMethod)}
            {order.collectionStage && (
              <Badge tone={getCollectionStageTone(order.collectionStage.code)}>{order.collectionStage.label}</Badge>
            )}
          </span>
        </Row>
      </dl>
    </DetailPanel>
  );
}
