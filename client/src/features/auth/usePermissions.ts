import { useAppSelector } from '../../app/hooks';
import {
  selectAuthStatus,
  selectCurrentUser,
  selectPermissions,
} from './authSlice';
import {
  hasAllPermissions,
  hasAnyPermission,
  hasPermission,
} from './permissionUtils';

/**
 * Non-visual permission hooks for future action visibility (Phase 11+).
 * Each returns a plain boolean derived from the hydrated permission array —
 * cheap `.includes` checks, no role synthesis. The reusable visual
 * PermissionGuard component is Phase 10.6.
 */

/** The hydrated identity summary (or null). */
export const useCurrentUser = () => useAppSelector(selectCurrentUser);

/** 'unknown' | 'authenticated' | 'unauthenticated'. */
export const useAuthStatus = () => useAppSelector(selectAuthStatus);

/** The hydrated permission code array (empty when not authenticated). */
export const usePermissions = () => useAppSelector(selectPermissions);

/** Does the current user hold this permission? (UX only.) */
export function useHasPermission(permission: string): boolean {
  return useAppSelector((state) =>
    hasPermission(selectPermissions(state), permission),
  );
}

/** Does the current user hold at least one of these permissions? */
export function useHasAnyPermission(required: readonly string[]): boolean {
  return useAppSelector((state) =>
    hasAnyPermission(selectPermissions(state), required),
  );
}

/** Does the current user hold every one of these permissions? */
export function useHasAllPermissions(required: readonly string[]): boolean {
  return useAppSelector((state) =>
    hasAllPermissions(selectPermissions(state), required),
  );
}
