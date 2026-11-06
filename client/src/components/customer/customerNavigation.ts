import { paths } from '../../routes/paths';

/**
 * Customer Portal main navigation (handoff §0 D1-B, page_structure §32).
 *
 * Four items. Transactions and Payouts are tabs inside Wallet, so the Wallet
 * item is the current page on all three Wallet routes. Routes are unchanged.
 */
export interface CustomerNavItem {
  id: 'dashboard' | 'orders' | 'wallet' | 'profile';
  label: string;
  to: string;
  /** Every path prefix for which this item is the current page. */
  activeFor: readonly string[];
}

export const CUSTOMER_NAV_ITEMS: readonly CustomerNavItem[] = [
  { id: 'dashboard', label: 'Dashboard', to: paths.customer.dashboard, activeFor: [paths.customer.dashboard] },
  { id: 'orders', label: 'My Orders', to: paths.customer.orders, activeFor: [paths.customer.orders] },
  {
    id: 'wallet',
    label: 'Wallet',
    to: paths.customer.wallet,
    activeFor: [paths.customer.wallet, paths.customer.transactions, paths.customer.payouts],
  },
  { id: 'profile', label: 'Profile', to: paths.customer.profile, activeFor: [paths.customer.profile] },
];

/** True when `pathname` is one of the item's paths or a sub-path of one ("/customer/orders/123"). */
export function isCustomerNavItemActive(item: CustomerNavItem, pathname: string): boolean {
  const path = pathname.replace(/\/+$/, '') || '/';
  return item.activeFor.some((p) => path === p || path.startsWith(`${p}/`));
}
