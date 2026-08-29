import RoutePlaceholder from '../RoutePlaceholder';

/**
 * Phase 10.2 route-target placeholders for the Driver route group.
 * The real mobile-first Driver Portal is Phase 12.
 */
const driver = (title: string) => (
  <RoutePlaceholder section="Driver" title={title} phase="Phase 12" />
);

export const DriverOrdersPage = () => driver('Assigned Orders');
export const DriverOrderDetailPage = () => driver('Order Detail');
export const DriverOutForDeliveryPage = () => driver('Out for Delivery');
export const DriverCompletedPage = () => driver('Completed');
export const DriverFailedPage = () => driver('Failed');
export const DriverCashPage = () => driver('Driver Cash');
