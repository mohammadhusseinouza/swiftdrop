import { Link } from 'react-router-dom';
import { Badge } from '../../../components/ui/Badge';
import { paths } from '../../../routes/paths';
import { formatDate, formatMoney, humanizeToken } from '../../../lib/format';
import type { WalletSummary } from '../../../services/domain.types';

/** Compact Customer Wallet card for mobile widths — opens Wallet Detail. */
export function MobileWalletCard({ wallet }: { wallet: WalletSummary }) {
  return (
    <Link
      to={paths.management.walletDetail(wallet.customer.id)}
      className="block rounded-card border border-line bg-card p-3 shadow-card hover:border-brand-600"
    >
      <p className="font-semibold text-ink">{wallet.customer.name}</p>
      <p className="text-xs text-ink-muted">{wallet.customer.customerNumber}</p>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-ink-muted">
            Available
          </p>
          <p className="text-lg font-semibold tabular-nums text-ink">
            {formatMoney(wallet.availableBalance)}
          </p>
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-ink-muted">
            Pending
          </p>
          <p className="tabular-nums text-ink-muted">
            {formatMoney(wallet.pendingAmount)}
          </p>
        </div>
      </div>

      <dl className="mt-3 space-y-1 border-t border-line pt-2 text-xs text-ink-muted">
        <div className="flex items-center justify-between gap-2">
          <dt>Last transaction</dt>
          <dd>
            {wallet.lastTransaction ? (
              <span className="flex items-center gap-1.5">
                <Badge tone="neutral">
                  {humanizeToken(wallet.lastTransaction.type)}
                </Badge>
                {formatDate(wallet.lastTransaction.createdAt)}
              </span>
            ) : (
              'No activity'
            )}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Last payout</dt>
          <dd>
            {wallet.lastPayout
              ? `${wallet.lastPayout.payoutNumber} · ${formatDate(wallet.lastPayout.createdAt)}`
              : '—'}
          </dd>
        </div>
      </dl>
    </Link>
  );
}
