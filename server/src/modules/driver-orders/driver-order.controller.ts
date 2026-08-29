import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getDriverProfileForUser } from "../auth/ownership.service";
import {
  deliverDriverOrder,
  failDriverOrder,
  getDriverOrderById,
  listDriverOrders,
  pickupDriverOrder,
  startDeliveryDriverOrder,
} from "./driver-order.service";
import type { DeliverOrderInput, FailDeliveryOrderInput, ListDriverOrdersQuery } from "./driver-order.schema";
import type { DriverOrderDetail, DriverOrderSummary } from "./driver-order.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

// TRUSTED DRIVER IDENTITY (Phase 7.1): the Driver profile is resolved ONLY
// from req.actor.userId — the authenticated, database-derived identity
// authenticate() already attached to the request. There is no code path in
// this controller that reads a driverId from query/params/body/JWT claim.
// getDriverProfileForUser throws a safe 403 if the authenticated account
// (even an ADMIN, who holds driver.orders.read_own in the permission
// catalog) has no linked drivers row — it never creates one.
export const listDriverOrdersController: RequestHandler<
  Record<string, never>,
  ApiListResponse<DriverOrderSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);

    // validate({ query: ListDriverOrdersQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result — same convention as
    // the Management orders list controller.
    const query = req.query as unknown as ListDriverOrdersQuery;
    const { items, total } = await listDriverOrders(driver.id, query);
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

export const getDriverOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverOrderDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);
    const order = await getDriverOrderById(driver.id, req.params.id);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/driver/orders/:id/pickup (Phase 7.2) — accepts no request
// body; the Order id comes only from the validated route param, and the
// Driver identity comes only from getDriverProfileForUser(req.actor.userId)
// — any client-supplied driverId/currentDriverId/pickedUpById in the body
// is simply never read.
export const pickupDriverOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverOrderDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);
    const order = await pickupDriverOrder(driver.id, req.params.id, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/driver/orders/:id/start-delivery (Phase 7.3) — accepts no
// request body; identical trusted-identity discipline as pickup above.
export const startDeliveryDriverOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverOrderDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);
    const order = await startDeliveryDriverOrder(driver.id, req.params.id, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/driver/orders/:id/fail (Phase 7.4) — the only client input
// ever read is body.failedReasonId/body.notes, both already shape-validated
// by FailDeliveryOrderSchema; every other field (driverId, outcome,
// attemptNumber, expectedCollection, actualCollection, startedAt,
// completedAt, status, financialStatus, failedReasonName, ...) is stripped
// by Zod and never reaches this controller or the service below.
export const failDriverOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverOrderDetail>,
  FailDeliveryOrderInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);
    const order = await failDriverOrder(driver.id, req.params.id, req.body.failedReasonId, req.body.notes ?? null, req.actor.userId);
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};

// POST /api/v1/driver/orders/:id/deliver (Phase 7.5) — the only client
// input ever read is body.actualAmountCollected/body.collectionDifferenceReason,
// both already shape-validated by DeliverOrderSchema (actualAmountCollected
// is already a Prisma.Decimal by the time it reaches here — moneySchema
// transforms it); every other field (expectedAmount, amountToCollect,
// difference, needsFinancialReview, financialStatus, outcome,
// attemptNumber, deliveredAt, driverId, currentDriverId, ...) is stripped
// by Zod and never reaches this controller or the service below.
export const deliverDriverOrderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverOrderDetail>,
  DeliverOrderInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);
    const order = await deliverDriverOrder(
      driver.id,
      req.params.id,
      req.body.actualAmountCollected,
      req.body.collectionDifferenceReason ?? null,
      req.actor.userId
    );
    res.json({ success: true, data: order });
  } catch (error) {
    next(error);
  }
};
