import { z } from "zod";

// Management-safe Driver Cash read contract (Phase 11.7 correction).
// ALL of these are finance.read-gated in finance.routes.ts — drivers.read is
// never a bypass around approved finance permissions.

export const DriverCashDriverIdParamSchema = z.object({
  driverId: z.string().uuid(),
});

export const DriverCashTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type DriverCashTransactionsQuery = z.infer<typeof DriverCashTransactionsQuerySchema>;

// GET /finance/driver-cash/summaries?driverIds=<uuid>,<uuid>,...
// Batched Cash-Held lookup for a page of the Driver List — never one request
// per driver. Cap matches the list's max page size (100).
export const DRIVER_CASH_SUMMARIES_MAX_IDS = 100;

export const DriverCashSummariesQuerySchema = z.object({
  driverIds: z
    .string()
    .transform((val) =>
      val
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    )
    .pipe(z.array(z.string().uuid()).min(1).max(DRIVER_CASH_SUMMARIES_MAX_IDS)),
});

export type DriverCashSummariesQuery = z.infer<typeof DriverCashSummariesQuerySchema>;
