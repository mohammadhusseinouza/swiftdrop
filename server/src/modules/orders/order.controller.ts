import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  assignOrder,
  bulkAssignOrders,
  cancelOrder,
  createOrder,
  getOrderById,
  getOrderHistory,
  listOrders,
  reassignOrder,
  readyOrder,
  rescheduleOrder,
  resolveCollectionDifference,
  updateOrder,
} from "./order.service";
import type { OrderCreateFoundationInput } from "./order-create.schema";
import type {
  AssignOrderInput,
  BulkAssignOrdersInput,
  CancelOrderInput,
  ListOrdersQuery,
  OrderUpdateInput,
  ReassignOrderInput,
  ResolveCollectionDifferenceInput,
  RescheduleOrderInput,
} from "./order.schema";
import type { BulkAssignResult, OrderDetail, OrderHistoryResponse, OrderSummary } from "./order.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const createOrderController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<OrderDetail>,
  OrderCreateFoundationInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await createOrder(req.body, req.actor.userId);
    res.status(201).json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const getOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>
> = async (req, res, next) => {
  try {
    const order = await getOrderById(req.params.id);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const updateOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>,
  OrderUpdateInput
> = async (req, res, next) => {
  try {
    const order = await updateOrder(req.params.id, req.body);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const assignOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>,
  AssignOrderInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await assignOrder(req.params.id, req.body.driverId, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const reassignOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>,
  ReassignOrderInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await reassignOrder(req.params.id, req.body.driverId, req.body.reason, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const bulkAssignOrdersController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<BulkAssignResult>,
  BulkAssignOrdersInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const result = await bulkAssignOrders(req.body.orderIds, req.body.driverId, req.actor.userId);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const readyOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await readyOrder(req.params.id, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const rescheduleOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>,
  RescheduleOrderInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await rescheduleOrder(req.params.id, req.body.reason, req.body.notes, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const cancelOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>,
  CancelOrderInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await cancelOrder(req.params.id, req.body.reason, req.body.notes, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const resolveCollectionDifferenceController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderDetail>,
  ResolveCollectionDifferenceInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const order = await resolveCollectionDifference(req.params.id, req.body, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

export const getOrderHistoryController: RequestHandler<
  { id: string },
  ApiSuccessResponse<OrderHistoryResponse>
> = async (req, res, next) => {
  try {
    const history = await getOrderHistory(req.params.id);
    res.json({ success: true, data: history });
  } catch (error) {
    next(error);
  }
};

export const listOrdersController: RequestHandler<
  Record<string, never>,
  ApiListResponse<OrderSummary>
> = async (req, res, next) => {
  try {
    // validate({ query: ListOrdersQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result by the time this
    // controller runs — same convention as Customers/Drivers/Areas.
    const query = req.query as unknown as ListOrdersQuery;
    const { items, total } = await listOrders(query);
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
