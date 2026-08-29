import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getDashboardSummary } from "./dashboard.service";
import type { DashboardSummary } from "./dashboard.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

export const getDashboardController: RequestHandler<Record<string, never>, ApiSuccessResponse<DashboardSummary>> = async (
  req,
  res,
  next
) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const summary = await getDashboardSummary(req.actor.permissions);
    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};
