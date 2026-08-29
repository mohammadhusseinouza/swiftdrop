import RoutePlaceholder from '../RoutePlaceholder';

/**
 * Phase 10.2 route-target placeholders for the Management route group.
 * All real pages belong to Phase 11 (sub-phase noted per component).
 */
const mgmt = (title: string, phase: string) => (
  <RoutePlaceholder section="Management" title={title} phase={phase} />
);

export const ManagementDashboardPage = () => mgmt('Dashboard', 'Phase 11.11');
export const ManagementOrdersPage = () => mgmt('Orders', 'Phase 11.3');
export const ManagementOrderCreatePage = () => mgmt('Create Order', 'Phase 11.4');
export const ManagementOrderDetailPage = () => mgmt('Order Detail', 'Phase 11.5');
export const ManagementCustomersPage = () => mgmt('Customers', 'Phase 11.6');
export const ManagementCustomerDetailPage = () =>
  mgmt('Customer Detail', 'Phase 11.6');
export const ManagementDriversPage = () => mgmt('Drivers', 'Phase 11.7');
export const ManagementDriverDetailPage = () =>
  mgmt('Driver Detail', 'Phase 11.7');
export const ManagementWalletsPage = () => mgmt('Customer Wallets', 'Phase 11.8');
export const ManagementWalletDetailPage = () =>
  mgmt('Customer Wallet Detail', 'Phase 11.8');
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
