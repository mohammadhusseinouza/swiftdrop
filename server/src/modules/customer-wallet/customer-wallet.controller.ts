import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerWallet, listCustomerWalletTransactions } from "./customer-wallet.service";
import type { ListCustomerWalletTransactionsQuery } from "./customer-wallet.schema";
import type { CustomerWalletSummary, CustomerWalletTransactionSummary } from "./customer-wallet.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

// GET /api/v1/customer/me/wallet (authenticate + requirePortal("customer") +
// authorize("customer.wallet.read_own")). Trusted Customer identity — the
// Customer is resolved ONLY from req.actor.userId inside the service.
export const getCustomerWalletController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<CustomerWalletSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const wallet = await getCustomerWallet(req.actor.userId);
    res.json({ success: true, data: wallet });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/customer/me/wallet/transactions (Phase 13.5). Same guard chain
// + trusted Customer identity. `validate({ query })` has already parsed /
// typed / defaulted req.query.
export const listCustomerWalletTransactionsController: RequestHandler<
  Record<string, never>,
  ApiListResponse<CustomerWalletTransactionSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as ListCustomerWalletTransactionsQuery;
    const { items, total } = await listCustomerWalletTransactions(req.actor.userId, query);
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
