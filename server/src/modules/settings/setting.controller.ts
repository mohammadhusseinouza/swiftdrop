import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getSettingByKey, listSettings, updateSettingByKey } from "./setting.service";
import type { UpdateSettingInput } from "./setting.schema";
import type { SettingSummary } from "./setting.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

export const listSettingsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<SettingSummary[]>
> = async (_req, res, next) => {
  try {
    const items = await listSettings();
    res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

export const getSettingController: RequestHandler<
  { key: string },
  ApiSuccessResponse<SettingSummary>
> = async (req, res, next) => {
  try {
    const setting = await getSettingByKey(req.params.key);
    res.json({ success: true, data: setting });
  } catch (error) {
    next(error);
  }
};

export const updateSettingController: RequestHandler<
  { key: string },
  ApiSuccessResponse<SettingSummary>,
  UpdateSettingInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const setting = await updateSettingByKey(req.params.key, req.body, req.actor.userId);
    res.json({ success: true, data: setting });
  } catch (error) {
    next(error);
  }
};
