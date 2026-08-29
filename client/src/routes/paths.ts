/**
 * Central route path constants.
 *
 * Phase 10.2 scope: plain URL constants for redirects and (later) <Link> targets.
 * This is intentionally NOT a navigation / permission registry — permission-aware
 * navigation is Phase 11.2, auth guards are Phase 10.5.
 */
export const paths = {
  root: '/',

  auth: {
    root: '/auth',
    login: '/auth/login',
  },

  management: {
    root: '/management',
    dashboard: '/management/dashboard',
    orders: '/management/orders',
    orderNew: '/management/orders/new',
    orderDetail: (id = ':id') => `/management/orders/${id}`,
    customers: '/management/customers',
    customerDetail: (id = ':id') => `/management/customers/${id}`,
    drivers: '/management/drivers',
    driverDetail: (id = ':id') => `/management/drivers/${id}`,
    wallets: '/management/wallets',
    walletDetail: (customerId = ':customerId') =>
      `/management/wallets/${customerId}`,
    payouts: '/management/payouts',
    driverSettlements: '/management/driver-settlements',
    finance: '/management/finance',
    reports: '/management/reports',
    employees: '/management/employees',
    employeeDetail: (id = ':id') => `/management/employees/${id}`,
    auditLogs: '/management/audit-logs',
    settings: '/management/settings',
  },

  driver: {
    root: '/driver',
    orders: '/driver/orders',
    orderDetail: (id = ':id') => `/driver/orders/${id}`,
    outForDelivery: '/driver/out-for-delivery',
    completed: '/driver/completed',
    failed: '/driver/failed',
    cash: '/driver/cash',
  },

  customer: {
    root: '/customer',
    dashboard: '/customer/dashboard',
    orders: '/customer/orders',
    orderDetail: (id = ':id') => `/customer/orders/${id}`,
    wallet: '/customer/wallet',
    transactions: '/customer/transactions',
    payouts: '/customer/payouts',
    profile: '/customer/profile',
  },

  public: {
    track: '/track',
  },
} as const;
