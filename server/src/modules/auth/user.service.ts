import { prisma } from "../../db/prisma";
import type { roles, users } from "../../generated/prisma/client";
import type { SafeUser, UserAccess } from "./auth.types";

type UserWithRole = users & { roles: roles };

export function toSafeUser(user: UserWithRole): SafeUser {
  return {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    phone: user.phone,
    isActive: user.is_active,
    role: {
      id: user.roles.id,
      code: user.roles.code,
      name: user.roles.name,
    },
  };
}

export async function getRolePermissionCodes(roleId: string): Promise<string[]> {
  const rows = await prisma.role_permissions.findMany({
    where: { role_id: roleId },
    include: { permissions: true },
  });

  return rows.map((row) => row.permissions.code);
}

export async function getUserAccessByEmail(email: string): Promise<UserAccess | null> {
  const user = await prisma.users.findUnique({
    where: { email: email.trim().toLowerCase() },
    include: { roles: true },
  });

  if (!user) {
    return null;
  }

  const permissions = await getRolePermissionCodes(user.role_id);

  return {
    user: toSafeUser(user),
    permissions,
  };
}
