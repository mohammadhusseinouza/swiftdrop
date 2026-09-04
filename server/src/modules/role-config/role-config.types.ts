// ============================================================
// Settings — Role → Permission configuration DTOs (Phase 11.16).
//
// Safe catalog metadata only. NEVER any User / Employee private data, no
// auth material. This surface configures which permissions a management
// ROLE grants; it does NOT assign roles to users (that is Employee
// Management) and there is NO per-user override model.
// ============================================================

export interface PermissionCatalogEntry {
  code: string;
  name: string;
  description: string | null;
}

export interface RoleConfigSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  /** How many users currently hold this role (context for the confirm step). */
  userCount: number;
  /** Whether settings.manage may change this role's permission set. */
  editable: boolean;
  /** True for the protected Administrator role (full catalog, not mutable). */
  locked: boolean;
  permissionCount: number;
  /** Sorted permission codes this role currently grants. */
  permissionCodes: string[];
}

export interface RoleConfigResponse {
  /** The management roles only — ADMIN, DISPATCHER, FINANCE. */
  roles: RoleConfigSummary[];
  /** The full application permission catalog, sorted by code. */
  permissionCatalog: PermissionCatalogEntry[];
  /**
   * Codes a management role may be granted. Portal self-service permissions
   * (`driver.*`, `customer.*`) are excluded — they belong to the Driver /
   * Customer portal families and the backend rejects assigning them here.
   */
  assignablePermissionCodes: string[];
  editableRoleCodes: string[];
  lockedRoleCodes: string[];
}
