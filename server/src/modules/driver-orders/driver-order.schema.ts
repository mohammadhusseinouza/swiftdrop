import { z } from "zod";
import { moneySchema } from "../orders/order-financial.schema";

export const DriverOrderIdParamSchema = z.object({
  id: z.string().uuid(),
});

// Only the statuses an Order can realistically hold while current_driver_id
// is still set (Phase 6 lifecycle rules) — RECEIVED/READY_FOR_PICKUP/
// CANCELLED/RETURNED_* always carry a null current_driver_id in normal
// operation, so they are intentionally not offered as a Driver-side filter
// value. DELIVERED was added in Phase 7.5: unlike Management cancellation,
// a successful delivery deliberately preserves current_driver_id (see
// driver-order.service.ts's deliverDriverOrder), so a completed Order
// legitimately remains filterable here until a dedicated Driver
// Completed/history endpoint exists.
export const DriverOrderStatusFilterSchema = z.enum([
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "FAILED_DELIVERY",
  "RESCHEDULED",
  "DELIVERED",
]);

export const ListDriverOrdersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  status: DriverOrderStatusFilterSchema.optional(),
});

export type ListDriverOrdersQuery = z.infer<typeof ListDriverOrdersQuerySchema>;

// POST /api/v1/driver/orders/:id/fail (Phase 7.4). Only shape validation
// happens here — the business rule "notes are required when the selected
// reason's requires_notes=true" depends on a DB lookup and is enforced in
// driver-order.service.ts once the reason row is loaded. Unknown/spoofed
// fields (driverId, outcome, attemptNumber, expectedCollection,
// actualCollection, startedAt, completedAt, status, financialStatus,
// failedReasonName, ...) are silently stripped by Zod's default object
// behavior — never read, never effective.
export const FailDeliveryOrderSchema = z.object({
  failedReasonId: z.string().uuid(),
  notes: z.string().trim().min(1).optional(),
});

export type FailDeliveryOrderInput = z.infer<typeof FailDeliveryOrderSchema>;

// POST /api/v1/driver/orders/:id/deliver (Phase 7.5). Only shape validation
// happens here — the business rule "collectionDifferenceReason is required
// when actualAmountCollected differs from orders.amount_to_collect" depends
// on a DB read (the server-authoritative expected amount) and is enforced
// in driver-order.service.ts, same convention as Phase 7.4's requires_notes
// rule. actualAmountCollected reuses the exact Phase 6.1 moneySchema — the
// same non-negative/≤2-decimal-places/NUMERIC(14,2)-range Decimal-safe
// validation as every other money field in this project. Unknown/spoofed
// fields (expectedAmount, amountToCollect, difference, needsFinancialReview,
// financialStatus, outcome, attemptNumber, deliveredAt, driverId,
// currentDriverId, ...) are silently stripped by Zod's default object
// behavior — never read, never effective.
export const DeliverOrderSchema = z.object({
  actualAmountCollected: moneySchema,
  collectionDifferenceReason: z.string().trim().min(1).optional(),
});

export type DeliverOrderInput = z.infer<typeof DeliverOrderSchema>;
