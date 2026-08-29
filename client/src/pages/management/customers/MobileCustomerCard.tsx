import { Phone, MapPin } from 'lucide-react';
import { Link } from 'react-router-dom';
import { paths } from '../../../routes/paths';
import { formatDate, formatMoney } from '../../../lib/format';
import type {
  CustomerSummary,
  WalletCustomerSummary,
} from '../../../services/domain.types';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';

/** Compact Customer card for mobile widths — links to the Customer Detail page. */
export function MobileCustomerCard({
  customer,
  wallet,
}: {
  customer: CustomerSummary;
  /** Only supplied when the caller has wallets.read. */
  wallet?: WalletCustomerSummary;
}) {
  return (
    <Link
      to={paths.management.customerDetail(customer.id)}
      className="block rounded-card border border-line bg-card p-3 shadow-card hover:border-brand-600"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{customer.name}</p>
          <p className="text-xs text-ink-muted">{customer.customerNumber}</p>
        </div>
        <ActiveBadge isActive={customer.isActive} />
      </div>

      <div className="mt-2 space-y-0.5 text-xs text-ink-muted">
        {customer.primaryPhone && (
          <p className="flex items-center gap-1.5">
            <Phone className="size-3.5" aria-hidden="true" />
            {customer.primaryPhone}
          </p>
        )}
        {customer.area && (
          <p className="flex items-center gap-1.5">
            <MapPin className="size-3.5" aria-hidden="true" />
            {customer.area.name}
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        <span className="text-ink-secondary">
          <span className="text-ink-muted">Active orders:</span>{' '}
          {customer.activeOrders}
        </span>
        {wallet && (
          <>
            <span className="text-ink-secondary tabular-nums">
              <span className="text-ink-muted">Wallet:</span>{' '}
              {formatMoney(wallet.availableBalance)}
            </span>
            <span className="text-ink-secondary tabular-nums">
              <span className="text-ink-muted">Pending:</span>{' '}
              {formatMoney(wallet.pendingAmount)}
            </span>
          </>
        )}
      </div>

      <p className="mt-1.5 text-xs text-ink-subtle">
        {customer.hasPortalAccount ? 'Portal linked' : 'No portal account'}
        {` · Added ${formatDate(customer.createdAt)}`}
      </p>
    </Link>
  );
}
