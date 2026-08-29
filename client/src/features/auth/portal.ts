import type { AuthenticatedUser } from './auth.types';

/**
 * PORTAL ISOLATION is decided by the authenticated ROLE CODE, never by
 * permissions.
 *
 * Rationale: ADMIN currently holds every V1 permission, including
 * `driver.*.read_own` and `customer.*.read_own`. A permission-only portal
 * guard would therefore wrongly admit an Admin into the Driver/Customer
 * portals. Role picks the portal (the user experience); permissions then pick
 * which pages/actions are allowed inside that portal.
 *
 * The backend independently enforces auth, permissions, ownership and IDOR on
 * every request — these guards are UX only.
 */
export type PortalFamily = 'management' | 'driver' | 'customer';

const MANAGEMENT_ROLE_CODES: readonly string[] = ['ADMIN', 'DISPATCHER', 'FINANCE'];

/** Portal family for a role code, or `null` for an unrecognized role. */
export function getPortalFamily(roleCode: string): PortalFamily | null {
  if (MANAGEMENT_ROLE_CODES.includes(roleCode)) return 'management';
  if (roleCode === 'DRIVER') return 'driver';
  if (roleCode === 'CUSTOMER') return 'customer';
  return null;
}

/**
 * The landing route for an authenticated user, or `null` for an unrecognized
 * role (→ caller must route to Unauthorized, never guess another portal).
 */
export function getDefaultAuthenticatedPath(
  user: Pick<AuthenticatedUser, 'role'>,
): string | null {
  switch (getPortalFamily(user.role.code)) {
    case 'management':
      return '/management/dashboard';
    case 'driver':
      return '/driver/orders';
    case 'customer':
      return '/customer/dashboard';
    default:
      return null;
  }
}

/**
 * Accept only same-origin, app-internal paths as a post-login redirect target
 * (guards against open-redirect via a crafted `from`). Protocol-relative
 * (`//host`) and backslash tricks are rejected.
 */
export function isSafeInternalPath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 1 &&
    path.startsWith('/') &&
    !path.startsWith('//') &&
    !path.startsWith('/\\')
  );
}
