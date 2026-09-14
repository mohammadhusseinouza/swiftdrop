import type { ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { paths } from '../../routes/paths';
import { useGetCustomerOrderDetailQuery } from '../../services/customerOrdersApi';
import {
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../services/apiError';
import { formatDate, formatMoney } from '../../lib/format';
import {
  getOrderTypeLabel,
  getPaymentTypePresentation,
} from '../../components/orders/orderStatus';

import { PageHeader } from '../../components/data-display/PageHeader';
import { Card } from '../../components/ui/Card';
import { Badge } from '../../components/ui/Badge';
import { StatusBadge } from '../../components/orders/StatusBadge';
import { LoadingState } from '../../components/feedback/LoadingState';
import { ErrorState } from '../../components/feedback/ErrorState';
import { CustomerOrderTimeline } from '../../components/customer/CustomerOrderTimeline';
import {
  getCollectionStageTone,
  getCustomerParcelIntakeLabel,
} from '../../components/customer/customerOrderPresentation';

function BackLink() {
  return (
    <Link
      to={paths.customer.orders}
      className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-700 hover:underline"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to My Orders
    </Link>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="text-sm font-semibold text-ink">{title}</h2>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{value || '—'}</dd>
    </div>
  );
}

/**
 * Phase 13.3 — /customer/orders/:id.
 *
 * READ-ONLY. Deep-link safe (id comes from the route param, never navigation
 * state). One request — GET /customer/me/orders/:id returns the safe Order
 * snapshot + the embedded Customer-safe tracking timeline. A not-owned or
 * unknown id is a plain 404 ("This order is not available."). No mutation
 * controls.
 */
export default function CustomerOrderDetailPage() {
  const { id = '' } = useParams();
  const query = useGetCustomerOrderDetailQuery(id, { skip: !id });
  const order = query.data;

  if (query.isLoading) {
    return (
      <div className="space-y-4">
        <BackLink />
        <Card flush>
          <LoadingState className="py-16" label="Loading order…" />
        </Card>
      </div>
    );
  }

  if (query.isError || !order) {
    const status = getApiErrorStatus(query.error as UnknownApiError);
    const notFound = status === 404;
    return (
      <div className="space-y-4">
        <BackLink />
        <Card flush>
          <ErrorState
            className="py-16"
            title={notFound ? 'Order not available' : 'Something went wrong'}
            message={
              notFound
                ? 'This order is not available.'
                : getApiErrorMessage(query.error as UnknownApiError)
            }
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
        </Card>
      </div>
    );
  }

  const payment = getPaymentTypePresentation(order.payment.type);

  return (
    <div className="space-y-4">
      <BackLink />

      <PageHeader
        size="lg"
        title={order.orderNumber}
        description={`Tracking ${order.trackingCode}`}
        actions={<StatusBadge status={order.status} audience="customer" />}
      />

      <Section title="Order Information">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="Order type" value={getOrderTypeLabel(order.orderType)} />
          <Field label="Tracking code" value={order.trackingCode} />
          <Field label="Created" value={formatDate(order.createdAt)} />
          {order.deliveredAt && (
            <Field label="Delivered" value={formatDate(order.deliveredAt)} />
          )}
        </dl>
      </Section>

      <Section title="Delivery Information">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="Receiver" value={order.receiver.name} />
          <Field label="Phone" value={order.receiver.phone} />
          {order.receiver.altPhone && (
            <Field label="Alt. phone" value={order.receiver.altPhone} />
          )}
          <Field label="Area" value={order.receiver.area} />
          <Field label="Address" value={order.receiver.address} />
          {order.receiver.buildingFloor && (
            <Field label="Building / floor" value={order.receiver.buildingFloor} />
          )}
          {order.receiver.instructions && (
            <Field label="Delivery instructions" value={order.receiver.instructions} />
          )}
          <Field label="Package" value={order.package.description} />
          <Field label="Pieces" value={String(order.package.packageCount)} />
          {order.package.quantity != null && (
            <Field label="Quantity" value={String(order.package.quantity)} />
          )}
          {order.package.weightKg && (
            <Field label="Weight (kg)" value={order.package.weightKg} />
          )}
        </dl>
      </Section>

      <Section title="Payment & Amount">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Field label="Payment type" value={payment.label} />
          <Field
            label="Order amount"
            value={<span className="tabular-nums">{formatMoney(order.payment.orderAmount)}</span>}
          />
          <Field
            label="Delivery fee"
            value={<span className="tabular-nums">{formatMoney(order.payment.deliveryFee)}</span>}
          />
          <Field
            label="Amount to collect"
            value={<span className="tabular-nums">{formatMoney(order.payment.amountToCollect)}</span>}
          />
        </dl>
      </Section>

      <Section title="Parcel Intake">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink">
            {getCustomerParcelIntakeLabel(order.parcelIntakeMethod)}
          </span>
          {order.collectionStage && (
            <Badge tone={getCollectionStageTone(order.collectionStage.code)}>
              {order.collectionStage.label}
            </Badge>
          )}
        </div>
      </Section>

      <Section title="Tracking">
        <CustomerOrderTimeline tracking={order.tracking} />
      </Section>
    </div>
  );
}
