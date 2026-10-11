import { formatMoney } from '../../../lib/format';
import type {
  DriverOperationalSummary,
  ManagementDriverCashTotals,
} from '../../../services/domain.types';

/**
 * Card model for the Management Drivers page summary — the same four cards
 * (and the same permission gating) as the Driver Detail summary, but fed by
 * the system-wide totals endpoints. Values come ONLY from those endpoints,
 * never from the rows rendered in the (paginated / filtered) table.
 */

export interface TotalsQueryState<T> {
  data?: T;
  isError: boolean;
}

export interface DriverTotalsCard {
  key: 'assignedOrders' | 'outForDelivery' | 'deliveredToday' | 'cashHeld';
  label: string;
  value: string;
  supportingText?: string;
}

/** Same placeholder convention as Driver Detail: `…` loading, `—` failed. */
function display<T>(q: TotalsQueryState<T>, pick: (d: T) => string): string {
  if (q.data) return pick(q.data);
  return q.isError ? '—' : '…';
}

export function buildDriverTotalsCards(input: {
  showCash: boolean;
  operational: TotalsQueryState<DriverOperationalSummary>;
  cash: TotalsQueryState<ManagementDriverCashTotals>;
}): DriverTotalsCard[] {
  const cards: DriverTotalsCard[] = [
    {
      key: 'assignedOrders',
      label: 'Assigned orders',
      value: display(input.operational, (d) => String(d.activeOrders)),
      supportingText: 'Active work currently held',
    },
    {
      key: 'outForDelivery',
      label: 'Out for delivery',
      value: display(input.operational, (d) => String(d.outForDelivery)),
    },
    {
      key: 'deliveredToday',
      label: 'Delivered today',
      value: display(input.operational, (d) => String(d.completedToday)),
      supportingText: 'Successful deliveries completed today',
    },
  ];
  if (input.showCash) {
    cards.push({
      key: 'cashHeld',
      label: 'Cash held',
      value: display(input.cash, (d) => formatMoney(d.currentBalance)),
      supportingText: 'Not yet settled',
    });
  }
  return cards;
}

/**
 * Desktop column count follows the visible cards (4, or 3 without
 * finance.read) so a hidden Cash Held card never leaves an empty slot.
 */
export function driverTotalsGridClass(cardCount: number): string {
  return cardCount >= 4
    ? 'grid gap-3 sm:grid-cols-2 lg:grid-cols-4'
    : 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3';
}
