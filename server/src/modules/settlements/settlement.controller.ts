import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createSettlement, listSettlements } from "./settlement.service";
import type { CreateSettlementInput, ListSettlementsQuery } from "./settlement.schema";
import type { SettlementSummary } from "./settlement.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const createSettlementController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<SettlementSummary>
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    // validate({ body: CreateSettlementBodySchema }) has already replaced
    // req.body with the parsed/typed result — settlementNumber, balance
    // snapshots, receivedById, and every other server-derived field are
    // never read from the request.
    const input = req.body as unknown as CreateSettlementInput;
    const settlement = await createSettlement(input, req.actor.userId, req.idempotencyKey as string);
    res.status(201).json({ success: true, data: settlement });
  } catch (error) {
    next(error);
  }
};

export const listSettlementsController: RequestHandler<Record<string, never>, ApiListResponse<SettlementSummary>> = async (
  req,
  res,
  next
) => {
  try {
    const query = req.query as unknown as ListSettlementsQuery;
    const { items, total } = await listSettlements(query);
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
