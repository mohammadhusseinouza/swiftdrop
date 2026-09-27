import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  createPaymentMethod,
  getPaymentMethodById,
  listActivePaymentMethodsForDriver,
  listPaymentMethods,
  updatePaymentMethod,
} from "./payment-method.service";
import type {
  CreatePaymentMethodInput,
  ListPaymentMethodsQuery,
  UpdatePaymentMethodInput,
} from "./payment-method.schema";
import type { DriverPaymentMethodSummary, PaymentMethodSummary } from "./payment-method.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

function requireActorId(req: { actor?: { userId: string } }): string {
  if (!req.actor) {
    throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return req.actor.userId;
}

export const listPaymentMethodsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<PaymentMethodSummary[]>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListPaymentMethodsQuery;
    const items = await listPaymentMethods(query);
    res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/driver/payment-methods — narrow Driver-safe list, authorized
// by driver.orders.read_own (NEVER settings.read). Mirrors
// listDriverFailedDeliveryReasonsController exactly.
export const listDriverPaymentMethodsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<DriverPaymentMethodSummary[]>
> = async (_req, res, next) => {
  try {
    res.json({ success: true, data: await listActivePaymentMethodsForDriver() });
  } catch (error) {
    next(error);
  }
};

export const createPaymentMethodController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<PaymentMethodSummary>,
  CreatePaymentMethodInput
> = async (req, res, next) => {
  try {
    const paymentMethod = await createPaymentMethod(req.body, requireActorId(req));
    res.status(201).json({ success: true, data: paymentMethod });
  } catch (error) {
    next(error);
  }
};

export const getPaymentMethodController: RequestHandler<
  { id: string },
  ApiSuccessResponse<PaymentMethodSummary>
> = async (req, res, next) => {
  try {
    const paymentMethod = await getPaymentMethodById(req.params.id);
    res.json({ success: true, data: paymentMethod });
  } catch (error) {
    next(error);
  }
};

export const updatePaymentMethodController: RequestHandler<
  { id: string },
  ApiSuccessResponse<PaymentMethodSummary>,
  UpdatePaymentMethodInput
> = async (req, res, next) => {
  try {
    const paymentMethod = await updatePaymentMethod(req.params.id, req.body, requireActorId(req));
    res.json({ success: true, data: paymentMethod });
  } catch (error) {
    next(error);
  }
};
