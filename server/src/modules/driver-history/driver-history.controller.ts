import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getDriverProfileForUser } from "../auth/ownership.service";
import { listDriverHistory } from "./driver-history.service";
import type { ListDriverHistoryQuery } from "./driver-history.schema";
import type { DriverWorkHistoryItem } from "./driver-history.types";
import type { ApiListResponse } from "../../shared/types/api-response";

// GET /api/v1/driver/history (Phase 12.5). TRUSTED DRIVER IDENTITY: the
// Driver profile is resolved ONLY from req.actor.userId — identical
// discipline to driver-job.controller.ts / driver-cash.controller.ts. There
// is no code path here that reads a driverId from query/params/body.
export const listDriverHistoryController: RequestHandler<
  Record<string, never>,
  ApiListResponse<DriverWorkHistoryItem>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);

    // validate({ query: ListDriverHistoryQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result.
    const query = req.query as unknown as ListDriverHistoryQuery;
    const { items, total } = await listDriverHistory(driver.id, query);
    const totalPages = Math.ceil(total / query.limit);

    res.json({
      success: true,
      data: items,
      meta: { page: query.page, limit: query.limit, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};
