import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { Badge } from '../../../components/ui/Badge';
import { paths } from '../../../routes/paths';
import { formatDate, humanizeToken } from '../../../lib/format';
import { formatMoney } from '../../../lib/format';
import type { WalletSummary } from '../../../services/domain.types';

const DASH = '—';

/**
 * Customer Wallets list columns. Everything comes from ONE `GET /wallets`
 * response — `availableBalance`, `pendingAmount`, `lastTransaction` and
 * `lastPayout` are all batched server-side (no per-row request). There is no
 * server sort contract, so headers are not sortable.
 *
 * Available balance is the strong figure; Pending is visually secondary and
 * labelled so it never reads as withdrawable cash.
 */
export const walletColumns: DataTableColumn<WalletSummary>[] = [
  {
    id: 'customer',
    header: 'Customer',
    cell: (w) => (
      <Link
        to={paths.management.walletDetail(w.customer.id)}
        className="font-medium text-brand-600 hover:underline"
      >
        <span className="block">{w.customer.name}</span>
        <span className="block text-xs font-normal text-ink-muted">
          {w.customer.customerNumber}
        </span>
      </Link>
    ),
  },
  {
    id: 'available',
    header: 'Available balance',
    align: 'right',
    cell: (w) => (
      <span className="font-semibold tabular-nums text-ink">
        {formatMoney(w.availableBalance)}
      </span>
    ),
  },
  {
    id: 'pending',
    header: 'Pending',
    align: 'right',
    cell: (w) => (
      <span className="tabular-nums text-ink-muted">
        {formatMoney(w.pendingAmount)}
      </span>
    ),
  },
  {
    id: 'lastTransaction',
    header: 'Last transaction',
    hideBelow: 'lg',
    cell: (w) =>
      w.lastTransaction ? (
        <span className="flex flex-col gap-0.5">
          <Badge tone="neutral">{humanizeToken(w.lastTransaction.type)}</Badge>
          <span className="text-xs text-ink-muted">
            {formatDate(w.lastTransaction.createdAt)}
          </span>
        </span>
      ) : (
        <span className="text-ink-subtle">No activity</span>
      ),
  },
  {
    id: 'lastPayout',
    header: 'Last payout',
    hideBelow: 'xl',
    cell: (w) =>
      w.lastPayout ? (
        <span className="flex flex-col gap-0.5">
          <span className="text-sm">{w.lastPayout.payoutNumber}</span>
          <span className="text-xs text-ink-muted">
            {humanizeToken(w.lastPayout.status)} ·{' '}
            {formatDate(w.lastPayout.createdAt)}
          </span>
        </span>
      ) : (
        <span className="text-ink-subtle">{DASH}</span>
      ),
  },
];
