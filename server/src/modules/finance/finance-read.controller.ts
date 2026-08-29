import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getFinanceSummary } from "./finance-summary.service";
import { getFinanceTransactions } from "./finance-transaction.service";
import type { FinanceDateRangeQuery, FinanceTransactionsQuery } from "./finance-read.schema";
import type { FinanceSummaryDto, FinanceTransactionEntry } from "./finance-read.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const getFinanceSummaryController: RequestHandler<Record<string, never>, ApiSuccessResponse<FinanceSummaryDto>> = async (
  req,
  res,
  next
) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as FinanceDateRangeQuery;
    const summary = await getFinanceSummary(query);
    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};

export const getFinanceTransactionsController: RequestHandler<Record<string, never>, ApiListResponse<FinanceTransactionEntry>> = async (
  req,
  res,
  next
) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as FinanceTransactionsQuery;
    const { items, total } = await getFinanceTransactions(query);
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
