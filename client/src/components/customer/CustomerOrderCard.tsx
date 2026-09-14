import { Link } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import { paths } from '../../routes/paths';
import { Badge } from '../ui/Badge';
import { StatusBadge } from '../orders/StatusBadge';
import { getOrderTypeLabel } from '../orders/orderStatus';
import {
  getCollectionStageTone,
  getCustomerParcelIntakeLabel,
} from './customerOrderPresentation';
import { formatDate, formatMoney } from '../../lib/format';
import type { CustomerOrderSummary } from '../../services/domain.types';

/**
 * Phase 13.2 — one Customer "My Orders" row.
 *
 * READ-ONLY. No mutation controls. "View order" links to the Phase 13.3
 * Customer Order Detail route for EVERY owned order (active + terminal alike
 * — task §42). Delivery status uses the shared Customer-safe StatusBadge
 * (audience="customer"); the collection stage label is the server's already
 * Customer-safe wording.
 */
export function CustomerOrderCard({ order }: { order: CustomerOrderSummary }) {
  const isDelivered = order.status === 'DELIVERED';

  return (
    <article
      className="rounded-card border border-line bg-card p-4 shadow-card"
      aria-label={`Order ${order.orderNumber}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold text-ink">
            {order.orderNumber}
          </h3>
          <p className="mt-0.5 break-all text-xs text-ink-subtle">
            Tracking {order.trackingCode}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Badge tone={order.orderType === 'COMPANY_ORDER' ? 'brand' : 'neutral'}>
            {getOrderTypeLabel(order.orderType)}
          </Badge>
          <StatusBadge status={order.status} audience="customer" />
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Receiver</dt>
          <dd className="truncate text-ink">{order.receiverName}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Area</dt>
          <dd className="truncate text-ink">{order.receiverArea}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Created</dt>
          <dd className="text-ink">{formatDate(order.createdAt)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Order Amount</dt>
          <dd className="text-ink tabular-nums">{formatMoney(order.orderAmount)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Delivery Fee</dt>
          <dd className="text-ink tabular-nums">{formatMoney(order.deliveryFee)}</dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs text-ink-muted">Amount to Collect</dt>
          <dd className="text-ink tabular-nums">{formatMoney(order.amountToCollect)}</dd>
        </div>
        {isDelivered && order.deliveredAt && (
          <div className="min-w-0">
            <dt className="text-xs text-ink-muted">Delivered</dt>
            <dd className="text-ink">{formatDate(order.deliveredAt)}</dd>
          </div>
        )}
      </dl>

      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-ink-muted">Parcel intake:</span>
          <span className="text-xs font-medium text-ink-secondary">
            {getCustomerParcelIntakeLabel(order.parcelIntakeMethod)}
          </span>
          {order.collectionStage && (
            <Badge tone={getCollectionStageTone(order.collectionStage.code)}>
              {order.collectionStage.label}
            </Badge>
          )}
        </div>
        <Link
          to={paths.customer.orderDetail(order.id)}
          className="inline-flex items-center gap-1 rounded-control border border-line px-2.5 py-1 text-xs font-medium text-brand-700 hover:bg-sunken"
          aria-label={`View order ${order.orderNumber}`}
        >
          View order
          <ChevronRight className="size-3.5" aria-hidden="true" />
        </Link>
      </div>
    </article>
  );
}
