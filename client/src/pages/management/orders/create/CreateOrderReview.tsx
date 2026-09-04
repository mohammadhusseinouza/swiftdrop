import { CalculatedField } from '../../../../components/forms/CalculatedField';
import { formatMoney } from '../../../../lib/format';
import { getOrderTypeLabel, getPaymentTypePresentation } from '../../../../components/orders/orderStatus';
import { getParcelIntakeMethodLabel } from '../../../../components/orders/parcelCollection';
import type { CreateOrderFormValues } from './createOrder.schema';
import type { OrderFinancialPreview } from './createOrderFinancialPreview';

export interface CreateOrderReviewLabels {
  customer: string | null;
  area: string | null;
  prepaidMethod: string | null;
  collectionMethod: string | null;
  driver: string | null;
  collectionArea: string | null;
  collectionDriver: string | null;
}

interface CreateOrderReviewProps {
  values: CreateOrderFormValues;
  labels: CreateOrderReviewLabels;
  preview: OrderFinancialPreview;
}

const DASH = '—';

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 py-1 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="text-right font-medium text-ink-secondary">{value || DASH}</dd>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
        {title}
      </h3>
      <dl className="mt-1 divide-y divide-line-subtle">{children}</dl>
    </div>
  );
}

/**
 * Read-only summary of what will be submitted. Performs NO calculation — the
 * money preview comes from `calculateOrderPreview` (exact bigint-cents), and
 * every total is recomputed and stored authoritatively by the server.
 */
export function CreateOrderReview({ values, labels, preview }: CreateOrderReviewProps) {
  const money = (v: string) => (v.trim() ? formatMoney(v) : DASH);
  const driverCollection = values.parcelIntakeMethod === 'DRIVER_COLLECTION';

  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Group title="Customer & type">
          <Row label="Customer" value={labels.customer ?? (values.customerId ? 'Selected' : '')} />
          <Row label="Order type" value={getOrderTypeLabel(values.orderType)} />
        </Group>

        <Group title="Receiver">
          <Row label="Name" value={values.receiverName} />
          <Row label="Phone" value={values.receiverPhone} />
          <Row label="Area" value={labels.area ?? (values.receiverAreaId ? 'Selected' : '')} />
          <Row label="Address" value={values.receiverAddress} />
        </Group>

        <Group title="Package">
          <Row label="Description" value={values.description} />
          <Row label="Packages" value={values.packageCount} />
          {values.quantity.trim() !== '' && <Row label="Quantity" value={values.quantity} />}
          {values.weightKg.trim() !== '' && <Row label="Weight (kg)" value={values.weightKg} />}
        </Group>

        <Group title="Payment">
          <Row label="Order amount" value={money(values.orderAmount)} />
          <Row label="Delivery fee" value={money(values.deliveryFee)} />
          <Row
            label="Payment type"
            value={getPaymentTypePresentation(values.paymentType).label}
          />
          <Row label="Prepaid order amount" value={money(values.prepaidOrderAmount)} />
          <Row label="Prepaid delivery fee" value={money(values.prepaidDeliveryFee)} />
          <Row label="Prepaid method" value={labels.prepaidMethod ?? ''} />
          <Row label="Collection method" value={labels.collectionMethod ?? ''} />
        </Group>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          Expected totals (preview)
        </h3>
        <div className="mt-2 space-y-2">
          <CalculatedField
            label="Remaining order amount"
            value={preview.remainingOrderAmount ? formatMoney(preview.remainingOrderAmount) : DASH}
          />
          <CalculatedField
            label="Remaining delivery fee"
            value={preview.remainingDeliveryFee ? formatMoney(preview.remainingDeliveryFee) : DASH}
          />
          <CalculatedField
            label="Amount to collect"
            value={preview.amountToCollect ? formatMoney(preview.amountToCollect) : DASH}
            emphasis
          />
        </div>
        <p className="mt-2 text-xs text-ink-muted">
          Final totals are recalculated by the server when the order is created.
        </p>
      </div>

      <Group title="Parcel intake">
        <Row
          label="Intake method"
          value={getParcelIntakeMethodLabel(values.parcelIntakeMethod)}
        />
        {driverCollection && (
          <>
            <Row label="Collection contact" value={values.parcelCollectionContactName} />
            <Row label="Collection phone" value={values.parcelCollectionPhone} />
            <Row
              label="Collection area"
              value={
                labels.collectionArea ??
                (values.parcelCollectionAreaId ? 'Selected' : '')
              }
            />
            <Row label="Collection address" value={values.parcelCollectionAddress} />
            <Row
              label="Collection driver"
              value={
                values.parcelCollectionDriverId
                  ? (labels.collectionDriver ?? 'Selected')
                  : 'Unassigned (awaiting collection assignment)'
              }
            />
          </>
        )}
      </Group>

      <Group title="Delivery assignment">
        <Row
          label="Delivery driver"
          value={
            driverCollection
              ? 'Assigned after the parcel is received at the company'
              : values.driverId
                ? (labels.driver ?? 'Selected')
                : 'Unassigned (create only)'
          }
        />
      </Group>
    </div>
  );
}
