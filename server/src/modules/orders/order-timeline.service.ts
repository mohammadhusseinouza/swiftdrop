import { prisma } from "../../db/prisma";
import { getOrderById } from "./order.service";
import { getParcelCollectionForOrder } from "../parcel-collection/parcel-collection.service";
import type {
  OrderAssignmentHistoryEntry,
  OrderFinancialEvent,
  OrderStatusHistoryEntry,
  DeliveryAttemptEntry,
} from "./order.types";
import type {
  ParcelCollectionAssignmentEntry,
  ParcelCollectionAttemptEntry,
  ParcelCollectionDetail,
} from "../parcel-collection/parcel-collection.types";
import type { OrderTimelineActor, OrderTimelineDriverRef, OrderTimelineEvent, OrderTimelineEventType } from "./order-timeline.types";

// ============================================================
// Deterministic ordering (task §47) — every event source below contributes
// entries with a monotonically increasing per-source sequence number, so two
// events sharing the identical millisecond timestamp (routine for events
// written inside the same transaction — a delivery + its financial rows,
// for example) still sort identically on every request. Source order itself
// mirrors OrderDetail's own array ordering convention.
// ============================================================

type TimelineDraft = OrderTimelineEvent & { sortAt: number; sortSeq: number };

function toMillis(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

function driverRef(d: { id: string; driverNumber: string; user: { firstName: string; lastName: string } }): OrderTimelineDriverRef {
  return { id: d.id, driverNumber: d.driverNumber, firstName: d.user.firstName, lastName: d.user.lastName };
}

function actorRef(a: { id: string; firstName: string; lastName: string } | null): OrderTimelineActor | null {
  return a ? { id: a.id, firstName: a.firstName, lastName: a.lastName } : null;
}

function base(id: string, type: OrderTimelineEventType, occurredAt: string, seq: number): TimelineDraft {
  return {
    id,
    type,
    occurredAt,
    actor: null,
    driver: null,
    toDriver: null,
    fromStatus: null,
    toStatus: null,
    endReason: null,
    attemptNumber: null,
    outcome: null,
    reason: null,
    notes: null,
    amount: null,
    ledger: null,
    financialType: null,
    sortAt: toMillis(occurredAt),
    sortSeq: seq,
  };
}

// ---- Order status history ---------------------------------------------

function statusEvents(rows: OrderStatusHistoryEntry[]): TimelineDraft[] {
  return rows.map((row, i) => ({
    ...base(`status:${row.id}`, "STATUS_CHANGED", row.createdAt, 100000 + i),
    actor: actorRef(row.changedBy),
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    reason: row.reason,
    notes: row.notes,
  }));
}

// ---- Delivery assignment history ---------------------------------------

function deliveryAssignmentEvents(rows: OrderAssignmentHistoryEntry[]): TimelineDraft[] {
  const events: TimelineDraft[] = [];
  rows.forEach((row, i) => {
    events.push({
      ...base(`assign:${row.id}`, "DELIVERY_DRIVER_ASSIGNED", row.assignedAt, 200000 + i * 2),
      actor: actorRef(row.assignedBy),
      driver: driverRef(row.driver),
    });
    if (row.endedAt && row.endReason) {
      events.push({
        ...base(`assign-end:${row.id}`, "DELIVERY_ASSIGNMENT_ENDED", row.endedAt, 200000 + i * 2 + 1),
        driver: driverRef(row.driver),
        endReason: row.endReason,
      });
    }
  });
  return events;
}

// ---- Delivery attempts ---------------------------------------------------

function deliveryAttemptEvents(rows: DeliveryAttemptEntry[]): TimelineDraft[] {
  return rows.map((row, i) => {
    const when = row.completedAt ?? row.startedAt;
    return {
      ...base(`attempt:${row.id}`, "DELIVERY_ATTEMPT", when, 300000 + i),
      driver: driverRef(row.driver),
      attemptNumber: row.attemptNumber,
      outcome: row.outcome,
      reason: row.failedReason?.name ?? null,
      notes: row.notes,
      amount: row.actualCollection,
    };
  });
}

// ---- Order-scoped financial ledger events --------------------------------

function financialEvents(rows: OrderFinancialEvent[]): TimelineDraft[] {
  return rows.map((row, i) => ({
    ...base(`finance:${row.id}`, "FINANCIAL_EVENT", row.occurredAt, 400000 + i),
    actor: actorRef(row.actor),
    notes: row.notes,
    amount: row.signedAmount,
    ledger: row.ledger,
    financialType: row.type,
  }));
}

// ---- Parcel Collection assignments ---------------------------------------
//
// Dedup rules (task §44/§45):
//   - a REASSIGNED row is combined with the NEXT (adjacent) assignment row
//     into a single PARCEL_COLLECTION_DRIVER_REASSIGNED event — never two
//     disconnected "ended" + "assigned" lines.
//   - a row ending FAILED or RECEIVED_AT_COMPANY contributes NO separate
//     "ended" event — that fact is already carried by the attempt /
//     receipt event below, sourced from the attempt/receipt data itself.
//   - a row ending ORDER_CANCELLED DOES get its own event — this is a
//     distinct fact (order-level cancellation consequence), not a
//     duplicate of anything else on the timeline.
function parcelAssignmentEvents(rows: ParcelCollectionAssignmentEntry[]): TimelineDraft[] {
  const events: TimelineDraft[] = [];
  rows.forEach((row, i) => {
    const prev = i > 0 ? rows[i - 1] : null;
    const isReassignTarget = prev !== null && prev.endReason === "REASSIGNED" && prev.endedAt === row.assignedAt;

    if (isReassignTarget && prev) {
      events.push({
        ...base(`parcel-reassign:${row.id}`, "PARCEL_COLLECTION_DRIVER_REASSIGNED", row.assignedAt, 500000 + i * 2),
        actor: actorRef(row.assignedBy),
        driver: driverRef(prev.driver),
        toDriver: driverRef(row.driver),
      });
    } else {
      events.push({
        ...base(`parcel-assign:${row.id}`, "PARCEL_COLLECTION_DRIVER_ASSIGNED", row.assignedAt, 500000 + i * 2),
        actor: actorRef(row.assignedBy),
        driver: driverRef(row.driver),
      });
    }

    if (row.endedAt && row.endReason === "ORDER_CANCELLED") {
      events.push({
        ...base(`parcel-assign-end:${row.id}`, "PARCEL_COLLECTION_ENDED_ORDER_CANCELLED", row.endedAt, 500000 + i * 2 + 1),
        driver: driverRef(row.driver),
        endReason: row.endReason,
      });
    }
    // REASSIGNED -> folded into the next row's combined event above.
    // FAILED / RECEIVED_AT_COMPANY -> sourced from the attempt/receipt
    // events below; no separate "ended" line here (task §44).
  });
  return events;
}

// ---- Parcel Collection attempts -------------------------------------------

function parcelAttemptEvents(rows: ParcelCollectionAttemptEntry[]): TimelineDraft[] {
  return rows.map((row, i) => {
    const when = row.completedAt ?? row.createdAt;
    const type: OrderTimelineEventType = row.outcome === "COLLECTED" ? "PARCEL_COLLECTED_FROM_SENDER" : "PARCEL_COLLECTION_FAILED";
    return {
      ...base(`parcel-attempt:${row.id}`, type, when, 600000 + i),
      driver: driverRef(row.driver),
      attemptNumber: row.attemptNumber,
      outcome: row.outcome,
      reason: row.failedReason?.name ?? null,
      notes: row.notes,
    };
  });
}

// ---- Company receipt ------------------------------------------------------

function receiptEvent(parcel: ParcelCollectionDetail): TimelineDraft[] {
  if (!parcel.receivedAtCompanyAt) return [];
  return [
    {
      ...base(`parcel-receipt:${parcel.orderId}`, "PARCEL_RECEIVED_AT_COMPANY", parcel.receivedAtCompanyAt, 700000),
      actor: actorRef(parcel.receivedAtCompanyBy),
    },
  ];
}

// ---- Reschedule (audit-sourced DISPLAY ONLY, task §46) --------------------

interface RescheduleAuditRow {
  id: string;
  created_at: Date;
  users: { id: string; first_name: string; last_name: string } | null;
}

async function rescheduleEvents(orderId: string): Promise<TimelineDraft[]> {
  const rows = await prisma.audit_logs.findMany({
    where: { entity_type: "ORDER", entity_id: orderId, action: "PARCEL_COLLECTION_RESCHEDULED" },
    orderBy: [{ created_at: "asc" }, { id: "asc" }],
    select: { id: true, created_at: true, users: { select: { id: true, first_name: true, last_name: true } } },
  });
  return (rows as RescheduleAuditRow[]).map((row, i) => ({
    ...base(`parcel-reschedule:${row.id}`, "PARCEL_COLLECTION_RESCHEDULED", row.created_at.toISOString(), 650000 + i),
    actor: row.users ? { id: row.users.id, firstName: row.users.first_name, lastName: row.users.last_name } : null,
  }));
}

// ============================================================
// GET /api/v1/orders/:id/timeline
// ============================================================

export async function getOrderTimeline(orderId: string): Promise<OrderTimelineEvent[]> {
  // getOrderById throws the standard 404 for a nonexistent Order — reused
  // as-is (never a second existence check).
  const [order, parcel, reschedules] = await Promise.all([
    getOrderById(orderId),
    getParcelCollectionForOrder(orderId),
    rescheduleEvents(orderId),
  ]);

  const drafts: TimelineDraft[] = [
    ...statusEvents(order.statusHistory),
    ...deliveryAssignmentEvents(order.assignmentHistory),
    ...deliveryAttemptEvents(order.deliveryAttempts),
    ...financialEvents(order.financialEvents),
    ...parcelAssignmentEvents(parcel.assignments),
    ...parcelAttemptEvents(parcel.attempts),
    ...receiptEvent(parcel),
    ...reschedules,
  ];

  // Oldest-first (chronological) — the same raw-data convention as every
  // other OrderDetail array (statusHistory/assignmentHistory/
  // deliveryAttempts/financialEvents). The Management frontend's existing
  // display-order choice (newest-first) is applied client-side, unchanged
  // from the pre-11.17.6 client-built timeline.
  drafts.sort((a, b) => a.sortAt - b.sortAt || a.sortSeq - b.sortSeq);

  return drafts.map(({ sortAt: _sortAt, sortSeq: _sortSeq, ...event }) => event);
}
