import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { StatusBadge } from '../../../components/orders/StatusBadge';
import { OrderTypeBadge } from '../../../components/orders/OrderTypeBadge';
import { PaymentTypeBadge } from '../../../components/orders/PaymentTypeBadge';
import { ParcelIntakeBadge } from '../../../components/orders/ParcelCollectionBadge';
import { Button } from '../../../components/ui/Button';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import type { OrderSummary } from '../../../services/domain.types';
import { canMarkReadyOrder } from './detail/orderDetailActions';

const DASH = '—';

function driverLabel(driver: OrderSummary['currentDriver']): string {
  if (!driver) return 'Unassigned';
  const { user, driverNumber } = driver;
  return `${user.firstName} ${user.lastName} (${driverNumber})`;
}

export interface OrderRowActionsOptions {
  /** Permission-hydrated array from `usePermissions()` — never re-derived here. */
  permissions: readonly string[];
  onMarkReady: (order: OrderSummary) => void;
}

/**
 * Orders list columns. Money values are the backend's own decimal strings —
 * formatted for display only (`formatMoney`), never recalculated.
 *
 * `sortable: true` is set ONLY on columns the backend `sortBy` allowlist
 * supports (Order/Status/Order amt/Delivery fee/To collect/Created/Delivered).
 * The column id -> backend `sortBy` mapping lives in ordersListParams.ts
 * (`COLUMN_SORT_BY`); the DataTable never sorts rows itself — a header click
 * updates the URL and the backend returns the sorted page.
 */
export const orderColumns: DataTableColumn<OrderSummary>[] = [
  {
    id: 'order',
    header: 'Order',
    sortable: true,
    cell: (o) => (
      <Link
        to={`/management/orders/${o.id}`}
        className="font-medium text-brand-600 hover:underline"
      >
        {o.orderNumber}
      </Link>
    ),
  },
  {
    id: 'customer',
    header: 'Customer',
    cell: (o) => o.customer.name,
    hideBelow: 'lg',
  },
  {
    id: 'receiver',
    header: 'Receiver',
    cell: (o) => o.receiverName,
  },
  {
    id: 'phone',
    header: 'Phone',
    cell: (o) => o.receiverPhone || DASH,
    hideBelow: 'xl',
  },
  {
    id: 'area',
    header: 'Area',
    cell: (o) => o.receiverArea || DASH,
    hideBelow: 'lg',
  },
  {
    id: 'type',
    header: 'Type',
    cell: (o) => <OrderTypeBadge orderType={o.orderType} />,
    hideBelow: 'md',
  },
  {
    id: 'intake',
    header: 'Parcel intake',
    cell: (o) => (
      <ParcelIntakeBadge
        method={o.parcelIntakeMethod}
        status={o.parcelCollectionStatus}
      />
    ),
    hideBelow: 'lg',
  },
  {
    id: 'paymentType',
    header: 'Payment',
    cell: (o) => <PaymentTypeBadge paymentType={o.paymentType} />,
    hideBelow: 'xl',
  },
  {
    id: 'orderAmount',
    header: 'Order amt',
    sortable: true,
    cell: (o) => formatMoney(o.orderAmount),
    align: 'right',
    hideBelow: 'xl',
  },
  {
    id: 'deliveryFee',
    header: 'Delivery fee',
    sortable: true,
    cell: (o) => formatMoney(o.deliveryFee),
    align: 'right',
    hideBelow: 'xl',
  },
  {
    id: 'collect',
    header: 'To collect',
    sortable: true,
    cell: (o) => (
      <span className="font-medium">{formatMoney(o.amountToCollect)}</span>
    ),
    align: 'right',
  },
  {
    id: 'collectionDriver',
    header: 'Collection Driver',
    cell: (o) => (
      <span className={o.currentCollectionDriver ? undefined : 'text-ink-subtle'}>
        {o.currentCollectionDriver ? driverLabel(o.currentCollectionDriver) : DASH}
      </span>
    ),
    hideBelow: 'lg',
  },
  {
    id: 'driver',
    header: 'Delivery Driver',
    cell: (o) => (
      <span className={o.currentDriver ? undefined : 'text-ink-subtle'}>
        {driverLabel(o.currentDriver)}
      </span>
    ),
    hideBelow: 'md',
  },
  {
    id: 'status',
    header: 'Status',
    sortable: true,
    cell: (o) => <StatusBadge status={o.status} />,
  },
  {
    id: 'created',
    header: 'Created',
    sortable: true,
    cell: (o) => formatDateTime(o.createdAt),
    hideBelow: 'lg',
  },
  {
    id: 'delivered',
    header: 'Delivered',
    sortable: true,
    cell: (o) => formatDate(o.deliveredAt),
    hideBelow: 'xl',
  },
];

/**
 * Orders table columns plus the row-level "Mark ready" action.
 *
 * Eligibility reuses `canMarkReadyOrder` — the exact same rule the Order
 * Detail action bar uses (`RECEIVED` + `orders.change-status`). No transition
 * or permission logic is duplicated here; this column only decides whether to
 * render the button and delegates the click to the caller, which owns the
 * confirmation dialog and the `readyOrder` mutation.
 */
export function buildOrderColumns({
  permissions,
  onMarkReady,
}: OrderRowActionsOptions): DataTableColumn<OrderSummary>[] {
  const actionsColumn: DataTableColumn<OrderSummary> = {
    id: 'actions',
    header: 'Actions',
    cell: (o) =>
      canMarkReadyOrder(o.status, permissions) ? (
        <Button
          size="sm"
          variant="secondary"
          onClick={(e) => {
            // Row navigation lives on the "Order" cell's <Link>, not a
            // row-level onClick — stopPropagation is defensive in case one
            // is ever added.
            e.stopPropagation();
            onMarkReady(o);
          }}
        >
          Mark ready
        </Button>
      ) : null,
  };

  // Positioned right after "Order" and before "Customer" per UI request.
  const [orderCol, ...rest] = orderColumns;
  return [orderCol, actionsColumn, ...rest];
}
