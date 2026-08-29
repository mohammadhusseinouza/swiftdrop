import RoutePlaceholder from '../RoutePlaceholder';

/**
 * Phase 10.2 route-target placeholders for the Management route group.
 * All real pages belong to Phase 11 (sub-phase noted per component).
 */
const mgmt = (title: string, phase: string) => (
  <RoutePlaceholder section="Management" title={title} phase={phase} />
);

export const ManagementDashboardPage = () => mgmt('Dashboard', 'Phase 11.11');
// Create Order (`/management/orders/new`) is a real page — see
// pages/management/orders/create/CreateOrderPage.tsx (Phase 11.4).
// Order Detail (`/management/orders/:id`) is a real page — see
// pages/management/orders/detail/OrderDetailPage.tsx (Phase 11.5).
// Customers + Customer Detail are real pages — see
// pages/management/customers/ (Phase 11.6).
// Drivers + Driver Detail are real pages — see
// pages/management/drivers/ (Phase 11.7).
// Customer Wallets + Wallet Detail are real pages — see
// pages/management/wallets/ (Phase 11.8).
export const ManagementPayoutsPage = () => mgmt('Customer Payouts', 'Phase 11.9');
export const ManagementDriverSettlementsPage = () =>
  mgmt('Driver Settlements', 'Phase 11.10');
export const ManagementFinancePage = () => mgmt('Finance', 'Phase 11.12');
export const ManagementReportsPage = () => mgmt('Reports', 'Phase 11.13');
export const ManagementEmployeesPage = () => mgmt('Employees', 'Phase 11.14');
export const ManagementEmployeeDetailPage = () =>
  mgmt('Employee Detail', 'Phase 11.14');
export const ManagementAuditLogsPage = () => mgmt('Audit Logs', 'Phase 11.15');
export const ManagementSettingsPage = () => mgmt('Settings', 'Phase 11.16');
