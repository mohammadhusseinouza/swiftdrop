/**
 * Pure pathname → Management page title (for the TopNavbar context label).
 * No API call — a `:id` route shows a generic "… Details" label, never the
 * entity's name. Order matters: more specific patterns come first.
 */
const TITLE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/management\/dashboard\/?$/, 'Dashboard'],
  [/^\/management\/orders\/new\/?$/, 'Create Order'],
  [/^\/management\/orders\/[^/]+\/?$/, 'Order Details'],
  [/^\/management\/orders\/?$/, 'Orders'],
  [/^\/management\/customers\/[^/]+\/?$/, 'Customer Details'],
  [/^\/management\/customers\/?$/, 'Customers'],
  [/^\/management\/drivers\/[^/]+\/?$/, 'Driver Details'],
  [/^\/management\/drivers\/?$/, 'Drivers'],
  [/^\/management\/wallets\/[^/]+\/?$/, 'Wallet Details'],
  [/^\/management\/wallets\/?$/, 'Customer Wallets'],
  [/^\/management\/payouts\/?$/, 'Customer Payouts'],
  [/^\/management\/driver-settlements\/?$/, 'Driver Settlements'],
  [/^\/management\/finance\/?$/, 'Finance'],
  [/^\/management\/reports\/?$/, 'Reports'],
  [/^\/management\/employees\/[^/]+\/?$/, 'Employee Details'],
  [/^\/management\/employees\/?$/, 'Employees'],
  [/^\/management\/audit-logs\/?$/, 'Audit Logs'],
  [/^\/management\/settings\/?$/, 'Settings'],
];

export function getManagementRouteTitle(pathname: string): string {
  for (const [pattern, title] of TITLE_RULES) {
    if (pattern.test(pathname)) return title;
  }
  return 'Management';
}
