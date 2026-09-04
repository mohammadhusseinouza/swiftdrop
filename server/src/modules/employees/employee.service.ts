import { Prisma } from "../../generated/prisma/client";
import type { employees, roles, users } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { hashPassword } from "../auth/auth.utils";
import { createAuditLog } from "../../shared/audit/audit.service";
import { MANAGEMENT_ROLE_CODES } from "./employee.schema";
import type { CreateEmployeeInput, ListEmployeesQuery, UpdateEmployeeInput } from "./employee.schema";
import type {
  EmployeeDetail,
  EmployeePermissionRef,
  EmployeeRoleDetail,
  EmployeeRoleOption,
  EmployeeSummary,
} from "./employee.types";

const ADMIN_ROLE_CODE = "ADMIN";

// ============================================================
// DTO mapping
// ============================================================

type EmployeeWithUser = employees & { users: users & { roles: roles } };
type RoleWithPermissions = roles & {
  role_permissions: { permissions: { code: string; name: string; description: string | null } }[];
};

const employeeInclude = {
  users: { include: { roles: true } },
} satisfies Prisma.employeesInclude;

const roleWithPermissionsInclude = {
  role_permissions: { include: { permissions: true } },
} satisfies Prisma.rolesInclude;

function toPermissionRefs(role: RoleWithPermissions): EmployeePermissionRef[] {
  return role.role_permissions
    .map((rp) => ({ code: rp.permissions.code, name: rp.permissions.name, description: rp.permissions.description }))
    .sort((a, b) => a.code.localeCompare(b.code));
}

function toRoleDetail(role: RoleWithPermissions): EmployeeRoleDetail {
  const permissions = toPermissionRefs(role);
  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isActive: role.is_active,
    permissionCount: permissions.length,
    permissions,
  };
}

function toEmployeeSummary(row: EmployeeWithUser): EmployeeSummary {
  return {
    id: row.id,
    employeeNumber: row.employee_number,
    userId: row.users.id,
    firstName: row.users.first_name,
    lastName: row.users.last_name,
    email: row.users.email,
    phone: row.users.phone,
    role: { id: row.users.roles.id, code: row.users.roles.code, name: row.users.roles.name },
    isActive: row.users.is_active,
    lastLoginAt: row.users.last_login_at ? row.users.last_login_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ============================================================
// GET /api/v1/employees/roles — assignable management roles
// ============================================================

export async function getManagementRoleOptions(): Promise<EmployeeRoleOption[]> {
  const roles = await prisma.roles.findMany({
    where: { code: { in: [...MANAGEMENT_ROLE_CODES] } },
    include: roleWithPermissionsInclude,
  });
  const order = new Map(MANAGEMENT_ROLE_CODES.map((code, i) => [code, i]));
  return roles
    .map(toRoleDetail)
    .sort((a, b) => (order.get(a.code as never) ?? 99) - (order.get(b.code as never) ?? 99));
}

// ============================================================
// GET /api/v1/employees
// ============================================================

export interface ListEmployeesResult {
  items: EmployeeSummary[];
  total: number;
}

export async function listEmployees(query: ListEmployeesQuery): Promise<ListEmployeesResult> {
  const and: Prisma.employeesWhereInput[] = [];
  if (query.roleId) and.push({ users: { role_id: query.roleId } });
  if (query.isActive !== undefined) and.push({ users: { is_active: query.isActive } });
  if (query.search) {
    const contains = { contains: query.search, mode: "insensitive" as const };
    and.push({
      OR: [
        { employee_number: contains },
        { users: { first_name: contains } },
        { users: { last_name: contains } },
        { users: { email: contains } },
        { users: { phone: contains } },
      ],
    });
  }
  const where: Prisma.employeesWhereInput = and.length ? { AND: and } : {};

  const [rows, total] = await Promise.all([
    prisma.employees.findMany({
      where,
      include: employeeInclude,
      orderBy: [{ created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.employees.count({ where }),
  ]);

  return { items: rows.map(toEmployeeSummary), total };
}

// ============================================================
// GET /api/v1/employees/:id
// ============================================================

export async function getEmployeeById(id: string): Promise<EmployeeDetail> {
  const employee = await prisma.employees.findUnique({ where: { id }, include: employeeInclude });
  if (!employee) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Employee not found" });
  }

  const role = await prisma.roles.findUniqueOrThrow({
    where: { id: employee.users.role_id },
    include: roleWithPermissionsInclude,
  });

  const summary = toEmployeeSummary(employee);
  return { ...summary, role: toRoleDetail(role) };
}

// ============================================================
// Shared: resolve + validate a management role
// ============================================================

async function loadManagementRole(tx: Prisma.TransactionClient, roleId: string): Promise<roles> {
  const role = await tx.roles.findUnique({ where: { id: roleId } });
  if (!role) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified role does not exist" });
  }
  if (!(MANAGEMENT_ROLE_CODES as readonly string[]).includes(role.code)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Employees must have a management role (Administrator, Dispatcher or Finance)",
    });
  }
  if (!role.is_active) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: "The specified role is not active" });
  }
  return role;
}

// ============================================================
// POST /api/v1/employees — atomic User + Employee
// ============================================================

export async function createEmployee(input: CreateEmployeeInput, actorUserId: string): Promise<EmployeeDetail> {
  const passwordHash = await hashPassword(input.user.password);

  try {
    const employeeId = await prisma.$transaction(async (tx) => {
      const role = await loadManagementRole(tx, input.roleId);

      const emailTaken = await tx.users.findUnique({ where: { email: input.user.email } });
      if (emailTaken) {
        throw new AppError({ statusCode: 409, code: "CONFLICT", message: "An account with this email already exists" });
      }
      const numberTaken = await tx.employees.findUnique({ where: { employee_number: input.employeeNumber } });
      if (numberTaken) {
        throw new AppError({ statusCode: 409, code: "CONFLICT", message: "An employee with this number already exists" });
      }

      const user = await tx.users.create({
        data: {
          email: input.user.email,
          password_hash: passwordHash,
          first_name: input.user.firstName,
          last_name: input.user.lastName,
          phone: input.user.phone ?? null,
          role_id: role.id,
          is_active: true,
        },
      });

      const employee = await tx.employees.create({
        data: { user_id: user.id, employee_number: input.employeeNumber },
      });

      // Durable audit — same transaction. NEVER the password / password hash
      // / any auth token.
      await createAuditLog(tx, {
        actorUserId,
        action: "EMPLOYEE_CREATED",
        entityType: "EMPLOYEE",
        entityId: employee.id,
        newValues: {
          employeeNumber: employee.employee_number,
          userId: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: role.code,
          isActive: user.is_active,
        },
      });

      return employee.id;
    });

    return getEmployeeById(employeeId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "A user or employee record with conflicting unique data already exists",
      });
    }
    console.error("[employee.service] createEmployee failed", error);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Failed to create the employee" });
  }
}

// ============================================================
// PATCH /api/v1/employees/:id
// ============================================================

const AUDITED_PROFILE_FIELDS = ["firstName", "lastName", "email", "phone"] as const;

export async function updateEmployee(
  id: string,
  input: UpdateEmployeeInput,
  actorUserId: string
): Promise<EmployeeDetail> {
  const existing = await prisma.employees.findUnique({ where: { id }, include: employeeInclude });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Employee not found" });
  }

  const wantsDeactivate = input.isActive === false && existing.users.is_active;
  const wantsReactivate = input.isActive === true && !existing.users.is_active;
  const roleChangeRequested = input.roleId !== undefined && input.roleId !== existing.users.role_id;

  // An actor deactivating their OWN account is almost always a mistake and
  // could contribute to a lockout — blocked outright (a different admin can
  // still deactivate them).
  if (wantsDeactivate && existing.user_id === actorUserId) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "You cannot deactivate your own account",
    });
  }

  try {
    const updatedId = await prisma.$transaction(
      async (tx) => {
        let newRoleCode: string | null = null;
        if (roleChangeRequested) {
          const role = await loadManagementRole(tx, input.roleId as string);
          newRoleCode = role.code;
        }

        // ----------------------------------------------------------------
        // LAST-ACTIVE-ADMINISTRATOR invariant. If this employee is currently
        // an active ADMIN and the change would remove that (deactivation, or
        // a role change away from ADMIN), there must be at least one OTHER
        // active ADMIN user. Serializable isolation (below) prevents two
        // concurrent "demote the last admin" requests from both passing.
        // ----------------------------------------------------------------
        const currentlyActiveAdmin =
          existing.users.roles.code === ADMIN_ROLE_CODE && existing.users.is_active;
        const losingAdminAccess =
          currentlyActiveAdmin && (wantsDeactivate || (newRoleCode !== null && newRoleCode !== ADMIN_ROLE_CODE));
        if (losingAdminAccess) {
          const otherActiveAdmins = await tx.users.count({
            where: { is_active: true, id: { not: existing.user_id }, roles: { code: ADMIN_ROLE_CODE } },
          });
          if (otherActiveAdmins === 0) {
            throw new AppError({
              statusCode: 409,
              code: "CONFLICT",
              message:
                "This is the last active administrator. Assign administrator access to another employee before deactivating or changing this one's role.",
            });
          }
        }

        // ---- build audit diff ----
        const previousValues: Record<string, unknown> = {};
        const newValues: Record<string, unknown> = {};
        const existingProfile: Record<(typeof AUDITED_PROFILE_FIELDS)[number], unknown> = {
          firstName: existing.users.first_name,
          lastName: existing.users.last_name,
          email: existing.users.email,
          phone: existing.users.phone,
        };
        let profileTouched = false;
        for (const f of AUDITED_PROFILE_FIELDS) {
          const next = (input as Record<string, unknown>)[f];
          if (next !== undefined && next !== existingProfile[f]) {
            previousValues[f] = existingProfile[f];
            newValues[f] = next;
            profileTouched = true;
          }
        }
        if (newRoleCode !== null) {
          previousValues.role = existing.users.roles.code;
          newValues.role = newRoleCode;
        }
        if (wantsDeactivate || wantsReactivate) {
          previousValues.isActive = existing.users.is_active;
          newValues.isActive = input.isActive;
        }

        // ---- apply to the linked User ----
        const userData: Prisma.usersUpdateInput = { updated_at: new Date() };
        if (input.firstName !== undefined) userData.first_name = input.firstName;
        if (input.lastName !== undefined) userData.last_name = input.lastName;
        if (input.email !== undefined) userData.email = input.email;
        if (input.phone !== undefined) userData.phone = input.phone;
        if (newRoleCode !== null) userData.roles = { connect: { id: input.roleId as string } };
        if (input.isActive !== undefined) userData.is_active = input.isActive;
        await tx.users.update({ where: { id: existing.user_id }, data: userData });

        await tx.employees.update({ where: { id }, data: { updated_at: new Date() } });

        const action =
          profileTouched || newRoleCode !== null
            ? "EMPLOYEE_UPDATED"
            : wantsDeactivate
              ? "EMPLOYEE_DEACTIVATED"
              : wantsReactivate
                ? "EMPLOYEE_REACTIVATED"
                : "EMPLOYEE_UPDATED";

        await createAuditLog(tx, {
          actorUserId,
          action,
          entityType: "EMPLOYEE",
          entityId: id,
          previousValues: Object.keys(previousValues).length
            ? (previousValues as unknown as Prisma.InputJsonValue)
            : undefined,
          newValues: Object.keys(newValues).length
            ? (newValues as unknown as Prisma.InputJsonValue)
            : undefined,
        });

        return id;
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );

    return getEmployeeById(updatedId);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new AppError({ statusCode: 409, code: "CONFLICT", message: "An account with this email already exists" });
    }
    console.error("[employee.service] updateEmployee failed", error);
    throw new AppError({ statusCode: 500, code: "INTERNAL_ERROR", message: "Failed to update the employee" });
  }
}
