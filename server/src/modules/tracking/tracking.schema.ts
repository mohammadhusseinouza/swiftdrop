import { z } from "zod";

export const OrderIdParamSchema = z.object({
  id: z.string().uuid(),
});

// tracking_code is varchar(100) (orders.tracking_code, format "TRK-XXXX...").
// Bounded, trimmed, non-empty — not a strict format regex, matching the
// existing audit-log entityId convention (a lookup filter, not a generated-
// value validator). An unmatched value is a normal safe 404, never a 400.
export const TrackingCodeParamSchema = z.object({
  trackingCode: z.string().trim().min(1).max(100),
});
