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

const PANEL = 'rounded-panel border border-line bg-card';

function BackLink() {
  return (
    <Link
      to={paths.customer.orders}
      className="inline-flex items-center gap-1 self-start text-sm font-semibold text-ink-secondary hover:text-ink"
    >
      <ChevronLeft className="size-4" aria-hidden="true" />
      All orders
    </Link>
  );
}

/**
 * /customer/orders/:id — Order Detail (Customer Portal Redesign Step 4,
 * handoff §3.3).
 *
 * READ-ONLY and deep-link safe (id from the route param). One request —
 * GET /customer/me/orders/:id returns the Customer-safe Order snapshot plus the
 * shared Customer-safe tracking stages. A not-owned or unknown id is a plain
 * 404 ("This order is not available."). No mutation controls, no driver
 * identity, no attempt / assignment history, no ETAs, no review amounts.
 */
export default function CustomerOrderDetailPage() {
  const { id = '' } = useParams();
  const query = useGetCustomerOrderDetailQuery(id, { skip: !id });
  const order = query.data;

  if (query.isLoading) {
    return (
      <div className="flex flex-col gap-6">
        <BackLink />
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
        <BackLink />
        <div className={PANEL}>
          <ErrorState
            className="py-16"
            title={notFound ? 'Order not available' : 'Something went wrong'}
            message={notFound ? 'This order is not available.' : getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={notFound ? undefined : () => void query.refetch()}
            action={
              <Link
                to={paths.customer.orders}
                className="inline-flex h-8 items-center rounded-control border border-line px-3 text-sm font-medium text-ink-secondary hover:bg-sunken"
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
      <BackLink />
      <SummaryPanel order={order} />

      <div className="flex flex-wrap items-start gap-5">
        <DetailPanel title="Journey" titleStyle="title" className="flex-[3_1_520px]">
          <p className="-mt-3 mb-6 text-sm text-ink-secondary">{getJourneyLead(order.status)}</p>
          <CustomerJourney tracking={order.tracking} />
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

/* --------------------------------- Summary -------------------------------- */

function SummaryPanel({ order }: { order: CustomerOrderDetail }) {
  return (
    <section aria-label="Order summary" className={cn(PANEL, 'flex flex-wrap items-stretch gap-6 p-6 sm:p-8')}>
      <div className="min-w-0 flex-[1_1_320px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusPill status={order.status} />
          <span className="inline-flex h-[26px] items-center whitespace-nowrap rounded-full bg-canvas px-2.5 text-xs font-semibold text-ink-secondary">
            {getOrderTypeLabel(order.orderType)}
          </span>
        </div>
        <h1 className="mt-4 text-[1.875rem] leading-[1.08] font-bold tracking-[-0.035em] text-ink [overflow-wrap:anywhere] sm:text-[2.375rem]">
          {order.orderNumber}
        </h1>
        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3 text-[0.8125rem] text-ink-muted">
          <TrackingCode code={order.trackingCode} />
          <span className="inline-flex items-center gap-1.5">
            <Calendar className="size-3.5 shrink-0" aria-hidden="true" />
            Created {formatDate(order.createdAt)}
          </span>
          {order.deliveredAt && (
            <span className="font-medium text-success-700">Delivered {formatDate(order.deliveredAt)}</span>
          )}
        </div>
      </div>

      <div className="flex min-w-0 flex-[1_1_260px] flex-col sm:flex-[0_1_260px] justify-center rounded-[18px] bg-chrome px-6 py-5 text-white">
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-chrome-ink">Amount to collect</p>
        <p className="mt-2 text-[2.25rem] leading-none font-bold tracking-[-0.04em] tabular-nums">
          {formatMoney(order.payment.amountToCollect)}
        </p>
      </div>
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
      <span className="inline-flex items-center gap-1 rounded-control bg-sunken py-0.5 pr-0.5 pl-2.5 ring-1 ring-line ring-inset">
        <code className="font-mono text-[0.8125rem] font-semibold text-ink [overflow-wrap:anywhere]">{code}</code>
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label="Copy tracking code"
          className="inline-flex size-7 items-center justify-center rounded-[8px] text-ink-secondary hover:bg-card hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600"
        >
          <Copy className="size-3.5" aria-hidden="true" />
        </button>
      </span>
      {/* Polite live region: always mounted so the announcement is reliable. */}
      <span
        role="status"
        aria-live="polite"
        className={cn('text-xs font-semibold', result === 'copied' ? 'text-success-700' : 'text-warning-800')}
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
      <dt className={cn('text-sm', strong ? 'font-bold text-ink' : 'text-ink-muted')}>{label}</dt>
      <dd
        className={cn(
          'min-w-0 text-right text-sm tabular-nums [overflow-wrap:anywhere]',
          strong ? 'text-base font-bold text-ink' : 'font-semibold text-ink',
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
      className="inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:text-brand-700 hover:underline"
    >
      <Phone className="size-3.5 shrink-0" aria-hidden="true" />
      {phone}
    </a>
  );
}

function DeliveringToPanel({ order }: { order: CustomerOrderDetail }) {
  const r = order.receiver;
  const addressParts = getReceiverAddressParts(r);
  return (
    <DetailPanel title="Delivering to">
      <p className="text-xl font-bold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">{r.name}</p>
      {addressParts.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 text-sm text-ink-secondary">
          <MapPin className="mt-0.5 size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
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
            className="inline-flex items-center gap-1.5 font-semibold text-brand-600 hover:text-brand-700 hover:underline"
          >
            Open in maps
            <ExternalLink className="size-3.5" aria-hidden="true" />
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        )}
      </div>
      {r.instructions && r.instructions.trim() !== '' && (
        <div className="mt-4 rounded-[14px] bg-sunken p-4">
          <p className="text-xs font-bold uppercase tracking-[0.1em] text-ink-muted">Delivery instructions</p>
          <p className="mt-1 text-sm whitespace-pre-line text-ink-secondary [overflow-wrap:anywhere]">{r.instructions}</p>
        </div>
      )}
    </DetailPanel>
  );
}

function PaymentPanel({ order }: { order: CustomerOrderDetail }) {
  const p = order.payment;
  return (
    <DetailPanel title="Payment">
      <dl className="-my-2.5">
        <Row label="Payment type">{getPaymentTypePresentation(p.type).label}</Row>
        <Row label="Order amount">{formatMoney(p.orderAmount)}</Row>
        <Row label="Delivery fee">{formatMoney(p.deliveryFee)}</Row>
        <div className="my-1.5 border-t border-line" aria-hidden="true" />
        <Row label="Amount to collect" strong>
          {formatMoney(p.amountToCollect)}
        </Row>
      </dl>
    </DetailPanel>
  );
}

function PackagePanel({ order }: { order: CustomerOrderDetail }) {
  return (
    <DetailPanel title="Package">
      <dl className="-my-2.5 divide-y divide-line-subtle">
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
