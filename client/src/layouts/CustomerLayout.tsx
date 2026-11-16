import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Outlet, useLocation } from 'react-router-dom';
import { useAppSelector } from '../app/hooks';
import { selectCurrentUser } from '../features/auth/authSlice';
import { useLogout } from '../features/auth/useSession';
import { useGetCustomerProfileQuery } from '../services/customerProfileApi';
import { UserMenu } from '../components/navigation/UserMenu';
import { cn } from '../components/ui/cn';
import { CUSTOMER_NAV_ITEMS, isCustomerNavItemActive } from '../components/customer/customerNavigation';
import { paths } from '../routes/paths';
import {
  CustomerHeroContext,
  type CustomerHeroOptions,
} from '../components/customer/CustomerHero';
import { OrbitRing, RedArc, SpeedLines } from '../components/customer/HeroDecor';
import '../components/customer/brandFonts';
import sdMark from '../assets/brand/sd-mark.png';
import sdWordmarkWhite from '../assets/brand/sd-wordmark-white.png';

/**
 * Customer Portal shell — brand hero-band shell (docs/brand-theme/
 * brand-theme-handoff.md §3.1, decisions B-D1..B-D4 A; built on the Customer
 * Portal Redesign shell, docs/customer-portal-redesign-handoff.md §2).
 *
 * A full-bleed charcoal band holds the header (logo, a pill nav with the FOUR
 * approved items — page_structure §32, decision D1-B: Transactions and Payouts
 * are tabs inside Wallet, so Wallet is current on all three Wallet routes — and
 * the existing UserMenu sign-out behaviour, pending + error state unchanged)
 * and the page's hero section. Pages fill the hero with `<CustomerHero>`
 * (components/customer/CustomerHero.tsx); a page without one gets a minimal
 * fallback hero naming its section. The page body then overlaps the band by
 * 36 px. Saira + Inter (brand fonts) are applied on this root only
 * (decision B-D3 A); other portals keep their typography.
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
  const [heroTarget, setHeroTarget] = useState<HTMLDivElement | null>(null);
  const [hero, setHero] = useState<CustomerHeroOptions | null>(null);
  const heroContext = useMemo(() => ({ target: heroTarget, setHero }), [heroTarget]);

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

  const activeSection = CUSTOMER_NAV_ITEMS.find((item) => isCustomerNavItemActive(item, pathname));
  const heroWidth = hero?.width === 'narrow' ? 'max-w-[960px]' : 'max-w-[1200px]';

  return (
    <div className="flex min-h-screen flex-col bg-sd-page font-sd-body text-ink">
      <div className="sd-on-dark relative bg-sd-charcoal text-white">
        {/*
         * Decoration is clipped in its own layer, so the band itself never
         * clips the account menu that drops out of the header.
         */}
        <div className="pointer-events-none absolute inset-0 z-0 overflow-hidden" aria-hidden="true">
          <OrbitRing />
          <RedArc />
          {hero?.speedLines && <SpeedLines />}
        </div>

        <header className="relative z-20 border-b border-white/8">
          <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center gap-x-6 gap-y-3 px-4 py-2.5 sm:px-6">
            <Link
              to={paths.customer.dashboard}
              aria-label="Spring Delivery home"
              className="flex shrink-0 items-center gap-2 rounded-control"
            >
              <img src={sdMark} alt="" width={40} height={39} className="h-auto w-10" />
              <img
                src={sdWordmarkWhite}
                alt="Spring Delivery"
                width={83}
                height={30}
                className="h-[30px] w-auto"
              />
            </Link>

            {/*
             * Below `lg` the nav takes its own full-width row under the logo and
             * scrolls horizontally when the items do not fit (phone width).
             */}
            <nav
              aria-label="Customer navigation"
              className="order-last w-full min-w-0 lg:order-none lg:w-auto"
            >
              <ul
                ref={navTrackRef}
                className="flex w-full gap-1 overflow-x-auto rounded-[10px] bg-white/6 p-1 [scrollbar-width:none] lg:w-max [&::-webkit-scrollbar]:hidden">
                {CUSTOMER_NAV_ITEMS.map((item) => {
                  const active = isCustomerNavItemActive(item, pathname);
                  return (
                    <li key={item.id} className="flex-1 sm:flex-none">
                      <Link
                        to={item.to}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'sd-press inline-flex h-[34px] w-full items-center justify-center whitespace-nowrap rounded-[7px] px-3 text-sm sm:px-4',
                          active
                            ? 'bg-sd-red font-semibold text-white'
                            : 'font-medium text-sd-on-dark hover:bg-white/8 hover:text-white',
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
                  avatarClassName="size-9 text-[0.8125rem]"
                  tone="dark"
                  onSignOut={handleSignOut}
                  signingOut={signingOut}
                  signOutError={signOutError}
                />
              ) : null}
            </div>
          </div>
        </header>

        {/* Hero section: filled by the page's <CustomerHero>, or the fallback. */}
        <div className={cn('relative mx-auto w-full px-4 pt-7 pb-16 sm:px-6', heroWidth)}>
          <div ref={setHeroTarget} />
          {!hero && activeSection && (
            <p className="sd-rise font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.16em] text-sd-on-dark">
              {activeSection.label}
            </p>
          )}
        </div>
      </div>

      <main className="relative mx-auto -mt-9 w-full max-w-[1200px] flex-1 px-4 pb-12 sm:px-6">
        <CustomerHeroContext.Provider value={heroContext}>
          <Outlet />
        </CustomerHeroContext.Provider>
      </main>
    </div>
  );
}
