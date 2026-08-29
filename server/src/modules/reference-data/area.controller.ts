import { RequestHandler } from "express";
import { createArea, getAreaById, listAreas, updateArea } from "./area.service";
import type { CreateAreaInput, ListAreasQuery, UpdateAreaInput } from "./area.schema";
import type { AreaSummary } from "./area.types";
import type { ApiListResponse, ApiSuccessResponse } from "../../shared/types/api-response";

export const listAreasController: RequestHandler<
  Record<string, never>,
  ApiListResponse<AreaSummary>
> = async (req, res, next) => {
  try {
    // validate({ query: ListAreasQuerySchema }) has already replaced req.query
    // with the parsed/typed/defaulted result by the time this controller
    // runs — Express's own Query generic stays ParsedQs for route-chain
    // compatibility, so this cast reflects that real shape.
    const query = req.query as unknown as ListAreasQuery;
    const { items, total } = await listAreas(query);
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

export const createAreaController: RequestHandler<
  Record<string, never>,
  ApiSuccessResponse<AreaSummary>,
  CreateAreaInput
> = async (req, res, next) => {
  try {
    const area = await createArea(req.body);
    res.status(201).json({ success: true, data: area });
  } catch (error) {
    next(error);
  }
};

export const getAreaController: RequestHandler<
  { id: string },
  ApiSuccessResponse<AreaSummary>
> = async (req, res, next) => {
  try {
    const area = await getAreaById(req.params.id);
    res.json({ success: true, data: area });
  } catch (error) {
    next(error);
  }
};

export const updateAreaController: RequestHandler<
  { id: string },
  ApiSuccessResponse<AreaSummary>,
  UpdateAreaInput
> = async (req, res, next) => {
  try {
    const area = await updateArea(req.params.id, req.body);
    res.json({ success: true, data: area });
  } catch (error) {
    next(error);
  }
};
