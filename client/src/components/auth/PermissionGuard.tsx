import type { ReactNode } from 'react';
import {
  useHasAllPermissions,
  useHasAnyPermission,
  useHasPermission,
} from '../../features/auth/usePermissions';

/**
 * UI-VISIBILITY guard for buttons / actions / sections.
 *
 * This is NOT route protection — that is `RequirePermission` (Phase 10.5).
 * It makes NO backend call, never synthesises role permissions, never
 * redirects, and never replaces backend authorization: the backend
 * independently denies any request the hidden control would have made.
 *
 * Provide exactly one of `permission` / `anyOf` / `allOf`.
 */
export interface PermissionGuardProps {
  permission?: string;
  anyOf?: readonly string[];
  allOf?: readonly string[];
  /** Rendered when the check fails. Defaults to nothing. */
  fallback?: ReactNode;
  children: ReactNode;
}

export function PermissionGuard({
  permission,
  anyOf,
  allOf,
  fallback = null,
  children,
}: PermissionGuardProps) {
  const hasSingle = useHasPermission(permission ?? '');
  const hasAny = useHasAnyPermission(anyOf ?? []);
  const hasAll = useHasAllPermissions(allOf ?? []);

  let allowed = false;
  if (permission) allowed = hasSingle;
  else if (anyOf) allowed = hasAny;
  else if (allOf) allowed = hasAll;

  return <>{allowed ? children : fallback}</>;
}
