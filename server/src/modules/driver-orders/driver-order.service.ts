import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { assertConsistentCurrentAssignment } from "../orders/order.service";
import { calculateCollectionDifference } from "../orders/order-financial.service";
import { creditDriverCollection } from "../driver-cash/driver-cash-ledger.service";
import { creditWalletForOrder } from "../wallets/wallet-ledger.service";
import { recordDeliveryFeeRevenue, recordCompanyOrderProductRevenue } from "../company-finance/company-finance-ledger.service";
import { createAuditLog } from "../../shared/audit/audit.service";
import type { ListDriverOrdersQuery } from "./driver-order.schema";
import type { DriverOrderDetail, DriverOrderSummary } from "./driver-order.types";

// ============================================================
// QUERY SECURITY (Phase 7.1): every function in this module takes a
// `driverId` parameter that MUST be resolved server-side via
// getDriverProfileForUser(req.actor.userId) — see driver-order.controller.ts.
// There is no code path here that accepts a client-supplied driver
// identity. The ownership predicate (current_driver_id: driverId) is a
// mandatory, non-optional top-level key on every `where` clause below —
// never conditionally attached — so it can never be accidentally composed
// away by a filter.
// ============================================================

const driverOrderSelect = {
  id: true,
  order_number: true,
  tracking_code: true,
  order_type: true,
  status: true,

  receiver_name: true,
  receiver_phone: true,
  receiver_alt_phone: true,
  receiver_area: true,
  receiver_address: true,
  receiver_building_floor: true,
  receiver_map_link: true,
  receiver_instructions: true,

  description: true,
  package_count: true,
  quantity: true,
  weight_kg: true,
  package_notes: true,

  amount_to_collect: true,
  // Safe to echo back — it is the Driver's own submitted value (Phase 7.5).
  // financialStatus/needsFinancialReview/collectionDifferenceReason remain
  // Management/Finance-only and are deliberately never selected here.
  actual_amount_collected: true,
  payment_methods_orders_collection_payment_method_idTopayment_methods: {
    select: { id: true, code: true, name: true },
  },

  assigned_at: true,
  picked_up_at: true,
  out_for_delivery_at: true,
  delivered_at: true,
} satisfies Prisma.ordersSelect;

type DriverOrderRow = Prisma.ordersGetPayload<{ select: typeof driverOrderSelect }>;

function toDriverOrderSummary(row: DriverOrderRow): DriverOrderSummary {
  return {
    id: row.id,
    orderNumber: row.order_number,
    trackingCode: row.tracking_code,
    orderType: row.order_type,
    status: row.status,

    receiver: {
      name: row.receiver_name,
      phone: row.receiver_phone,
      altPhone: row.receiver_alt_phone,
      area: row.receiver_area,
      address: row.receiver_address,
      buildingFloor: row.receiver_building_floor,
      mapLink: row.receiver_map_link,
      instructions: row.receiver_instructions,
    },

    package: {
      description: row.description,
      packageCount: row.package_count,
      quantity: row.quantity,
      weightKg: row.weight_kg ? row.weight_kg.toString() : null,
      notes: row.package_notes,
    },

    collection: {
      amountToCollect: row.amount_to_collect.toString(),
      actualAmountCollected: row.actual_amount_collected ? row.actual_amount_collected.toString() : null,
      paymentMethod: row.payment_methods_orders_collection_payment_method_idTopayment_methods
        ? {
            id: row.payment_methods_orders_collection_payment_method_idTopayment_methods.id,
            code: row.payment_methods_orders_collection_payment_method_idTopayment_methods.code,
            name: row.payment_methods_orders_collection_payment_method_idTopayment_methods.name,
          }
        : null,
    },

    timestamps: {
      assignedAt: row.assigned_at ? row.assigned_at.toISOString() : null,
      pickedUpAt: row.picked_up_at ? row.picked_up_at.toISOString() : null,
      outForDeliveryAt: row.out_for_delivery_at ? row.out_for_delivery_at.toISOString() : null,
      deliveredAt: row.delivered_at ? row.delivered_at.toISOString() : null,
    },
  };
}

export interface ListDriverOrdersResult {
  items: DriverOrderSummary[];
  total: number;
}

// Shared by Phase 7.4 (/fail) and Phase 7.5 (/deliver) — both finalize a
// delivery_attempts row only once an outcome is known. Must be called ONLY
// after the caller's transaction has already won the exact OUT_FOR_DELIVERY
// state claim on the Order — that row transition is the concurrency mutex,
// so no other request can be concurrently allocating a number for the same
// order at the point this runs. MAX+1 (not COUNT+1) tolerates any
// historical gaps; the DB's UNIQUE(order_id, attempt_number) constraint
// remains the backstop regardless.
async function allocateNextAttemptNumber(tx: Prisma.TransactionClient, orderId: string): Promise<number> {
  const maxAttempt = await tx.delivery_attempts.aggregate({
    where: { order_id: orderId },
    _max: { attempt_number: true },
  });
  return (maxAttempt._max.attempt_number ?? 0) + 1;
}

// GET /api/v1/driver/me/orders — Orders currently assigned to `driverId`
// only. Ownership is current_driver_id equality, never derived from
// historical order_assignments rows (a reassigned/cancelled Order must
// disappear immediately — see CURRENT ASSIGNMENT RULE in the Phase 7.1
// task). current_driver_id is always a plain top-level `where` key, so it
// is structurally ANDed with every other condition below by Prisma — a
// status/search filter can never compose it away.
export async function listDriverOrders(driverId: string, query: ListDriverOrdersQuery): Promise<ListDriverOrdersResult> {
  const where: Prisma.ordersWhereInput = { current_driver_id: driverId };

  if (query.status) {
    where.status = query.status;
  }

  if (query.search) {
    where.OR = [
      { order_number: { contains: query.search, mode: "insensitive" } },
      { tracking_code: { contains: query.search, mode: "insensitive" } },
      { receiver_name: { contains: query.search, mode: "insensitive" } },
      { receiver_phone: { contains: query.search, mode: "insensitive" } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.orders.findMany({
      where,
      select: driverOrderSelect,
      // assigned_at DESC with created_at/id tiebreakers — deterministic even
      // for seeded/edge-case rows where assigned_at might coincide or (in
      // malformed test fixtures only) be null.
      orderBy: [{ assigned_at: "desc" }, { created_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.orders.count({ where }),
  ]);

  return { items: rows.map(toDriverOrderSummary), total };
}

// GET /api/v1/driver/me/orders/:id — ownership is enforced IN the query
// (findFirst with both id and current_driver_id in the same `where`), never
// checked after a global-by-id lookup. An Order that exists but is
// currently assigned to a different Driver returns the identical 404 as a
// nonexistent Order — never a 403 that would leak its existence (CROSS-
// DRIVER PRIVACY in the Phase 7.1 task).
export async function getDriverOrderById(driverId: string, orderId: string): Promise<DriverOrderDetail> {
  const order = await prisma.orders.findFirst({
    where: { id: orderId, current_driver_id: driverId },
    select: driverOrderSelect,
  });

  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }

  return toDriverOrderSummary(order);
}

// ============================================================
// POST /api/v1/driver/orders/:id/pickup (Phase 7.2)
//
// ASSIGNED -> PICKED_UP only, and only for the Order's authenticated
// CURRENT driver — never a historically-assigned-but-since-reassigned
// Driver. Deliberately does NOT create a delivery_attempts row: the
// approved schema's delivery_attempts.outcome is NOT NULL and the
// DeliveryAttemptOutcome enum only has DELIVERED/FAILED/RETURNED — there is
// no in-progress outcome value, so creating a row here would force an
// invented, premature final outcome. Phase 7.3+ must decide how attempt
// timing is represented without corrupting that meaning; not solved here.
// ============================================================
export async function pickupDriverOrder(driverId: string, orderId: string, actorUserId: string): Promise<DriverOrderDetail> {
  // Ownership enforced in the query itself (id + current_driver_id together)
  // — an Order that exists but belongs to another Driver, or one this
  // Driver was previously assigned to but has since been reassigned away
  // from, returns the identical 404 as a nonexistent Order (same contract
  // as Phase 7.1's getDriverOrderById).
  const existing = await prisma.orders.findFirst({ where: { id: orderId, current_driver_id: driverId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (existing.status !== "ASSIGNED") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be picked up while its status is ${existing.status}`,
    });
  }

  // Assignment-history integrity — reused verbatim from Phase 6 (never a
  // subtly different duplicate check). Never silently repaired; fails
  // closed with a sanitized 500 if the current_driver_id/order_assignments
  // invariant is somehow violated.
  await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: "ASSIGNED", current_driver_id: driverId },
      data: { status: "PICKED_UP", picked_up_at: now, updated_at: now },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    // The current assignment row is untouched — the same Driver remains
    // assigned, so there is nothing to end/create. No delivery_attempts
    // row (see module doc comment above). No financial/collection field is
    // touched — pickup is not a collection event.
    await tx.order_status_history.create({
      data: { order_id: orderId, from_status: "ASSIGNED", to_status: "PICKED_UP", changed_by_id: actorUserId },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, select: driverOrderSelect });
    return toDriverOrderSummary(updated);
  });
}

// ============================================================
// POST /api/v1/driver/orders/:id/start-delivery (Phase 7.3)
//
// Two approved source statuses, both requiring the authenticated CURRENT
// driver:
//   PICKED_UP    -> OUT_FOR_DELIVERY   (normal first attempt)
//   RESCHEDULED  -> OUT_FOR_DELIVERY   (same-driver retry after a prior
//                                       failed attempt — Phase 6.6
//                                       deliberately preserved the current
//                                       driver/assignment through reschedule
//                                       specifically so this retry would not
//                                       require a second PICKED_UP event)
//
// A RESCHEDULED order reassigned to a DIFFERENT driver already transitioned
// to ASSIGNED at reassignment time (Phase 6.6/6.5) — that new driver must
// go through the normal pickup -> start-delivery sequence, so no special
// flag is needed here to distinguish "retry" from "first attempt": the
// order's live status IS the distinguishing signal.
//
// Deliberately creates NO delivery_attempts row — same schema-consistency
// reasoning as Phase 7.2 Pickup (delivery_attempts.outcome is NOT NULL and
// DeliveryAttemptOutcome only has DELIVERED/FAILED/RETURNED, so there is no
// in-progress value to store). out_for_delivery_at instead represents the
// start of the CURRENT attempt at the Order level; Phase 7.4/7.5 will read
// it as the finalized delivery_attempt's started_at when the attempt
// completes (see the module-level contract note below). attempt_number is
// deliberately not computed here — it belongs to the finalized row Phase
// 7.4/7.5 will create.
// ============================================================

const START_DELIVERY_SOURCE_STATUSES = new Set(["PICKED_UP", "RESCHEDULED"]);

export async function startDeliveryDriverOrder(driverId: string, orderId: string, actorUserId: string): Promise<DriverOrderDetail> {
  // Ownership enforced in the query itself, identical contract to Pickup —
  // a non-owned or nonexistent Order returns the same safe 404.
  const existing = await prisma.orders.findFirst({ where: { id: orderId, current_driver_id: driverId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (!START_DELIVERY_SOURCE_STATUSES.has(existing.status)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot start delivery while its status is ${existing.status}`,
    });
  }
  const sourceStatus = existing.status as "PICKED_UP" | "RESCHEDULED";

  // Assignment-history integrity — reused verbatim from Phase 6, never a
  // subtly different duplicate check. Fails closed with a sanitized 500 on
  // corruption; never silently repaired.
  await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: sourceStatus, current_driver_id: driverId },
      // out_for_delivery_at is always overwritten with this attempt's start
      // time — a RESCHEDULED retry must NOT keep the prior (failed)
      // attempt's out_for_delivery_at; that historical value belongs in the
      // prior attempt's own finalized delivery_attempts row, untouched by
      // this transition.
      data: { status: "OUT_FOR_DELIVERY", out_for_delivery_at: now, updated_at: now },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    // Current assignment is untouched (same driver remains assigned). No
    // delivery_attempts row is created or modified — see module doc
    // comment above. No financial/collection field is touched.
    await tx.order_status_history.create({
      data: { order_id: orderId, from_status: sourceStatus, to_status: "OUT_FOR_DELIVERY", changed_by_id: actorUserId },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, select: driverOrderSelect });
    return toDriverOrderSummary(updated);
  });
}

// ============================================================
// POST /api/v1/driver/orders/:id/fail (Phase 7.4)
//
// OUT_FOR_DELIVERY -> FAILED_DELIVERY only, for the authenticated CURRENT
// driver. Unlike Pickup/Start Delivery, the final outcome IS known here, so
// this is the point where Phase 7.2/7.3's deferred delivery_attempts row is
// finally materialized — one finalized FAILED row per attempt, never a
// placeholder.
//
// FAIL VS FUTURE DELIVER CONTRACT (documented for Phase 7.5): /deliver will
// claim the identical {id, status: OUT_FOR_DELIVERY, current_driver_id}
// state via the same conditional-updateMany pattern used here, so exactly
// one of a concurrent /fail vs /deliver pair can ever win — the loser's
// updateMany affects 0 rows and gets 409 (or a pre-transaction 400 if its
// read happened after the winner's commit), identical to every other
// Phase 6/7 transition guard. Not implemented here.
// ============================================================
export async function failDriverOrder(
  driverId: string,
  orderId: string,
  failedReasonId: string,
  notes: string | null,
  actorUserId: string
): Promise<DriverOrderDetail> {
  // Ownership enforced in the query itself, identical contract to
  // Pickup/Start Delivery — a non-owned or nonexistent Order returns the
  // same safe 404.
  const existing = await prisma.orders.findFirst({ where: { id: orderId, current_driver_id: driverId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (existing.status !== "OUT_FOR_DELIVERY") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be marked as a failed delivery while its status is ${existing.status}`,
    });
  }
  // A valid OUT_FOR_DELIVERY order must carry the current attempt's start
  // time (Phase 7.3). If it doesn't, this is a data-consistency failure —
  // never invent a started_at (e.g. via `now`) as a substitute.
  if (!existing.out_for_delivery_at) {
    console.error(
      `[driver-order.service] data-consistency failure for order ${orderId}: OUT_FOR_DELIVERY order unexpectedly has out_for_delivery_at=null`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order delivery-attempt state is inconsistent — action was not performed",
    });
  }
  const startedAt = existing.out_for_delivery_at;
  // amount_to_collect cannot change while status is OUT_FOR_DELIVERY — that
  // status is not in updateOrder()'s EDITABLE_ORDER_STATUSES set (Phase
  // 6.4), so there is no race to guard against here; the pre-transaction
  // read is authoritative.
  const expectedCollection = existing.amount_to_collect;

  // Failed-reason validation — a NEW attempt may only select an active,
  // configured reason (a reason later deactivated still remains valid on
  // attempts that already reference it; this row is never modified here).
  const reason = await prisma.failed_delivery_reasons.findUnique({ where: { id: failedReasonId } });
  if (!reason || !reason.is_active) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Failed delivery reason not found or inactive",
    });
  }
  // requires_notes is driven entirely by the configured DB field — never a
  // hard-coded reason name. Schema-layer validation (FailDeliveryOrderSchema)
  // already guarantees `notes`, if present at all, is non-empty after
  // trimming — so a whitespace-only value can never reach here as
  // non-null; this only needs to check presence.
  if (reason.requires_notes && !notes) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Notes are required for the selected reason "${reason.name}"`,
    });
  }

  // Assignment-history integrity — reused verbatim from Phase 6, never a
  // subtly different duplicate check. Fails closed with a sanitized 500 on
  // corruption; never silently repaired.
  await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: "OUT_FOR_DELIVERY", current_driver_id: driverId },
      // picked_up_at/out_for_delivery_at/assigned_at/delivered_at/
      // cancelled_at are all deliberately untouched — see the module doc
      // comment above (out_for_delivery_at must survive as the permanent
      // record of THIS attempt's start, which the delivery_attempt row
      // below also captures).
      data: { status: "FAILED_DELIVERY", updated_at: now },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    const nextAttemptNumber = await allocateNextAttemptNumber(tx, orderId);

    try {
      await tx.delivery_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          attempt_number: nextAttemptNumber,
          expected_collection: expectedCollection,
          // V1 Failed Delivery never records a collection amount — NULL,
          // never 0 (0 would falsely claim a known zero collection). The
          // approved failure UI only asks for reason + notes.
          actual_collection: null,
          outcome: "FAILED",
          failed_reason_id: reason.id,
          notes,
          started_at: startedAt,
          completed_at: now,
        },
      });
    } catch (error) {
      // The Order-state claim above is the primary concurrency guard, so
      // this should never actually fire in practice — but if the
      // (order_id, attempt_number) unique constraint is ever unexpectedly
      // hit, roll back rather than leaving a FAILED order with no attempt,
      // and never leak the raw Prisma error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Order was changed by another request — please retry",
        });
      }
      throw error;
    }

    // Human-readable reason snapshot in status history (the name, not just
    // the FK) — delivery_attempts.failed_reason_id retains the configured
    // reference separately. No assignment-history row: assignment did not
    // change. No financial/collection field is touched.
    await tx.order_status_history.create({
      data: {
        order_id: orderId,
        from_status: "OUT_FOR_DELIVERY",
        to_status: "FAILED_DELIVERY",
        changed_by_id: actorUserId,
        reason: reason.name,
        notes,
      },
    });

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, select: driverOrderSelect });
    return toDriverOrderSummary(updated);
  });
}

// ============================================================
// POST /api/v1/driver/orders/:id/deliver (Phase 7.5 operational, Phase 8.3
// financial integration for exact DELIVERY_ONLY)
//
// OUT_FOR_DELIVERY -> DELIVERED only, for the authenticated CURRENT driver.
// This remains the ONE orchestration point Phase 7.5 established — Phase
// 8.3 extends its existing transaction rather than adding a second,
// independently-drifting successful-delivery code path.
//
// FINANCIAL SCOPE (Phase 8.3): when, and ONLY when, BOTH of the following
// hold, this single transaction also posts real ledgers and finalizes the
// Order financially:
//   - order_type = DELIVERY_ONLY
//   - actualAmountCollected == amount_to_collect (exact — Decimal-compared
//     via the same calculateCollectionDifference() used for the difference
//     branch, never a duplicate comparison)
// In that case: financial_status becomes FINALIZED (never PENDING), and
// (skipping any zero-value component, per Phase 8.1/8.2's ledger
// primitives correctly rejecting zero rows):
//   - actualAmountCollected > 0      -> Driver Cash COLLECTION (+actual)
//   - order.remaining_order_amount>0 -> Wallet ORDER_CREDIT (+remaining
//     order amount only — never order_amount, never a prepaid portion)
//   - order.remaining_delivery_fee>0 -> Company DELIVERY_FEE_REVENUE
//   - one audit_logs row documenting the finalized event
//
// FINANCIAL SCOPE (Phase 8.4): the identical exact-collection rule now also
// finalizes an exact COMPANY_ORDER delivery in this same transaction:
//   - order_type = COMPANY_ORDER
//   - actualAmountCollected == amount_to_collect (exact, same helper)
// financial_status becomes FINALIZED and (skipping any zero-value
// component):
//   - actualAmountCollected > 0      -> Driver Cash COLLECTION (+actual,
//     shared with the DELIVERY_ONLY branch below — identical rule either
//     way: physical cash collected by the Driver)
//   - order.remaining_order_amount>0 -> Company COMPANY_ORDER_PRODUCT_REVENUE
//     (+remaining order amount — the qualifying unpaid product value)
//   - order.remaining_delivery_fee>0 -> Company DELIVERY_FEE_REVENUE
//   - one audit_logs row documenting the finalized event
// Customer Wallet receives EXACTLY ZERO for a COMPANY_ORDER — creditWalletForOrder()
// is never called anywhere in this branch (CLAUDE.md §12/§63 mandatory
// invariant). The two order-type branches are kept explicitly separate
// (never merged into one generic allocation) specifically so a Company
// Order can never accidentally credit a wallet.
//
// A DELIVERY_ONLY collection DIFFERENCE and a COMPANY_ORDER collection
// DIFFERENCE are both explicitly UNCHANGED — financial_status stays
// REVIEW_REQUIRED, zero ledgers posted, no customer/company split is ever
// guessed (Phase 8.7's scope).
//
// All financial mutations use the Phase 8.1/8.2/8.3/8.4-foundation
// TRANSACTION-CLIENT primitives (creditDriverCollection/creditWalletForOrder/
// recordDeliveryFeeRevenue/recordCompanyOrderProductRevenue) called with THIS
// function's own `tx` — never their independent-transaction convenience
// wrappers (runDriverCashTransaction/runWalletTransaction). Nesting an
// independent transaction inside this one would break the atomicity this
// phase exists to guarantee: if ANY step (state claim, attempt, history,
// Driver Cash, Wallet, Company revenue, audit) fails, Prisma rolls back the
// entire operation — no partially-delivered, partially-financed Order is
// ever left behind.
//
// FAIL VS DELIVER RACE: uses the identical conditional-updateMany pattern
// on the identical {id, status: OUT_FOR_DELIVERY, current_driver_id} claim
// as /fail, so exactly one of a concurrent /fail vs /deliver pair can ever
// win — see failDriverOrder above for the full reasoning, unchanged here.
// A losing /deliver never posts partial financial rows: the state claim is
// the first thing attempted in the transaction, and everything financial
// happens strictly after it succeeds.
// ============================================================
export async function deliverDriverOrder(
  driverId: string,
  orderId: string,
  actualAmountCollected: Prisma.Decimal,
  collectionDifferenceReasonInput: string | null,
  actorUserId: string
): Promise<DriverOrderDetail> {
  // Ownership enforced in the query itself, identical contract to
  // Pickup/Start Delivery/Fail — a non-owned or nonexistent Order returns
  // the same safe 404.
  const existing = await prisma.orders.findFirst({ where: { id: orderId, current_driver_id: driverId } });
  if (!existing) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if (existing.status !== "OUT_FOR_DELIVERY") {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Order cannot be marked as delivered while its status is ${existing.status}`,
    });
  }
  // A valid OUT_FOR_DELIVERY order must carry the current attempt's start
  // time (Phase 7.3). If it doesn't, this is a data-consistency failure —
  // never invent a started_at (e.g. via `now`) as a substitute.
  if (!existing.out_for_delivery_at) {
    console.error(
      `[driver-order.service] data-consistency failure for order ${orderId}: OUT_FOR_DELIVERY order unexpectedly has out_for_delivery_at=null`
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Order delivery-attempt state is inconsistent — action was not performed",
    });
  }
  const startedAt = existing.out_for_delivery_at;
  // Expected collection is ALWAYS server-derived from amount_to_collect —
  // never accepted as client input. Safe to read pre-transaction: OUT_FOR_
  // DELIVERY is not in updateOrder()'s EDITABLE_ORDER_STATUSES (Phase 6.4),
  // so Management cannot concurrently change financial fields on this order.
  const expectedAmountToCollect = existing.amount_to_collect;

  // Reuses the approved Phase 6.1 domain function — never a duplicate
  // Decimal-difference implementation. Overcollection and undercollection
  // are both valid operational outcomes; neither is rejected here.
  const difference = calculateCollectionDifference(expectedAmountToCollect, actualAmountCollected);

  // A supplied reason is only meaningful (and only persisted) when the
  // collection actually differs — an unnecessary reason on an exact
  // delivery is normalized to null rather than retained as misleading
  // financial-review metadata.
  const collectionDifferenceReason = difference.needsFinancialReview ? collectionDifferenceReasonInput : null;
  if (difference.needsFinancialReview && !collectionDifferenceReason) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "collectionDifferenceReason is required when the actual amount collected differs from the amount to collect",
    });
  }

  // Assignment-history integrity — reused verbatim from Phase 6, never a
  // subtly different duplicate check. Fails closed with a sanitized 500 on
  // corruption; never silently repaired.
  await assertConsistentCurrentAssignment(orderId, existing.current_driver_id);

  const now = new Date();
  // Exact DELIVERY_ONLY (Phase 8.3) and exact COMPANY_ORDER (Phase 8.4) both
  // fully post ledgers and finalize — see the module doc comment above. Any
  // collection difference remains REVIEW_REQUIRED regardless of order type
  // (Phase 8.7).
  const isExactDeliveryOnlyFinance = existing.order_type === "DELIVERY_ONLY" && !difference.needsFinancialReview;
  const isExactCompanyOrderFinance = existing.order_type === "COMPANY_ORDER" && !difference.needsFinancialReview;
  const isExactFinance = isExactDeliveryOnlyFinance || isExactCompanyOrderFinance;
  const financialStatus = difference.needsFinancialReview ? "REVIEW_REQUIRED" : isExactFinance ? "FINALIZED" : "PENDING";

  return prisma.$transaction(async (tx) => {
    const claim = await tx.orders.updateMany({
      where: { id: orderId, status: "OUT_FOR_DELIVERY", current_driver_id: driverId },
      // picked_up_at/out_for_delivery_at/assigned_at/cancelled_at are all
      // deliberately untouched — current_driver_id/assigned_at/the current
      // assignment row are preserved too (no field here clears them; see
      // the module doc comment for why delivery does not end assignment).
      data: {
        status: "DELIVERED",
        delivered_at: now,
        actual_amount_collected: actualAmountCollected,
        collection_difference_reason: collectionDifferenceReason,
        needs_financial_review: difference.needsFinancialReview,
        financial_status: financialStatus,
        updated_at: now,
      },
    });
    if (claim.count !== 1) {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Order was changed by another request — please retry",
      });
    }

    const nextAttemptNumber = await allocateNextAttemptNumber(tx, orderId);

    try {
      await tx.delivery_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          attempt_number: nextAttemptNumber,
          expected_collection: expectedAmountToCollect,
          actual_collection: actualAmountCollected,
          outcome: "DELIVERED",
          // The dedicated orders.collection_difference_reason field owns
          // the financial-review explanation — failed_reason_id/notes stay
          // null for a DELIVERED attempt (those belong to FAILED attempts).
          failed_reason_id: null,
          notes: null,
          started_at: startedAt,
          completed_at: now,
        },
      });
    } catch (error) {
      // The Order-state claim above is the primary concurrency guard, so
      // this should never actually fire in practice — but if the
      // (order_id, attempt_number) unique constraint is ever unexpectedly
      // hit, roll back rather than leaving a DELIVERED order with no
      // attempt, and never leak the raw Prisma error.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Order was changed by another request — please retry",
        });
      }
      throw error;
    }

    // Normal operational transition — reason/notes stay null here; the
    // collection-difference explanation belongs only to
    // orders.collection_difference_reason, never conflated with the
    // status-transition reason. No assignment-history row: assignment did
    // not change.
    await tx.order_status_history.create({
      data: { order_id: orderId, from_status: "OUT_FOR_DELIVERY", to_status: "DELIVERED", changed_by_id: actorUserId },
    });

    // ------------------------------------------------------------
    // Driver Cash always reflects the REAL physical cash collected — exact
    // (Phase 8.3/8.4) or a difference (Phase 8.7) — inside this SAME
    // transaction. Zero-value collection is skipped entirely (Phase 8.1's
    // ledger primitive correctly rejects a zero-amount row): an all-prepaid
    // exact delivery, or a difference delivery where the Driver collected
    // nothing, legitimately posts no Driver Cash row and still finalizes/
    // records the review successfully. Driver Cash collection is identical
    // regardless of order type or exact-vs-difference outcome (it is
    // physical cash custody, not accounting ownership) — the branches below
    // only affect the WALLET/COMPANY allocation, so a Company Order can
    // never accidentally credit a customer wallet, and a difference can
    // never have its ownership split guessed automatically.
    // ------------------------------------------------------------
    {
      let driverCashTransactionId: string | null = null;

      if (actualAmountCollected.greaterThan(0)) {
        const driverCash = await creditDriverCollection(tx, {
          driverId,
          amount: actualAmountCollected,
          orderId,
          createdById: actorUserId,
          // Same deterministic category key for both exact and difference
          // outcomes — an Order can only be delivered successfully once, so
          // this guarantees at most one normal COLLECTION row per Order.
          idempotencyKey: `delivery:${orderId}:driver-collection`,
        });
        driverCashTransactionId = driverCash.transaction.id;
      }

      if (isExactDeliveryOnlyFinance) {
        let walletTransactionId: string | null = null;
        let companyTransactionId: string | null = null;

        if (existing.remaining_order_amount.greaterThan(0)) {
          const wallet = await creditWalletForOrder(tx, {
            customerId: existing.customer_id,
            orderId,
            amount: existing.remaining_order_amount,
            processedById: actorUserId,
            idempotencyKey: `delivery:${orderId}:wallet-order-credit`,
          });
          walletTransactionId = wallet.transaction.id;
        }

        if (existing.remaining_delivery_fee.greaterThan(0)) {
          const companyTransaction = await recordDeliveryFeeRevenue(tx, {
            orderId,
            amount: existing.remaining_delivery_fee,
            paymentMethodId: existing.collection_payment_method_id ?? undefined,
            createdById: actorUserId,
            idempotencyKey: `delivery:${orderId}:delivery-fee-revenue`,
          });
          companyTransactionId = companyTransaction.id;
        }

        // Required durable audit record for the financial finalization
        // event — created inside this same transaction so an audit failure
        // rolls the whole delivery back, never leaving money "half
        // recorded".
        await createAuditLog(tx, {
          actorUserId,
          action: "DELIVERY_ONLY_FINANCE_FINALIZED",
          entityType: "ORDER",
          entityId: orderId,
          previousValues: { status: existing.status, financialStatus: existing.financial_status },
          newValues: { status: "DELIVERED", financialStatus: "FINALIZED" },
          metadata: {
            actualAmountCollected: actualAmountCollected.toString(),
            walletCredit: existing.remaining_order_amount.toString(),
            deliveryFeeRevenue: existing.remaining_delivery_fee.toString(),
            driverCashTransactionId,
            walletTransactionId,
            companyTransactionId,
          },
        });
      } else if (isExactCompanyOrderFinance) {
        let companyProductTransactionId: string | null = null;
        let companyFeeTransactionId: string | null = null;

        // No customer wallet mutation anywhere in this branch — a
        // COMPANY_ORDER's qualifying order value belongs to the company,
        // never the customer (CLAUDE.md §12/§63).
        if (existing.remaining_order_amount.greaterThan(0)) {
          const productRevenue = await recordCompanyOrderProductRevenue(tx, {
            orderId,
            amount: existing.remaining_order_amount,
            paymentMethodId: existing.collection_payment_method_id ?? undefined,
            createdById: actorUserId,
            idempotencyKey: `delivery:${orderId}:company-product-revenue`,
          });
          companyProductTransactionId = productRevenue.id;
        }

        if (existing.remaining_delivery_fee.greaterThan(0)) {
          const feeRevenue = await recordDeliveryFeeRevenue(tx, {
            orderId,
            amount: existing.remaining_delivery_fee,
            paymentMethodId: existing.collection_payment_method_id ?? undefined,
            createdById: actorUserId,
            idempotencyKey: `delivery:${orderId}:delivery-fee-revenue`,
          });
          companyFeeTransactionId = feeRevenue.id;
        }

        await createAuditLog(tx, {
          actorUserId,
          action: "COMPANY_ORDER_FINANCE_FINALIZED",
          entityType: "ORDER",
          entityId: orderId,
          previousValues: { status: existing.status, financialStatus: existing.financial_status },
          newValues: { status: "DELIVERED", financialStatus: "FINALIZED" },
          metadata: {
            actualAmountCollected: actualAmountCollected.toString(),
            companyProductRevenue: existing.remaining_order_amount.toString(),
            companyDeliveryFeeRevenue: existing.remaining_delivery_fee.toString(),
            driverCashTransactionId,
            companyProductTransactionId,
            companyFeeTransactionId,
          },
        });
      } else if (difference.needsFinancialReview) {
        // ------------------------------------------------------------
        // Phase 8.7 — the collection differed from expected. Driver Cash
        // above already recorded the REAL physical amount collected; this
        // branch deliberately creates ZERO Wallet/Company rows — the
        // ownership split is unknown until an authorized Finance/Admin
        // actor resolves it via POST /orders/:id/resolve-collection-
        // difference (order.service.ts). Applies identically to both
        // DELIVERY_ONLY and COMPANY_ORDER.
        // ------------------------------------------------------------
        await createAuditLog(tx, {
          actorUserId,
          action: "COLLECTION_DIFFERENCE_RECORDED",
          entityType: "ORDER",
          entityId: orderId,
          previousValues: { status: existing.status, financialStatus: existing.financial_status },
          newValues: { status: "DELIVERED", financialStatus: "REVIEW_REQUIRED" },
          metadata: {
            orderType: existing.order_type,
            expectedAmount: expectedAmountToCollect.toString(),
            actualAmount: actualAmountCollected.toString(),
            difference: difference.collectionDifference.toString(),
            collectionDifferenceReason,
            driverCashTransactionId,
          },
        });
      }
    }

    const updated = await tx.orders.findUniqueOrThrow({ where: { id: orderId }, select: driverOrderSelect });
    return toDriverOrderSummary(updated);
  });
}
