import { Link } from 'react-router-dom';

import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { Badge } from '../../../components/ui/Badge';
import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../lib/format';
import type { PayoutSummary } from '../../../services/domain.types';

import { payoutStatusLabel, payoutStatusTone } from './payoutPresentation';

const DASH = '—';

/**
 * Customer Payouts list columns. Everything comes from ONE `GET /payouts`
 * response (safe Management DTO — no idempotency key, no wallet ledger
 * internals, no driver cash / company finance data). There is no server sort
 * contract, so headers are not sortable. Money is a backend string rendered
 * with `formatMoney` (never `Number` / `parseFloat`).
 */
export function buildPayoutColumns(opts: {
  canViewCustomer: boolean;
}): DataTableColumn<PayoutSummary>[] {
  return [
    {
      id: 'payout',
      header: 'Payout',
      cell: (p) => (
        <span className="font-medium text-ink">{p.payoutNumber}</span>
      ),
    },
    {
      id: 'customer',
      header: 'Customer',
      cell: (p) =>
        opts.canViewCustomer ? (
          <Link
            to={paths.management.customerDetail(p.customer.id)}
            className="text-brand-600 hover:underline"
          >
            <span className="block">{p.customer.name}</span>
            <span className="block text-xs font-normal text-ink-muted">
              {p.customer.customerNumber}
            </span>
          </Link>
        ) : (
          <span>
            <span className="block">{p.customer.name}</span>
            <span className="block text-xs text-ink-muted">
              {p.customer.customerNumber}
            </span>
          </span>
        ),
    },
    {
      id: 'amount',
      header: 'Amount',
      align: 'right',
      cell: (p) => (
        <span className="font-semibold tabular-nums text-ink">
          {formatMoney(p.amount)}
        </span>
      ),
    },
    {
      id: 'method',
      header: 'Payment method',
      hideBelow: 'md',
      cell: (p) => p.paymentMethod.name,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (p) => (
        <Badge tone={payoutStatusTone(p.status)}>
          {payoutStatusLabel(p.status)}
        </Badge>
      ),
    },
    {
      id: 'processedBy',
      header: 'Processed by',
      hideBelow: 'xl',
      cell: (p) => `${p.processedBy.firstName} ${p.processedBy.lastName}`,
    },
    {
      id: 'date',
      header: 'Date',
      hideBelow: 'lg',
      cell: (p) => formatDateTime(p.createdAt),
    },
    {
      id: 'notes',
      header: 'Notes',
      hideBelow: 'xl',
      cell: (p) =>
        p.notes && p.notes.trim() !== '' ? (
          <span
            className="block max-w-[16rem] truncate text-ink-muted"
            title={p.notes}
          >
            {p.notes}
          </span>
        ) : (
          <span className="text-ink-subtle">{DASH}</span>
        ),
    },
  ];
}
