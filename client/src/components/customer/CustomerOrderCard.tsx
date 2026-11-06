import { Link } from 'react-router-dom';
import { Calendar, ChevronRight, MapPin, Package } from 'lucide-react';
import { paths } from '../../routes/paths';
import { Badge } from '../ui/Badge';
import { getOrderTypeLabel } from '../orders/orderStatus';
import { StatusPill } from './StatusPill';
import { StageProgress } from './StageProgress';
import {
  getCollectionStageTone,
  getCustomerParcelIntakeLabel,
} from './customerOrderPresentation';
import { formatDate, formatMoney } from '../../lib/format';
import type { CustomerOrderSummary } from '../../services/domain.types';

/**
 * One Customer "My Orders" card (Customer Portal Redesign Step 3, handoff §3.2).
 *
 * READ-ONLY. "View order" links to Customer Order Detail for every owned
 * order. Status wording + stage come from the canonical customer-safe mapping
 * (StatusPill / StageProgress). For an exception status (failed, rescheduled,
 * returned, cancelled) no stage is drawn: the list DTO carries no reached
 * stage, and one is never guessed. The collection-stage label is the server's
 * already Customer-safe wording. Money is server strings via formatMoney.
 * No driver identity, ETA or financial-review data.
 */
export function CustomerOrderCard({ order }: { order: CustomerOrderSummary }) {
  const isDelivered = order.status === 'DELIVERED';

  return (
    <article
      className="flex h-full flex-col gap-5 rounded-panel border border-line bg-card p-5 sm:p-6"
      aria-label={`Order ${order.orderNumber}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="min-w-0 flex-[1_1_200px]">
          <h2 className="truncate text-lg font-bold tracking-[-0.02em] text-ink">{order.receiverName}</h2>
          {/* Wraps between the two parts first; a single over-long code may still break. */}
          <p className="mt-0.5 text-[0.8125rem] text-ink-muted [overflow-wrap:anywhere]">
            <span className="inline-block max-w-full">{order.orderNumber} ·</span>{' '}
            <span className="inline-block max-w-full">Tracking {order.trackingCode}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <span className="inline-flex h-[26px] items-center whitespace-nowrap rounded-full bg-canvas px-2.5 text-xs font-semibold text-ink-secondary">
            {getOrderTypeLabel(order.orderType)}
          </span>
          <StatusPill status={order.status} />
        </div>
      </div>

      <StageProgress status={order.status} variant="labelled" />

      <dl className="grid grid-cols-3 divide-x divide-line rounded-[14px] bg-sunken py-3.5">
        <AmountCell label="Order amount" value={formatMoney(order.orderAmount)} />
        <AmountCell label="Delivery fee" value={formatMoney(order.deliveryFee)} />
        <AmountCell label="To collect" value={formatMoney(order.amountToCollect)} strong />
      </dl>

      <div className="mt-auto flex flex-wrap items-center gap-x-4 gap-y-2.5 border-t border-line-subtle pt-4 text-[0.8125rem] text-ink-muted">
        <span className="inline-flex min-w-0 items-center gap-1.5">
          <MapPin className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">Area:</span>
          <span className="truncate">{order.receiverArea}</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Calendar className="size-3.5 shrink-0" aria-hidden="true" />
          Created {formatDate(order.createdAt)}
        </span>
        {isDelivered && order.deliveredAt && (
          <span className="font-medium text-success-700">Delivered {formatDate(order.deliveredAt)}</span>
        )}
        <span className="inline-flex items-center gap-1.5">
          <Package className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="sr-only">Parcel intake:</span>
          {getCustomerParcelIntakeLabel(order.parcelIntakeMethod)}
        </span>
        {order.collectionStage && (
          <Badge tone={getCollectionStageTone(order.collectionStage.code)}>
            {order.collectionStage.label}
          </Badge>
        )}
        <Link
          to={paths.customer.orderDetail(order.id)}
          className="ml-auto inline-flex h-9 shrink-0 items-center gap-1 rounded-control border border-line bg-card px-3.5 text-[0.8125rem] font-semibold text-ink transition-colors hover:border-line-strong"
          aria-label={`View order ${order.orderNumber}`}
        >
          View order
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}

function AmountCell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="min-w-0 px-3 sm:px-4">
      <dt className="truncate text-xs text-ink-muted">{label}</dt>
      <dd
        className={
          strong
            ? 'mt-1 truncate text-[0.9375rem] font-bold tabular-nums text-ink'
            : 'mt-1 truncate text-[0.9375rem] font-semibold tabular-nums text-ink-secondary'
        }
      >
        {value}
      </dd>
    </div>
  );
}
