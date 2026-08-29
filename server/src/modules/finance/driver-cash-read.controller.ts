import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  getManagementDriverCashDetail,
  getManagementDriverCashSummaries,
  listManagementDriverCashTransactions,
} from "./driver-cash-read.service";
import type { DriverCashSummariesQuery, DriverCashTransactionsQuery } from "./driver-cash-read.schema";
import type {
  ManagementDriverCashDetail,
  ManagementDriverCashSummary,
  ManagementDriverCashTransactionEntry,
} from "./driver-cash-read.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

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
