import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { listCustomerPayouts } from "./customer-payout.service";
import type { ListCustomerPayoutsQuery } from "./customer-payout.schema";
import type { CustomerPayoutSummary } from "./customer-payout.types";
import type { ApiListResponse } from "../../shared/types/api-response";

// GET /api/v1/customer/me/payouts (authenticate + requirePortal("customer") +
// authorize("customer.payouts.read_own")).
//
// TRUSTED CUSTOMER IDENTITY: the Customer is resolved ONLY from
// req.actor.userId inside the service. `validate({ query })` has already
// parsed / typed / defaulted req.query.
export const listCustomerPayoutsController: RequestHandler<
  Record<string, never>,
  ApiListResponse<CustomerPayoutSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const query = req.query as unknown as ListCustomerPayoutsQuery;
    const { items, total } = await listCustomerPayouts(req.actor.userId, query);
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
