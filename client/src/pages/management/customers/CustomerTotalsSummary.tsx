import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetCustomerOrderTotalsQuery } from '../../../services/customersApi';
import { useGetWalletTotalsQuery } from '../../../services/walletsApi';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { cn } from '../../../components/ui/cn';

import { buildCustomerTotalsCards } from './customerTotalsCards';

/**
 * System-wide summary cards for /management/customers. Takes no props on
 * purpose: the totals never depend on the table's search / filters / page,
 * so list param changes cannot refetch them. Each half is fetched only when
 * the caller holds the permission that gates it on Customer Detail; a failed
 * request degrades to `—` without affecting the rest of the page.
 */
export function CustomerTotalsSummary() {
  const showFinancial = useHasPermission(PERMISSIONS.WALLETS_READ);
  const showOrders = useHasPermission(PERMISSIONS.ORDERS_READ);

  const wallet = useGetWalletTotalsQuery(undefined, { skip: !showFinancial });
  const orders = useGetCustomerOrderTotalsQuery(undefined, {
    skip: !showOrders,
  });

  const cards = buildCustomerTotalsCards({
    showFinancial,
    showOrders,
    wallet,
    orders,
  });
  if (cards.length === 0) return null;

  return (
    <section
      aria-label="Customer totals"
      className={cn(
        'grid gap-3 sm:grid-cols-2',
        cards.length === 4 ? 'lg:grid-cols-4' : 'lg:grid-cols-2',
      )}
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
