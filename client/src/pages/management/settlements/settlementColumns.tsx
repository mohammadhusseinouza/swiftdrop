import { Link } from 'react-router-dom';

import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../lib/format';
import type { SettlementSummary } from '../../../services/domain.types';

const DASH = '—';

/**
 * Driver Settlements list columns. Everything comes from ONE
 * `GET /driver-settlements` response (safe Management DTO — no idempotency
 * key, no raw driver-cash-account internals, no customer wallet / company
 * finance data). `balanceBefore` / `balanceAfter` are the PERSISTED
 * authoritative snapshots — never recomputed in React. There is no server
 * sort contract, so headers are not sortable. Money is a backend string
 * rendered with `formatMoney` (never `Number` / `parseFloat`).
 */
export function buildSettlementColumns(opts: {
  canViewDriver: boolean;
}): DataTableColumn<SettlementSummary>[] {
  return [
    {
      id: 'settlement',
      header: 'Settlement',
      cell: (s) => (
        <span className="font-medium text-ink">{s.settlementNumber}</span>
      ),
    },
    {
      id: 'driver',
      header: 'Driver',
      cell: (s) => {
        const name = `${s.driver.user.firstName} ${s.driver.user.lastName}`;
        return opts.canViewDriver ? (
          <Link
            to={paths.management.driverDetail(s.driver.id)}
            className="text-brand-600 hover:underline"
          >
            <span className="block">{name}</span>
            <span className="block text-xs font-normal text-ink-muted">
              {s.driver.driverNumber}
            </span>
          </Link>
        ) : (
          <span>
            <span className="block">{name}</span>
            <span className="block text-xs text-ink-muted">
              {s.driver.driverNumber}
            </span>
          </span>
        );
      },
    },
    {
      id: 'amount',
      header: 'Amount received',
      align: 'right',
      cell: (s) => (
        <span className="font-semibold tabular-nums text-ink">
          {formatMoney(s.amountReceived)}
        </span>
      ),
    },
    {
      id: 'method',
      header: 'Payment method',
      hideBelow: 'md',
      cell: (s) => s.paymentMethod.name,
    },
    {
      id: 'before',
      header: 'Balance before',
      align: 'right',
      hideBelow: 'lg',
      cell: (s) => (
        <span className="tabular-nums text-ink-muted">
          {formatMoney(s.balanceBefore)}
        </span>
      ),
    },
    {
      id: 'after',
      header: 'Balance after',
      align: 'right',
      hideBelow: 'lg',
      cell: (s) => (
        <span className="tabular-nums text-ink-muted">
          {formatMoney(s.balanceAfter)}
        </span>
      ),
    },
    {
      id: 'by',
      header: 'Received by',
      hideBelow: 'xl',
      cell: (s) => `${s.receivedBy.firstName} ${s.receivedBy.lastName}`,
    },
    {
      id: 'date',
      header: 'Date',
      hideBelow: 'md',
      cell: (s) => formatDateTime(s.createdAt),
    },
    {
      id: 'notes',
      header: 'Notes',
      hideBelow: 'xl',
      cell: (s) =>
        s.notes && s.notes.trim() !== '' ? (
          <span
            className="block max-w-[16rem] truncate text-ink-muted"
            title={s.notes}
          >
            {s.notes}
          </span>
        ) : (
          <span className="text-ink-subtle">{DASH}</span>
        ),
    },
  ];
}
