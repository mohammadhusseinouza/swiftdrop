import { useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { Truck, X } from 'lucide-react';

import { useAppDispatch, useAppSelector } from '../app/hooks';
import { selectCurrentUser } from '../features/auth/authSlice';
import {
  closeMobileNavigation,
  openMobileNavigation,
  selectMobileNavigationOpen,
  selectSidebarCollapsed,
  toggleSidebarCollapsed,
} from '../features/ui/uiSlice';
import { useLogout } from '../features/auth/useSession';
import {
  buildManagementNavigation,
  getActiveManagementNavId,
} from '../features/navigation/managementNavigation';
import { getManagementRouteTitle } from '../features/navigation/routeTitle';
import { MD_QUERY, useMediaQuery } from '../lib/useMediaQuery';
import {
  AppSidebar,
  type SidebarSection,
} from '../components/navigation/AppSidebar';
import { TopNavbar } from '../components/navigation/TopNavbar';
import { UserMenu } from '../components/navigation/UserMenu';

const DRAWER_ID = 'management-mobile-nav';
const TOGGLE_ID = 'management-nav-toggle';

/**
 * Phase 11.2 — the real Management Portal shell.
 *
 * Composes the shared AppSidebar + TopNavbar with permission-aware navigation,
 * the hydrated auth user, and the Redux `ui` slice (sidebarCollapsed /
 * mobileNavigationOpen). Reached only for ADMIN / DISPATCHER / FINANCE
 * (RequirePortal handles portal-family isolation — this layout does NOT do a
 * second role check). Sidebar item visibility is UX only; RequirePermission
 * still guards each route and the backend authorizes every request.
 *
 * No business-data API calls. Route pages still render their placeholders.
 */
export default function ManagementLayout() {
  const dispatch = useAppDispatch();
  const location = useLocation();
  const user = useAppSelector(selectCurrentUser);
  const collapsed = useAppSelector(selectSidebarCollapsed);
  const mobileOpen = useAppSelector(selectMobileNavigationOpen);
  const isDesktop = useMediaQuery(MD_QUERY);

  const [signingOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState<string | null>(null);
  const { logout } = useLogout();

  const closeRef = useRef<HTMLButtonElement>(null);

  const activeId = getActiveManagementNavId(location.pathname);
  const title = getManagementRouteTitle(location.pathname);
  const permissions = user?.permissions ?? [];

  const sections: SidebarSection[] = useMemo(
    () =>
      buildManagementNavigation(permissions).map((group) => ({
        id: group.id,
        label: group.label,
        items: group.items.map((item) => ({
          id: item.id,
          label: item.label,
          to: item.to,
          icon: item.icon,
          indent: item.indent,
          active: item.id === activeId,
        })),
      })),
    [permissions, activeId],
  );

  // Close the mobile drawer on any route change (covers non-sidebar navigation).
  useEffect(() => {
    dispatch(closeMobileNavigation());
  }, [location.pathname, dispatch]);

  // Close the mobile drawer once the viewport grows to desktop.
  useEffect(() => {
    if (isDesktop && mobileOpen) dispatch(closeMobileNavigation());
  }, [isDesktop, mobileOpen, dispatch]);

  // While the drawer is open: lock body scroll, wire Escape, focus the close btn.
  useEffect(() => {
    if (!mobileOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch(closeMobileNavigation());
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
      document.getElementById(TOGGLE_ID)?.focus();
    };
  }, [mobileOpen, dispatch]);

  const handleToggle = () => {
    if (isDesktop) dispatch(toggleSidebarCollapsed());
    else dispatch(openMobileNavigation());
  };

  const handleSignOut = async () => {
    setSignOutError(null);
    setSigningOut(true);
    try {
      // useLogout owns token clear + auth-state + cache reset + navigation.
      await logout();
      // Navigated to /auth/login — this layout unmounts.
    } catch {
      // Transport/5xx: the backend session may still be live — stay signed in.
      setSignOutError('Unable to sign out. Please try again.');
      setSigningOut(false);
    }
  };

  const displayName = user
    ? `${user.firstName} ${user.lastName}`.trim() || user.email
    : '';
  const sidebarUser = user
    ? { name: displayName, secondary: user.role.name }
    : undefined;
  const userMenu = user ? (
    <UserMenu
      name={displayName}
      email={user.email}
      roleName={user.role.name}
      onSignOut={handleSignOut}
      signingOut={signingOut}
      signOutError={signOutError}
    />
  ) : null;

  return (
    <div className="flex min-h-screen bg-canvas">
      {/* Persistent desktop sidebar (out of flow on mobile). */}
      <div className="sticky top-0 hidden h-screen shrink-0 md:flex">
        <AppSidebar
          sections={sections}
          collapsed={collapsed}
          navLabel="Management navigation"
          brand="SwiftDrop"
          brandIcon={<Truck />}
          user={sidebarUser}
        />
      </div>

      {/* Mobile drawer + backdrop. */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-ink/40"
            aria-hidden="true"
            onClick={() => dispatch(closeMobileNavigation())}
          />
          <div
            id={DRAWER_ID}
            role="dialog"
            aria-label="Navigation menu"
            className="absolute inset-y-0 left-0 z-50 w-[min(85vw,280px)]"
          >
            <AppSidebar
              sections={sections}
              navLabel="Management navigation"
              brand="SwiftDrop"
              brandIcon={<Truck />}
              onNavigate={() => dispatch(closeMobileNavigation())}
              user={sidebarUser}
            />
            <button
              ref={closeRef}
              type="button"
              aria-label="Close navigation"
              onClick={() => dispatch(closeMobileNavigation())}
              className="absolute top-2 right-2 rounded-control p-1.5 text-chrome-ink hover:bg-chrome-deep hover:text-chrome-ink-strong"
            >
              <X className="size-5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopNavbar
          className="sticky top-0 z-20"
          title={title}
          onToggleSidebar={handleToggle}
          toggleId={TOGGLE_ID}
          toggleLabel={isDesktop ? 'Collapse navigation' : 'Open navigation'}
          toggleAriaExpanded={isDesktop ? !collapsed : mobileOpen}
          toggleAriaControls={isDesktop ? undefined : DRAWER_ID}
          actions={userMenu}
        />
        <main className="flex-1 p-4 sm:p-5 lg:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
