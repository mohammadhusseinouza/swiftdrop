import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  createFailedDeliveryReason,
  getFailedDeliveryReasonById,
  listFailedDeliveryReasons,
  updateFailedDeliveryReason,
} from "./failed-delivery-reason.service";
import type {
  CreateFailedDeliveryReasonInput,
  ListFailedDeliveryReasonsQuery,
  UpdateFailedDeliveryReasonInput,
} from "./failed-delivery-reason.schema";
import type { FailedDeliveryReasonSummary } from "./failed-delivery-reason.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

function requireActorId(req: { actor?: { userId: string } }): string {
  if (!req.actor) {
    throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return req.actor.userId;
}

export const listFailedDeliveryReasonsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FailedDeliveryReasonSummary[]>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListFailedDeliveryReasonsQuery;
    const items = await listFailedDeliveryReasons(query);
    res.json({ success: true, data: items });
  } catch (error) {
    next(error);
  }
};

export const createFailedDeliveryReasonController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FailedDeliveryReasonSummary>,
  CreateFailedDeliveryReasonInput
> = async (req, res, next) => {
  try {
    const reason = await createFailedDeliveryReason(req.body, requireActorId(req));
    res.status(201).json({ success: true, data: reason });
  } catch (error) {
    next(error);
  }
};

export const getFailedDeliveryReasonController: RequestHandler<
  { id: string },
  ApiSuccessResponse<FailedDeliveryReasonSummary>
> = async (req, res, next) => {
  try {
    const reason = await getFailedDeliveryReasonById(req.params.id);
    res.json({ success: true, data: reason });
  } catch (error) {
    next(error);
  }
};

export const updateFailedDeliveryReasonController: RequestHandler<
  { id: string },
  ApiSuccessResponse<FailedDeliveryReasonSummary>,
  UpdateFailedDeliveryReasonInput
> = async (req, res, next) => {
  try {
    const reason = await updateFailedDeliveryReason(req.params.id, req.body, requireActorId(req));
    res.json({ success: true, data: reason });
  } catch (error) {
    next(error);
  }
};
