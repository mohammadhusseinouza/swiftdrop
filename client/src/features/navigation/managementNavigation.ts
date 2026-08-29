import type { ComponentType } from 'react';
import type { LucideProps } from 'lucide-react';
import {
  Banknote,
  ChartColumn,
  HandCoins,
  Landmark,
  LayoutDashboard,
  Package,
  PlusCircle,
  ScrollText,
  Settings,
  Truck,
  UserCog,
  Users,
  WalletCards,
} from 'lucide-react';
import { PERMISSIONS as P } from '../auth/permissions';
import { hasPermission } from '../auth/permissionUtils';

/**
 * Central Management navigation definition (Phase 11.2).
 *
 * Grouping follows docs/page_structure.md §2 exactly:
 *   Overview → Operations → Finance → Administration
 * (Reports lives under Administration, NOT Finance.)
 *
 * Every `permission` here is the SAME `PERMISSIONS.*` constant the matching
 * route uses in routeTree.tsx — the equality is asserted in verification so the
 * sidebar can never show an item whose route would 403 (or hide one that
 * wouldn't). Sidebar visibility is UX only; RequirePermission still guards the
 * route and the backend authorizes every request.
 */
export type ManagementNavGroupId =
  | 'overview'
  | 'operations'
  | 'finance'
  | 'administration';

export interface ManagementNavItem {
  id: string;
  label: string;
  to: string;
  permission: string;
  icon: ComponentType<LucideProps>;
  /** Visually subordinate row (Create Order under Orders). */
  indent?: boolean;
}

export interface ManagementNavGroup {
  id: ManagementNavGroupId;
  label: string;
  items: ManagementNavItem[];
}

export const MANAGEMENT_NAVIGATION: readonly ManagementNavGroup[] = [
  {
    id: 'overview',
    label: 'Overview',
    items: [
      {
        id: 'dashboard',
        label: 'Dashboard',
        to: '/management/dashboard',
        permission: P.DASHBOARD_READ,
        icon: LayoutDashboard,
      },
    ],
  },
  {
    id: 'operations',
    label: 'Operations',
    items: [
      {
        id: 'orders',
        label: 'Orders',
        to: '/management/orders',
        permission: P.ORDERS_READ,
        icon: Package,
      },
      {
        id: 'orders-new',
        label: 'Create Order',
        to: '/management/orders/new',
        permission: P.ORDERS_CREATE,
        icon: PlusCircle,
        indent: true,
      },
      {
        id: 'customers',
        label: 'Customers',
        to: '/management/customers',
        permission: P.CUSTOMERS_READ,
        icon: Users,
      },
      {
        id: 'drivers',
        label: 'Drivers',
        to: '/management/drivers',
        permission: P.DRIVERS_READ,
        icon: Truck,
      },
    ],
  },
  {
    id: 'finance',
    label: 'Finance',
    items: [
      {
        id: 'wallets',
        label: 'Customer Wallets',
        to: '/management/wallets',
        permission: P.WALLETS_READ,
        icon: WalletCards,
      },
      {
        id: 'payouts',
        label: 'Customer Payouts',
        to: '/management/payouts',
        permission: P.PAYOUTS_READ,
        icon: Banknote,
      },
      {
        id: 'settlements',
        label: 'Driver Settlements',
        to: '/management/driver-settlements',
        permission: P.SETTLEMENTS_READ,
        icon: HandCoins,
      },
      {
        id: 'finance',
        label: 'Finance',
        to: '/management/finance',
        permission: P.FINANCE_READ,
        icon: Landmark,
      },
    ],
  },
  {
    id: 'administration',
    label: 'Administration',
    items: [
      {
        id: 'employees',
        label: 'Employees',
        to: '/management/employees',
        permission: P.EMPLOYEES_READ,
        icon: UserCog,
      },
      {
        id: 'reports',
        label: 'Reports',
        to: '/management/reports',
        permission: P.REPORTS_READ,
        icon: ChartColumn,
      },
      {
        id: 'audit-logs',
        label: 'Audit Logs',
        to: '/management/audit-logs',
        permission: P.AUDIT_READ,
        icon: ScrollText,
      },
      {
        id: 'settings',
        label: 'Settings',
        to: '/management/settings',
        permission: P.SETTINGS_READ,
        icon: Settings,
      },
    ],
  },
];

/**
 * Pure: the navigation visible for a hydrated permission array. Items the user
 * lacks permission for are dropped; a group with no remaining items is removed
 * (no empty section headings). NEVER inspects role.
 */
export function buildManagementNavigation(
  permissions: readonly string[],
): ManagementNavGroup[] {
  return MANAGEMENT_NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) =>
      hasPermission(permissions, item.permission),
    ),
  })).filter((group) => group.items.length > 0);
}

/**
 * The id of the single active nav item for a pathname, or null.
 *
 * An item matches when the pathname equals its `to` or is nested under it
 * (`to` + "/..."). The MOST specific match wins (longest `to`), so
 * `/management/orders/new` activates "Create Order" only — never also "Orders"
 * — and `/management/orders/:id` activates "Orders" only.
 */
export function getActiveManagementNavId(pathname: string): string | null {
  let best: { id: string; length: number } | null = null;
  for (const group of MANAGEMENT_NAVIGATION) {
    for (const item of group.items) {
      const matches =
        pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (matches && (best === null || item.to.length > best.length)) {
        best = { id: item.id, length: item.to.length };
      }
    }
  }
  return best?.id ?? null;
}
