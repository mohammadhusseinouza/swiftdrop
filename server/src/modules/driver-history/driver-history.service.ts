import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import type { ListDriverHistoryQuery } from "./driver-history.schema";
import type {
  CollectionCompletedHistory,
  CollectionFailedHistory,
  DeliveryCompletedHistory,
  DeliveryFailedHistory,
  DriverWorkHistoryItem,
} from "./driver-history.types";

// ============================================================
// Phase 12.5 — GET /api/v1/driver/history ("Completed" + "Failed / Returned").
//
// READ-ONLY. Never mutates an order, attempt, assignment, ledger, or audit
// row (task §65).
//
// OWNERSHIP: every source query below has `driver_id = driverId` as a
// mandatory, non-optional top-level `where` key — identical discipline to
// modules/driver-orders and modules/driver-jobs. `driverId` is resolved by
// the controller ONLY via getDriverProfileForUser(req.actor.userId); no code
// path here accepts a client-supplied driver identity (task §7/§56).
//
// HISTORICAL ATTRIBUTION (task §10-§16): attribution is ALWAYS the row's own
// stored driver_id, NEVER orders.current_driver_id /
// orders.current_parcel_collection_driver_id. A reassigned-away Order keeps
// this Driver's earlier attempt; an Order this Driver never worked never
// appears. This reuses the already-approved Management Driver-history
// philosophy (modules/drivers/driver-work.service.ts).
//
// FOUR LOGICAL RESULT SOURCES, THREE PHYSICAL QUERIES:
//   DELIVERY COMPLETED  = delivery_attempts WHERE driver_id = me AND outcome = DELIVERED
//   DELIVERY FAILED     = delivery_attempts WHERE driver_id = me AND outcome = FAILED
//     (one query, outcome IN {DELIVERED, FAILED}, split in the mapper)
//   COLLECTION COMPLETED = parcel_collection_assignments WHERE driver_id = me
//     AND end_reason = RECEIVED_AT_COMPANY  (task §12 — a Collection job is
//     historically complete only once Management confirms company receipt,
//     NOT merely when the COLLECTED attempt is recorded; deriving it from
//     the COLLECTED attempt would double-count and would also show a job in
//     both My Jobs and Completed at once — task §60)
//   COLLECTION FAILED   = parcel_collection_attempts WHERE driver_id = me
//     AND outcome = FAILED  (task §13/§61 — one canonical failed row; the
//     assignment's own end_reason=FAILED is NOT emitted as a second row)
//
// occurredAt (task §64):
//   Delivery (either result) -> delivery_attempts.completed_at
//   Collection FAILED        -> parcel_collection_attempts.completed_at
//   Collection COMPLETED     -> parcel_collection_assignments.ended_at
//   never orders.updated_at.
//
// GLOBAL PAGINATION — bounded top-K merge (task §24, identical pattern to
// modules/driver-jobs Phase 12.1):
//   needed = page * limit
//   each source is DB-sorted (its own occurredAt column DESC, then id ASC)
//     and capped at `take: needed`
//   the bounded, already-sorted result sets are merged and re-sorted in
//     application code by ONE global total order: occurredAt DESC, then id
//     ASC (row ids are globally-unique UUIDs, so this is a strict total
//     order with no cross-source ambiguity)
//   the requested page is sliced from that merged sequence
//   `total` is the SUM of unbounded COUNTs over the identical WHERE clauses,
//     never the length of a capped fetch.
// CORRECTNESS: the true global top-`needed` rows can never include more than
// `needed` rows from any single source, so capping each source's fetch at
// `needed` can never drop a row that belongs on the requested page. The
// per-source DB tie-break (`id ASC`, applied after the timestamp DESC keys)
// is exactly the application-level tie-break, so a tie can never be split
// one way at the `needed` boundary and re-ordered differently in the final
// merge. NEVER apply skip/take per source before the merge (task §24).
// ============================================================

// -------- Delivery attempts (COMPLETED + FAILED) --------

const deliveryAttemptSelect = {
  id: true,
  attempt_number: true,
  outcome: true,
  actual_collection: true,
  notes: true,
  completed_at: true,
  started_at: true,
  failed_delivery_reasons: { select: { name: true } },
  orders: {
    select: {
      id: true,
      order_number: true,
      tracking_code: true,
      order_type: true,
      status: true,
      receiver_name: true,
      receiver_area: true,
      payment_methods_orders_collection_payment_method_idTopayment_methods: {
        select: { id: true, code: true, name: true },
      },
    },
  },
} satisfies Prisma.delivery_attemptsSelect;

type DeliveryAttemptRow = Prisma.delivery_attemptsGetPayload<{ select: typeof deliveryAttemptSelect }>;

// -------- Parcel collection assignments (COMPLETED) --------

const collectionAssignmentSelect = {
  id: true,
  ended_at: true,
  orders: {
    select: {
      id: true,
      order_number: true,
      tracking_code: true,
      order_type: true,
      status: true,
      parcel_collection_status: true,
      parcel_collection_contact_name: true,
      parcel_collection_area: true,
      parcel_collection_address: true,
      parcel_collected_from_sender_at: true,
    },
  },
} satisfies Prisma.parcel_collection_assignmentsSelect;

type CollectionAssignmentRow = Prisma.parcel_collection_assignmentsGetPayload<{
  select: typeof collectionAssignmentSelect;
}>;

// -------- Parcel collection attempts (FAILED) --------

const collectionAttemptSelect = {
  id: true,
  attempt_number: true,
  notes: true,
  completed_at: true,
  failed_collection_reasons: { select: { name: true } },
  orders: {
    select: {
      id: true,
      order_number: true,
      tracking_code: true,
      order_type: true,
      status: true,
      parcel_collection_status: true,
      parcel_collection_contact_name: true,
      parcel_collection_area: true,
      parcel_collection_address: true,
    },
  },
} satisfies Prisma.parcel_collection_attemptsSelect;

type CollectionAttemptRow = Prisma.parcel_collection_attemptsGetPayload<{ select: typeof collectionAttemptSelect }>;

// ---- mappers -------------------------------------------------------------

function deliveryTimestamp(row: { completed_at: Date | null; started_at: Date | null }): Date {
  // A DELIVERED / FAILED attempt is always written with completed_at set
  // (driver-order.service.ts). started_at is the defensive-only fallback —
  // never a fabricated `new Date()`.
  return row.completed_at ?? row.started_at ?? new Date(0);
}

function toDeliveryHistoryItem(row: DeliveryAttemptRow): DeliveryCompletedHistory | DeliveryFailedHistory {
  const order = row.orders;
  const when = deliveryTimestamp(row).toISOString();
  const base = {
    id: row.id,
    attemptId: row.id,
    attemptNumber: row.attempt_number,
    jobType: "DELIVERY" as const,
    orderId: order.id,
    orderNumber: order.order_number,
    trackingCode: order.tracking_code,
    orderType: order.order_type,
    occurredAt: when,
    resultingOrderStatus: order.status,
    receiver: { name: order.receiver_name, area: order.receiver_area },
  };

  if (row.outcome === "DELIVERED") {
    const method = order.payment_methods_orders_collection_payment_method_idTopayment_methods;
    return {
      ...base,
      result: "COMPLETED",
      completedAt: when,
      actualAmountCollected: row.actual_collection ? row.actual_collection.toString() : null,
      paymentMethod: method ? { id: method.id, code: method.code, name: method.name } : null,
    };
  }

  return {
    ...base,
    result: "FAILED",
    failedAt: when,
    failure: { reasonName: row.failed_delivery_reasons?.name ?? null, notes: row.notes },
  };
}

function toCollectionCompletedHistoryItem(row: CollectionAssignmentRow): CollectionCompletedHistory {
  const order = row.orders;
  // end_reason = RECEIVED_AT_COMPANY always implies a non-null ended_at
  // (parcel-collection.service.ts sets them together). new Date(0) is
  // defensive-only.
  const when = (row.ended_at ?? new Date(0)).toISOString();
  return {
    id: row.id,
    assignmentId: row.id,
    jobType: "COLLECTION",
    result: "COMPLETED",
    orderId: order.id,
    orderNumber: order.order_number,
    trackingCode: order.tracking_code,
    orderType: order.order_type,
    occurredAt: when,
    completedAt: when,
    resultingOrderStatus: order.status,
    resultingParcelCollectionStatus: order.parcel_collection_status,
    collectedFromSenderAt: order.parcel_collected_from_sender_at
      ? order.parcel_collected_from_sender_at.toISOString()
      : null,
    contact: {
      name: order.parcel_collection_contact_name,
      area: order.parcel_collection_area,
      address: order.parcel_collection_address,
    },
  };
}

function toCollectionFailedHistoryItem(row: CollectionAttemptRow): CollectionFailedHistory {
  const order = row.orders;
  const when = (row.completed_at ?? new Date(0)).toISOString();
  return {
    id: row.id,
    attemptId: row.id,
    attemptNumber: row.attempt_number,
    jobType: "COLLECTION",
    result: "FAILED",
    orderId: order.id,
    orderNumber: order.order_number,
    trackingCode: order.tracking_code,
    orderType: order.order_type,
    occurredAt: when,
    failedAt: when,
    resultingOrderStatus: order.status,
    resultingParcelCollectionStatus: order.parcel_collection_status,
    contact: {
      name: order.parcel_collection_contact_name,
      area: order.parcel_collection_area,
      address: order.parcel_collection_address,
    },
    failure: { reasonName: row.failed_collection_reasons?.name ?? null, notes: row.notes },
  };
}

// ---- service ------------------------------------------------------------

export interface ListDriverHistoryResult {
  items: DriverWorkHistoryItem[];
  total: number;
}

interface Sortable {
  sortAt: number;
  id: string;
  item: DriverWorkHistoryItem;
}

export async function listDriverHistory(
  driverId: string,
  query: ListDriverHistoryQuery,
): Promise<ListDriverHistoryResult> {
  const wantCollection = query.jobType !== "DELIVERY";
  const wantDelivery = query.jobType !== "COLLECTION";
  const wantCompleted = query.result !== "FAILED";
  const wantFailed = query.result !== "COMPLETED";

  const needed = query.page * query.limit;

  // Delivery source — outcome narrowed by the result filter.
  const deliveryOutcomes: ("DELIVERED" | "FAILED")[] = [];
  if (wantCompleted) deliveryOutcomes.push("DELIVERED");
  if (wantFailed) deliveryOutcomes.push("FAILED");
  const runDelivery = wantDelivery && deliveryOutcomes.length > 0;
  const deliveryWhere: Prisma.delivery_attemptsWhereInput = {
    driver_id: driverId,
    outcome: { in: deliveryOutcomes },
  };

  const runCollectionCompleted = wantCollection && wantCompleted;
  const collectionCompletedWhere: Prisma.parcel_collection_assignmentsWhereInput = {
    driver_id: driverId,
    end_reason: "RECEIVED_AT_COMPANY",
  };

  const runCollectionFailed = wantCollection && wantFailed;
  const collectionFailedWhere: Prisma.parcel_collection_attemptsWhereInput = {
    driver_id: driverId,
    outcome: "FAILED",
  };

  const [
    deliveryRows,
    deliveryCount,
    collectionCompletedRows,
    collectionCompletedCount,
    collectionFailedRows,
    collectionFailedCount,
  ] = await Promise.all([
    runDelivery
      ? prisma.delivery_attempts.findMany({
          where: deliveryWhere,
          select: deliveryAttemptSelect,
          orderBy: [{ completed_at: "desc" }, { started_at: "desc" }, { id: "asc" }],
          take: needed,
        })
      : Promise.resolve([] as DeliveryAttemptRow[]),
    runDelivery ? prisma.delivery_attempts.count({ where: deliveryWhere }) : Promise.resolve(0),
    runCollectionCompleted
      ? prisma.parcel_collection_assignments.findMany({
          where: collectionCompletedWhere,
          select: collectionAssignmentSelect,
          orderBy: [{ ended_at: "desc" }, { id: "asc" }],
          take: needed,
        })
      : Promise.resolve([] as CollectionAssignmentRow[]),
    runCollectionCompleted
      ? prisma.parcel_collection_assignments.count({ where: collectionCompletedWhere })
      : Promise.resolve(0),
    runCollectionFailed
      ? prisma.parcel_collection_attempts.findMany({
          where: collectionFailedWhere,
          select: collectionAttemptSelect,
          orderBy: [{ completed_at: "desc" }, { id: "asc" }],
          take: needed,
        })
      : Promise.resolve([] as CollectionAttemptRow[]),
    runCollectionFailed
      ? prisma.parcel_collection_attempts.count({ where: collectionFailedWhere })
      : Promise.resolve(0),
  ]);

  const sortable: Sortable[] = [
    ...deliveryRows.map((row): Sortable => {
      const item = toDeliveryHistoryItem(row);
      return { sortAt: new Date(item.occurredAt).getTime(), id: row.id, item };
    }),
    ...collectionCompletedRows.map((row): Sortable => {
      const item = toCollectionCompletedHistoryItem(row);
      return { sortAt: new Date(item.occurredAt).getTime(), id: row.id, item };
    }),
    ...collectionFailedRows.map((row): Sortable => {
      const item = toCollectionFailedHistoryItem(row);
      return { sortAt: new Date(item.occurredAt).getTime(), id: row.id, item };
    }),
  ];

  // Single global total order: occurredAt DESC, then id ASC (globally-unique
  // UUIDs). Deterministic and stable across repeated calls (task §23).
  sortable.sort((a, b) => {
    if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  const total = deliveryCount + collectionCompletedCount + collectionFailedCount;
  const start = (query.page - 1) * query.limit;
  const items = sortable.slice(start, start + query.limit).map((s) => s.item);

  return { items, total };
}
