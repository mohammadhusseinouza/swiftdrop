// Management-facing Employee DTOs (Phase 11.14). Safe subset only — NEVER
// password_hash, access/refresh tokens, auth_sessions, reset tokens, or any
// other User relation beyond the approved role.

export interface EmployeeRoleRef {
  id: string;
  code: string;
  name: string;
}

export interface EmployeePermissionRef {
  code: string;
  name: string;
  description: string | null;
}

export interface EmployeeRoleDetail extends EmployeeRoleRef {
  description: string | null;
  isActive: boolean;
  permissionCount: number;
  /** Every permission inherited via this role's role_permissions rows. */
  permissions: EmployeePermissionRef[];
}

export interface EmployeeSummary {
  id: string;
  employeeNumber: string;
  userId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  role: EmployeeRoleRef;
  isActive: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmployeeDetail extends Omit<EmployeeSummary, "role"> {
  role: EmployeeRoleDetail;
}

/** GET /api/v1/employees/roles — the assignable management roles. */
export type EmployeeRoleOption = EmployeeRoleDetail;
