import { z } from "zod";

// GET /api/v1/driver/jobs (Phase 12.1). jobType is optional — omitted means
// "All" (both Collection and Delivery), matching the approved quick-filter
// set (task §22): All / Collection / Delivery. No speculative filters.
export const DriverJobTypeFilterSchema = z.enum(["COLLECTION", "DELIVERY"]);

export const ListDriverJobsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  jobType: DriverJobTypeFilterSchema.optional(),
});

export type ListDriverJobsQuery = z.infer<typeof ListDriverJobsQuerySchema>;

// GET /api/v1/driver/jobs/:jobType/:orderId (Phase 12.2). The URL segment is
// lowercase (RESTful path convention, task §41) and is mapped to the
// uppercase domain value here — the ONE place that translation happens, so
// the controller/service only ever see "COLLECTION" | "DELIVERY". An
// unrecognized segment (anything other than "collection"/"delivery") fails
// this schema and reaches the client as the standard 400 VALIDATION_ERROR —
// never silently coerced to a guessed job type.
export const DriverJobTypeParamSchema = z
  .enum(["collection", "delivery"])
  .transform((value) => value.toUpperCase() as "COLLECTION" | "DELIVERY");

export const DriverJobDetailParamsSchema = z.object({
  jobType: DriverJobTypeParamSchema,
  orderId: z.string().uuid(),
});

export type DriverJobDetailParams = z.infer<typeof DriverJobDetailParamsSchema>;
