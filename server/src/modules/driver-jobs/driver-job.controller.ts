import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getDriverProfileForUser } from "../auth/ownership.service";
import { getDriverJobDetail, listDriverJobs } from "./driver-job.service";
import type { DriverJobDetailParams, ListDriverJobsQuery } from "./driver-job.schema";
import type { DriverJobDetail, DriverJobSummary } from "./driver-job.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

// GET /api/v1/driver/jobs (Phase 12.1). TRUSTED DRIVER IDENTITY: the Driver
// profile is resolved ONLY from req.actor.userId — identical discipline to
// driver-order.controller.ts. There is no code path here that reads a
// driverId from query/params/body.
export const listDriverJobsController: RequestHandler<
  Record<string, never>,
  ApiListResponse<DriverJobSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);

    // validate({ query: ListDriverJobsQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result.
    const query = req.query as unknown as ListDriverJobsQuery;
    const { items, total } = await listDriverJobs(driver.id, query);
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

// GET /api/v1/driver/jobs/:jobType/:orderId (Phase 12.2). TRUSTED DRIVER
// IDENTITY — identical discipline to listDriverJobsController above: the
// Driver profile comes ONLY from req.actor.userId. jobType/orderId come
// ONLY from the validated route params (DriverJobDetailParamsSchema has
// already normalized jobType to "COLLECTION"/"DELIVERY" and confirmed
// orderId is a UUID) — no client-supplied driverId anywhere.
export const getDriverJobDetailController: RequestHandler<
  { jobType: string; orderId: string },
  ApiSuccessResponse<DriverJobDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);
    const params = req.params as unknown as DriverJobDetailParams;
    const job = await getDriverJobDetail(driver.id, params.jobType, params.orderId);
    res.json({ success: true, data: job });
  } catch (error) {
    next(error);
  }
};
