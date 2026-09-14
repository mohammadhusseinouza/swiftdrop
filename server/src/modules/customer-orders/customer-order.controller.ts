import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerOrderDetail, listCustomerOrders } from "./customer-order.service";
import type { ListCustomerOrdersQuery } from "./customer-order.schema";
import type { CustomerOrderDetail, CustomerOrderSummary } from "./customer-order.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

// GET /api/v1/customer/me/orders (authenticate + requirePortal("customer") +
// authorize("customer.orders.read_own")).
//
// TRUSTED CUSTOMER IDENTITY: the Customer is resolved ONLY from
// req.actor.userId inside the service. `validate({ query })` has already
// replaced req.query with the parsed/typed/defaulted result.
export const listCustomerOrdersController: RequestHandler<
  Record<string, never>,
  ApiListResponse<CustomerOrderSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const query = req.query as unknown as ListCustomerOrdersQuery;
    const { items, total } = await listCustomerOrders(req.actor.userId, query);
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

// GET /api/v1/customer/me/orders/:id (Phase 13.3). Same guard chain +
// trusted Customer identity. A not-owned Order id returns 404, identical to
// a nonexistent one (IDOR-safe — enforced in the service query).
export const getCustomerOrderDetailController: RequestHandler<
  { id: string },
  ApiSuccessResponse<CustomerOrderDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const detail = await getCustomerOrderDetail(req.actor.userId, req.params.id);
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};
