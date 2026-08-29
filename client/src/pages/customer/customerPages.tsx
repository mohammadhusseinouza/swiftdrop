import RoutePlaceholder from '../RoutePlaceholder';

/**
 * Phase 10.2 route-target placeholders for the Customer route group.
 * The real Customer Portal is Phase 13.
 */
const customer = (title: string) => (
  <RoutePlaceholder section="Customer" title={title} phase="Phase 13" />
);

export const CustomerDashboardPage = () => customer('Dashboard');
export const CustomerOrdersPage = () => customer('Orders');
export const CustomerOrderDetailPage = () => customer('Order Detail');
export const CustomerWalletPage = () => customer('Wallet');
export const CustomerTransactionsPage = () => customer('Transactions');
export const CustomerPayoutsPage = () => customer('Payout History');
export const CustomerProfilePage = () => customer('Profile');
