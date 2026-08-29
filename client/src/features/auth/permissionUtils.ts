/**
 * Pure permission-membership helpers. They check ONLY against the actual
 * hydrated permission array from the backend — no role synthesis, no defaults.
 * Non-visual; the reusable visual PermissionGuard is Phase 10.6.
 */

export function hasPermission(
  permissions: readonly string[],
  permission: string,
): boolean {
  return permissions.includes(permission);
}

export function hasAnyPermission(
  permissions: readonly string[],
  required: readonly string[],
): boolean {
  return required.some((p) => permissions.includes(p));
}

export function hasAllPermissions(
  permissions: readonly string[],
  required: readonly string[],
): boolean {
  return required.every((p) => permissions.includes(p));
}
