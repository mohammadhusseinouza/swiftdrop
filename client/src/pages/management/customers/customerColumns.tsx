import { Link } from 'react-router-dom';
import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { paths } from '../../../routes/paths';
import { formatDate, formatMoney } from '../../../lib/format';
import type {
  CustomerSummary,
  WalletCustomerSummary,
} from '../../../services/domain.types';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';

const DASH = '—';

export interface CustomerColumnsOptions {
  /** Show the wallets.read-gated Available Wallet + Pending columns. */
  showFinancial: boolean;
  /** customerId -> wallet summary (from GET /wallets/customer-summaries). */
  walletByCustomer: Map<string, WalletCustomerSummary>;
  /** The wallet-summaries request is still loading. */
  financialLoading: boolean;
}

/**
 * Customer list columns. `activeOrders` comes from `GET /customers` (batched
 * server aggregate). Available Wallet / Pending are wallets.read-gated and
 * come from a separate batched `GET /wallets/customer-summaries` request —
 * they are OMITTED entirely for a caller without `wallets.read` (never shown
 * as "$0" / "restricted").
 */
export function buildCustomerColumns({
  showFinancial,
  walletByCustomer,
  financialLoading,
}: CustomerColumnsOptions): DataTableColumn<CustomerSummary>[] {
  const money = (c: CustomerSummary, key: 'availableBalance' | 'pendingAmount') => {
    const w = walletByCustomer.get(c.id);
    if (w) return formatMoney(w[key]);
    return financialLoading ? '…' : DASH;
  };

  const columns: DataTableColumn<CustomerSummary>[] = [
    {
      id: 'customer',
      header: 'Customer',
      cell: (c) => (
        <Link
          to={paths.management.customerDetail(c.id)}
          className="font-medium text-brand-600 hover:underline"
        >
          <span className="block">{c.name}</span>
          <span className="block text-xs font-normal text-ink-muted">
            {c.customerNumber}
          </span>
        </Link>
      ),
    },
    { id: 'phone', header: 'Phone', cell: (c) => c.primaryPhone || DASH },
    {
      id: 'area',
      header: 'Area',
      cell: (c) => c.area?.name ?? DASH,
      hideBelow: 'md',
    },
  ];

  if (showFinancial) {
    columns.push(
      {
        id: 'wallet',
        header: 'Available wallet',
        align: 'right',
        cell: (c) => (
          <span className="tabular-nums">{money(c, 'availableBalance')}</span>
        ),
        hideBelow: 'lg',
      },
      {
        id: 'pending',
        header: 'Pending',
        align: 'right',
        cell: (c) => (
          <span className="tabular-nums">{money(c, 'pendingAmount')}</span>
        ),
        hideBelow: 'lg',
      },
    );
  }

  columns.push(
    {
      id: 'activeOrders',
      header: 'Active orders',
      align: 'right',
      cell: (c) => <span className="tabular-nums">{c.activeOrders}</span>,
      hideBelow: 'md',
    },
    {
      id: 'status',
      header: 'Status',
      cell: (c) => <ActiveBadge isActive={c.isActive} />,
    },
    {
      id: 'created',
      header: 'Created',
      cell: (c) => formatDate(c.createdAt),
      hideBelow: 'lg',
    },
  );

  return columns;
}
