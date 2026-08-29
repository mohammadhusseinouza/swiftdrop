import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { paths } from '../../../routes/paths';
import { formatMoney } from '../../../lib/format';
import type { DriverSummary } from '../../../services/domain.types';

const DASH = '—';

export interface DriverColumnOptions {
  /** Render the Cash Held column (caller holds `finance.read`). */
  showCash: boolean;
  /** driverId -> current cash balance string, from the batched summaries call. */
  cashByDriver: Map<string, string>;
  /** The batched cash request is still loading. */
  cashLoading: boolean;
}

/**
 * Driver list columns (Phase 11.7 correction). Operational metrics
 * (Active Orders / Out for Delivery / Completed Today) come from the
 * authoritative server `operationalSummary` on each row — never counted
 * client-side. Cash Held is `finance.read`-only and is filled from ONE
 * batched `/finance/driver-cash/summaries` request for the page, never a
 * per-row lookup. There is no server sort param, so headers are not sortable.
 */
export function buildDriverColumns({
  showCash,
  cashByDriver,
  cashLoading,
}: DriverColumnOptions): DataTableColumn<DriverSummary>[] {
  const columns: DataTableColumn<DriverSummary>[] = [
    {
      id: 'driver',
      header: 'Driver',
      cell: (d) => (
        <Link
          to={paths.management.driverDetail(d.id)}
          className="font-medium text-brand-600 hover:underline"
        >
          <span className="block">
            {d.user.firstName} {d.user.lastName}
          </span>
          <span className="block text-xs font-normal text-ink-muted">
            {d.driverNumber}
          </span>
        </Link>
      ),
    },
    {
      id: 'phone',
      header: 'Phone',
      cell: (d) => d.user.phone || DASH,
      hideBelow: 'lg',
    },
    {
      id: 'active',
      header: 'Active orders',
      align: 'right',
      cell: (d) => (
        <span className="tabular-nums">{d.operationalSummary.activeOrders}</span>
      ),
    },
    {
      id: 'ofd',
      header: 'Out for delivery',
      align: 'right',
      hideBelow: 'md',
      cell: (d) => (
        <span className="tabular-nums">
          {d.operationalSummary.outForDelivery}
        </span>
      ),
    },
    {
      id: 'completed',
      header: 'Completed today',
      align: 'right',
      hideBelow: 'lg',
      cell: (d) => (
        <span className="tabular-nums">
          {d.operationalSummary.completedToday}
        </span>
      ),
    },
  ];

  if (showCash) {
    columns.push({
      id: 'cash',
      header: 'Cash held',
      align: 'right',
      cell: (d) => {
        const balance = cashByDriver.get(d.id);
        if (balance != null) {
          return (
            <span className="font-medium tabular-nums">
              {formatMoney(balance)}
            </span>
          );
        }
        return (
          <span className="text-ink-subtle">{cashLoading ? '…' : DASH}</span>
        );
      },
    });
  }

  columns.push({
    id: 'status',
    header: 'Status',
    cell: (d) => <ActiveBadge isActive={d.isActive} />,
  });

  return columns;
}
