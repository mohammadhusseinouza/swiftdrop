import { z } from "zod";
import { OrderTypeSchema, PaymentTypeSchema, moneySchema } from "./order-financial.schema";

export const OrderIdParamSchema = z.object({
  id: z.string().uuid(),
});

// Real orders.status enum values (prisma/schema.prisma OrderStatus).
export const OrderStatusSchema = z.enum([
  "RECEIVED",
  "READY_FOR_PICKUP",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
  "FAILED_DELIVERY",
  "RESCHEDULED",
  "RETURNED_TO_COMPANY",
  "RETURNED_TO_CUSTOMER",
  "CANCELLED",
]);

// Real orders.financial_status enum values (prisma/schema.prisma OrderFinancialStatus).
export const OrderFinancialStatusSchema = z.enum(["PENDING", "FINALIZED", "REVIEW_REQUIRED", "NOT_APPLICABLE"]);

// Not a DB enum — a derived filter concept over orders.current_driver_id,
// which the schema exposes as a nullable FK rather than a boolean/enum
// column. ASSIGNED means current_driver_id IS NOT NULL; UNASSIGNED means it
// IS NULL. Never inferred from OrderStatus.
export const AssignmentStatusSchema = z.enum(["ASSIGNED", "UNASSIGNED"]);

const uuid = z.string().uuid();

// Same safe boolean-query pattern as Phase 5 (customers.isActive,
// drivers.isActive, areas.isActive, payment_methods.isActive) — never
// z.coerce.boolean(), which would treat the literal string "false" as truthy.
const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

// Matches a bare date ("2026-02-30") or an explicit-UTC datetime
// ("2026-02-30T10:00:00.000Z") so the literal calendar components can be
// round-tripped against what the Date constructor actually produced.
const ROLLOVER_CHECK_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z)?$/;

// z.coerce.date() alone is not strict enough: the ECMAScript Date parser
// silently rolls an impossible calendar day forward instead of rejecting
// it — e.g. new Date("2026-02-30") parses as March 2, 2026, and
// new Date("2026-02-30T10:00:00.000Z") parses as March 2, 2026T10:00Z.
// This round-trips the parsed UTC components back against the literal
// input for the date-only and explicit-UTC forms (the ones this query
// param realistically receives) and rejects any mismatch as 400, while
// out-of-range months/hours/etc. are already correctly rejected by the
// base Date parse. Non-UTC-offset datetime input (rare for this filter)
// is intentionally left to the base check only — disambiguating a
// timezone-shifted calendar day from true rollover is out of scope here.
function parseStrictDate(raw: string, ctx: z.RefinementCtx): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: "custom", message: "Invalid date" });
    return z.NEVER;
  }

  const match = ROLLOVER_CHECK_PATTERN.exec(raw);
  if (match) {
    const [, y, m, d, hh, mm, ss] = match;
    const rolledOver =
      date.getUTCFullYear() !== Number(y) ||
      date.getUTCMonth() + 1 !== Number(m) ||
      date.getUTCDate() !== Number(d) ||
      (hh !== undefined && date.getUTCHours() !== Number(hh)) ||
      (mm !== undefined && date.getUTCMinutes() !== Number(mm)) ||
      (ss !== undefined && date.getUTCSeconds() !== Number(ss));
    if (rolledOver) {
      ctx.addIssue({ code: "custom", message: "Invalid calendar date" });
      return z.NEVER;
    }
  }

  return date;
}

const strictDateSchema = z.string().transform(parseStrictDate);

export const ListOrdersQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    search: z.string().trim().min(1).max(200).optional(),

    status: OrderStatusSchema.optional(),
    orderType: OrderTypeSchema.optional(),
    paymentType: PaymentTypeSchema.optional(),
    financialStatus: OrderFinancialStatusSchema.optional(),

    customerId: uuid.optional(),
    driverId: uuid.optional(),
    areaId: uuid.optional(),

    needsFinancialReview: booleanQueryParam.optional(),
    assignmentStatus: AssignmentStatusSchema.optional(),

    createdFrom: strictDateSchema.optional(),
    createdTo: strictDateSchema.optional(),
  })
  .refine((data) => !data.createdFrom || !data.createdTo || data.createdFrom.getTime() <= data.createdTo.getTime(), {
    message: "createdFrom must be before or equal to createdTo",
    path: ["createdFrom"],
  });

export type ListOrdersQuery = z.infer<typeof ListOrdersQuerySchema>;

// ============================================================
// PATCH /api/v1/orders/:id (Phase 6.4)
//
// Deliberately NOT a reuse of OrderCreateFoundationSchema — a PATCH is
// partial by nature, and its payment-method cross-field requirements
// (prepaidPaymentMethodId/collectionPaymentMethodId required-or-null)
// depend on the EXISTING stored Order's financial state merged with
// whatever subset of fields this request supplies. That merge can only
// happen once the existing row has been read from the database, so it is
// performed in order.service.ts's updateOrder() — reusing the exact same
// Phase 6.1 calculateOrderFinancials/validatePaymentTypeConsistency
// functions used by create — not here. This schema only validates the
// per-field shape of whatever the client actually sent.
//
// orderType is intentionally NOT editable (CLAUDE.md-locked V1 rule: it
// changes financial ownership semantics and is immutable after creation).
// status/financialStatus/remaining*/amountToCollect/actualAmountCollected/
// collectionDifferenceReason/needsFinancialReview/currentDriverId/
// assignedAt/pickedUpAt/outForDeliveryAt/deliveredAt/cancelledAt/id/
// orderNumber/trackingCode/createdById/createdAt are all excluded — Zod's
// default strip-unknown-keys behavior (same convention as every other
// Phase 5/6 update schema) additionally guarantees none of them survive
// parsing even if a client sends them.
//
// Money fields use the REQUIRED moneySchema wrapped in .optional() — never
// order-create.schema.ts's optionalMoneySchema, which defaults a missing
// field to 0. In a PATCH, "field omitted" must mean "leave unchanged," not
// "reset to zero."
export const OrderUpdateSchema = z
  .object({
    customerId: z.string().uuid().optional(),

    receiverName: z.string().trim().min(1, "Receiver name is required").max(200).optional(),
    receiverPhone: z.string().trim().min(1, "Receiver phone is required").max(30).optional(),
    receiverAltPhone: z.string().trim().min(1).max(30).nullable().optional(),
    // Required V1 field on create, but naturally optional on PATCH — see
    // the AREA CHANGE / SNAPSHOT handling in order.service.ts: omitting it
    // preserves the existing receiver_area_id/receiver_area snapshot
    // exactly (even if the referenced Area was later renamed), and only an
    // explicit, actually-different value triggers a new snapshot.
    receiverAreaId: z.string().uuid().optional(),
    receiverAddress: z.string().trim().min(1, "Receiver address is required").max(500).optional(),
    receiverBuildingFloor: z.string().trim().min(1).max(200).nullable().optional(),
    receiverMapLink: z.string().trim().min(1).max(1000).nullable().optional(),
    receiverInstructions: z.string().trim().min(1).nullable().optional(),

    description: z.string().trim().min(1, "Description is required").optional(),
    packageCount: z.number().int().min(1).optional(),
    quantity: z.number().int().min(0).nullable().optional(),
    weightKg: z.coerce.number().min(0).nullable().optional(),
    packageNotes: z.string().trim().min(1).nullable().optional(),

    paymentType: PaymentTypeSchema.optional(),
    orderAmount: moneySchema.optional(),
    deliveryFee: moneySchema.optional(),
    prepaidOrderAmount: moneySchema.optional(),
    prepaidDeliveryFee: moneySchema.optional(),
    prepaidPaymentMethodId: z.string().uuid().nullable().optional(),
    collectionPaymentMethodId: z.string().uuid().nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type OrderUpdateInput = z.infer<typeof OrderUpdateSchema>;

// ============================================================
// Assignment / Reassignment / Bulk Assignment (Phase 6.5)
//
// None of these accept assignedById/assignedAt/status/currentDriverId/
// isCurrent — every one of those is server-derived (actor from
// req.actor.userId, timestamps from the transaction, status/current
// driver from the approved lifecycle rules in order.service.ts).
// ============================================================

export const AssignOrderSchema = z.object({
  driverId: z.string().uuid(),
});

export type AssignOrderInput = z.infer<typeof AssignOrderSchema>;

// A reassignment reason is required for V1 — it becomes
// order_assignments.end_reason on the assignment being ended, which is the
// only place this traceability is recorded (see REASSIGNMENT RULES in the
// Phase 6.5 report).
export const ReassignOrderSchema = z.object({
  driverId: z.string().uuid(),
  reason: z.string().trim().min(1, "Reason is required").max(500),
});

export type ReassignOrderInput = z.infer<typeof ReassignOrderSchema>;

export const BulkAssignOrdersSchema = z
  .object({
    orderIds: z
      .array(z.string().uuid())
      .min(1, "At least one order is required")
      .max(100, "At most 100 orders are allowed per bulk assignment"),
    driverId: z.string().uuid(),
  })
  // Reject duplicates outright rather than silently de-duplicating and
  // processing the same Order once — per the task's explicit preference.
  .refine((data) => new Set(data.orderIds).size === data.orderIds.length, {
    message: "orderIds must not contain duplicates",
    path: ["orderIds"],
  });

export type BulkAssignOrdersInput = z.infer<typeof BulkAssignOrdersSchema>;

// ============================================================
// Ready / Reschedule / Cancel (Phase 6.6)
//
// Ready accepts no body (POST /:id/ready) — no schema needed. Reschedule
// and Cancel both use order_status_history's real columns
// (reason varchar(500), notes text). Neither accepts status/cancelledAt/
// currentDriverId/changedById/endedAt/isCurrent — all server-derived.
// ============================================================

export const RescheduleOrderSchema = z.object({
  reason: z.string().trim().min(1, "Reason is required").max(500),
  notes: z.string().trim().min(1).optional(),
});

export type RescheduleOrderInput = z.infer<typeof RescheduleOrderSchema>;

export const CancelOrderSchema = z.object({
  reason: z.string().trim().min(1, "Reason is required").max(500),
  notes: z.string().trim().min(1).optional(),
});

export type CancelOrderInput = z.infer<typeof CancelOrderSchema>;

// POST /api/v1/orders/:id/resolve-collection-difference (Phase 8.7).
// moneySchema itself already permits zero (only rejects negative/>2-decimal/
// out-of-range) — exactly right here, since a component legitimately
// receives no allocation. Deliberately excludes orderType, expectedAmount,
// actualAmount, financialStatus, needsFinancialReview, driverCashAmount,
// actorId, idempotency keys, and status — all server-authoritative (see
// order.service.ts's resolveCollectionDifference).
export const ResolveCollectionDifferenceSchema = z.object({
  customerWalletCredit: moneySchema,
  companyProductRevenue: moneySchema,
  companyDeliveryFeeRevenue: moneySchema,
  resolutionNotes: z.string().trim().min(1, "resolutionNotes is required").max(2000),
});

export type ResolveCollectionDifferenceInput = z.infer<typeof ResolveCollectionDifferenceSchema>;
