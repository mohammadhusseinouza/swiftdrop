import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getOrderReport } from "./order-report.service";
import { getDriverReport } from "./driver-report.service";
import { getCustomerReport } from "./customer-report.service";
import { getFinanceReport } from "./finance-report.service";
import type { OrderReportQuery, DriverReportQuery, CustomerReportQuery, FinanceReportQuery } from "./report.schema";
import type { CustomerReportDto, DriverReportDto, FinanceReportDto, OrderReportDto } from "./report.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

function requireActor(req: { actor?: unknown }): void {
  if (!req.actor) {
    throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  }
}

export const getOrderReportController: RequestHandler<Record<string, never>, ApiSuccessResponse<OrderReportDto>> = async (req, res, next) => {
  try {
    requireActor(req);
    const query = req.query as unknown as OrderReportQuery;
    const report = await getOrderReport(query);
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
};

export const getDriverReportController: RequestHandler<Record<string, never>, ApiSuccessResponse<DriverReportDto>> = async (req, res, next) => {
  try {
    requireActor(req);
    const query = req.query as unknown as DriverReportQuery;
    const report = await getDriverReport(query);
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
};

export const getCustomerReportController: RequestHandler<Record<string, never>, ApiSuccessResponse<CustomerReportDto>> = async (req, res, next) => {
  try {
    requireActor(req);
    const query = req.query as unknown as CustomerReportQuery;
    const report = await getCustomerReport(query);
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
};

export const getFinanceReportController: RequestHandler<Record<string, never>, ApiSuccessResponse<FinanceReportDto>> = async (req, res, next) => {
  try {
    requireActor(req);
    const query = req.query as unknown as FinanceReportQuery;
    const report = await getFinanceReport(query);
    res.json({ success: true, data: report });
  } catch (error) {
    next(error);
  }
};
