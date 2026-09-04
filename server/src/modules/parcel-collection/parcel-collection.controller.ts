import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getDriverProfileForUser } from "../auth/ownership.service";
import {
  assignParcelCollectionDriver,
  confirmReceivedAtCompany,
  failParcelCollection,
  getParcelCollectionForOrder,
  markCollectedFromSender,
  reassignParcelCollectionDriver,
  rescheduleParcelCollection,
} from "./parcel-collection.service";
import type {
  AssignParcelCollectionDriverInput,
  FailParcelCollectionInput,
  ReassignParcelCollectionDriverInput,
} from "./parcel-collection.schema";
import type { DriverParcelCollectionResult, ParcelCollectionDetail } from "./parcel-collection.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

function requireActorId(req: { actor?: { userId: string } }): string {
  if (!req.actor) {
    throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
  }
  return req.actor.userId;
}

// ---- Management -----------------------------------------------------------

export const getParcelCollectionController: RequestHandler<
  { id: string },
  ApiSuccessResponse<ParcelCollectionDetail>
> = async (req, res, next) => {
  try {
    requireActorId(req);
    const detail = await getParcelCollectionForOrder(req.params.id);
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};

export const assignParcelCollectionDriverController: RequestHandler<
  { id: string },
  ApiSuccessResponse<ParcelCollectionDetail>,
  AssignParcelCollectionDriverInput
> = async (req, res, next) => {
  try {
    const detail = await assignParcelCollectionDriver(req.params.id, req.body.driverId, requireActorId(req));
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};

export const reassignParcelCollectionDriverController: RequestHandler<
  { id: string },
  ApiSuccessResponse<ParcelCollectionDetail>,
  ReassignParcelCollectionDriverInput
> = async (req, res, next) => {
  try {
    const detail = await reassignParcelCollectionDriver(req.params.id, req.body.driverId, requireActorId(req));
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};

export const rescheduleParcelCollectionController: RequestHandler<
  { id: string },
  ApiSuccessResponse<ParcelCollectionDetail>
> = async (req, res, next) => {
  try {
    const detail = await rescheduleParcelCollection(req.params.id, requireActorId(req));
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};

export const confirmReceivedAtCompanyController: RequestHandler<
  { id: string },
  ApiSuccessResponse<ParcelCollectionDetail>
> = async (req, res, next) => {
  try {
    const detail = await confirmReceivedAtCompany(req.params.id, requireActorId(req));
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};

// ---- Driver (own job) ----------------------------------------------------
// TRUSTED IDENTITY: the Driver is resolved ONLY from req.actor.userId via
// getDriverProfileForUser — no driverId is ever read from the request.

export const markCollectedFromSenderController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverParcelCollectionResult>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const driver = await getDriverProfileForUser(req.actor.userId);
    const result = await markCollectedFromSender(driver.id, req.params.id);
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

export const failParcelCollectionController: RequestHandler<
  { id: string },
  ApiSuccessResponse<DriverParcelCollectionResult>,
  FailParcelCollectionInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const driver = await getDriverProfileForUser(req.actor.userId);
    const result = await failParcelCollection(
      driver.id,
      req.params.id,
      req.body.failedCollectionReasonId,
      req.body.notes ?? null,
    );
    res.json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};
