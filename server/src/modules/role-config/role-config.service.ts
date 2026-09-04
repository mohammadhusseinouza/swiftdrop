import { Prisma } from "../../generated/prisma/client";
import type { permissions, roles } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import type {
  PermissionCatalogEntry,
  RoleConfigResponse,
  RoleConfigSummary,
} from "./role-config.types";

// The Settings role editor is scoped to the management portal family. Driver
// and Customer role matrices are NOT configured from this page in V1
// (docs CLAUDE.md §8, phase spec §26 / §76).
const MANAGEMENT_ROLE_CODES = ["ADMIN", "DISPATCHER", "FINANCE"] as const;

// ADMIN is a protected full-access role: the approved invariant is that it
// receives EVERY permission through role_permissions with no hard-coded
// bypass (CLAUDE.md §27). Allowing the only full-control role to lose
// permissions could lock the whole system out, so its matrix is immutable
// and displayed read-only.
const LOCKED_ROLE_CODES = ["ADMIN"] as const;
const EDITABLE_ROLE_CODES = ["DISPATCHER", "FINANCE"] as const;

/**
 * Portal self-service permissions belong to the Driver / Customer role
 * families and must never be assignable to a management role (§30 / §76).
 * Everything else in the catalog is a management permission and may be
 * granted to DISPATCHER / FINANCE — including the powerful `settings.manage`
 * / `employees.manage` / `audit.read`, which is a deliberate, surfaced
 * configuration decision, not an accident.
 */
export function isAssignableToManagementRole(code: string): boolean {
  return !code.startsWith("driver.") && !code.startsWith("customer.");
}

function toCatalogEntry(p: permissions): PermissionCatalogEntry {
  return { code: p.code, name: p.name, description: p.description };
}

function isManagementRoleCode(code: string): code is (typeof MANAGEMENT_ROLE_CODES)[number] {
  return (MANAGEMENT_ROLE_CODES as readonly string[]).includes(code);
}

function isLockedRoleCode(code: string): boolean {
  return (LOCKED_ROLE_CODES as readonly string[]).includes(code);
}

async function buildRoleSummary(
  client: Prisma.TransactionClient | typeof prisma,
  role: roles,
): Promise<RoleConfigSummary> {
  const [rolePermissions, userCount] = await Promise.all([
    client.role_permissions.findMany({
      where: { role_id: role.id },
      include: { permissions: { select: { code: true } } },
    }),
    client.users.count({ where: { role_id: role.id } }),
  ]);

  const permissionCodes = rolePermissions.map((rp) => rp.permissions.code).sort();

  return {
    id: role.id,
    code: role.code,
    name: role.name,
    description: role.description,
    isActive: role.is_active,
    userCount,
    editable: (EDITABLE_ROLE_CODES as readonly string[]).includes(role.code),
    locked: isLockedRoleCode(role.code),
    permissionCount: permissionCodes.length,
    permissionCodes,
  };
}

// ============================================================
// GET /api/v1/settings/roles
// ============================================================

export async function getRoleConfig(): Promise<RoleConfigResponse> {
  const [roleRows, permissionRows] = await Promise.all([
    prisma.roles.findMany({ where: { code: { in: [...MANAGEMENT_ROLE_CODES] } } }),
    prisma.permissions.findMany({ orderBy: { code: "asc" } }),
  ]);

  const order = new Map(MANAGEMENT_ROLE_CODES.map((code, i) => [code, i]));
  const roles = await Promise.all(
    roleRows
      .sort((a, b) => (order.get(a.code as never) ?? 99) - (order.get(b.code as never) ?? 99))
      .map((role) => buildRoleSummary(prisma, role)),
  );

  const permissionCatalog = permissionRows.map(toCatalogEntry);

  return {
    roles,
    permissionCatalog,
    assignablePermissionCodes: permissionCatalog
      .map((p) => p.code)
      .filter(isAssignableToManagementRole),
    editableRoleCodes: [...EDITABLE_ROLE_CODES],
    lockedRoleCodes: [...LOCKED_ROLE_CODES],
  };
}

// ============================================================
// PUT /api/v1/settings/roles/:id/permissions
// ============================================================

export async function updateRolePermissions(
  roleId: string,
  permissionCodes: string[],
  actorUserId: string,
): Promise<RoleConfigSummary> {
  // Reject duplicates up front — a full-replacement set with a repeated code
  // is a malformed request, not something to silently collapse (§58).
  const seen = new Set<string>();
  for (const code of permissionCodes) {
    if (seen.has(code)) {
      throw new AppError({
        statusCode: 400,
        code: "VALIDATION_ERROR",
        message: `Duplicate permission code in request: ${code}`,
      });
    }
    seen.add(code);
  }

  try {
    const summary = await prisma.$transaction(
      async (tx) => {
        const role = await tx.roles.findUnique({ where: { id: roleId } });
        if (!role) {
          throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Role not found" });
        }
        if (!isManagementRoleCode(role.code)) {
          throw new AppError({
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: "Only management roles (Dispatcher, Finance) can be configured from Settings",
          });
        }
        if (isLockedRoleCode(role.code)) {
          throw new AppError({
            statusCode: 409,
            code: "CONFLICT",
            message:
              "The Administrator role has full access by design and its permissions cannot be changed",
          });
        }

        const catalog = await tx.permissions.findMany();
        const byCode = new Map(catalog.map((p) => [p.code, p]));

        const unknown = permissionCodes.filter((c) => !byCode.has(c));
        if (unknown.length > 0) {
          throw new AppError({
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: `Unknown permission code(s): ${unknown.join(", ")}`,
          });
        }

        const forbidden = permissionCodes.filter((c) => !isAssignableToManagementRole(c));
        if (forbidden.length > 0) {
          throw new AppError({
            statusCode: 400,
            code: "VALIDATION_ERROR",
            message: `These permissions belong to the Driver/Customer portals and cannot be assigned to a management role: ${forbidden.join(
              ", ",
            )}`,
          });
        }

        const previous = await tx.role_permissions.findMany({
          where: { role_id: role.id },
          include: { permissions: { select: { code: true } } },
        });
        const previousCodes = previous.map((rp) => rp.permissions.code).sort();
        const nextCodes = [...permissionCodes].sort();

        // Atomic full replacement — delete then re-insert inside the same
        // Serializable transaction, so a concurrent writer to this role
        // aborts rather than producing a merged/partial set (§31 / §57).
        await tx.role_permissions.deleteMany({ where: { role_id: role.id } });
        if (nextCodes.length > 0) {
          await tx.role_permissions.createMany({
            data: nextCodes.map((code) => ({
              role_id: role.id,
              permission_id: byCode.get(code)!.id,
            })),
          });
        }

        const added = nextCodes.filter((c) => !previousCodes.includes(c));
        const removed = previousCodes.filter((c) => !nextCodes.includes(c));

        await createAuditLog(tx, {
          actorUserId,
          action: "ROLE_PERMISSIONS_UPDATED",
          entityType: "ROLE",
          entityId: role.id,
          previousValues: { roleCode: role.code, permissionCodes: previousCodes },
          newValues: { roleCode: role.code, permissionCodes: nextCodes },
          metadata: { added, removed },
        });

        return buildRoleSummary(tx, role);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );

    return summary;
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      (error.code === "P2034" || error.code === "P2002")
    ) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "This role was updated by someone else. Reload the page and try again.",
      });
    }
    console.error("[role-config.service] updateRolePermissions failed", error);
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Failed to update the role's permissions",
    });
  }
}
