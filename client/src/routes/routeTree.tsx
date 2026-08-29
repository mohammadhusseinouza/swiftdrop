import type { ReactNode } from 'react';
import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';

import AuthLayout from '../layouts/AuthLayout';
import ManagementLayout from '../layouts/ManagementLayout';
import DriverLayout from '../layouts/DriverLayout';
import CustomerLayout from '../layouts/CustomerLayout';
import PublicLayout from '../layouts/PublicLayout';

import AuthBootstrapBoundary from './guards/AuthBootstrapBoundary';
import RootRedirect from './guards/RootRedirect';
import GuestOnly from './guards/GuestOnly';
import RequirePortal from './guards/RequirePortal';
import RequirePermission from './guards/RequirePermission';

import NotFoundPage from '../pages/NotFoundPage';
import UnauthorizedPage from '../pages/UnauthorizedPage';
import LoginPage from '../pages/auth/LoginPage';
import TrackingPlaceholderPage from '../pages/public/TrackingPlaceholderPage';
import { PERMISSIONS as P } from '../features/auth/permissions';
import {
  ManagementDashboardPage,
  ManagementPayoutsPage,
  ManagementDriverSettlementsPage,
  ManagementFinancePage,
  ManagementReportsPage,
  ManagementEmployeesPage,
  ManagementEmployeeDetailPage,
  ManagementAuditLogsPage,
  ManagementSettingsPage,
} from '../pages/management/managementPages';
import OrdersListPage from '../pages/management/orders/OrdersListPage';
import CreateOrderPage from '../pages/management/orders/create/CreateOrderPage';
import OrderDetailPage from '../pages/management/orders/detail/OrderDetailPage';
import CustomersListPage from '../pages/management/customers/CustomersListPage';
import CustomerDetailPage from '../pages/management/customers/CustomerDetailPage';
import DriversListPage from '../pages/management/drivers/DriversListPage';
import DriverDetailPage from '../pages/management/drivers/DriverDetailPage';
import WalletsListPage from '../pages/management/wallets/WalletsListPage';
import WalletDetailPage from '../pages/management/wallets/WalletDetailPage';
import {
  DriverOrdersPage,
  DriverOrderDetailPage,
  DriverOutForDeliveryPage,
  DriverCompletedPage,
  DriverFailedPage,
  DriverCashPage,
} from '../pages/driver/driverPages';
import {
  CustomerDashboardPage,
  CustomerOrdersPage,
  CustomerOrderDetailPage,
  CustomerWalletPage,
  CustomerTransactionsPage,
  CustomerPayoutsPage,
  CustomerProfilePage,
} from '../pages/customer/customerPages';

/**
 * Phase 10.5 — Auth bootstrap + portal isolation + permission guards.
 *
 * Guard order:  AuthBootstrapBoundary → RequirePortal (auth + role family)
 *               → RequirePermission (page permission) → page.
 *
 * FRONTEND GUARDS ARE UX ONLY. Every backend endpoint independently enforces
 * authentication, permissions, ownership and IDOR prevention. Hiding a route
 * never secures an API.
 *
 * `/track` sits OUTSIDE the bootstrap boundary — public, no auth wait.
 * NotFound (`*`) is also outside — an unknown route is not a forbidden route.
 *
 * Management page → required permission (backend catalog, verified live):
 *   dashboard      dashboard.read      customers[/:id]  customers.read
 *   orders         orders.read         drivers[/:id]    drivers.read
 *   orders/new     orders.create       wallets[/:id]    wallets.read
 *   orders/:id     orders.read         payouts          payouts.read
 *   driver-settlements settlements.read finance         finance.read
 *   reports        reports.read        employees[/:id]  employees.read
 *   audit-logs     audit.read          settings         settings.read
 *
 * Notes matching the seed catalog: DISPATCHER & FINANCE hold settings.read
 * (Settings page is readable; settings.manage controls are gated later);
 * reports.read belongs to all three Management roles (no extra finance.read
 * requirement); audit.read is ADMIN-only.
 */

/** A single guarded page: `RequirePermission` wrapping one element. */
function permitted(
  permission: string | readonly string[],
  element: ReactNode,
): Pick<RouteObject, 'element' | 'children'> {
  return {
    element: <RequirePermission permission={permission} />,
    children: [{ index: true, element }],
  };
}

const managementChildren: RouteObject[] = [
  { index: true, element: <Navigate to="/management/dashboard" replace /> },
  { path: 'dashboard', ...permitted(P.DASHBOARD_READ, <ManagementDashboardPage />) },
  { path: 'orders', ...permitted(P.ORDERS_READ, <OrdersListPage />) },
  // Static `orders/new` before dynamic `orders/:id` (React Router also ranks
  // the static segment higher regardless of declaration order).
  { path: 'orders/new', ...permitted(P.ORDERS_CREATE, <CreateOrderPage />) },
  { path: 'orders/:id', ...permitted(P.ORDERS_READ, <OrderDetailPage />) },
  { path: 'customers', ...permitted(P.CUSTOMERS_READ, <CustomersListPage />) },
  { path: 'customers/:id', ...permitted(P.CUSTOMERS_READ, <CustomerDetailPage />) },
  { path: 'drivers', ...permitted(P.DRIVERS_READ, <DriversListPage />) },
  { path: 'drivers/:id', ...permitted(P.DRIVERS_READ, <DriverDetailPage />) },
  { path: 'wallets', ...permitted(P.WALLETS_READ, <WalletsListPage />) },
  { path: 'wallets/:customerId', ...permitted(P.WALLETS_READ, <WalletDetailPage />) },
  { path: 'payouts', ...permitted(P.PAYOUTS_READ, <ManagementPayoutsPage />) },
  { path: 'driver-settlements', ...permitted(P.SETTLEMENTS_READ, <ManagementDriverSettlementsPage />) },
  { path: 'finance', ...permitted(P.FINANCE_READ, <ManagementFinancePage />) },
  { path: 'reports', ...permitted(P.REPORTS_READ, <ManagementReportsPage />) },
  { path: 'employees', ...permitted(P.EMPLOYEES_READ, <ManagementEmployeesPage />) },
  { path: 'employees/:id', ...permitted(P.EMPLOYEES_READ, <ManagementEmployeeDetailPage />) },
  { path: 'audit-logs', ...permitted(P.AUDIT_READ, <ManagementAuditLogsPage />) },
  { path: 'settings', ...permitted(P.SETTINGS_READ, <ManagementSettingsPage />) },
];

const driverChildren: RouteObject[] = [
  { index: true, element: <Navigate to="/driver/orders" replace /> },
  { path: 'orders', element: <DriverOrdersPage /> },
  { path: 'orders/:id', element: <DriverOrderDetailPage /> },
  { path: 'out-for-delivery', element: <DriverOutForDeliveryPage /> },
  { path: 'completed', element: <DriverCompletedPage /> },
  { path: 'failed', element: <DriverFailedPage /> },
  { path: 'cash', element: <DriverCashPage /> },
];

const customerChildren: RouteObject[] = [
  { index: true, element: <Navigate to="/customer/dashboard" replace /> },
  { path: 'dashboard', element: <CustomerDashboardPage /> },
  { path: 'orders', element: <CustomerOrdersPage /> },
  { path: 'orders/:id', element: <CustomerOrderDetailPage /> },
  { path: 'wallet', element: <CustomerWalletPage /> },
  { path: 'transactions', element: <CustomerTransactionsPage /> },
  { path: 'payouts', element: <CustomerPayoutsPage /> },
  { path: 'profile', element: <CustomerProfilePage /> },
];

export const routeTree: RouteObject[] = [
  {
    element: <AuthBootstrapBoundary />,
    children: [
      { path: '/', element: <RootRedirect /> },
      { path: 'unauthorized', element: <UnauthorizedPage /> },

      {
        path: 'auth',
        element: <GuestOnly />,
        children: [
          {
            element: <AuthLayout />,
            children: [
              { index: true, element: <Navigate to="/auth/login" replace /> },
              { path: 'login', element: <LoginPage /> },
            ],
          },
        ],
      },

      {
        path: 'management',
        element: <RequirePortal portal="management" />,
        children: [{ element: <ManagementLayout />, children: managementChildren }],
      },

      {
        path: 'driver',
        element: <RequirePortal portal="driver" />,
        children: [{ element: <DriverLayout />, children: driverChildren }],
      },

      {
        path: 'customer',
        element: <RequirePortal portal="customer" />,
        children: [{ element: <CustomerLayout />, children: customerChildren }],
      },
    ],
  },

  // Public — outside the auth bootstrap boundary.
  {
    path: 'track',
    element: <PublicLayout />,
    children: [{ index: true, element: <TrackingPlaceholderPage /> }],
  },

  { path: '*', element: <NotFoundPage /> },
];
