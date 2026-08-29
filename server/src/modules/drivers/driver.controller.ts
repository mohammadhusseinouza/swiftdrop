import { RequestHandler } from "express";
import { createDriver, getDriverById, listDrivers, updateDriver } from "./driver.service";
import type { CreateDriverInput, ListDriversQuery, UpdateDriverInput } from "./driver.schema";
import type { DriverDetail, DriverSummary } from "./driver.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const listDriversController: RequestHandler<
  Record<string, never>,
  ApiListResponse<DriverSummary>
> = async (req, res, next) => {
  try {
    // validate({ query: ListDriversQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result by the time this
    // controller runs — Express's own Query generic stays ParsedQs for
    // route-chain compatibility, so this cast reflects that real shape.
    const query = req.query as unknown as ListDriversQuery;
    const { items, total } = await listDrivers(query);
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

export const createDriverController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<DriverDetail>,
  CreateDriverInput
> = async (req, res, next) => {
  try {
    const driver = await createDriver(req.body);
    res.status(201).json({ success: true, data: driver });
  } catch (error) {
    next(error);
  }
};

export const getDriverController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverDetail>
> = async (req, res, next) => {
  try {
    const driver = await getDriverById(req.params.id);
    res.json({ success: true, data: driver });
  } catch (error) {
    next(error);
  }
};

export const updateDriverController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverDetail>,
  UpdateDriverInput
> = async (req, res, next) => {
  try {
    const driver = await updateDriver(req.params.id, req.body);
    res.json({ success: true, data: driver });
  } catch (error) {
    next(error);
  }
};
