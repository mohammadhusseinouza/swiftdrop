import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { Package } from 'lucide-react';
import { useAppSelector } from '../app/hooks';
import { selectCurrentUser } from '../features/auth/authSlice';
import { useLogout } from '../features/auth/useSession';
import { useGetCustomerProfileQuery } from '../services/customerProfileApi';
import { UserMenu } from '../components/navigation/UserMenu';
import { cn } from '../components/ui/cn';
import { CUSTOMER_NAV_ITEMS, isCustomerNavItemActive } from '../components/customer/customerNavigation';
import { paths } from '../routes/paths';

/**
 * Customer Portal shell — "CustomerShell" (Customer Portal Redesign, Step 1;
 * docs/customer-portal-redesign-handoff.md §2).
 *
 * White sticky header: logo tile, a pill nav with the FOUR approved items
 * (page_structure §32 — decision D1-B: Transactions and Payouts are tabs inside
 * Wallet, so Wallet is current on all three Wallet routes), and the existing UserMenu sign-out
 * behaviour (pending + error state unchanged). Plus Jakarta Sans is applied on
 * this root only (`font-customer`, decision D2-A); other portals keep Inter.
 *
 * Reached only for the CUSTOMER role — RequirePortal handles portal-family
 * isolation, so this layout does not do a second role check. Routes and paths
 * are unchanged. The customer number comes from the existing self-scoped
 * profile query (GET /customer/me/profile — no customer id in the request; the
 * cache entry is shared with the Profile page). While it loads or if it fails,
 * the header falls back to the signed-in user's name and omits the number.
 */
export default function CustomerLayout() {
  const user = useAppSelector(selectCurrentUser);
  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { logout } = useLogout();
  const profile = useGetCustomerProfileQuery(undefined, { skip: !user });
  const { pathname } = useLocation();
  const navTrackRef = useRef<HTMLUListElement>(null);

  // Phone width: the nav row scrolls horizontally, so keep the active item in
  // view after every navigation. Only the nav row's own scrollLeft changes —
  // never the page scroll.
  // Also re-checked when the viewport is resized (e.g. a tablet rotated into
  // the phone layout), since the active item can then fall out of view.
  useEffect(() => {
    const revealActive = () => {
      const track = navTrackRef.current;
      const active = track?.querySelector<HTMLElement>('[aria-current="page"]');
      if (!track || !active || track.scrollWidth <= track.clientWidth) return;
      const trackRect = track.getBoundingClientRect();
      const activeRect = active.getBoundingClientRect();
      const left = activeRect.left - trackRect.left + track.scrollLeft;
      const right = left + activeRect.width;
      if (left < track.scrollLeft) track.scrollLeft = left - 4;
      else if (right > track.scrollLeft + track.clientWidth) track.scrollLeft = right - track.clientWidth + 4;
    };
    revealActive();
    window.addEventListener('resize', revealActive);
    return () => window.removeEventListener('resize', revealActive);
  }, [pathname]);

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

  const userName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : '';
  const displayName = profile.data?.name.trim() || userName;
  const customerNumber = profile.data?.customerNumber ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-canvas font-customer text-ink">
      <header className="sticky top-0 z-20 border-b border-line bg-card">
        <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6">
          <Link
            to={paths.customer.dashboard}
            className="flex shrink-0 items-center gap-2.5 rounded-control"
          >
            <span
              className="flex size-9 items-center justify-center rounded-[11px] bg-brand-600 text-white"
              aria-hidden="true"
            >
              <Package className="size-[18px]" strokeWidth={2} />
            </span>
            <span className="text-base font-bold tracking-[-0.01em] text-ink">
              Spring Delivery
            </span>
          </Link>

          {/*
           * Below `lg` the nav takes its own full-width row under the logo and
           * scrolls horizontally when the six items do not fit (phone width).
           */}
          <nav
            aria-label="Customer navigation"
            className="order-last w-full min-w-0 lg:order-none lg:w-auto"
          >
            <ul
              ref={navTrackRef}
              className="flex w-full gap-1 overflow-x-auto rounded-full bg-canvas p-1 [scrollbar-width:none] lg:w-max [&::-webkit-scrollbar]:hidden">
              {CUSTOMER_NAV_ITEMS.map((item) => {
                const active = isCustomerNavItemActive(item, pathname);
                return (
                  <li key={item.id} className="flex-1 sm:flex-none">
                    <Link
                      to={item.to}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'inline-flex h-9 w-full items-center justify-center whitespace-nowrap rounded-full px-3 text-sm transition-colors sm:px-[18px]',
                        active
                          ? 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(15,20,34,.08),0_0_0_1px_rgba(15,20,34,.04)]'
                          : 'font-medium text-ink-secondary hover:text-ink',
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="ml-auto flex shrink-0 items-center">
            {user ? (
              <UserMenu
                name={displayName}
                email={user.email}
                roleName={user.role.name}
                subtitle={customerNumber}
                avatarClassName="size-[38px] text-[0.8125rem]"
                onSignOut={handleSignOut}
                signingOut={signingOut}
                signOutError={signOutError}
              />
            ) : null}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1200px] flex-1 px-4 pt-8 pb-18 sm:px-6 sm:pt-11">
        <Outlet />
      </main>
    </div>
  );
}
