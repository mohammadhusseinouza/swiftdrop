import { formatMoney } from '../../../lib/format';
import type {
  CustomerOrderTotals,
  WalletTotals,
} from '../../../services/domain.types';

/**
 * Card model for the Management Customers page summary — the same four cards
 * (and the same permission gating) as the Customer Detail summary, but fed by
 * the system-wide totals endpoints. Values come ONLY from those endpoints,
 * never from the rows rendered in the (paginated / filtered) table.
 */

export interface TotalsQueryState<T> {
  data?: T;
  isError: boolean;
}

export interface CustomerTotalsCard {
  key: 'availableWallet' | 'pendingAmount' | 'activeOrders' | 'deliveredOrders';
  label: string;
  value: string;
  supportingText?: string;
}

/** Same placeholder convention as Customer Detail: `…` loading, `—` failed. */
function display<T>(q: TotalsQueryState<T>, pick: (d: T) => string): string {
  if (q.data) return pick(q.data);
  return q.isError ? '—' : '…';
}

export function buildCustomerTotalsCards(input: {
  showFinancial: boolean;
  showOrders: boolean;
  wallet: TotalsQueryState<WalletTotals>;
  orders: TotalsQueryState<CustomerOrderTotals>;
}): CustomerTotalsCard[] {
  const cards: CustomerTotalsCard[] = [];
  if (input.showFinancial) {
    cards.push(
      {
        key: 'availableWallet',
        label: 'Available wallet',
        value: display(input.wallet, (d) => formatMoney(d.availableBalance)),
      },
      {
        key: 'pendingAmount',
        label: 'Pending amount',
        value: display(input.wallet, (d) => formatMoney(d.pendingAmount)),
        supportingText: 'Qualifying active delivery-only orders',
      },
    );
  }
  if (input.showOrders) {
    cards.push(
      {
        key: 'activeOrders',
        label: 'Active orders',
        value: display(input.orders, (d) => String(d.activeOrders)),
        supportingText: 'Not yet in a terminal state',
      },
      {
        key: 'deliveredOrders',
        label: 'Delivered orders',
        value: display(input.orders, (d) => String(d.deliveredOrders)),
      },
    );
  }
  return cards;
}
