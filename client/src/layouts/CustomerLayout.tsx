import { useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Package } from 'lucide-react';
import { useAppSelector } from '../app/hooks';
import { selectCurrentUser } from '../features/auth/authSlice';
import { useLogout } from '../features/auth/useSession';
import { TopNavbar } from '../components/navigation/TopNavbar';
import { UserMenu } from '../components/navigation/UserMenu';
import { cn } from '../components/ui/cn';
import { paths } from '../routes/paths';

/**
 * Phase 13.1 — the real Customer Portal shell.
 *
 * Deliberately the calmest of the three shells (task §21/§22): a single top
 * bar + one slim nav row, generous whitespace, a wider reading column than
 * the phone-first Driver Portal but far lighter than the dense Management
 * Portal. Reached only for the CUSTOMER role — RequirePortal handles
 * portal-family isolation, so this layout does not do a second role check.
 *
 * Every destination is a real page (Phases 13.1–13.7); the Customer nav is
 * now complete and no placeholder route remains. The nav is a plain list.
 */
const CUSTOMER_NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', to: paths.customer.dashboard, end: true },
  { id: 'orders', label: 'My Orders', to: paths.customer.orders, end: false },
  { id: 'wallet', label: 'Wallet', to: paths.customer.wallet, end: false },
  { id: 'transactions', label: 'Transactions', to: paths.customer.transactions, end: false },
  { id: 'payouts', label: 'Payouts', to: paths.customer.payouts, end: false },
  { id: 'profile', label: 'Profile', to: paths.customer.profile, end: false },
] as const;

export default function CustomerLayout() {
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
            <Package
              className="size-4 shrink-0 text-brand-600"
              aria-hidden="true"
            />
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
        aria-label="Customer navigation"
        className="sticky top-15 z-10 flex gap-1 overflow-x-auto border-b border-line bg-card px-3 py-2 sm:px-4"
      >
        {CUSTOMER_NAV_ITEMS.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            end={item.end}
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

      <main className="mx-auto w-full max-w-4xl flex-1 p-4 sm:p-6">
        <Outlet />
      </main>
    </div>
  );
}
