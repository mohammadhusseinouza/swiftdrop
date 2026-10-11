import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetDriverCashTotalsQuery,
  useGetDriverOperationalTotalsQuery,
} from '../../../services/driversApi';
import { StatisticCard } from '../../../components/data-display/StatisticCard';

import { buildDriverTotalsCards, driverTotalsGridClass } from './driverTotalsCards';

/**
 * System-wide summary cards for /management/drivers. Takes no props on
 * purpose: the totals never depend on the table's search / filters / page,
 * so list param changes cannot refetch them. Cash Held is fetched only with
 * finance.read (same gate as Driver Detail); a failed request degrades to
 * `—` without affecting the rest of the page.
 */
export function DriverTotalsSummary() {
  const showCash = useHasPermission(PERMISSIONS.FINANCE_READ);

  const operational = useGetDriverOperationalTotalsQuery();
  const cash = useGetDriverCashTotalsQuery(undefined, { skip: !showCash });

  const cards = buildDriverTotalsCards({ showCash, operational, cash });

  return (
    <section
      aria-label="Driver totals"
      className={driverTotalsGridClass(cards.length)}
    >
      {cards.map((c) => (
        <StatisticCard
          key={c.key}
          label={c.label}
          value={c.value}
          supportingText={c.supportingText}
        />
      ))}
    </section>
  );
}
