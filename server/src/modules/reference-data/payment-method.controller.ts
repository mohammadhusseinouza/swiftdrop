import { RequestHandler } from "express";
import {
  createPaymentMethod,
  getPaymentMethodById,
  listPaymentMethods,
  updatePaymentMethod,
} from "./payment-method.service";
import type {
  CreatePaymentMethodInput,
  ListPaymentMethodsQuery,
  UpdatePaymentMethodInput,
} from "./payment-method.schema";
import type { PaymentMethodSummary } from "./payment-method.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

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

export const createPaymentMethodController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<PaymentMethodSummary>,
  CreatePaymentMethodInput
> = async (req, res, next) => {
  try {
    const paymentMethod = await createPaymentMethod(req.body);
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
    const paymentMethod = await updatePaymentMethod(req.params.id, req.body);
    res.json({ success: true, data: paymentMethod });
  } catch (error) {
    next(error);
  }
};
