import type { AuthenticatedUser, AuthStatus } from '../../features/auth/auth.types';
import {
  getDefaultAuthenticatedPath,
  getPortalFamily,
  type PortalFamily,
} from '../../features/auth/portal';
import { hasAnyPermission } from '../../features/auth/permissionUtils';

/**
 * Pure route-guard decision logic, separated from the React components so it
 * can be exhaustively tested without a DOM.
 *
 * Guard order is always: bootstrap resolved -> auth -> portal role -> permission.
 * These decisions assume the AuthBootstrapBoundary has already resolved
 * `status` away from 'unknown' before any of them run.
 */
export type GuardDecision =
  | { kind: 'allow' }
  | { kind: 'redirect'; to: string }
  | { kind: 'login'; from?: string }
  | { kind: 'unauthorized' };

type UserLike = Pick<AuthenticatedUser, 'role'> | null;

/** `/` — auth-aware landing. */
export function decideRoot(status: AuthStatus, user: UserLike): GuardDecision {
  if (status !== 'authenticated' || !user) return { kind: 'login' };
  const home = getDefaultAuthenticatedPath(user);
  return home ? { kind: 'redirect', to: home } : { kind: 'unauthorized' };
}

/** `/auth/*` — guest only. */
export function decideGuestOnly(
  status: AuthStatus,
  user: UserLike,
): GuardDecision {
  if (status === 'authenticated' && user) {
    const home = getDefaultAuthenticatedPath(user);
    return { kind: 'redirect', to: home ?? '/unauthorized' };
  }
  return { kind: 'allow' };
}

/** `/management/*`, `/driver/*`, `/customer/*` — auth + role-family isolation. */
export function decidePortal(params: {
  status: AuthStatus;
  user: UserLike;
  portal: PortalFamily;
  from?: string;
}): GuardDecision {
  const { status, user, portal, from } = params;

  if (status !== 'authenticated' || !user) {
    return { kind: 'login', from };
  }

  const family = getPortalFamily(user.role.code);
  if (family === null) return { kind: 'unauthorized' };

  if (family !== portal) {
    // Own-portal redirect policy for a wrong-portal authenticated user.
    return {
      kind: 'redirect',
      to: getDefaultAuthenticatedPath(user) ?? '/unauthorized',
    };
  }

  return { kind: 'allow' };
}

/** Page-level permission (OR semantics). Renders Unauthorized in place. */
export function decidePermission(
  permissions: readonly string[],
  required: readonly string[],
): GuardDecision {
  return hasAnyPermission(permissions, required)
    ? { kind: 'allow' }
    : { kind: 'unauthorized' };
}
