import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { Badge } from '../../../components/ui/Badge';
import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney, humanizeToken } from '../../../lib/format';
import type { WalletTransactionEntry } from '../../../services/domain.types';

const DASH = '—';

const TYPE_TONE: Record<string, 'success' | 'warning' | 'info' | 'neutral'> = {
  ORDER_CREDIT: 'success',
  PAYOUT: 'info',
  ADJUSTMENT: 'warning',
  REVERSAL: 'neutral',
};

function notesCell(notes: string | null) {
  if (!notes) return <span className="text-ink-subtle">{DASH}</span>;
  // Plain text only — never render HTML from notes. Preserve line wrapping.
  return (
    <span className="block max-w-[22rem] whitespace-pre-wrap break-words text-xs text-ink-secondary">
      {notes}
    </span>
  );
}

export interface WalletTransactionColumnOptions {
  /** Caller holds `orders.read` — render the related order as a link. */
  canViewOrders: boolean;
  /** Trailing per-row actions (Reverse — Phase 11.12). Omit to hide the column. */
  renderActions?: (row: WalletTransactionEntry) => ReactNode;
}

/**
 * Wallet ledger columns (Phase 11.8). All values come straight from the
 * backend transaction DTO. `credit` / `debit` are positive-magnitude strings
 * shown in separate, explicitly-labelled columns — never merged into one
 * signed number. `Balance` is the persisted `balanceAfter`, never a
 * client-reconstructed running total. Append-only: no edit/delete controls.
 */
export function buildWalletTransactionColumns({
  canViewOrders,
  renderActions,
}: WalletTransactionColumnOptions): DataTableColumn<WalletTransactionEntry>[] {
  const cols: DataTableColumn<WalletTransactionEntry>[] = [
    {
      id: 'date',
      header: 'Date',
      cell: (t) => formatDateTime(t.createdAt),
    },
    {
      id: 'type',
      header: 'Type',
      cell: (t) => (
        <div className="flex flex-col gap-0.5">
          <Badge tone={TYPE_TONE[t.type] ?? 'neutral'}>
            {humanizeToken(t.type)}
          </Badge>
          {t.payout && (
            <span className="text-xs text-ink-muted">
              {t.payout.payoutNumber}
            </span>
          )}
        </div>
      ),
    },
    {
      id: 'order',
      header: 'Related order',
      hideBelow: 'lg',
      cell: (t) => {
        if (!t.order) return <span className="text-ink-subtle">{DASH}</span>;
        return canViewOrders ? (
          <Link
            to={paths.management.orderDetail(t.order.id)}
            className="text-brand-600 hover:underline"
          >
            {t.order.orderNumber}
          </Link>
        ) : (
          <span>{t.order.orderNumber}</span>
        );
      },
    },
    {
      id: 'credit',
      header: 'Credit',
      align: 'right',
      cell: (t) =>
        t.credit === '0' ? (
          <span className="text-ink-subtle">{DASH}</span>
        ) : (
          <span className="font-medium tabular-nums text-success-700">
            {formatMoney(t.credit)}
          </span>
        ),
    },
    {
      id: 'debit',
      header: 'Debit',
      align: 'right',
      cell: (t) =>
        t.debit === '0' ? (
          <span className="text-ink-subtle">{DASH}</span>
        ) : (
          <span className="font-medium tabular-nums text-danger-700">
            {formatMoney(t.debit)}
          </span>
        ),
    },
    {
      id: 'balance',
      header: 'Balance',
      align: 'right',
      hideBelow: 'md',
      cell: (t) => (
        <span className="tabular-nums">{formatMoney(t.balanceAfter)}</span>
      ),
    },
    {
      id: 'method',
      header: 'Payment method',
      hideBelow: 'xl',
      cell: (t) => t.paymentMethod?.name ?? DASH,
    },
    {
      id: 'by',
      header: 'Processed by',
      hideBelow: 'xl',
      cell: (t) =>
        t.processedBy
          ? `${t.processedBy.firstName} ${t.processedBy.lastName}`
          : 'System',
    },
    {
      id: 'notes',
      header: 'Notes',
      hideBelow: 'xl',
      cell: (t) => notesCell(t.notes),
    },
  ];

  if (renderActions) {
    cols.push({
      id: 'actions',
      header: '',
      align: 'right',
      cell: (t) => renderActions(t),
    });
  }

  return cols;
}
