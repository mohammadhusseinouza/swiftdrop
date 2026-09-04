import type { EmployeePermissionRef } from '../../../services/domain.types';

/**
 * PRESENTATION-ONLY grouping of permission codes by domain. Grouping is
 * derived from the code prefix — it never changes a code and never implies a
 * per-permission toggle (permissions are inherited whole from the role).
 */

const GROUP_ORDER: { id: string; label: string; match: (code: string) => boolean }[] = [
  { id: 'dashboard', label: 'Overview', match: (c) => c.startsWith('dashboard.') },
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

export interface PermissionGroup {
  id: string;
  label: string;
  permissions: EmployeePermissionRef[];
}

export function groupPermissions(
  permissions: EmployeePermissionRef[],
): PermissionGroup[] {
  const groups: PermissionGroup[] = GROUP_ORDER.map((g) => ({
    id: g.id,
    label: g.label,
    permissions: [],
  }));
  const other: PermissionGroup = { id: 'other', label: 'Other', permissions: [] };

  for (const p of permissions) {
    const def = GROUP_ORDER.find((g) => g.match(p.code));
    const target = def ? groups.find((g) => g.id === def.id)! : other;
    target.permissions.push(p);
  }

  const result = groups.filter((g) => g.permissions.length > 0);
  if (other.permissions.length > 0) result.push(other);
  return result;
}
