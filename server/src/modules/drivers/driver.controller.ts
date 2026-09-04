import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createDriver, getDriverById, listDrivers, updateDriver } from "./driver.service";
import { listDriverCurrentOrders, listDriverDeliveryHistory, listDriverParcelCollectionHistory } from "./driver-work.service";
import type { CreateDriverInput, DriverWorkListQuery, ListDriversQuery, UpdateDriverInput } from "./driver.schema";
import type { DriverDetail, DriverSummary } from "./driver.types";
import type { DriverDeliveryHistoryRow, DriverParcelCollectionHistoryRow } from "./driver-work.types";
import type { OrderSummary } from "../orders/order.types";
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
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const driver = await createDriver(req.body, req.actor.userId);
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
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const driver = await updateDriver(req.params.id, req.body, req.actor.userId);
    res.json({ success: true, data: driver });
  } catch (error) {
    next(error);
  }
};

export const listDriverCurrentOrdersController: RequestHandler<
  { id: string },
  ApiListResponse<OrderSummary>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as DriverWorkListQuery;
    const { items, total } = await listDriverCurrentOrders(req.params.id, query);
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

export const listDriverDeliveryHistoryController: RequestHandler<
  { id: string },
  ApiListResponse<DriverDeliveryHistoryRow>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as DriverWorkListQuery;
    const { items, total } = await listDriverDeliveryHistory(req.params.id, query);
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

// GET /api/v1/drivers/:id/parcel-collection-history (Phase 11.17.6, task §27).
export const listDriverParcelCollectionHistoryController: RequestHandler<
  { id: string },
  ApiListResponse<DriverParcelCollectionHistoryRow>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as DriverWorkListQuery;
    const { items, total } = await listDriverParcelCollectionHistory(req.params.id, query);
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
