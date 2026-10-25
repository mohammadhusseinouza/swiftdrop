import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  getManagementDriverCashDetail,
  getManagementDriverCashSummaries,
  getManagementDriverCashTotals,
  listManagementDriverCashTransactions,
} from "./driver-cash-read.service";
import type { DriverCashSummariesQuery, DriverCashTransactionsQuery, OutstandingCollectionsQuery } from "./driver-cash-read.schema";
import { getDriverOutstandingCollections } from "../financial-release/financial-release-read.service";
import type { DriverOutstandingCollections } from "../financial-release/financial-release.types";
import type {
  ManagementDriverCashDetail,
  ManagementDriverCashSummary,
  ManagementDriverCashTotals,
  ManagementDriverCashTransactionEntry,
} from "./driver-cash-read.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";
import type { ApiListMeta } from "../../shared/types/api-response";

export const getDriverCashDetailController: RequestHandler<
  { driverId: string },
  ApiSuccessResponse<ManagementDriverCashDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const data = await getManagementDriverCashDetail(req.params.driverId);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getDriverCashTransactionsController: RequestHandler<
  { driverId: string },
  ApiListResponse<ManagementDriverCashTransactionEntry>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as DriverCashTransactionsQuery;
    const { items, total } = await listManagementDriverCashTransactions(req.params.driverId, query);
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

export const getDriverCashSummariesController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<ManagementDriverCashSummary[]>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as DriverCashSummariesQuery;
    const data = await getManagementDriverCashSummaries(query.driverIds);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getDriverCashTotalsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<ManagementDriverCashTotals>
> = async (_req, res, next) => {
  try {
    const data = await getManagementDriverCashTotals();
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

// FR.7 — outstanding settlement-mode collections of one driver, with the
// driver's cash position. `data` carries the position + the page of items;
// `meta` the standard pagination over outstanding collections.
export const getDriverOutstandingCollectionsController: RequestHandler<
  { driverId: string },
  ApiSuccessResponse<DriverOutstandingCollections> & { meta: ApiListMeta }
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as OutstandingCollectionsQuery;
    const data = await getDriverOutstandingCollections(req.params.driverId, query);
    const total = data.outstandingCollectionCount;
    res.json({ success: true, data, meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
};
