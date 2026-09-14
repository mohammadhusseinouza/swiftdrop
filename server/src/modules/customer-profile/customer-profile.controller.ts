import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerProfile } from "./customer-profile.service";
import type { CustomerProfile } from "./customer-profile.types";
import type { ApiSuccessResponse } from "../../shared/types/api-response";

// GET /api/v1/customer/me/profile (authenticate + requirePortal("customer") +
// authorize("customer.profile.read_own")). Trusted Customer identity — the
// Customer is resolved ONLY from req.actor.userId inside the service; there
// is no client-supplied customerId anywhere on this path.
export const getCustomerProfileController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<CustomerProfile>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const profile = await getCustomerProfile(req.actor.userId);
    res.json({ success: true, data: profile });
  } catch (error) {
    next(error);
  }
};
