import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { ORDER_ACTIVE_STATUSES } from "../orders/order-lifecycle";
import { orderSummarySelect, toOrderSummary } from "../orders/order.service";
import type { OrderSummary } from "../orders/order.types";
import type { DriverWorkListQuery } from "./driver.schema";
import type { DriverDeliveryHistoryRow, DriverParcelCollectionHistoryRow } from "./driver-work.types";

async function assertDriverExists(driverId: string): Promise<void> {
  const driver = await prisma.drivers.findUnique({ where: { id: driverId }, select: { id: true } });
  if (!driver) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Driver not found" });
  }
}

export interface DriverWorkListResult<T> {
  items: T[];
  total: number;
}

// GET /api/v1/drivers/:id/current-orders — CURRENT held active work only.
// Precise server-side filter: current_driver_id = driver AND status IN
// ORDER_ACTIVE_STATUSES (never the coarse "not DELIVERED", which still
// includes terminal RETURNED_*/CANCELLED). Server pagination only; no
// historical assignment rows.
export async function listDriverCurrentOrders(
  driverId: string,
  query: DriverWorkListQuery
): Promise<DriverWorkListResult<OrderSummary>> {
  await assertDriverExists(driverId);

  const where: Prisma.ordersWhereInput = {
    current_driver_id: driverId,
    status: { in: [...ORDER_ACTIVE_STATUSES] },
  };

  const [rows, total] = await Promise.all([
    prisma.orders.findMany({
      where,
      select: orderSummarySelect,
      orderBy: [{ assigned_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.orders.count({ where }),
  ]);

  return { items: rows.map(toOrderSummary), total };
}

const deliveryHistorySelect = {
  id: true,
  attempt_number: true,
  outcome: true,
  expected_collection: true,
  actual_collection: true,
  notes: true,
  started_at: true,
  completed_at: true,
  orders: { select: { id: true, order_number: true, status: true, receiver_name: true, receiver_area: true } },
  failed_delivery_reasons: { select: { id: true, name: true } },
} satisfies Prisma.delivery_attemptsSelect;

type DeliveryHistoryRow = Prisma.delivery_attemptsGetPayload<{ select: typeof deliveryHistorySelect }>;

function toDeliveryHistoryRow(row: DeliveryHistoryRow): DriverDeliveryHistoryRow {
  return {
    attemptId: row.id,
    attemptNumber: row.attempt_number,
    outcome: row.outcome,
    order: {
      id: row.orders.id,
      orderNumber: row.orders.order_number,
      status: row.orders.status,
    },
    receiverName: row.orders.receiver_name,
    area: row.orders.receiver_area,
    expectedCollection: row.expected_collection.toString(),
    actualCollection: row.actual_collection ? row.actual_collection.toString() : null,
    failedReason: row.failed_delivery_reasons
      ? { id: row.failed_delivery_reasons.id, name: row.failed_delivery_reasons.name }
      : null,
    notes: row.notes,
    startedAt: row.started_at.toISOString(),
    completedAt: row.completed_at ? row.completed_at.toISOString() : null,
  };
}

// GET /api/v1/drivers/:id/delivery-history — HISTORICAL driver work.
// Attribution source is delivery_attempts.driver_id, NEVER
// orders.current_driver_id: a reassigned-away order keeps this driver's
// earlier attempt, and an order this driver never attempted never appears.
// Newest attempt first; server pagination only.
export async function listDriverDeliveryHistory(
  driverId: string,
  query: DriverWorkListQuery
): Promise<DriverWorkListResult<DriverDeliveryHistoryRow>> {
  await assertDriverExists(driverId);

  const where: Prisma.delivery_attemptsWhereInput = { driver_id: driverId };

  const [rows, total] = await Promise.all([
    prisma.delivery_attempts.findMany({
      where,
      select: deliveryHistorySelect,
      orderBy: [{ started_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.delivery_attempts.count({ where }),
  ]);

  return { items: rows.map(toDeliveryHistoryRow), total };
}

// ============================================================
// Parcel Collection history (Phase 11.17.6 — task §27-§29).
// ============================================================

const parcelCollectionHistorySelect = {
  id: true,
  assigned_at: true,
  ended_at: true,
  end_reason: true,
  is_current: true,
  orders: { select: { id: true, order_number: true, order_type: true, parcel_collection_status: true } },
} satisfies Prisma.parcel_collection_assignmentsSelect;

type ParcelCollectionHistoryRow = Prisma.parcel_collection_assignmentsGetPayload<{
  select: typeof parcelCollectionHistorySelect;
}>;

function toParcelCollectionHistoryRow(row: ParcelCollectionHistoryRow): DriverParcelCollectionHistoryRow {
  return {
    assignmentId: row.id,
    order: { id: row.orders.id, orderNumber: row.orders.order_number, orderType: row.orders.order_type },
    assignedAt: row.assigned_at.toISOString(),
    endedAt: row.ended_at ? row.ended_at.toISOString() : null,
    endReason: row.end_reason,
    isCurrent: row.is_current,
    parcelCollectionStatus: row.orders.parcel_collection_status,
  };
}

// GET /api/v1/drivers/:id/parcel-collection-history — HISTORICAL Parcel
// Collection work, based on parcel_collection_assignments (one JOB
// responsibility per row — NOT the same domain as delivery_attempts). The
// same Order may legitimately appear more than once across separate
// (reassigned / rescheduled) assignments — permanent history, never
// collapsed. Newest assignment first; server pagination only. Financially
// neutral (no money field is ever selected here).
export async function listDriverParcelCollectionHistory(
  driverId: string,
  query: DriverWorkListQuery
): Promise<DriverWorkListResult<DriverParcelCollectionHistoryRow>> {
  await assertDriverExists(driverId);

  const where: Prisma.parcel_collection_assignmentsWhereInput = { driver_id: driverId };

  const [rows, total] = await Promise.all([
    prisma.parcel_collection_assignments.findMany({
      where,
      select: parcelCollectionHistorySelect,
      orderBy: [{ assigned_at: "desc" }, { id: "desc" }],
      skip: (query.page - 1) * query.limit,
      take: query.limit,
    }),
    prisma.parcel_collection_assignments.count({ where }),
  ]);

  return { items: rows.map(toParcelCollectionHistoryRow), total };
}
