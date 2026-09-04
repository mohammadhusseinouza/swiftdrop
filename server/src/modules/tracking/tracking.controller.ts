import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerOrderTracking, getPublicTracking } from "./tracking.service";
import type { CustomerTrackingDetail, PublicTrackingDetail } from "./tracking.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

// GET /api/v1/customer/me/orders/:id/tracking (authenticate + requirePortal
// customer + customer.orders.read_own).
export const getCustomerOrderTrackingController: RequestHandler<
  { id: string },
  ApiSuccessResponse<CustomerTrackingDetail>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const tracking = await getCustomerOrderTracking(req.actor.userId, req.params.id);
    res.json({ success: true, data: tracking });
  } catch (error) {
    next(error);
  }
};

// GET /api/v1/track/:trackingCode — UNAUTHENTICATED, public.
export const getPublicTrackingController: RequestHandler<
  { trackingCode: string },
  ApiSuccessResponse<PublicTrackingDetail>
> = async (req, res, next) => {
  try {
    const tracking = await getPublicTracking(req.params.trackingCode);
    res.json({ success: true, data: tracking });
  } catch (error) {
    next(error);
  }
};
