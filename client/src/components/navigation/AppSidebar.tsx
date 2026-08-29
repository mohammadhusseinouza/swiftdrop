import type { ComponentType, ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import type { LucideProps } from 'lucide-react';
import { cn } from '../ui/cn';

/**
 * PRESENTATIONAL, CONTROLLED sidebar. Phase 10.6 shared component — NOT the
 * Phase 11.2 Management Shell.
 *
 * It does NOT: decide permissions, call RTK Query, call logout, own the
 * authenticated user, compute role navigation, or define routes. Phase 11.2
 * composes it with permission-aware nav, the real user, Redux sidebar state
 * and routing.
 */
export interface SidebarNavItem {
  id: string;
  label: string;
  to: string;
  icon?: ComponentType<LucideProps>;
  /** Optional trailing count/indicator. */
  badge?: ReactNode;
}

export interface SidebarSection {
  id: string;
  /** Optional group label ("Operations", "Finance", …). */
  label?: string;
  items: SidebarNavItem[];
}

export interface SidebarUser {
  name: string;
  secondary?: string;
}

export interface AppSidebarProps {
  /** Brand wordmark / short name shown in the header. */
  brand?: ReactNode;
  sections: SidebarSection[];
  collapsed?: boolean;
  /** Bottom user area content (supplied by the shell — never hard-coded). */
  user?: SidebarUser;
  /** Slot under the user summary (e.g. a logout button from the shell). */
  userActions?: ReactNode;
  className?: string;
}

export function AppSidebar({
  brand = 'SwiftDrop',
  sections,
  collapsed = false,
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
          'flex h-15 shrink-0 items-center border-b border-chrome-line px-4',
          'text-sm font-semibold tracking-tight text-chrome-ink-strong',
          collapsed && 'justify-center px-0',
        )}
      >
        {collapsed ? (
          <span aria-hidden="true">S</span>
        ) : (
          <span>{brand}</span>
        )}
      </div>

      <nav
        aria-label="Primary"
        className="flex-1 space-y-4 overflow-y-auto px-2 py-3"
      >
        {sections.map((section) => (
          <div key={section.id}>
            {section.label && !collapsed && (
              <p className="px-2 pb-1 text-[0.6875rem] font-semibold uppercase tracking-wide text-chrome-ink/60">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <li key={item.id}>
                    <NavLink
                      to={item.to}
                      end
                      title={collapsed ? item.label : undefined}
                      className={({ isActive }) =>
                        cn(
                          'flex items-center gap-3 rounded-control px-2.5 py-2 text-sm',
                          'transition-colors',
                          collapsed && 'justify-center',
                          isActive
                            ? 'bg-brand-600 text-white'
                            : 'text-chrome-ink hover:bg-chrome-deep hover:text-chrome-ink-strong',
                        )
                      }
                    >
                      {Icon && (
                        <Icon className="size-4 shrink-0" aria-hidden="true" />
                      )}
                      {!collapsed && <span className="flex-1">{item.label}</span>}
                      {!collapsed && item.badge}
                    </NavLink>
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
