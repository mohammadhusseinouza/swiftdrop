import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getRoleConfig, updateRolePermissions } from "./role-config.service";
import type { UpdateRolePermissionsInput } from "./role-config.schema";
import type { RoleConfigResponse, RoleConfigSummary } from "./role-config.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

export const getRoleConfigController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<RoleConfigResponse>
> = async (_req, res, next) => {
  try {
    const data = await getRoleConfig();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const updateRolePermissionsController: RequestHandler<
  { id: string },
  ApiSuccessResponse<RoleConfigSummary>,
  UpdateRolePermissionsInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const role = await updateRolePermissions(req.params.id, req.body.permissionCodes, req.actor.userId);
    res.json({ success: true, data: role });
  } catch (error) {
    next(error);
  }
};
