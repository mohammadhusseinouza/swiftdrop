import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createPayout, listPayouts } from "./payout.service";
import type { CreatePayoutInput, ListPayoutsQuery } from "./payout.schema";
import type { PayoutSummary } from "./payout.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const createPayoutController: RequestHandler<Record<string, never>, ApiSuccessResponse<PayoutSummary>> = async (
  req,
  res,
  next
) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    // validate({ body: CreatePayoutBodySchema }) has already replaced
    // req.body with the parsed/typed result — payoutNumber, status,
    // processedById, and every other server-derived field are never read
    // from the request.
    const input = req.body as unknown as CreatePayoutInput;
    const payout = await createPayout(input, req.actor.userId, req.idempotencyKey as string);
    res.status(201).json({ success: true, data: payout });
  } catch (error) {
    next(error);
  }
};

export const listPayoutsController: RequestHandler<Record<string, never>, ApiListResponse<PayoutSummary>> = async (
  req,
  res,
  next
) => {
  try {
    const query = req.query as unknown as ListPayoutsQuery;
    const { items, total } = await listPayouts(query);
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
