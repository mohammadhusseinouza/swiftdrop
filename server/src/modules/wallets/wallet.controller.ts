import { RequestHandler } from "express";
import {
  getWalletCustomerSummaries,
  getWalletDetail,
  listWallets,
  listWalletTransactions,
} from "./wallet.service";
import type {
  ListWalletsQuery,
  ListWalletTransactionsQuery,
  WalletCustomerSummariesQuery,
} from "./wallet.schema";
import type {
  WalletCustomerSummaryEntry,
  WalletDetail,
  WalletSummary,
  WalletTransactionEntry,
} from "./wallet.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const listWalletsController: RequestHandler<Record<string, never>, ApiListResponse<WalletSummary>> = async (
  req,
  res,
  next
) => {
  try {
    // validate({ query: ListWalletsQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result.
    const query = req.query as unknown as ListWalletsQuery;
    const { items, total } = await listWallets(query);
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

export const getWalletCustomerSummariesController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<WalletCustomerSummaryEntry[]>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as WalletCustomerSummariesQuery;
    const data = await getWalletCustomerSummaries(query.customerIds);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

export const getWalletDetailController: RequestHandler<{ customerId: string }, ApiSuccessResponse<WalletDetail>> = async (
  req,
  res,
  next
) => {
  try {
    const detail = await getWalletDetail(req.params.customerId);
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};

export const listWalletTransactionsController: RequestHandler<
  { customerId: string },
  ApiListResponse<WalletTransactionEntry>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListWalletTransactionsQuery;
    const { items, total } = await listWalletTransactions(req.params.customerId, query);
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
