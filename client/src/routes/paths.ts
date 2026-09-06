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
    /** My Jobs (Phase 12.1) — the Driver Portal landing page. */
    jobs: '/driver/jobs',
    /** Job Detail (Phase 12.2). `jobType` is the lowercase URL segment ('collection' | 'delivery') — see driverJobRoute.ts. */
    jobDetail: (jobType: string = ':jobType', orderId = ':orderId') =>
      `/driver/jobs/${jobType}/${orderId}`,
    /** Completed work history (Phase 12.5). */
    completed: '/driver/completed',
    /** Failed / Returned work history (Phase 12.5). */
    failed: '/driver/failed',
    /** My Cash (Phase 12.5). */
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
