import { z } from "zod";
import { dateOnlySchema, fromNotAfterTo } from "../../shared/date/date-range.schema";
import { OrderStatusSchema } from "../orders/order.schema";
import { OrderTypeSchema } from "../orders/order-financial.schema";

// Same safe boolean-query pattern already duplicated per-module elsewhere
// (drivers.isActive, customers.isActive, areas.isActive) — never
// z.coerce.boolean(), which would treat the literal string "false" as truthy.
const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

const uuid = z.string().uuid();

const baseDateRange = {
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
};

// ------------------------------------------------------------
// GET /api/v1/reports/orders
// ------------------------------------------------------------

export const OrderReportGroupBySchema = z.enum(["date", "customer", "driver", "area", "status", "type", "outcome"]);
export const OrderReportBucketSchema = z.enum(["day", "week", "month"]);

export const OrderReportQuerySchema = z
  .object({
    ...baseDateRange,
    groupBy: OrderReportGroupBySchema.optional().default("date"),
    // Only meaningful when groupBy=date (see order-report.service.ts) —
    // silently ignored for every other grouping rather than rejected, since
    // a client harmlessly repeating `bucket=day` while switching groupBy
    // values is not a validation error.
    bucket: OrderReportBucketSchema.optional().default("day"),
    customerId: uuid.optional(),
    driverId: uuid.optional(),
    areaId: uuid.optional(),
    status: OrderStatusSchema.optional(),
    orderType: OrderTypeSchema.optional(),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] });

export type OrderReportQuery = z.infer<typeof OrderReportQuerySchema>;

// ------------------------------------------------------------
// GET /api/v1/reports/drivers
// ------------------------------------------------------------

export const DriverReportQuerySchema = z
  .object({
    ...baseDateRange,
    driverId: uuid.optional(),
    isActive: booleanQueryParam.optional(),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] });

export type DriverReportQuery = z.infer<typeof DriverReportQuerySchema>;

// ------------------------------------------------------------
// GET /api/v1/reports/customers
// ------------------------------------------------------------

export const CustomerReportQuerySchema = z
  .object({
    ...baseDateRange,
    customerId: uuid.optional(),
    isActive: booleanQueryParam.optional(),
    areaId: uuid.optional(),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] });

export type CustomerReportQuery = z.infer<typeof CustomerReportQuerySchema>;

// ------------------------------------------------------------
// GET /api/v1/reports/finance
// ------------------------------------------------------------

export const FinanceReportGroupBySchema = z.enum(["day", "week", "month", "category"]);

export const FinanceReportQuerySchema = z
  .object({
    ...baseDateRange,
    groupBy: FinanceReportGroupBySchema.optional().default("month"),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] });

export type FinanceReportQuery = z.infer<typeof FinanceReportQuerySchema>;
