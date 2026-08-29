import { RequestHandler } from "express";
import { listAuditLogs } from "./audit-read.service";
import type { ListAuditLogsQuery } from "./audit-read.schema";
import type { AuditLogEntry } from "./audit-read.types";
import type { ApiListResponse } from "../../shared/types/api-response";

export const listAuditLogsController: RequestHandler<Record<string, never>, ApiListResponse<AuditLogEntry>> = async (
  req,
  res,
  next
) => {
  try {
    // validate({ query: ListAuditLogsQuerySchema }) has already replaced
    // req.query with the parsed/typed result.
    const query = req.query as unknown as ListAuditLogsQuery;
    const { items, total } = await listAuditLogs(query);
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
