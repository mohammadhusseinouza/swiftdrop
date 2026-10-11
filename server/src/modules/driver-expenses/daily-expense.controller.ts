import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import type { AuthenticatedActor } from "../../middleware/authenticate";
import { listExpenseDrivers, upsertExpenseProfile } from "./driver-expense-profile.service";
import {
  createDailyExpense,
  getDailyExpense,
  listDailyExpenses,
  listDailyExpensesForDate,
  listDriverExpenseHistory,
  updateDailyExpense,
} from "./daily-expense.service";
import type {
  CreateDailyExpenseInput,
  DriverExpenseHistoryQuery,
  ListDailyExpensesQuery,
  ListExpenseDriversQuery,
  UpdateDailyExpenseInput,
  UpsertExpenseProfileInput,
} from "./daily-expense.schema";
import type { DailyExpenseDetail, ExpenseDriverSummary, ExpenseProfileDetail } from "./daily-expense.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";
import { getDailyTrend, getDriverReport, getReportSummary, getVehicleReport } from "./report.service";
import type { DriverReportQuery, ReportFilterQuery } from "./report.schema";
import type { DailyTrendRow, DriverReportRow, ReportSummary, VehicleReportRow } from "./report.types";

// validate({ params, query, body }) has already replaced req.* with the parsed
// shapes by the time these run; the casts reflect that real shape.

function requireActor(actor: AuthenticatedActor | undefined): string {
  if (!actor) throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  return actor.userId;
}

function listMeta(page: number, limit: number, total: number) {
  return { page, limit, total, totalPages: Math.ceil(total / limit) };
}

export const listExpenseDriversController: RequestHandler<
  Record<string, never>,
  ApiListResponse<ExpenseDriverSummary>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListExpenseDriversQuery;
    const { items, total } = await listExpenseDrivers(query);
    res.json({ success: true, data: items, meta: listMeta(query.page, query.limit, total) });
  } catch (error) {
    next(error);
  }
};

export const upsertExpenseProfileController: RequestHandler<
  { driverId: string },
  ApiSuccessResponse<ExpenseProfileDetail>,
  UpsertExpenseProfileInput
> = async (req, res, next) => {
  try {
    const actorUserId = requireActor(req.actor);
    const { profile, created } = await upsertExpenseProfile(req.params.driverId, req.body, actorUserId);
    res.status(created ? 201 : 200).json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};

export const createDailyExpenseController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<DailyExpenseDetail>,
  CreateDailyExpenseInput
> = async (req, res, next) => {
  try {
    const actorUserId = requireActor(req.actor);
    res.status(201).json({ success: true, data: await createDailyExpense(req.body, actorUserId) });
  } catch (error) {
    next(error);
  }
};

export const updateDailyExpenseController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DailyExpenseDetail>,
  UpdateDailyExpenseInput
> = async (req, res, next) => {
  try {
    const actorUserId = requireActor(req.actor);
    res.json({ success: true, data: await updateDailyExpense(req.params.id, req.body, actorUserId) });
  } catch (error) {
    next(error);
  }
};

export const getDailyExpenseController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DailyExpenseDetail>
> = async (req, res, next) => {
  try {
    res.json({ success: true, data: await getDailyExpense(req.params.id) });
  } catch (error) {
    next(error);
  }
};

export const listDailyExpensesForDateController: RequestHandler<
  { date: string },
  ApiSuccessResponse<DailyExpenseDetail[]>
> = async (req, res, next) => {
  try {
    res.json({ success: true, data: await listDailyExpensesForDate(req.params.date) });
  } catch (error) {
    next(error);
  }
};

export const listDailyExpensesController: RequestHandler<
  Record<string, never>,
  ApiListResponse<DailyExpenseDetail>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListDailyExpensesQuery;
    const { items, total } = await listDailyExpenses(query);
    res.json({ success: true, data: items, meta: listMeta(query.page, query.limit, total) });
  } catch (error) {
    next(error);
  }
};

export const listDriverExpenseHistoryController: RequestHandler<
  { driverId: string },
  ApiListResponse<DailyExpenseDetail>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as DriverExpenseHistoryQuery;
    const { items, total } = await listDriverExpenseHistory(req.params.driverId, query);
    res.json({ success: true, data: items, meta: listMeta(query.page, query.limit, total) });
  } catch (error) {
    next(error);
  }
};

// ---------------------------------------------------------------------------
// Reports (Phase 5) — read-only aggregates; same ADMIN-only router.
// ---------------------------------------------------------------------------

export const getReportSummaryController: RequestHandler<Record<string, never>, ApiSuccessResponse<ReportSummary>> = async (
  req,
  res,
  next
) => {
  try {
    res.json({ success: true, data: await getReportSummary(req.query as unknown as ReportFilterQuery) });
  } catch (error) {
    next(error);
  }
};

export const getDriverReportController: RequestHandler<Record<string, never>, ApiListResponse<DriverReportRow>> = async (
  req,
  res,
  next
) => {
  try {
    const query = req.query as unknown as DriverReportQuery;
    const { items, total } = await getDriverReport(query);
    res.json({ success: true, data: items, meta: listMeta(query.page, query.limit, total) });
  } catch (error) {
    next(error);
  }
};

export const getVehicleReportController: RequestHandler<Record<string, never>, ApiSuccessResponse<VehicleReportRow[]>> = async (
  req,
  res,
  next
) => {
  try {
    res.json({ success: true, data: await getVehicleReport(req.query as unknown as ReportFilterQuery) });
  } catch (error) {
    next(error);
  }
};

export const getDailyTrendController: RequestHandler<Record<string, never>, ApiSuccessResponse<DailyTrendRow[]>> = async (
  req,
  res,
  next
) => {
  try {
    res.json({ success: true, data: await getDailyTrend(req.query as unknown as ReportFilterQuery) });
  } catch (error) {
    next(error);
  }
};
