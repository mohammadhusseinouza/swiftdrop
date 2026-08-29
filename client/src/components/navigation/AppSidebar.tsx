import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { LucideProps } from 'lucide-react';
import { cn } from '../ui/cn';

/**
 * PRESENTATIONAL, CONTROLLED sidebar (Phase 10.6). Composed by the Phase 11.2
 * Management shell.
 *
 * It does NOT: decide permissions, import Redux, call RTK Query, call logout,
 * own the authenticated user, compute route semantics, or define routes. The
 * shell computes `active` per item (route matching lives there) and supplies
 * `onNavigate` (used by the mobile drawer to close on selection).
 */
export interface SidebarNavItem {
  id: string;
  label: string;
  to: string;
  icon?: ComponentType<LucideProps>;
  /** Controlled active state — the shell decides which single item is active. */
  active?: boolean;
  /** Render as a visually subordinate row (e.g. "Create Order" under "Orders"). */
  indent?: boolean;
  /** Optional trailing count/indicator. */
  badge?: ReactNode;
}

export interface SidebarSection {
  id: string;
  /** Optional group label ("Operations", "Finance", …); hidden when collapsed. */
  label?: string;
  items: SidebarNavItem[];
}

export interface SidebarUser {
  name: string;
  secondary?: string;
}

export interface AppSidebarProps {
  /** Expanded brand wordmark. */
  brand?: ReactNode;
  /** Small mark shown beside/instead of the wordmark (both states). */
  brandIcon?: ReactNode;
  /** Accessible name for the <nav> landmark. */
  navLabel?: string;
  sections: SidebarSection[];
  collapsed?: boolean;
  /** Called after a nav link is activated (mobile drawer closes on this). */
  onNavigate?: () => void;
  /** Bottom user area (supplied by the shell — never hard-coded). */
  user?: SidebarUser;
  /** Slot under the user summary (e.g. the shell's user menu / logout). */
  userActions?: ReactNode;
  className?: string;
}

export function AppSidebar({
  brand = 'SwiftDrop',
  brandIcon,
  navLabel = 'Primary',
  sections,
  collapsed = false,
  onNavigate,
  user,
  userActions,
  className,
}: AppSidebarProps) {
  return (
    <div
      className={cn(
        'flex h-full flex-col bg-chrome text-chrome-ink',
        collapsed ? 'w-16' : 'w-60',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-15 shrink-0 items-center gap-2 border-b border-chrome-line px-4',
          'text-sm font-semibold tracking-tight text-chrome-ink-strong',
          collapsed && 'justify-center px-0',
        )}
      >
        {brandIcon && (
          <span className="shrink-0 [&>svg]:size-5" aria-hidden="true">
            {brandIcon}
          </span>
        )}
        {!collapsed && <span>{brand}</span>}
      </div>

      <nav
        aria-label={navLabel}
        className="flex-1 space-y-4 overflow-y-auto px-2 py-3"
      >
        {sections.map((section) => (
          <div key={section.id}>
            {section.label && !collapsed && (
              <p className="px-2 pb-1 text-[0.6875rem] font-semibold tracking-wide text-chrome-ink/60 uppercase">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <Link
                      to={item.to}
                      onClick={onNavigate}
                      aria-current={item.active ? 'page' : undefined}
                      aria-label={collapsed ? item.label : undefined}
                      title={collapsed ? item.label : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-control px-2.5 py-2 text-sm transition-colors',
                        collapsed && 'justify-center',
                        item.indent && !collapsed && 'ml-3',
                        item.active
                          ? 'bg-brand-600 text-white'
                          : 'text-chrome-ink hover:bg-chrome-deep hover:text-chrome-ink-strong',
                      )}
                    >
                      {Icon && (
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                      )}
                      {!collapsed && <span className="flex-1">{item.label}</span>}
                      {!collapsed && item.badge}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {user && (
        <div className="shrink-0 border-t border-chrome-line p-3">
          <div className={cn('min-w-0', collapsed && 'text-center')}>
            <p className="truncate text-sm font-medium text-chrome-ink-strong">
              {collapsed ? user.name.charAt(0) : user.name}
            </p>
            {!collapsed && user.secondary && (
              <p className="truncate text-xs text-chrome-ink">{user.secondary}</p>
            )}
          </div>
          {!collapsed && userActions && <div className="mt-2">{userActions}</div>}
        </div>
      )}
    </div>
  );
}
