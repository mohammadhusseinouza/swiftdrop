import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerDashboardSummary } from "./customer-dashboard.service";
import type { CustomerDashboardSummary } from "./customer-dashboard.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

// GET /api/v1/customer/me/dashboard (authenticate + requirePortal("customer")
// + authorize("customer.dashboard.read_own")).
//
// TRUSTED CUSTOMER IDENTITY: the Customer is resolved ONLY from
// req.actor.userId inside the service — there is no client-supplied
// customerId anywhere on this path.
export const getCustomerDashboardController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<CustomerDashboardSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const summary = await getCustomerDashboardSummary(req.actor.userId);
    res.json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};
