import { Phone } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { paths } from '../../../routes/paths';
import { formatMoney } from '../../../lib/format';
import type { DriverSummary } from '../../../services/domain.types';

/** Compact Driver card for mobile widths — links to the Driver Detail page. */
export function MobileDriverCard({
  driver,
  cashHeld,
  showCash,
}: {
  driver: DriverSummary;
  cashHeld: string | null;
  showCash: boolean;
}) {
  const s = driver.operationalSummary;
  return (
    <Link
      to={paths.management.driverDetail(driver.id)}
      className="block rounded-card border border-line bg-card p-3 shadow-card hover:border-brand-600"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">
            {driver.user.firstName} {driver.user.lastName}
          </p>
          <p className="text-xs text-ink-muted">{driver.driverNumber}</p>
        </div>
        <ActiveBadge isActive={driver.isActive} />
      </div>

      {driver.user.phone && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-ink-muted">
          <Phone className="size-3.5" aria-hidden="true" />
          {driver.user.phone}
        </p>
      )}

      <dl className="mt-2 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-control bg-sunken py-1.5">
          <dt className="text-[11px] text-ink-muted">Active</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {s.activeOrders}
          </dd>
        </div>
        <div className="rounded-control bg-sunken py-1.5">
          <dt className="text-[11px] text-ink-muted">Out</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {s.outForDelivery}
          </dd>
        </div>
        <div className="rounded-control bg-sunken py-1.5">
          <dt className="text-[11px] text-ink-muted">Done today</dt>
          <dd className="text-sm font-semibold tabular-nums">
            {s.completedToday}
          </dd>
        </div>
      </dl>

      {showCash && (
        <p className="mt-2 text-xs text-ink-muted">
          Cash held:{' '}
          <span className="font-medium tabular-nums text-ink">
            {cashHeld != null ? formatMoney(cashHeld) : '…'}
          </span>
        </p>
      )}
    </Link>
  );
}
