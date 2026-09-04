import { Router } from "express";
import { authenticate } from "../../middleware/authenticate";
import { authorize } from "../../middleware/authorize";
import { validate } from "../../middleware/validate";
import { RoleIdParamSchema, UpdateRolePermissionsSchema } from "./role-config.schema";
import { getRoleConfigController, updateRolePermissionsController } from "./role-config.controller";

// Mounted at /api/v1/settings/roles (Phase 11.16). Reads require settings.read
// (so DISPATCHER / FINANCE can inspect the matrix from the Settings page —
// they do NOT hold employees.read, so /employees/roles cannot serve this).
// Mutations require settings.manage. The ADMIN role is rejected by the
// service, not just by the UI.
export const roleConfigRouter = Router();

roleConfigRouter.get("/", authenticate, authorize("settings.read"), getRoleConfigController);

roleConfigRouter.put(
  "/:id/permissions",
  authenticate,
  authorize("settings.manage"),
  validate({ params: RoleIdParamSchema, body: UpdateRolePermissionsSchema }),
  updateRolePermissionsController,
);
