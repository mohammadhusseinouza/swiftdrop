import { RequestHandler } from "express";
import { AppError } from "../../shared/errors/app-error";
import { createSettlement, getSettlementDetail, listSettlements } from "./settlement.service";
import { recordSettlementShortfall, reverseSettlement } from "./settlement-correction.service";
import type { CreateSettlementInput, ListSettlementsQuery, ReverseSettlementInput, SettlementShortfallInput } from "./settlement.schema";
import type { SettlementCorrectionEntry, SettlementDetail, SettlementSummary } from "./settlement.types";
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

// FR.6 — settlement corrections (contract §8).
export const reverseSettlementController: RequestHandler<
  { id: string },
  ApiSuccessResponse<SettlementCorrectionEntry>,
  ReverseSettlementInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const correction = await reverseSettlement(req.params.id, req.body, req.actor.userId);
    res.status(201).json({ success: true, data: correction });
  } catch (error) {
    next(error);
  }
};

export const recordSettlementShortfallController: RequestHandler<
  { id: string },
  ApiSuccessResponse<SettlementCorrectionEntry>,
  SettlementShortfallInput
> = async (req, res, next) => {
  try {
    if (!req.actor) {
      throw new AppError({ statusCode: 401, code: "UNAUTHORIZED", message: "Authentication required" });
    }
    const input = req.body as unknown as SettlementShortfallInput;
    const correction = await recordSettlementShortfall(req.params.id, input, req.actor.userId, req.idempotencyKey as string);
    res.status(201).json({ success: true, data: correction });
  } catch (error) {
    next(error);
  }
};

// FR.7 — settlement detail (allocations, releases, corrections).
export const getSettlementDetailController: RequestHandler<{ id: string }, ApiSuccessResponse<SettlementDetail>> = async (req, res, next) => {
  try {
    const detail = await getSettlementDetail(req.params.id);
    res.json({ success: true, data: detail });
  } catch (error) {
    next(error);
  }
};
