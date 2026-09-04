import { z } from "zod";

export const RoleIdParamSchema = z.object({
  id: z.string().uuid(),
});

// A full replacement of the role's permission set. The service validates
// every code against the live catalog and against the management-role
// assignment policy; duplicates are rejected rather than silently deduped.
export const UpdateRolePermissionsSchema = z.object({
  permissionCodes: z
    .array(z.string().trim().min(1).max(100))
    .max(200),
});

export type UpdateRolePermissionsInput = z.infer<typeof UpdateRolePermissionsSchema>;
