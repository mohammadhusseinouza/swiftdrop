import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  createFuelSettings,
  getCurrentFuelSettings,
  getFuelSettingsForDate,
  listFuelSettings,
} from "./fuel-settings.service";
import type {
  CreateFuelSettingsInput,
  EffectiveFuelSettingsQuery,
  ListFuelSettingsQuery,
} from "./fuel-settings.schema";
import type { FuelSettingsDetail, FuelSettingsResolution } from "./fuel-settings.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const getCurrentFuelSettingsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FuelSettingsResolution>
> = async (_req, res, next) => {
  try {
    res.json({ success: true, data: await getCurrentFuelSettings() });
  } catch (error) {
    next(error);
  }
};

export const getEffectiveFuelSettingsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FuelSettingsResolution>
> = async (req, res, next) => {
  try {
    // validate({ query }) already replaced req.query with the parsed shape.
    const query = req.query as unknown as EffectiveFuelSettingsQuery;
    res.json({ success: true, data: await getFuelSettingsForDate(query.date) });
  } catch (error) {
    next(error);
  }
};

export const listFuelSettingsController: RequestHandler<
  Record<string, never>,
  ApiListResponse<FuelSettingsDetail>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListFuelSettingsQuery;
    const { items, total } = await listFuelSettings(query);
    res.json({
      success: true,
      data: items,
      meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
    });
  } catch (error) {
    next(error);
  }
};

export const createFuelSettingsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FuelSettingsDetail>,
  CreateFuelSettingsInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const created = await createFuelSettings(req.body, req.actor.userId);
    res.status(201).json({ success: true, data: created });
  } catch (error) {
    next(error);
  }
};
