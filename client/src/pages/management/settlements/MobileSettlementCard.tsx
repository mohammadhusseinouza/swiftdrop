import { Link } from 'react-router-dom';

import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../lib/format';
import type { SettlementSummary } from '../../../services/domain.types';
import { Badge } from '../../../components/ui/Badge';
import { isLegacySettlement } from './settlementPresentation';

/**
 * Compact Driver Settlement card for narrow screens — the finance table is
 * unusable at 375px. The settlement number opens the Settlement Detail (FR.9).
 */
export function MobileSettlementCard({
  settlement,
  canViewDriver,
}: {
  settlement: SettlementSummary;
  canViewDriver: boolean;
}) {
  const name = `${settlement.driver.user.firstName} ${settlement.driver.user.lastName}`;
  return (
    <div className="rounded-card border border-line bg-card p-3 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5">
            <Link
              to={paths.management.driverSettlementDetail(settlement.id)}
              className="font-semibold text-brand-600 hover:underline"
            >
              {settlement.settlementNumber}
            </Link>
            {settlement.reversed && <Badge tone="danger">Reversed</Badge>}
          </p>
          {canViewDriver ? (
            <Link
              to={paths.management.driverDetail(settlement.driver.id)}
              className="text-xs text-brand-600 hover:underline"
            >
              {name} · {settlement.driver.driverNumber}
            </Link>
          ) : (
            <p className="text-xs text-ink-muted">
              {name} · {settlement.driver.driverNumber}
            </p>
          )}
        </div>
        <div className="text-right">
          <p className="text-[11px] uppercase tracking-wide text-ink-muted">
            Received
          </p>
          <p className="text-lg font-semibold tabular-nums text-ink">
            {formatMoney(settlement.amountReceived)}
          </p>
        </div>
      </div>

      <dl className="mt-3 space-y-1 border-t border-line pt-2 text-xs text-ink-muted">
        <div className="flex items-center justify-between gap-2">
          <dt>Payment method</dt>
          <dd>{settlement.paymentMethod.name}</dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Allocated</dt>
          <dd className="tabular-nums">
            {isLegacySettlement(settlement) ? 'Legacy' : formatMoney(settlement.allocatedTotal)}
          </dd>
        </div>
        {!isLegacySettlement(settlement) && (
          <div className="flex items-center justify-between gap-2">
            <dt>Unattributed</dt>
            <dd className="tabular-nums">{formatMoney(settlement.unattributedAmount)}</dd>
          </div>
        )}
        <div className="flex items-center justify-between gap-2">
          <dt>Balance after</dt>
          <dd className="tabular-nums">
            {formatMoney(settlement.balanceAfter)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Date</dt>
          <dd>{formatDateTime(settlement.createdAt)}</dd>
        </div>
      </dl>
    </div>
  );
}
