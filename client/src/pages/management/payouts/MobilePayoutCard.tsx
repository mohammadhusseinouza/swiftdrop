import { Link } from 'react-router-dom';

import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../lib/format';
import type { PayoutSummary } from '../../../services/domain.types';

import { payoutStatusLabel, payoutStatusTone } from './payoutPresentation';

/**
 * Compact Customer Payout card for narrow screens — the finance table is
 * unusable at 375px. Informational (there is no Payout Detail route) plus the
 * read-only receipt reprint.
 */
export function MobilePayoutCard({
  payout,
  canViewCustomer,
  onPrintReceipt,
}: {
  payout: PayoutSummary;
  canViewCustomer: boolean;
  onPrintReceipt: (payout: PayoutSummary) => void;
}) {
  return (
    <div className="rounded-card border border-line bg-card p-3 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{payout.payoutNumber}</p>
          {canViewCustomer ? (
            <Link
              to={paths.management.customerDetail(payout.customer.id)}
              className="text-xs text-brand-600 hover:underline"
            >
              {payout.customer.name} · {payout.customer.customerNumber}
            </Link>
          ) : (
            <p className="text-xs text-ink-muted">
              {payout.customer.name} · {payout.customer.customerNumber}
            </p>
          )}
        </div>
        <Badge tone={payoutStatusTone(payout.status)}>
          {payoutStatusLabel(payout.status)}
        </Badge>
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div>
          <p className="text-[11px] uppercase tracking-wide text-ink-muted">
            Amount
          </p>
          <p className="text-lg font-semibold tabular-nums text-ink">
            {formatMoney(payout.amount)}
          </p>
        </div>
        <div className="text-right text-xs text-ink-muted">
          <p>{payout.paymentMethod.name}</p>
          <p>{formatDateTime(payout.createdAt)}</p>
        </div>
      </div>

      <div className="mt-3 flex justify-end">
        <Button
          size="sm"
          variant="secondary"
          onClick={() => onPrintReceipt(payout)}
          aria-label={`Print invoice for payout ${payout.payoutNumber}`}
        >
          Print invoice
        </Button>
      </div>
    </div>
  );
}
