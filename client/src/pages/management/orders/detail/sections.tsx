import { type ReactNode, useId } from 'react';
import { Link } from 'react-router-dom';
import { MapPin } from 'lucide-react';

import { Badge } from '../../../../components/ui/Badge';
import { StatusBadge } from '../../../../components/orders/StatusBadge';
import { OrderTypeBadge } from '../../../../components/orders/OrderTypeBadge';
import { PaymentTypeBadge } from '../../../../components/orders/PaymentTypeBadge';
import { OrderTimeline } from '../../../../components/orders/OrderTimeline';
import { EmptyState } from '../../../../components/feedback/EmptyState';
import { LoadingState } from '../../../../components/feedback/LoadingState';
import { ErrorState } from '../../../../components/feedback/ErrorState';
import { paths } from '../../../../routes/paths';
import { formatDateTime, formatMoney, humanizeToken } from '../../../../lib/format';
import { useGetOrderTimelineQuery } from '../../../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../../services/apiError';
import type { OrderDetail } from '../../../../services/domain.types';
import { buildOrderTimeline } from './buildTimeline';

const DASH = '—';

/* ----------------------------- shared primitives ---------------------------- */

export function Section({
  title,
  id,
  action,
  children,
}: {
  title: string;
  id?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className="scroll-mt-20 rounded-card border border-line bg-card p-4 shadow-card sm:p-5"
    >
      <div className="flex items-start justify-between gap-3">
        <h2 id={headingId} className="text-sm font-semibold text-ink">
          {title}
        </h2>
        {action}
      </div>
      <div className="mt-4">{children}</div>
    </section>
  );
}

export interface DetailRow {
  label: ReactNode;
  value: ReactNode;
  /** Span both columns on desktop. */
  wide?: boolean;
}

export function DetailList({ rows }: { rows: DetailRow[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
      {rows.map((row, i) => (
        <div
          key={i}
          className={row.wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}
        >
          <dt className="text-xs text-ink-muted">{row.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const orText = (v: string | null | undefined): ReactNode =>
  v && v.trim() !== '' ? v : DASH;

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const FINANCIAL_STATUS_TONE: Record<
  string,
  'neutral' | 'success' | 'danger' | 'warning'
> = {
  PENDING: 'neutral',
  FINALIZED: 'success',
  REVIEW_REQUIRED: 'danger',
  NOT_APPLICABLE: 'neutral',
};

/* -------------------------------- 1. Summary ------------------------------- */

export function OrderSummarySection({ order }: { order: OrderDetail }) {
  return (
    <Section title="Order" id="order-summary">
      <DetailList
        rows={[
          { label: 'Order number', value: order.orderNumber },
          { label: 'Tracking code', value: order.trackingCode },
          {
            label: 'Order type',
            value: <OrderTypeBadge orderType={order.orderType} />,
          },
          {
            label: 'Status',
            value: <StatusBadge status={order.status} />,
          },
          {
            label: 'Package count',
            value: String(order.package.packageCount),
          },
          {
            label: 'Description',
            value: orText(order.package.description),
            wide: true,
          },
          { label: 'Created', value: formatDateTime(order.createdAt) },
          { label: 'Last updated', value: formatDateTime(order.updatedAt) },
        ]}
      />
    </Section>
  );
}

/* -------------------------------- 2. Customer ------------------------------ */

export function CustomerSection({
  order,
  canViewCustomer,
  canViewWallet,
}: {
  order: OrderDetail;
  canViewCustomer: boolean;
  canViewWallet: boolean;
}) {
  const { customer } = order;
  const nameNode =
    canViewCustomer ? (
      <Link
        to={paths.management.customerDetail(customer.id)}
        className="font-medium text-brand-600 hover:underline"
      >
        {customer.name}
      </Link>
    ) : (
      <span className="font-medium">{customer.name}</span>
    );

  return (
    <Section
      title="Customer"
      action={
        canViewWallet ? (
          <Link
            to={paths.management.walletDetail(customer.id)}
            className="text-xs font-medium text-brand-600 hover:underline"
          >
            View wallet
          </Link>
        ) : undefined
      }
    >
      <DetailList
        rows={[
          { label: 'Customer number', value: customer.customerNumber },
          { label: 'Name', value: nameNode },
          {
            label: 'Primary phone',
            value: customer.primaryPhone ? (
              <a
                href={`tel:${customer.primaryPhone}`}
                className="text-brand-600 hover:underline"
              >
                {customer.primaryPhone}
              </a>
            ) : (
              DASH
            ),
          },
          {
            label: 'Status',
            value: customer.isActive ? (
              <Badge tone="success">Active</Badge>
            ) : (
              <Badge tone="neutral">Inactive</Badge>
            ),
          },
        ]}
      />
    </Section>
  );
}

/* -------------------------------- 3. Receiver ----------------------------- */

export function ReceiverSection({ order }: { order: OrderDetail }) {
  const r = order.receiver;
  const mapValue =
    r.mapLink && r.mapLink.trim() !== '' ? (
      isSafeHttpUrl(r.mapLink) ? (
        <a
          href={r.mapLink}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-brand-600 hover:underline"
        >
          <MapPin className="size-3.5" aria-hidden="true" />
          Open location
        </a>
      ) : (
        r.mapLink
      )
    ) : (
      DASH
    );

  return (
    <Section title="Receiver">
      <p className="mb-3 text-xs text-ink-muted">
        Snapshot taken when the order was created — it does not change if the
        customer's saved details change later.
      </p>
      <DetailList
        rows={[
          { label: 'Receiver name', value: orText(r.name) },
          {
            label: 'Primary phone',
            value: r.phone ? (
              <a
                href={`tel:${r.phone}`}
                className="text-brand-600 hover:underline"
              >
                {r.phone}
              </a>
            ) : (
              DASH
            ),
          },
          {
            label: 'Alternative phone',
            value: r.altPhone ? (
              <a
                href={`tel:${r.altPhone}`}
                className="text-brand-600 hover:underline"
              >
                {r.altPhone}
              </a>
            ) : (
              DASH
            ),
          },
          { label: 'Area', value: orText(r.area) },
          { label: 'Full address', value: orText(r.address), wide: true },
          { label: 'Building / floor', value: orText(r.buildingFloor) },
          { label: 'Map / location', value: mapValue },
          {
            label: 'Delivery instructions',
            value: orText(r.instructions),
            wide: true,
          },
        ]}
      />
    </Section>
  );
}

/* -------------------------------- 4. Package ----------------------------- */

export function PackageSection({ order }: { order: OrderDetail }) {
  const p = order.package;
  return (
    <Section title="Package">
      <DetailList
        rows={[
          { label: 'Description', value: orText(p.description), wide: true },
          { label: 'Package count', value: String(p.packageCount) },
          {
            label: 'Quantity',
            value: p.quantity == null ? DASH : String(p.quantity),
          },
          {
            label: 'Weight (kg)',
            value: p.weightKg == null ? DASH : p.weightKg,
          },
          { label: 'Package notes', value: orText(p.notes), wide: true },
        ]}
      />
    </Section>
  );
}

/* ------------------------------- 5. Financial ---------------------------- */

export function FinancialSection({ order }: { order: OrderDetail }) {
  const f = order.financial;
  const money = (v: string | null) => formatMoney(v);

  const alloc = order.financialAllocation;

  const rows: DetailRow[] = [
    {
      label: 'Payment type',
      value: <PaymentTypeBadge paymentType={order.paymentType} />,
    },
    { label: 'Order amount', value: money(f.orderAmount) },
    { label: 'Delivery fee', value: money(f.deliveryFee) },
    { label: 'Prepaid order amount', value: money(f.prepaidOrderAmount) },
    { label: 'Prepaid delivery fee', value: money(f.prepaidDeliveryFee) },
    { label: 'Remaining order amount', value: money(f.remainingOrderAmount) },
    { label: 'Remaining delivery fee', value: money(f.remainingDeliveryFee) },
    {
      label: 'Amount to collect',
      value: (
        <span className="font-semibold tabular-nums">
          {money(f.amountToCollect)}
        </span>
      ),
    },
    {
      label: 'Actual amount collected',
      value:
        f.actualAmountCollected == null
          ? DASH
          : money(f.actualAmountCollected),
    },
    {
      label: 'Prepaid payment method',
      value: order.prepaidPaymentMethod?.name ?? DASH,
    },
    {
      label: 'Collection payment method',
      value: order.collectionPaymentMethod?.name ?? DASH,
    },
    { label: 'Company amount', value: money(alloc.companyAmount) },
    { label: 'Customer wallet amount', value: money(alloc.customerWalletAmount) },
    {
      label: 'Financial status',
      value: (
        <Badge tone={FINANCIAL_STATUS_TONE[order.financialStatus] ?? 'neutral'}>
          {humanizeToken(order.financialStatus)}
        </Badge>
      ),
    },
    {
      label: 'Needs financial review',
      value: f.needsFinancialReview ? (
        <Badge tone="danger">Yes</Badge>
      ) : (
        <Badge tone="neutral">No</Badge>
      ),
    },
  ];
  if (f.collectionDifferenceReason) {
    rows.push({
      label: 'Collection difference reason',
      value: f.collectionDifferenceReason,
      wide: true,
    });
  }

  return (
    <Section title="Financial">
      <DetailList rows={rows} />
      <p className="mt-4 text-xs text-ink-muted">
        Server-calculated totals shown as stored — never recalculated here.
        Company amount and customer wallet amount are the authoritative net
        amounts posted to the ledgers for this order; both read{' '}
        <span className="tabular-nums">$0.00</span> until the order is
        financially finalized.
      </p>
    </Section>
  );
}

/* ------------------------------- 6. Delivery ---------------------------- */

export function DeliverySection({
  order,
  canViewDriver,
}: {
  order: OrderDetail;
  canViewDriver: boolean;
}) {
  const current = order.assignmentHistory.find((a) => a.isCurrent) ?? null;
  const driver = order.currentDriver;

  let driverValue: ReactNode = (
    <span className="text-ink-subtle">Unassigned</span>
  );
  if (driver) {
    const label = current
      ? `${driver.driverNumber} · ${current.driver.user.firstName} ${current.driver.user.lastName}`
      : driver.driverNumber;
    driverValue = canViewDriver ? (
      <Link
        to={paths.management.driverDetail(driver.id)}
        className="font-medium text-brand-600 hover:underline"
      >
        {label}
      </Link>
    ) : (
      <span className="font-medium">{label}</span>
    );
  }

  const rows: DetailRow[] = [
    { label: 'Current driver', value: driverValue },
  ];
  if (driver && current?.driver.user.phone) {
    rows.push({
      label: 'Driver phone',
      value: (
        <a
          href={`tel:${current.driver.user.phone}`}
          className="text-brand-600 hover:underline"
        >
          {current.driver.user.phone}
        </a>
      ),
    });
  }
  if (driver && !driver.isActive) {
    rows.push({
      label: 'Driver account',
      value: <Badge tone="warning">Inactive</Badge>,
    });
  }
  rows.push(
    { label: 'Assignment date', value: formatDateTime(order.assignedAt) },
    { label: 'Pickup date', value: formatDateTime(order.pickedUpAt) },
    {
      label: 'Out for delivery date',
      value: formatDateTime(order.outForDeliveryAt),
    },
    { label: 'Delivery date', value: formatDateTime(order.deliveredAt) },
  );
  if (order.cancelledAt) {
    rows.push({
      label: 'Cancelled date',
      value: formatDateTime(order.cancelledAt),
    });
  }

  const awaitingParcel =
    !driver &&
    order.parcelIntakeMethod === 'DRIVER_COLLECTION' &&
    order.parcelCollectionStatus !== 'RECEIVED_AT_COMPANY';

  return (
    <Section title="Delivery">
      <p className="mb-3 text-xs text-ink-muted">
        Company → receiver. Separate from Parcel Intake (sender → company) above.
      </p>
      <DetailList rows={rows} />
      {awaitingParcel && (
        <p className="mt-3 rounded-control border border-line-subtle bg-sunken px-3 py-2 text-xs text-ink-muted">
          A delivery driver can be assigned once the parcel is received at the
          company (see Parcel Intake &amp; Collection above).
        </p>
      )}
    </Section>
  );
}

/* -------------------------- 7. Assignment history ----------------------- */

export function AssignmentHistorySection({ order }: { order: OrderDetail }) {
  // Backend returns oldest-first; show newest-first without mutating the cache.
  const rows = [...order.assignmentHistory].reverse();

  return (
    <Section title="Assignment history" id="assignment-history">
      {rows.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No assignment history yet"
          description="This order has never had a driver assigned."
        />
      ) : (
        <ul className="divide-y divide-line-subtle">
          {rows.map((a) => (
            <li key={a.id} className="py-3 first:pt-0 last:pb-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  {a.driver.driverNumber} · {a.driver.user.firstName}{' '}
                  {a.driver.user.lastName}
                </p>
                <Badge tone={a.isCurrent ? 'success' : 'neutral'}>
                  {a.isCurrent ? 'Current' : 'Previous'}
                </Badge>
              </div>
              <dl className="mt-1 grid grid-cols-1 gap-x-6 gap-y-1 text-xs text-ink-muted sm:grid-cols-2">
                <div>
                  Assigned {formatDateTime(a.assignedAt)} by {a.assignedBy.firstName}{' '}
                  {a.assignedBy.lastName}
                </div>
                <div>
                  {a.endedAt
                    ? `Ended ${formatDateTime(a.endedAt)}`
                    : 'Active assignment'}
                </div>
                {a.endReason && (
                  <div className="sm:col-span-2">Reason: {a.endReason}</div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/* --------------------------- 8. Delivery attempts ---------------------- */

const ATTEMPT_OUTCOME: Record<
  string,
  { label: string; tone: 'success' | 'danger' | 'warning' | 'neutral' }
> = {
  DELIVERED: { label: 'Delivered', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  RETURNED: { label: 'Returned', tone: 'warning' },
};

export function DeliveryAttemptsSection({ order }: { order: OrderDetail }) {
  const attempts = order.deliveryAttempts; // attemptNumber ascending

  return (
    <Section title="Delivery attempts" id="delivery-attempts">
      {attempts.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No delivery attempts yet"
          description="Attempts appear once a driver takes the order out for delivery."
        />
      ) : (
        <ul className="space-y-3">
          {attempts.map((att) => (
            <li
              key={att.id}
              className="rounded-control border border-line-subtle bg-sunken p-3"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-sm font-medium text-ink">
                  Attempt #{att.attemptNumber}
                </p>
                <Badge
                  tone={ATTEMPT_OUTCOME[att.outcome]?.tone ?? 'neutral'}
                >
                  {ATTEMPT_OUTCOME[att.outcome]?.label ??
                    humanizeToken(att.outcome)}
                </Badge>
              </div>
              <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                <Pair
                  label="Driver"
                  value={`${att.driver.driverNumber} · ${att.driver.user.firstName} ${att.driver.user.lastName}`}
                />
                <Pair label="Started" value={formatDateTime(att.startedAt)} />
                <Pair
                  label="Completed"
                  value={formatDateTime(att.completedAt)}
                />
                <Pair
                  label="Expected collection"
                  value={formatMoney(att.expectedCollection)}
                />
                <Pair
                  label="Actual collection"
                  value={
                    att.actualCollection == null
                      ? DASH
                      : formatMoney(att.actualCollection)
                  }
                />
                {att.failedReason && (
                  <Pair label="Failed reason" value={att.failedReason.name} />
                )}
                {att.notes && (
                  <div className="sm:col-span-2">
                    <span className="text-ink-muted">Notes: </span>
                    <span className="text-ink">{att.notes}</span>
                  </div>
                )}
              </dl>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

function Pair({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <span className="text-ink-muted">{label}: </span>
      <span className="text-ink">{value}</span>
    </div>
  );
}

/* ------------------------------- 9. Timeline --------------------------- */

export function TimelineSection({ order }: { order: OrderDetail }) {
  // Phase 11.17.6 — the server-authoritative unified timeline (Collection +
  // Delivery events, already deduplicated/ordered) replaces the earlier
  // client-composed version built purely from `order`'s own arrays.
  const query = useGetOrderTimelineQuery(order.id);
  const items = query.data ? buildOrderTimeline(query.data) : [];

  return (
    <Section title="Order timeline" id="order-history">
      <p className="mb-4 text-xs text-ink-muted">
        Unified operational history for this order — status changes,
        delivery assignments/attempts, parcel collection events and
        financial events, in one chronological view. Not a full system audit
        log.
      </p>
      {query.isLoading ? (
        <LoadingState className="py-8" />
      ) : query.isError ? (
        <ErrorState
          className="py-8"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      ) : items.length === 0 ? (
        <EmptyState
          className="py-8"
          title="No timeline events yet"
          description="Events appear as the order moves through its workflow."
        />
      ) : (
        <OrderTimeline items={items} />
      )}
    </Section>
  );
}
