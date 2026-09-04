import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { Badge } from '../../../components/ui/Badge';
import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../lib/format';
import type { FinanceTransactionEntry } from '../../../services/domain.types';

import { LEDGER_LABEL, ledgerTypeLabel } from '../../../components/finance/ledgerCorrection';

const DASH = '—';

const LEDGER_TONE: Record<string, 'brand' | 'info' | 'neutral'> = {
  WALLET: 'brand',
  DRIVER_CASH: 'info',
  COMPANY_FINANCE: 'neutral',
};

/**
 * Finance unified transaction feed columns. Everything is from ONE
 * `GET /finance/transactions` response — the authoritative append-only view
 * over all three ledgers. No sort contract → not sortable. Money is a backend
 * string; `signedAmount` carries the sign, `direction` the CREDIT/DEBIT label.
 */
export function buildFinanceColumns(opts: {
  canViewOrders: boolean;
  canViewCustomers: boolean;
  canViewDrivers: boolean;
  /** Trailing per-row actions (Reverse). Omit to hide the column entirely. */
  renderActions?: (row: FinanceTransactionEntry) => ReactNode;
}): DataTableColumn<FinanceTransactionEntry>[] {
  const cols: DataTableColumn<FinanceTransactionEntry>[] = [
    {
      id: 'date',
      header: 'Date',
      cell: (t) => formatDateTime(t.createdAt),
    },
    {
      id: 'ledger',
      header: 'Ledger',
      cell: (t) => (
        <Badge tone={LEDGER_TONE[t.ledger] ?? 'neutral'}>
          {LEDGER_LABEL[t.ledger]}
        </Badge>
      ),
    },
    {
      id: 'type',
      header: 'Type',
      cell: (t) => (
        <span className="flex flex-col gap-0.5">
          <span>{ledgerTypeLabel(t.type)}</span>
          {t.reversalOf && (
            <span className="text-xs text-ink-muted">
              reverses {ledgerTypeLabel(t.reversalOf.type)}
            </span>
          )}
        </span>
      ),
    },
    {
      id: 'reference',
      header: 'Reference',
      hideBelow: 'lg',
      cell: (t) => {
        if (t.order) {
          return opts.canViewOrders ? (
            <Link
              to={paths.management.orderDetail(t.order.id)}
              className="text-brand-600 hover:underline"
            >
              {t.order.orderNumber}
            </Link>
          ) : (
            <span>{t.order.orderNumber}</span>
          );
        }
        if (t.payout) return <span>{t.payout.payoutNumber}</span>;
        if (t.settlement) return <span>{t.settlement.settlementNumber}</span>;
        return <span className="text-ink-subtle">{DASH}</span>;
      },
    },
    {
      id: 'party',
      header: 'Customer / Driver',
      hideBelow: 'lg',
      cell: (t) => {
        if (t.customer) {
          return opts.canViewCustomers ? (
            <Link
              to={paths.management.customerDetail(t.customer.id)}
              className="text-brand-600 hover:underline"
            >
              {t.customer.name}
            </Link>
          ) : (
            <span>{t.customer.name}</span>
          );
        }
        if (t.driver) {
          return opts.canViewDrivers ? (
            <Link
              to={paths.management.driverDetail(t.driver.id)}
              className="text-brand-600 hover:underline"
            >
              {t.driver.name}
            </Link>
          ) : (
            <span>{t.driver.name}</span>
          );
        }
        return <span className="text-ink-subtle">{DASH}</span>;
      },
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (t) => (
        <span
          className={
            t.direction === 'CREDIT'
              ? 'font-semibold tabular-nums text-success-700'
              : 'font-semibold tabular-nums text-danger-700'
          }
        >
          {t.direction === 'CREDIT' ? '+' : '−'}
          {formatMoney(t.amount)}
        </span>
      ),
    },
    {
      id: 'balanceAfter',
      header: 'Balance after',
      align: 'right',
      hideBelow: 'xl',
      cell: (t) =>
        t.balanceAfter === null ? (
          <span className="text-ink-subtle">{DASH}</span>
        ) : (
          <span className="tabular-nums text-ink-muted">
            {formatMoney(t.balanceAfter)}
          </span>
        ),
    },
    {
      id: 'method',
      header: 'Method',
      hideBelow: 'xl',
      cell: (t) => t.paymentMethod?.name ?? DASH,
    },
    {
      id: 'by',
      header: 'By',
      hideBelow: 'xl',
      cell: (t) =>
        t.actor ? `${t.actor.firstName} ${t.actor.lastName}` : 'System',
    },
    {
      id: 'notes',
      header: 'Notes',
      hideBelow: 'xl',
      cell: (t) =>
        t.notes && t.notes.trim() !== '' ? (
          <span
            className="block max-w-[14rem] truncate text-ink-muted"
            title={t.notes}
          >
            {t.notes}
          </span>
        ) : (
          <span className="text-ink-subtle">{DASH}</span>
        ),
    },
  ];

  if (opts.renderActions) {
    cols.push({
      id: 'actions',
      header: '',
      align: 'right',
      cell: (t) => opts.renderActions?.(t),
    });
  }

  return cols;
}
