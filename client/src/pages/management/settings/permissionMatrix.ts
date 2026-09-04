import type { PermissionCatalogEntry } from '../../../services/domain.types';

/**
 * PRESENTATION-ONLY grouping of the permission catalog by domain, for the
 * Settings role matrix. Grouping is derived from the code prefix; it never
 * changes a code and never implies partial assignment.
 */
const GROUPS: { id: string; label: string; match: (code: string) => boolean }[] =
  [
    { id: 'dashboard', label: 'Dashboard', match: (c) => c.startsWith('dashboard.') },
    { id: 'orders', label: 'Orders', match: (c) => c.startsWith('orders.') },
    { id: 'customers', label: 'Customers', match: (c) => c.startsWith('customers.') },
    { id: 'drivers', label: 'Drivers', match: (c) => c.startsWith('drivers.') },
    { id: 'wallets', label: 'Customer wallets', match: (c) => c.startsWith('wallets.') },
    { id: 'payouts', label: 'Customer payouts', match: (c) => c.startsWith('payouts.') },
    { id: 'settlements', label: 'Driver settlements', match: (c) => c.startsWith('settlements.') },
    { id: 'finance', label: 'Finance', match: (c) => c.startsWith('finance.') },
    { id: 'reports', label: 'Reports', match: (c) => c.startsWith('reports.') },
    { id: 'employees', label: 'Employees', match: (c) => c.startsWith('employees.') },
    { id: 'audit', label: 'Audit', match: (c) => c.startsWith('audit.') },
    { id: 'settings', label: 'Settings', match: (c) => c.startsWith('settings.') },
    { id: 'driver-self', label: 'Driver self-service', match: (c) => c.startsWith('driver.') },
    { id: 'customer-self', label: 'Customer self-service', match: (c) => c.startsWith('customer.') },
  ];

export interface PermissionMatrixGroup {
  id: string;
  label: string;
  permissions: PermissionCatalogEntry[];
}

/**
 * @param catalog full permission catalog
 * @param onlyCodes when given, restrict to these codes (e.g. the
 *   management-role assignable set — portal groups then disappear entirely)
 */
export function buildPermissionMatrix(
  catalog: PermissionCatalogEntry[],
  onlyCodes?: readonly string[],
): PermissionMatrixGroup[] {
  const allow = onlyCodes ? new Set(onlyCodes) : null;
  const groups: PermissionMatrixGroup[] = GROUPS.map((g) => ({
    id: g.id,
    label: g.label,
    permissions: [],
  }));
  const other: PermissionMatrixGroup = { id: 'other', label: 'Other', permissions: [] };

  for (const p of [...catalog].sort((a, b) => a.code.localeCompare(b.code))) {
    if (allow && !allow.has(p.code)) continue;
    const def = GROUPS.find((g) => g.match(p.code));
    (def ? groups.find((g) => g.id === def.id)! : other).permissions.push(p);
  }

  const result = groups.filter((g) => g.permissions.length > 0);
  if (other.permissions.length > 0) result.push(other);
  return result;
}

/**
 * Permissions that grant broad administrative control. Granting one of these
 * to a non-Admin role is legitimate but security-sensitive — the confirm
 * step must call it out explicitly (§75).
 */
export const ELEVATED_PERMISSION_CODES = new Set([
  'settings.manage',
  'employees.manage',
  'audit.read',
  'finance.adjust',
  'wallets.adjust',
]);
