import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { StatusBadge } from '../../../components/orders/StatusBadge';
import { OrderTypeBadge } from '../../../components/orders/OrderTypeBadge';
import { PaymentTypeBadge } from '../../../components/orders/PaymentTypeBadge';
import { ParcelIntakeBadge } from '../../../components/orders/ParcelCollectionBadge';
import { Button } from '../../../components/ui/Button';
import { cn } from '../../../components/ui/cn';
import { formatDate, formatDateTime, formatMoney } from '../../../lib/format';
import type { OrderSummary } from '../../../services/domain.types';
import { canMarkReadyOrder } from './detail/orderDetailActions';

const DASH = '—';
/** Right-aligned money: tabular figures + no wrapping so amounts line up. */
const MONEY = 'whitespace-nowrap tabular-nums';

/** Single-line cell text; the full value stays available as a tooltip. */
function Truncate({ text, className }: { text: string; className?: string }) {
  return (
    <span title={text} className={cn('block max-w-[12rem] truncate', className)}>
      {text}
    </span>
  );
}

function driverLabel(driver: OrderSummary['currentDriver']): string {
  if (!driver) return 'Unassigned';
  const { user, driverNumber } = driver;
  return `${user.firstName} ${user.lastName} (${driverNumber})`;
}

export interface OrderRowActionsOptions {
  /** Permission-hydrated array from `usePermissions()` — never re-derived here. */
  permissions: readonly string[];
  onMarkReady: (order: OrderSummary) => void;
  onPrintLabel: (order: OrderSummary) => void;
  /** Order id currently generating its A5 label (disables/loads only that row's button). */
  printingOrderId: string | null;
  /** Optional column ids to show (see orderColumnVisibility.ts). Order + Actions always show. */
  visibleColumnIds: ReadonlySet<string>;
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
        className="whitespace-nowrap font-medium text-brand-600 hover:underline"
      >
        {o.orderNumber}
      </Link>
    ),
  },
  {
    id: 'customer',
    header: 'Customer',
    cell: (o) => <Truncate text={o.customer.name} />,
  },
  {
    id: 'receiver',
    header: 'Receiver',
    cell: (o) => <Truncate text={o.receiverName} />,
  },
  {
    id: 'phone',
    header: 'Phone',
    cell: (o) => o.receiverPhone || DASH,
    className: 'whitespace-nowrap',
  },
  {
    id: 'area',
    header: 'Area',
    cell: (o) =>
      o.receiverArea ? <Truncate text={o.receiverArea} className="max-w-[9rem]" /> : DASH,
  },
  {
    id: 'type',
    header: 'Type',
    cell: (o) => <OrderTypeBadge orderType={o.orderType} />,
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
  },
  {
    id: 'paymentType',
    header: 'Payment',
    cell: (o) => <PaymentTypeBadge paymentType={o.paymentType} />,
  },
  {
    id: 'orderAmount',
    header: 'Order amt',
    sortable: true,
    cell: (o) => formatMoney(o.orderAmount),
    align: 'right',
    className: MONEY,
  },
  {
    id: 'deliveryFee',
    header: 'Delivery fee',
    sortable: true,
    cell: (o) => formatMoney(o.deliveryFee),
    align: 'right',
    className: MONEY,
  },
  {
    id: 'collect',
    header: 'To collect',
    sortable: true,
    cell: (o) => (
      <span className="font-medium">{formatMoney(o.amountToCollect)}</span>
    ),
    align: 'right',
    className: MONEY,
  },
  {
    id: 'collectionDriver',
    header: 'Collection Driver',
    cell: (o) => (
      o.currentCollectionDriver ? (
        <Truncate text={driverLabel(o.currentCollectionDriver)} />
      ) : (
        <span className="text-ink-subtle">{DASH}</span>
      )
    ),
  },
  {
    id: 'driver',
    header: 'Delivery Driver',
    cell: (o) => (
      o.currentDriver ? (
        <Truncate text={driverLabel(o.currentDriver)} />
      ) : (
        <span className="whitespace-nowrap text-ink-subtle">Unassigned</span>
      )
    ),
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
    className: 'whitespace-nowrap',
  },
  {
    id: 'delivered',
    header: 'Delivered',
    sortable: true,
    cell: (o) => formatDate(o.deliveredAt),
    className: 'whitespace-nowrap',
  },
];

/**
 * Orders table columns plus the row-level "Mark ready" / "Print A5" actions.
 *
 * Mark ready eligibility reuses `canMarkReadyOrder` — the exact same rule the
 * Order Detail action bar uses (`RECEIVED` + `orders.change-status`). No
 * transition or permission logic is duplicated here; this column only decides
 * whether to render each button and delegates the click to the caller, which
 * owns the confirmation dialog / mutation / PDF generation.
 *
 * Print A5 has no status eligibility gate — any order the user can see in
 * this (already `orders.read`-gated) table may be printed.
 */
export function buildOrderColumns({
  permissions,
  onMarkReady,
  onPrintLabel,
  printingOrderId,
  visibleColumnIds,
}: OrderRowActionsOptions): DataTableColumn<OrderSummary>[] {
  const actionsColumn: DataTableColumn<OrderSummary> = {
    id: 'actions',
    header: 'Actions',
    cell: (o) => (
      <div className="flex items-center gap-1.5 whitespace-nowrap">
        {canMarkReadyOrder(o.status, permissions) && (
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
        )}
        <Button
          size="sm"
          variant="secondary"
          loading={printingOrderId === o.id}
          disabled={printingOrderId != null && printingOrderId !== o.id}
          onClick={(e) => {
            e.stopPropagation();
            onPrintLabel(o);
          }}
        >
          Print A5
        </Button>
      </div>
    ),
  };

  // Positioned right after "Order" and before "Customer" per UI request.
  const [orderCol, ...rest] = orderColumns;
  return [
    orderCol,
    actionsColumn,
    ...rest.filter((col) => visibleColumnIds.has(col.id)),
  ];
}
