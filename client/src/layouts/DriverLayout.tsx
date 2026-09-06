import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Truck } from 'lucide-react';
import { useAppSelector } from '../app/hooks';
import { selectCurrentUser } from '../features/auth/authSlice';
import { useLogout } from '../features/auth/useSession';
import { TopNavbar } from '../components/navigation/TopNavbar';
import { UserMenu } from '../components/navigation/UserMenu';
import { cn } from '../components/ui/cn';
import { paths } from '../routes/paths';

/**
 * Phase 12.1 — the real Driver Portal shell.
 *
 * Deliberately simpler than ManagementLayout (task §24): no collapsible
 * desktop sidebar — a single slim nav row under the top bar, mobile-first.
 * Reached only for the DRIVER role (RequirePortal handles portal-family
 * isolation — this layout does not do a second role check). Only
 * functional destinations are linked (task §24: "prefer only functional
 * navigation"). Phase 12.5 adds the three remaining read-only surfaces.
 * The nav row scrolls horizontally on very narrow screens (375px) and
 * stays keyboard-accessible (task §52).
 */
const DRIVER_NAV_ITEMS = [
  { id: 'jobs', label: 'My Jobs', to: paths.driver.jobs },
  { id: 'completed', label: 'Completed', to: paths.driver.completed },
  { id: 'failed', label: 'Failed', to: paths.driver.failed },
  { id: 'cash', label: 'My Cash', to: paths.driver.cash },
] as const;

export default function DriverLayout() {
  const user = useAppSelector(selectCurrentUser);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { logout } = useLogout();

  const handleSignOut = async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      await logout();
    } catch {
      setSignOutError('Unable to sign out. Please try again.');
      setSigningOut(false);
    }
  };

  const displayName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : '';

  return (
    <div className="flex min-h-screen flex-col bg-canvas">
      <TopNavbar
        className="sticky top-0 z-20"
        title={
          <span className="flex items-center gap-2">
            <Truck className="size-4 shrink-0 text-brand-600" aria-hidden="true" />
            SwiftDrop
          </span>
        }
        actions={
          user ? (
            <UserMenu
              name={displayName}
              email={user.email}
              roleName={user.role.name}
              onSignOut={handleSignOut}
              signingOut={signingOut}
              signOutError={signOutError}
            />
          ) : null
        }
      />

      <nav
        aria-label="Driver navigation"
        className="sticky top-15 z-10 flex gap-1 overflow-x-auto border-b border-line bg-card px-3 py-2 sm:px-4"
      >
        {DRIVER_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            className={({ isActive }) =>
              cn(
                'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[0.5rem] border px-3 text-[0.8125rem] font-medium transition-colors',
                isActive
                  ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                  : 'border-line bg-card text-ink-secondary hover:bg-sunken',
              )
            }
          >
            {item.label}
          </NavLink>
        ))}
      </nav>

      <main className="mx-auto w-full max-w-2xl flex-1 p-3 sm:p-5">
        <Outlet />
      </main>
    </div>
  );
}
