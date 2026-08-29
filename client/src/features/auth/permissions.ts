/**
 * Frontend permission-code constants — NAMES ONLY.
 *
 * These are the exact V1 permission strings from the backend catalog
 * (`permissions.code`, verified against the live DB). They exist so route and
 * action guards can reference codes without typos.
 *
 * This module encodes NO role → permission mapping. The actual permissions a
 * user holds always come from the backend safe auth response
 * (`AuthenticatedUser.permissions`). The backend re-authorizes every request;
 * these guards are UX only.
 */
export const PERMISSIONS = {
  // Dashboard
  DASHBOARD_READ: 'dashboard.read',

  // Orders
  ORDERS_READ: 'orders.read',
  ORDERS_CREATE: 'orders.create',
  ORDERS_UPDATE: 'orders.update',
  ORDERS_ASSIGN: 'orders.assign',
  ORDERS_CHANGE_STATUS: 'orders.change_status',
  ORDERS_CANCEL: 'orders.cancel',

  // Customers
  CUSTOMERS_READ: 'customers.read',
  CUSTOMERS_CREATE: 'customers.create',
  CUSTOMERS_UPDATE: 'customers.update',

  // Drivers
  DRIVERS_READ: 'drivers.read',
  DRIVERS_MANAGE: 'drivers.manage',

  // Wallets
  WALLETS_READ: 'wallets.read',
  WALLETS_ADJUST: 'wallets.adjust',

  // Payouts
  PAYOUTS_READ: 'payouts.read',
  PAYOUTS_CREATE: 'payouts.create',

  // Settlements
  SETTLEMENTS_READ: 'settlements.read',
  SETTLEMENTS_CREATE: 'settlements.create',

  // Finance
  FINANCE_READ: 'finance.read',
  FINANCE_ADJUST: 'finance.adjust',

  // Reports
  REPORTS_READ: 'reports.read',

  // Employees (route exists from Phase 11.14; permission catalog already has it)
  EMPLOYEES_READ: 'employees.read',
  EMPLOYEES_MANAGE: 'employees.manage',

  // Audit
  AUDIT_READ: 'audit.read',

  // Settings
  SETTINGS_READ: 'settings.read',
  SETTINGS_MANAGE: 'settings.manage',

  // Driver self-service
  DRIVER_ORDERS_READ_OWN: 'driver.orders.read_own',
  DRIVER_ORDERS_UPDATE_OWN: 'driver.orders.update_own',
  DRIVER_CASH_READ_OWN: 'driver.cash.read_own',

  // Customer self-service
  CUSTOMER_DASHBOARD_READ_OWN: 'customer.dashboard.read_own',
  CUSTOMER_ORDERS_READ_OWN: 'customer.orders.read_own',
  CUSTOMER_WALLET_READ_OWN: 'customer.wallet.read_own',
  CUSTOMER_PAYOUTS_READ_OWN: 'customer.payouts.read_own',
  CUSTOMER_PROFILE_READ_OWN: 'customer.profile.read_own',
  CUSTOMER_PROFILE_UPDATE_OWN: 'customer.profile.update_own',
} as const;

export type PermissionCode = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];
