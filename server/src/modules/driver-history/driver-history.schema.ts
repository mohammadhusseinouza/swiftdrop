import { z } from "zod";

// GET /api/v1/driver/history (Phase 12.5). Minimal, non-speculative filter
// set (task §8): result (COMPLETED | FAILED), jobType (COLLECTION |
// DELIVERY), page, limit. Both filters optional — omitted means "all".
// Pagination bounds match every other list endpoint in the repo
// (driver-cash / driver-jobs): default 20, max 100.
export const DriverHistoryResultFilterSchema = z.enum(["COMPLETED", "FAILED"]);
export const DriverHistoryJobTypeFilterSchema = z.enum(["COLLECTION", "DELIVERY"]);

export const ListDriverHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  result: DriverHistoryResultFilterSchema.optional(),
  jobType: DriverHistoryJobTypeFilterSchema.optional(),
});

export type ListDriverHistoryQuery = z.infer<typeof ListDriverHistoryQuerySchema>;
