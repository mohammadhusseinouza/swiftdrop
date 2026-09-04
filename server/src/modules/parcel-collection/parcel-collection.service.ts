import { Prisma } from "../../generated/prisma/client";
import type {
  parcel_collection_assignments,
  parcel_collection_attempts,
} from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { createAuditLog } from "../../shared/audit/audit.service";
import { ORDER_TERMINAL_STATUSES } from "../orders/order-lifecycle";
import { assertDriverEligibleForAssignment, loadEligibleDriverForAssignment } from "../drivers/driver-eligibility";
import type {
  DriverParcelCollectionResult,
  ParcelCollectionActorSummary,
  ParcelCollectionAssignmentEntry,
  ParcelCollectionAttemptEntry,
  ParcelCollectionDetail,
  ParcelCollectionDriverSummary,
} from "./parcel-collection.types";

// ============================================================
// Phase 11.17.3 — Parcel Collection domain service.
//
// SEPARATE from financial cash collection. Every action here is financially
// neutral: it creates ZERO wallet / driver-cash / company-finance /
// payout / settlement rows. It also never touches orders.current_driver_id,
// order_assignments, delivery_attempts, or OrderStatus — those stay
// DELIVERY-only. Parcel Collection has its own state machine on
// orders.parcel_collection_status + parcel_collection_assignments +
// parcel_collection_attempts + orders.current_parcel_collection_driver_id.
//
// CONCURRENCY: identical shape to modules/orders/order.service.ts — a
// pre-read outside the transaction only produces a helpful specific error
// in the non-racing case; the real guarantee is the conditional
// tx.orders.updateMany() whose WHERE restates the exact
// (parcel_collection_status, current_parcel_collection_driver_id) just
// read. A 0-row claim => 409 CONFLICT. The DB CHECK
// (parcel_collection_assignments_current_state_chk) and the two partial
// unique indexes (one current assignment per order; one COLLECTED attempt
// per order) are defence-in-depth — a P2002 is mapped to 409, never leaked.
// ============================================================

const driverSummarySelect = {
  id: true,
  driver_number: true,
  users: { select: { first_name: true, last_name: true, phone: true } },
} satisfies Prisma.driversSelect;

type DriverSummaryRow = Prisma.driversGetPayload<{ select: typeof driverSummarySelect }>;

function toDriverSummary(row: DriverSummaryRow): ParcelCollectionDriverSummary {
  return {
    id: row.id,
    driverNumber: row.driver_number,
    user: { firstName: row.users.first_name, lastName: row.users.last_name, phone: row.users.phone },
  };
}

function toActorSummary(row: { id: string; first_name: string; last_name: string }): ParcelCollectionActorSummary {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name };
}

// ---- Management read DTO --------------------------------------------------

const parcelCollectionDetailSelect = {
  id: true,
  parcel_intake_method: true,
  parcel_collection_status: true,
  parcel_collection_contact_name: true,
  parcel_collection_phone: true,
  parcel_collection_alt_phone: true,
  parcel_collection_area_id: true,
  parcel_collection_area: true,
  parcel_collection_address: true,
  parcel_collection_notes: true,
  parcel_collected_from_sender_at: true,
  received_at_company_at: true,
  current_parcel_collection_driver: { select: driverSummarySelect },
  received_at_company_by: { select: { id: true, first_name: true, last_name: true } },
  parcel_collection_assignments: {
    orderBy: { assigned_at: "asc" },
    select: {
      id: true,
      assigned_at: true,
      ended_at: true,
      end_reason: true,
      is_current: true,
      drivers: { select: driverSummarySelect },
      assigned_by: { select: { id: true, first_name: true, last_name: true } },
    },
  },
  parcel_collection_attempts: {
    orderBy: { attempt_number: "asc" },
    select: {
      id: true,
      attempt_number: true,
      outcome: true,
      notes: true,
      started_at: true,
      completed_at: true,
      created_at: true,
      drivers: { select: driverSummarySelect },
      failed_collection_reasons: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.ordersSelect;

type ParcelCollectionDetailRow = Prisma.ordersGetPayload<{ select: typeof parcelCollectionDetailSelect }>;

function toParcelCollectionDetail(row: ParcelCollectionDetailRow): ParcelCollectionDetail {
  const assignments: ParcelCollectionAssignmentEntry[] = row.parcel_collection_assignments.map((a) => ({
    id: a.id,
    driver: toDriverSummary(a.drivers),
    assignedBy: toActorSummary(a.assigned_by),
    assignedAt: a.assigned_at.toISOString(),
    endedAt: a.ended_at ? a.ended_at.toISOString() : null,
    endReason: a.end_reason,
    isCurrent: a.is_current,
  }));

  const attempts: ParcelCollectionAttemptEntry[] = row.parcel_collection_attempts.map((t) => ({
    id: t.id,
    attemptNumber: t.attempt_number,
    driver: toDriverSummary(t.drivers),
    outcome: t.outcome,
    failedReason: t.failed_collection_reasons
      ? { id: t.failed_collection_reasons.id, name: t.failed_collection_reasons.name }
      : null,
    notes: t.notes,
    startedAt: t.started_at ? t.started_at.toISOString() : null,
    completedAt: t.completed_at ? t.completed_at.toISOString() : null,
    createdAt: t.created_at.toISOString(),
  }));

  return {
    orderId: row.id,
    intakeMethod: row.parcel_intake_method,
    status: row.parcel_collection_status,
    collectionSnapshot: {
      contactName: row.parcel_collection_contact_name,
      phone: row.parcel_collection_phone,
      altPhone: row.parcel_collection_alt_phone,
      areaId: row.parcel_collection_area_id,
      area: row.parcel_collection_area,
      address: row.parcel_collection_address,
      notes: row.parcel_collection_notes,
    },
    currentCollectionDriver: row.current_parcel_collection_driver
      ? toDriverSummary(row.current_parcel_collection_driver)
      : null,
    parcelCollectedFromSenderAt: row.parcel_collected_from_sender_at
      ? row.parcel_collected_from_sender_at.toISOString()
      : null,
    receivedAtCompanyAt: row.received_at_company_at ? row.received_at_company_at.toISOString() : null,
    receivedAtCompanyBy: row.received_at_company_by ? toActorSummary(row.received_at_company_by) : null,
    assignments,
    attempts,
  };
}

async function readParcelCollectionDetail(
  client: Prisma.TransactionClient | typeof prisma,
  orderId: string,
): Promise<ParcelCollectionDetail> {
  const row = await client.orders.findUniqueOrThrow({
    where: { id: orderId },
    select: parcelCollectionDetailSelect,
  });
  return toParcelCollectionDetail(row);
}

export async function getParcelCollectionForOrder(orderId: string): Promise<ParcelCollectionDetail> {
  const exists = await prisma.orders.findUnique({ where: { id: orderId }, select: { id: true } });
  if (!exists) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  return readParcelCollectionDetail(prisma, orderId);
}

// ============================================================
// Integrity helpers — fail CLOSED, never silently repair (task §14).
// ============================================================

async function assertNoCurrentParcelCollectionAssignment(
  client: Prisma.TransactionClient | typeof prisma,
  orderId: string,
): Promise<void> {
  const current = await client.parcel_collection_assignments.findMany({
    where: { order_id: orderId, is_current: true },
  });
  if (current.length !== 0) {
    console.error(
      `[parcel-collection.service] integrity failure for order ${orderId}: expected no current parcel ` +
        `collection assignment, found ${current.length} (drivers: ${current.map((a) => a.driver_id).join(", ")})`,
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Parcel collection assignment state is inconsistent — action was not performed",
    });
  }
}

// Exported for reuse by modules/orders (Phase 11.17.4 — Order cancellation
// from parcel_collection_status = ASSIGNED must close the collection
// assignment in the same transaction as the cancel).
export async function assertConsistentCurrentParcelCollectionAssignment(
  client: Prisma.TransactionClient | typeof prisma,
  orderId: string,
  currentDriverId: string | null,
): Promise<parcel_collection_assignments> {
  if (!currentDriverId) {
    console.error(
      `[parcel-collection.service] integrity failure for order ${orderId}: expected a current parcel ` +
        `collection driver but current_parcel_collection_driver_id is null`,
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Parcel collection assignment state is inconsistent — action was not performed",
    });
  }
  const current = await client.parcel_collection_assignments.findMany({
    where: { order_id: orderId, is_current: true },
  });
  if (current.length !== 1 || current[0].driver_id !== currentDriverId) {
    console.error(
      `[parcel-collection.service] assignment integrity failure for order ${orderId}: expected exactly one ` +
        `is_current row matching driver ${currentDriverId}, found ${current.length} ` +
        `(drivers: ${current.map((a) => a.driver_id).join(", ")})`,
    );
    throw new AppError({
      statusCode: 500,
      code: "INTERNAL_ERROR",
      message: "Parcel collection assignment history is inconsistent — action was not performed",
    });
  }
  return current[0];
}

async function allocateNextParcelCollectionAttemptNumber(
  tx: Prisma.TransactionClient,
  orderId: string,
): Promise<number> {
  const max = await tx.parcel_collection_attempts.aggregate({
    where: { order_id: orderId },
    _max: { attempt_number: true },
  });
  return (max._max.attempt_number ?? 0) + 1;
}

function mapKnownParcelCollectionError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    // one-current-assignment / (order,attempt_number) / one-COLLECTED partial
    // unique, or the assignment CHECK — all mean "state changed under us".
    if (error.code === "P2002" || error.code === "P2034" || error.code === "P2010") {
      throw new AppError({
        statusCode: 409,
        code: "CONFLICT",
        message: "Parcel collection state was changed by another request — please retry",
      });
    }
  }
  throw error;
}

// ============================================================
// Shared mutation pre-check: load the Order and reject the operation when
// it is meaningless (already at company) or the Order is terminal.
// ============================================================

interface ParcelMutationContext {
  id: string;
  parcel_intake_method: "ALREADY_AT_COMPANY" | "DRIVER_COLLECTION";
  parcel_collection_status:
    | "AWAITING_ASSIGNMENT"
    | "ASSIGNED"
    | "COLLECTED_FROM_SENDER"
    | "FAILED"
    | "RESCHEDULED"
    | "RECEIVED_AT_COMPANY";
  current_parcel_collection_driver_id: string | null;
  status: string;
}

async function loadOrderForParcelMutation(orderId: string): Promise<ParcelMutationContext> {
  const order = await prisma.orders.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      status: true,
      parcel_intake_method: true,
      parcel_collection_status: true,
      current_parcel_collection_driver_id: true,
    },
  });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if ((ORDER_TERMINAL_STATUSES as readonly string[]).includes(order.status)) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: `Parcel collection cannot be changed while the order is ${order.status}`,
    });
  }
  if (order.parcel_intake_method === "ALREADY_AT_COMPANY") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "This order's parcel is already at the company — it has no driver-collection workflow",
    });
  }
  return order;
}

// ============================================================
// Assign Collection Driver
//
// assignParcelCollectionDriverTx is the transaction-aware core so Phase
// 11.17.4 can reuse the exact invariant while creating an Order in the same
// transaction. It is NOT exported as an HTTP surface.
// ============================================================

export interface AssignParcelCollectionDriverTxParams {
  orderId: string;
  driverId: string;
  actorUserId: string;
  /** Which source status the caller expects. Defaults to both assignable states. */
  expectedStatus?: "AWAITING_ASSIGNMENT" | "RESCHEDULED";
}

export async function assignParcelCollectionDriverTx(
  tx: Prisma.TransactionClient,
  params: AssignParcelCollectionDriverTxParams,
): Promise<void> {
  const { orderId, driverId, actorUserId } = params;

  // AUTHORITATIVE eligibility check — always runs inside `tx`, immediately
  // before the assignment write. A pre-transaction check by the caller is
  // only a friendly early error; this is the one that guarantees the driver
  // is still eligible at commit (no TOCTOU — Phase 11.17.4 correction).
  await assertDriverEligibleForAssignment(tx, driverId);

  await assertNoCurrentParcelCollectionAssignment(tx, orderId);

  const sourceStatuses = params.expectedStatus
    ? [params.expectedStatus]
    : ["AWAITING_ASSIGNMENT", "RESCHEDULED"];

  const now = new Date();

  const claim = await tx.orders.updateMany({
    where: {
      id: orderId,
      parcel_intake_method: "DRIVER_COLLECTION",
      parcel_collection_status: { in: sourceStatuses as ParcelMutationContext["parcel_collection_status"][] },
      current_parcel_collection_driver_id: null,
    },
    data: {
      current_parcel_collection_driver_id: driverId,
      parcel_collection_status: "ASSIGNED",
      updated_at: now,
    },
  });
  if (claim.count !== 1) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "Parcel collection could not be assigned in the order's current state — please retry",
    });
  }

  const previousStatus = sourceStatuses.length === 1 ? sourceStatuses[0] : "AWAITING_ASSIGNMENT/RESCHEDULED";

  await tx.parcel_collection_assignments.create({
    data: {
      order_id: orderId,
      driver_id: driverId,
      assigned_by_id: actorUserId,
      assigned_at: now,
      ended_at: null,
      end_reason: null,
      is_current: true,
    },
  });

  await createAuditLog(tx, {
    actorUserId,
    action: "PARCEL_COLLECTION_DRIVER_ASSIGNED",
    entityType: "ORDER",
    entityId: orderId,
    previousValues: { parcelCollectionStatus: previousStatus, currentParcelCollectionDriverId: null },
    newValues: { parcelCollectionStatus: "ASSIGNED", currentParcelCollectionDriverId: driverId },
    metadata: { driverId },
  });
}

export async function assignParcelCollectionDriver(
  orderId: string,
  driverId: string,
  actorUserId: string,
): Promise<ParcelCollectionDetail> {
  const order = await loadOrderForParcelMutation(orderId);
  if (order.parcel_collection_status !== "AWAITING_ASSIGNMENT" && order.parcel_collection_status !== "RESCHEDULED") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: `A collection driver cannot be assigned while parcel collection is ${order.parcel_collection_status}`,
    });
  }
  if (order.current_parcel_collection_driver_id !== null) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: "This order already has a current collection driver — use reassign",
    });
  }

  // Friendly early error only; assignParcelCollectionDriverTx re-checks
  // eligibility INSIDE the transaction (that is the authoritative one).
  await loadEligibleDriverForAssignment(driverId);

  try {
    return await prisma.$transaction(async (tx) => {
      await assignParcelCollectionDriverTx(tx, {
        orderId,
        driverId,
        actorUserId,
        expectedStatus: order.parcel_collection_status as "AWAITING_ASSIGNMENT" | "RESCHEDULED",
      });
      return readParcelCollectionDetail(tx, orderId);
    });
  } catch (error) {
    mapKnownParcelCollectionError(error);
  }
}

// ============================================================
// Reassign Collection Driver — ASSIGNED only, forbidden after COLLECTED_FROM_SENDER.
// ============================================================

export async function reassignParcelCollectionDriver(
  orderId: string,
  newDriverId: string,
  actorUserId: string,
): Promise<ParcelCollectionDetail> {
  const order = await loadOrderForParcelMutation(orderId);
  if (order.parcel_collection_status !== "ASSIGNED") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message:
        order.parcel_collection_status === "COLLECTED_FROM_SENDER"
          ? "The collection driver already has the parcel — reassignment is no longer allowed"
          : `A collection driver cannot be reassigned while parcel collection is ${order.parcel_collection_status}`,
    });
  }

  const currentAssignment = await assertConsistentCurrentParcelCollectionAssignment(
    prisma,
    orderId,
    order.current_parcel_collection_driver_id,
  );
  if (newDriverId === currentAssignment.driver_id) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "The new collection driver must be different from the current one",
    });
  }

  // Friendly early error only — re-checked inside the transaction below.
  await loadEligibleDriverForAssignment(newDriverId);

  const oldDriverId = currentAssignment.driver_id;
  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      // Authoritative eligibility check, in-transaction, before the write
      // (no TOCTOU — Phase 11.17.4 correction).
      await assertDriverEligibleForAssignment(tx, newDriverId);

      const claim = await tx.orders.updateMany({
        where: {
          id: orderId,
          parcel_collection_status: "ASSIGNED",
          current_parcel_collection_driver_id: oldDriverId,
        },
        data: { current_parcel_collection_driver_id: newDriverId, updated_at: now },
      });
      if (claim.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Parcel collection state was changed by another request — please retry",
        });
      }

      const ended = await tx.parcel_collection_assignments.updateMany({
        where: { id: currentAssignment.id, is_current: true },
        data: { is_current: false, ended_at: now, end_reason: "REASSIGNED" },
      });
      if (ended.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Parcel collection state was changed by another request — please retry",
        });
      }

      await tx.parcel_collection_assignments.create({
        data: {
          order_id: orderId,
          driver_id: newDriverId,
          assigned_by_id: actorUserId,
          assigned_at: now,
          ended_at: null,
          end_reason: null,
          is_current: true,
        },
      });

      await createAuditLog(tx, {
        actorUserId,
        action: "PARCEL_COLLECTION_DRIVER_REASSIGNED",
        entityType: "ORDER",
        entityId: orderId,
        previousValues: { currentParcelCollectionDriverId: oldDriverId },
        newValues: { currentParcelCollectionDriverId: newDriverId },
        metadata: { fromDriverId: oldDriverId, toDriverId: newDriverId },
      });

      return readParcelCollectionDetail(tx, orderId);
    });
  } catch (error) {
    mapKnownParcelCollectionError(error);
  }
}

// ============================================================
// Management — Reschedule (FAILED -> RESCHEDULED). No date in V1.
// ============================================================

export async function rescheduleParcelCollection(
  orderId: string,
  actorUserId: string,
): Promise<ParcelCollectionDetail> {
  const order = await loadOrderForParcelMutation(orderId);
  if (order.parcel_collection_status !== "FAILED") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: `Parcel collection can only be rescheduled from FAILED (currently ${order.parcel_collection_status})`,
    });
  }
  // FAILED already implies no current assignment / null pointer — verify, fail closed.
  await assertNoCurrentParcelCollectionAssignment(prisma, orderId);

  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const claim = await tx.orders.updateMany({
        where: { id: orderId, parcel_collection_status: "FAILED", current_parcel_collection_driver_id: null },
        data: { parcel_collection_status: "RESCHEDULED", updated_at: now },
      });
      if (claim.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Parcel collection state was changed by another request — please retry",
        });
      }

      await createAuditLog(tx, {
        actorUserId,
        action: "PARCEL_COLLECTION_RESCHEDULED",
        entityType: "ORDER",
        entityId: orderId,
        previousValues: { parcelCollectionStatus: "FAILED" },
        newValues: { parcelCollectionStatus: "RESCHEDULED" },
      });

      return readParcelCollectionDetail(tx, orderId);
    });
  } catch (error) {
    mapKnownParcelCollectionError(error);
  }
}

// ============================================================
// Management — Confirm Received At Company (COLLECTED_FROM_SENDER -> RECEIVED_AT_COMPANY).
// ============================================================

export async function confirmReceivedAtCompany(
  orderId: string,
  actorUserId: string,
): Promise<ParcelCollectionDetail> {
  const order = await loadOrderForParcelMutation(orderId);
  if (order.parcel_collection_status !== "COLLECTED_FROM_SENDER") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: `Company receipt can only be confirmed from COLLECTED_FROM_SENDER (currently ${order.parcel_collection_status})`,
    });
  }

  const currentAssignment = await assertConsistentCurrentParcelCollectionAssignment(
    prisma,
    orderId,
    order.current_parcel_collection_driver_id,
  );
  const collectingDriverId = currentAssignment.driver_id;
  const now = new Date();

  try {
    return await prisma.$transaction(async (tx) => {
      const claim = await tx.orders.updateMany({
        where: {
          id: orderId,
          parcel_collection_status: "COLLECTED_FROM_SENDER",
          current_parcel_collection_driver_id: collectingDriverId,
        },
        data: {
          parcel_collection_status: "RECEIVED_AT_COMPANY",
          received_at_company_at: now,
          received_at_company_by_id: actorUserId,
          current_parcel_collection_driver_id: null,
          updated_at: now,
        },
      });
      if (claim.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Parcel collection state was changed by another request — please retry",
        });
      }

      const ended = await tx.parcel_collection_assignments.updateMany({
        where: { id: currentAssignment.id, is_current: true },
        data: { is_current: false, ended_at: now, end_reason: "RECEIVED_AT_COMPANY" },
      });
      if (ended.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "Parcel collection state was changed by another request — please retry",
        });
      }

      await createAuditLog(tx, {
        actorUserId,
        action: "PARCEL_RECEIPT_CONFIRMED",
        entityType: "ORDER",
        entityId: orderId,
        previousValues: {
          parcelCollectionStatus: "COLLECTED_FROM_SENDER",
          currentParcelCollectionDriverId: collectingDriverId,
        },
        newValues: {
          parcelCollectionStatus: "RECEIVED_AT_COMPANY",
          receivedAtCompanyAt: now.toISOString(),
          currentParcelCollectionDriverId: null,
        },
        metadata: { collectingDriverId },
      });

      return readParcelCollectionDetail(tx, orderId);
    });
  } catch (error) {
    mapKnownParcelCollectionError(error);
  }
}

// ============================================================
// Driver — resolve the authenticated Driver and the Order they currently
// own for parcel collection. IDOR-safe: an Order that exists but is not
// this Driver's current collection job returns the SAME 404 as a
// nonexistent Order (matches modules/driver-orders).
// ============================================================

interface DriverParcelJobContext {
  orderId: string;
  driverId: string;
}

async function loadDriverOwnedAssignedJob(driverId: string, orderId: string): Promise<DriverParcelJobContext> {
  const order = await prisma.orders.findFirst({
    where: { id: orderId, current_parcel_collection_driver_id: driverId },
    select: { id: true, status: true, parcel_collection_status: true, current_parcel_collection_driver_id: true },
  });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }
  if ((ORDER_TERMINAL_STATUSES as readonly string[]).includes(order.status)) {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: `Parcel collection cannot be changed while the order is ${order.status}`,
    });
  }
  if (order.parcel_collection_status !== "ASSIGNED") {
    throw new AppError({
      statusCode: 409,
      code: "CONFLICT",
      message: `This collection job is ${order.parcel_collection_status}, not ASSIGNED`,
    });
  }
  await assertConsistentCurrentParcelCollectionAssignment(prisma, orderId, order.current_parcel_collection_driver_id);
  return { orderId, driverId };
}

function toDriverResult(
  orderId: string,
  status: DriverParcelCollectionResult["parcelCollectionStatus"],
  collectedAt: Date | null,
  attempt: parcel_collection_attempts,
): DriverParcelCollectionResult {
  return {
    orderId,
    parcelCollectionStatus: status,
    parcelCollectedFromSenderAt: collectedAt ? collectedAt.toISOString() : null,
    latestAttempt: {
      attemptNumber: attempt.attempt_number,
      outcome: attempt.outcome,
      completedAt: attempt.completed_at ? attempt.completed_at.toISOString() : null,
    },
  };
}

// ---- Driver — Collected From Sender (ASSIGNED -> COLLECTED_FROM_SENDER) ----
// Custody rule: the assignment stays current and the pointer is NOT cleared.

export async function markCollectedFromSender(
  driverId: string,
  orderId: string,
): Promise<DriverParcelCollectionResult> {
  await loadDriverOwnedAssignedJob(driverId, orderId);
  const now = new Date();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.orders.updateMany({
        where: {
          id: orderId,
          parcel_collection_status: "ASSIGNED",
          current_parcel_collection_driver_id: driverId,
        },
        data: {
          parcel_collection_status: "COLLECTED_FROM_SENDER",
          parcel_collected_from_sender_at: now,
          updated_at: now,
        },
      });
      if (claim.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "This collection job was changed by another request — please retry",
        });
      }

      const attemptNumber = await allocateNextParcelCollectionAttemptNumber(tx, orderId);
      const attempt = await tx.parcel_collection_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          attempt_number: attemptNumber,
          outcome: "COLLECTED",
          failed_collection_reason_id: null,
          notes: null,
          // V1 has no "start parcel collection" action (task §19) — started_at
          // is NULL, never a fabricated start time. completed_at is the action time.
          started_at: null,
          completed_at: now,
        },
      });

      // The current assignment row is deliberately left untouched — the
      // driver still physically holds the parcel in transit (task §18).
      //
      // No audit_logs row: a Driver collection OUTCOME is operational history
      // and lives in parcel_collection_attempts (+ the status/assignment
      // transition) — matching the existing Driver /fail convention (Phase
      // 7.4), which writes delivery_attempts/status history but no audit row.
      // Management actions (assign/reassign/reschedule/receive) DO audit.

      return toDriverResult(orderId, "COLLECTED_FROM_SENDER", now, attempt);
    });
    return result;
  } catch (error) {
    mapKnownParcelCollectionError(error);
  }
}

// ---- Driver — Failed Collection (ASSIGNED -> FAILED) ----

export async function failParcelCollection(
  driverId: string,
  orderId: string,
  failedCollectionReasonId: string,
  notes: string | null,
): Promise<DriverParcelCollectionResult> {
  await loadDriverOwnedAssignedJob(driverId, orderId);

  const reason = await prisma.failed_collection_reasons.findUnique({ where: { id: failedCollectionReasonId } });
  if (!reason || !reason.is_active) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "Failed collection reason not found or inactive",
    });
  }
  if (reason.requires_notes && !notes) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `Notes are required for the selected reason "${reason.name}"`,
    });
  }

  const currentAssignment = await assertConsistentCurrentParcelCollectionAssignment(prisma, orderId, driverId);
  const now = new Date();

  try {
    const result = await prisma.$transaction(async (tx) => {
      const claim = await tx.orders.updateMany({
        where: {
          id: orderId,
          parcel_collection_status: "ASSIGNED",
          current_parcel_collection_driver_id: driverId,
        },
        data: {
          parcel_collection_status: "FAILED",
          current_parcel_collection_driver_id: null,
          updated_at: now,
        },
      });
      if (claim.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "This collection job was changed by another request — please retry",
        });
      }

      const attemptNumber = await allocateNextParcelCollectionAttemptNumber(tx, orderId);
      const attempt = await tx.parcel_collection_attempts.create({
        data: {
          order_id: orderId,
          driver_id: driverId,
          attempt_number: attemptNumber,
          outcome: "FAILED",
          // endReason on the assignment is FAILED — NOT ORDER_CANCELLED —
          // even for the "Collection cancelled by sender" reason (task §24).
          failed_collection_reason_id: reason.id,
          notes,
          started_at: null, // no "start collection" action in V1 (task §19)
          completed_at: now,
        },
      });

      const endedAssignment = await tx.parcel_collection_assignments.updateMany({
        where: { id: currentAssignment.id, is_current: true },
        data: { is_current: false, ended_at: now, end_reason: "FAILED" },
      });
      if (endedAssignment.count !== 1) {
        throw new AppError({
          statusCode: 409,
          code: "CONFLICT",
          message: "This collection job was changed by another request — please retry",
        });
      }

      // No audit_logs row — same reasoning as the collected path above: the
      // FAILED parcel_collection_attempts row (with reason + notes) is the
      // durable operational record, mirroring the Driver /fail convention.

      return toDriverResult(orderId, "FAILED", null, attempt);
    });
    return result;
  } catch (error) {
    mapKnownParcelCollectionError(error);
  }
}
