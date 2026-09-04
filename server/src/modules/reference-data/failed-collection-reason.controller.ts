import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import {
  createFailedCollectionReason,
  getFailedCollectionReasonById,
  listActiveFailedCollectionReasonsForDriver,
  listFailedCollectionReasons,
  updateFailedCollectionReason,
} from "./failed-collection-reason.service";
import type {
  CreateFailedCollectionReasonInput,
  ListFailedCollectionReasonsQuery,
  UpdateFailedCollectionReasonInput,
} from "./failed-collection-reason.schema";
import type {
  DriverFailedCollectionReasonSummary,
  FailedCollectionReasonSummary,
} from "./failed-collection-reason.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

function requireActorId(req: { actor?: { userId: string } }): string {
  if (!req.actor) {
    throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return req.actor.userId;
}

export const listFailedCollectionReasonsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FailedCollectionReasonSummary[]>
> = async (req, res, next) => {
  try {
    const query = req.query as unknown as ListFailedCollectionReasonsQuery;
    res.json({ success: true, data: await listFailedCollectionReasons(query) });
  } catch (error) {
    next(error);
  }
};

export const createFailedCollectionReasonController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<FailedCollectionReasonSummary>,
  CreateFailedCollectionReasonInput
> = async (req, res, next) => {
  try {
    const reason = await createFailedCollectionReason(req.body, requireActorId(req));
    res.status(201).json({ success: true, data: reason });
  } catch (error) {
    next(error);
  }
};

export const getFailedCollectionReasonController: RequestHandler<
  { id: string },
  ApiSuccessResponse<FailedCollectionReasonSummary>
> = async (req, res, next) => {
  try {
    res.json({ success: true, data: await getFailedCollectionReasonById(req.params.id) });
  } catch (error) {
    next(error);
  }
};

export const updateFailedCollectionReasonController: RequestHandler<
  { id: string },
  ApiSuccessResponse<FailedCollectionReasonSummary>,
  UpdateFailedCollectionReasonInput
> = async (req, res, next) => {
  try {
    const reason = await updateFailedCollectionReason(req.params.id, req.body, requireActorId(req));
    res.json({ success: true, data: reason });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/driver/failed-collection-reasons — narrow, active-only,
// authorized by driver.orders.read_own (NOT settings.read).
export const listDriverFailedCollectionReasonsController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<DriverFailedCollectionReasonSummary[]>
> = async (_req, res, next) => {
  try {
    res.json({ success: true, data: await listActiveFailedCollectionReasonsForDriver() });
  } catch (error) {
    next(error);
  }
};
