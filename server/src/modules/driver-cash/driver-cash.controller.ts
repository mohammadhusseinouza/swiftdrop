import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { getDriverProfileForUser } from "../auth/ownership.service";
import { getDriverCashOverview } from "./driver-cash.service";
import type { GetDriverCashQuery } from "./driver-cash.schema";
import type { DriverCashOverview } from "./driver-cash.types";
import type { ApiListMeta } from "../../shared/types/api-response";

// TRUSTED DRIVER IDENTITY: the Driver profile is resolved ONLY from
// req.actor.userId — never a client-supplied driverId. getDriverProfileForUser
// throws a safe 403 if the authenticated account (even an ADMIN, who holds
// driver.cash.read_own via the full permission catalog) has no linked
// drivers row — it never creates one and never lets an Admin impersonate an
// arbitrary Driver.
export const getDriverCashController: RequestHandler<
  Record<string, never>,
  { success: true; data: DriverCashOverview; meta: ApiListMeta }
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }

    const driver = await getDriverProfileForUser(req.actor.userId);

    // validate({ query: GetDriverCashQuerySchema }) has already replaced
    // req.query with the parsed/typed/defaulted result — same convention as
    // the Driver Orders list controller.
    const query = req.query as unknown as GetDriverCashQuery;
    const { overview, total } = await getDriverCashOverview(driver.id, query);
    const totalPages = Math.ceil(total / query.limit);

    res.json({
      success: true,
      data: overview,
      meta: { page: query.page, limit: query.limit, total, totalPages },
    });
  } catch (error) {
    next(error);
  }
};
