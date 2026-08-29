import type { RouteObject } from 'react-router-dom';
import { Navigate } from 'react-router-dom';

import AuthLayout from '../layouts/AuthLayout';
import ManagementLayout from '../layouts/ManagementLayout';
import DriverLayout from '../layouts/DriverLayout';
import CustomerLayout from '../layouts/CustomerLayout';
import PublicLayout from '../layouts/PublicLayout';

import NotFoundPage from '../pages/NotFoundPage';
import LoginPlaceholderPage from '../pages/auth/LoginPlaceholderPage';
import TrackingPlaceholderPage from '../pages/public/TrackingPlaceholderPage';
import {
  ManagementDashboardPage,
  ManagementOrdersPage,
  ManagementOrderCreatePage,
  ManagementOrderDetailPage,
  ManagementCustomersPage,
  ManagementCustomerDetailPage,
  ManagementDriversPage,
  ManagementDriverDetailPage,
  ManagementWalletsPage,
  ManagementWalletDetailPage,
  ManagementPayoutsPage,
  ManagementDriverSettlementsPage,
  ManagementFinancePage,
  ManagementReportsPage,
  ManagementEmployeesPage,
  ManagementEmployeeDetailPage,
  ManagementAuditLogsPage,
  ManagementSettingsPage,
} from '../pages/management/managementPages';
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
 * Phase 10.2 — approved URL structure (docs/page_structure.md §41) and nested
 * layout boundaries only.
 *
 * NOT in this phase (every route group is freely routable for now):
 *   - auth / role / permission guards ....... Phase 10.5
 *   - Redux store ........................... Phase 10.3
 *   - RTK Query / backend calls ............. Phase 10.4
 *   - real Management Shell (Sidebar/Navbar). Phase 11.2
 *   - real pages ........................... Phase 11 (mgmt) / 12 (driver) /
 *                                             13 (customer) / 14 (public track)
 *
 * `/` -> `/auth/login` is a deterministic neutral default only; Phase 10.5
 * replaces it with authenticated bootstrap/redirect logic. Group index
 * redirects are structural defaults and imply NO authorization.
 *
 * Production hosting note: the deployment layer (Phase 16) must serve index.html
 * for unknown frontend routes. The Vite dev server already does this. The
 * backend Express app is NOT modified to serve the SPA.
 */
export const routeTree: RouteObject[] = [
  {
    path: '/',
    element: <Navigate to="/auth/login" replace />,
  },

  {
    path: 'auth',
    element: <AuthLayout />,
    children: [
      { index: true, element: <Navigate to="/auth/login" replace /> },
      { path: 'login', element: <LoginPlaceholderPage /> },
    ],
  },

  {
    path: 'management',
    element: <ManagementLayout />,
    children: [
      { index: true, element: <Navigate to="/management/dashboard" replace /> },
      { path: 'dashboard', element: <ManagementDashboardPage /> },
      { path: 'orders', element: <ManagementOrdersPage /> },
      // Static `orders/new` is declared before dynamic `orders/:id`; React Router
      // route ranking also prefers the static segment regardless of order.
      { path: 'orders/new', element: <ManagementOrderCreatePage /> },
      { path: 'orders/:id', element: <ManagementOrderDetailPage /> },
      { path: 'customers', element: <ManagementCustomersPage /> },
      { path: 'customers/:id', element: <ManagementCustomerDetailPage /> },
      { path: 'drivers', element: <ManagementDriversPage /> },
      { path: 'drivers/:id', element: <ManagementDriverDetailPage /> },
      { path: 'wallets', element: <ManagementWalletsPage /> },
      { path: 'wallets/:customerId', element: <ManagementWalletDetailPage /> },
      { path: 'payouts', element: <ManagementPayoutsPage /> },
      {
        path: 'driver-settlements',
        element: <ManagementDriverSettlementsPage />,
      },
      { path: 'finance', element: <ManagementFinancePage /> },
      { path: 'reports', element: <ManagementReportsPage /> },
      { path: 'employees', element: <ManagementEmployeesPage /> },
      { path: 'employees/:id', element: <ManagementEmployeeDetailPage /> },
      { path: 'audit-logs', element: <ManagementAuditLogsPage /> },
      { path: 'settings', element: <ManagementSettingsPage /> },
    ],
  },

  {
    path: 'driver',
    element: <DriverLayout />,
    children: [
      { index: true, element: <Navigate to="/driver/orders" replace /> },
      { path: 'orders', element: <DriverOrdersPage /> },
      { path: 'orders/:id', element: <DriverOrderDetailPage /> },
      { path: 'out-for-delivery', element: <DriverOutForDeliveryPage /> },
      { path: 'completed', element: <DriverCompletedPage /> },
      { path: 'failed', element: <DriverFailedPage /> },
      { path: 'cash', element: <DriverCashPage /> },
    ],
  },

  {
    path: 'customer',
    element: <CustomerLayout />,
    children: [
      { index: true, element: <Navigate to="/customer/dashboard" replace /> },
      { path: 'dashboard', element: <CustomerDashboardPage /> },
      { path: 'orders', element: <CustomerOrdersPage /> },
      { path: 'orders/:id', element: <CustomerOrderDetailPage /> },
      { path: 'wallet', element: <CustomerWalletPage /> },
      { path: 'transactions', element: <CustomerTransactionsPage /> },
      { path: 'payouts', element: <CustomerPayoutsPage /> },
      { path: 'profile', element: <CustomerProfilePage /> },
    ],
  },

  {
    path: 'track',
    element: <PublicLayout />,
    children: [{ index: true, element: <TrackingPlaceholderPage /> }],
  },

  { path: '*', element: <NotFoundPage /> },
];
