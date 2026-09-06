import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { driverOrderSelect, toDriverOrderSummary, toDriverPackageSummary } from "../driver-orders/driver-order.service";
import { ORDER_TERMINAL_STATUSES } from "../orders/order-lifecycle";
import { assertConsistentCurrentParcelCollectionAssignment } from "../parcel-collection/parcel-collection.service";
import type { ListDriverJobsQuery } from "./driver-job.schema";
import type {
  CollectionDriverJobDetail,
  CollectionDriverJobSummary,
  DeliveryDriverJobDetail,
  DeliveryDriverJobSummary,
  DriverJobDetail,
  DriverJobSummary,
  DriverJobType,
} from "./driver-job.types";

// ============================================================
// Phase 12.1 — GET /api/v1/driver/jobs ("My Jobs").
//
// SCOPE: read-only, CURRENT jobs only (task §5/§27). Combines the Driver's
// current COLLECTION responsibility (Sender -> Company) and current
// DELIVERY responsibility (Company -> Receiver) into one server-authoritative,
// sorted, paginated list — never left to the frontend to fetch two lists and
// merge them (task §11/§50).
//
// OWNERSHIP: every query below has driver_id / current_driver_id as a
// mandatory top-level `where` key — identical discipline to
// modules/driver-orders and modules/parcel-collection. The caller
// (controller) resolves `driverId` ONLY via
// getDriverProfileForUser(req.actor.userId) — never a client-supplied value.
//
// CURRENT JOB DEFINITIONS (task §12/§13, matches the approved Phase 11.17
// state machine in parcel-collection.service.ts and the Phase 7 delivery
// state machine in driver-order.service.ts):
//   COLLECTION current = a parcel_collection_assignments row with
//     driver_id = driverId AND is_current = true, whose Order's
//     parcel_collection_status IN (ASSIGNED, COLLECTED_FROM_SENDER). This is
//     equivalent to "current_parcel_collection_driver_id = driverId" (the
//     assignment invariant — assertConsistentCurrentParcelCollectionAssignment
//     in parcel-collection.service.ts — guarantees at most one is_current row
//     per Order and that it always matches the Order's pointer), but queried
//     via the assignment table directly because assigned_at (the sort key)
//     is a real scalar column there, not reachable with a DB-level ORDER BY
//     through a to-many Prisma relation on `orders`. COLLECTED_FROM_SENDER
//     stays current — the Driver still physically holds the parcel until
//     Management confirms RECEIVED_AT_COMPANY, which clears is_current
//     (task §46).
//   DELIVERY current = current_driver_id = driverId AND status IN (ASSIGNED,
//     PICKED_UP, OUT_FOR_DELIVERY, RESCHEDULED). FAILED_DELIVERY is
//     deliberately EXCLUDED — there is no Driver-actionable next step until
//     Management explicitly reschedules it (FAILED_DELIVERY -> RESCHEDULED,
//     see order.service.ts), matching task §13's exact status list.
// The Collection predicate additionally excludes ORDER_TERMINAL_STATUSES as
// defence-in-depth (task §48/§49) — is_current already makes this
// unreachable in practice (cancelling an ASSIGNED collection ends the
// assignment in the same transaction — see order.service.ts), but a
// terminal-status guard costs nothing and protects against any future
// invariant drift.
//
// PAGINATION — GLOBAL top-K merge across BOTH sources (Phase 12.1 review
// correction). The two sources are fetched independently but NEVER with
// independent skip/take against the caller's requested page — that would
// silently drop rows that belong on the true combined page (e.g. page=2 with
// a Collection-dominated first page would wrongly skip 20 Delivery rows that
// actually belong on page 2). Instead:
//   needed = page * limit
//   each source query is DB-sorted DESC by its own assignedAt-equivalent
//     column (+ a matching secondary key) and capped at `take: needed`
//   the two bounded, already-sorted result sets are merged and re-sorted in
//     application code by the single global key (assignedAt DESC, then
//     jobType, then orderId)
//   the final page is sliced from that merged sequence:
//     slice((page-1)*limit, page*limit)
// CORRECTNESS: this is the standard bounded top-K merge argument — for two
// sources each individually sorted DESC by the same key, the true global top
// `needed` rows can never include more than `needed` rows from either single
// source, so capping each source's fetch at `needed` (rather than fetching
// everything, or independently paging each source) can never drop a row that
// belongs in the requested page. `total` still comes from unbounded COUNTs
// over the same WHERE clauses, never from the length of the capped fetch.
// The per-source DB ORDER BY tie-break (order id / assignment's own order_id)
// matches the application-level tie-break exactly, so no row can fall
// exactly on the `needed` boundary in one order and be re-ordered
// differently in the other.
//
// This dataset (a single Driver's CURRENT jobs) is inherently small in V1 —
// there is no batch/route-planning feature that would grow it — so the
// `needed` cap is a defensive/efficiency measure, not a requirement for
// correctness at today's scale; it is still applied because the task
// explicitly calls for it and it costs nothing.
// ============================================================

const COLLECTION_CURRENT_STATUSES = ["ASSIGNED", "COLLECTED_FROM_SENDER"] as const;
const DELIVERY_CURRENT_STATUSES = ["ASSIGNED", "PICKED_UP", "OUT_FOR_DELIVERY", "RESCHEDULED"] as const;

const collectionAssignmentOrderSelect = {
  id: true,
  order_number: true,
  tracking_code: true,
  order_type: true,
  parcel_collection_status: true,
  parcel_collection_contact_name: true,
  parcel_collection_phone: true,
  parcel_collection_alt_phone: true,
  parcel_collection_area: true,
  parcel_collection_address: true,
  parcel_collection_notes: true,
  parcel_collected_from_sender_at: true,
  // Package info is Order-level (shared by both Collection and Delivery
  // phases of the same parcel) — selected here too so Phase 12.2's Collection
  // Job Detail (task §11/§17) can reuse this exact query/row rather than a
  // second round trip. Unused by the Phase 12.1 list mapper (toCollectionJob
  // below never reads them) — a few extra scalar columns on an already-tiny,
  // already-indexed lookup, not a second query.
  description: true,
  package_count: true,
  quantity: true,
  weight_kg: true,
  package_notes: true,
} satisfies Prisma.ordersSelect;

const collectionAssignmentSelect = {
  id: true,
  order_id: true,
  assigned_at: true,
  orders: { select: collectionAssignmentOrderSelect },
} satisfies Prisma.parcel_collection_assignmentsSelect;

type CollectionAssignmentRow = Prisma.parcel_collection_assignmentsGetPayload<{ select: typeof collectionAssignmentSelect }>;

function toCollectionJob(row: CollectionAssignmentRow): CollectionDriverJobSummary {
  const order = row.orders;
  return {
    jobType: "COLLECTION",
    orderId: order.id,
    orderNumber: order.order_number,
    trackingCode: order.tracking_code,
    orderType: order.order_type,
    status: order.parcel_collection_status,
    assignmentId: row.id,
    assignedAt: row.assigned_at.toISOString(),
    collectedFromSenderAt: order.parcel_collected_from_sender_at ? order.parcel_collected_from_sender_at.toISOString() : null,
    contact: {
      name: order.parcel_collection_contact_name,
      phone: order.parcel_collection_phone,
      altPhone: order.parcel_collection_alt_phone,
      area: order.parcel_collection_area,
      address: order.parcel_collection_address,
      notes: order.parcel_collection_notes,
    },
  };
}

function toDeliveryJob(row: Prisma.ordersGetPayload<{ select: typeof driverOrderSelect }>): DeliveryDriverJobSummary {
  // Reuses the exact Phase 7.1 mapper — never a second, independently-
  // drifting DELIVERY DTO (task §17/§34). deliveredAt is deliberately
  // dropped: a current Delivery job is, by definition, never DELIVERED.
  const summary = toDriverOrderSummary(row);
  return {
    jobType: "DELIVERY",
    orderId: summary.id,
    orderNumber: summary.orderNumber,
    trackingCode: summary.trackingCode,
    orderType: summary.orderType,
    status: summary.status,
    receiver: summary.receiver,
    package: summary.package,
    collection: summary.collection,
    timestamps: {
      assignedAt: summary.timestamps.assignedAt,
      pickedUpAt: summary.timestamps.pickedUpAt,
      outForDeliveryAt: summary.timestamps.outForDeliveryAt,
    },
  };
}

interface SortableJob {
  sortAt: number;
  orderId: string;
  jobType: "COLLECTION" | "DELIVERY";
  job: DriverJobSummary;
}

export interface ListDriverJobsResult {
  items: DriverJobSummary[];
  total: number;
}

export async function listDriverJobs(driverId: string, query: ListDriverJobsQuery): Promise<ListDriverJobsResult> {
  const wantCollection = query.jobType !== "DELIVERY";
  const wantDelivery = query.jobType !== "COLLECTION";

  // Bounded top-K per source — see the module doc comment's CORRECTNESS
  // note above. Never independently skip/take-paginated per source.
  const needed = query.page * query.limit;

  const collectionWhere: Prisma.parcel_collection_assignmentsWhereInput = {
    driver_id: driverId,
    is_current: true,
    orders: {
      parcel_collection_status: { in: [...COLLECTION_CURRENT_STATUSES] },
      status: { notIn: [...ORDER_TERMINAL_STATUSES] },
    },
  };
  const deliveryWhere: Prisma.ordersWhereInput = {
    current_driver_id: driverId,
    status: { in: [...DELIVERY_CURRENT_STATUSES] },
  };

  const [collectionRows, collectionCount, deliveryRows, deliveryCount] = await Promise.all([
    wantCollection
      ? prisma.parcel_collection_assignments.findMany({
          where: collectionWhere,
          select: collectionAssignmentSelect,
          // Secondary key (order_id) matches the application-level
          // tie-break exactly, so the `needed` boundary can never split a
          // tie differently than the final merged sort would.
          orderBy: [{ assigned_at: "desc" }, { order_id: "desc" }],
          take: needed,
        })
      : Promise.resolve([]),
    wantCollection ? prisma.parcel_collection_assignments.count({ where: collectionWhere }) : Promise.resolve(0),
    wantDelivery
      ? prisma.orders.findMany({
          where: deliveryWhere,
          select: driverOrderSelect,
          orderBy: [{ assigned_at: "desc" }, { id: "desc" }],
          take: needed,
        })
      : Promise.resolve([]),
    wantDelivery ? prisma.orders.count({ where: deliveryWhere }) : Promise.resolve(0),
  ]);

  const sortable: SortableJob[] = [
    ...collectionRows.map(
      (row): SortableJob => ({
        sortAt: row.assigned_at.getTime(),
        orderId: row.order_id,
        jobType: "COLLECTION",
        job: toCollectionJob(row),
      }),
    ),
    ...deliveryRows.map(
      (row): SortableJob => ({
        // A current Delivery job always has assigned_at set (every current
        // status implies a live assignment) — the -Infinity fallback is
        // defensive only, never expected to fire.
        sortAt: row.assigned_at ? row.assigned_at.getTime() : -Infinity,
        orderId: row.id,
        jobType: "DELIVERY",
        job: toDeliveryJob(row),
      }),
    ),
  ];

  // assignedAt DESC, then jobType, then orderId — a fully deterministic
  // total order (task §23/§L), never left to array-insertion order. This
  // final in-memory sort re-establishes the single global order across both
  // already-bounded, already-individually-sorted sources.
  sortable.sort((a, b) => {
    if (a.sortAt !== b.sortAt) return b.sortAt - a.sortAt;
    if (a.jobType !== b.jobType) return a.jobType < b.jobType ? -1 : 1;
    return a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0;
  });

  const total = collectionCount + deliveryCount;
  const start = (query.page - 1) * query.limit;
  const items = sortable.slice(start, start + query.limit).map((s) => s.job);

  return { items, total };
}

// ============================================================
// Phase 12.2 — GET /api/v1/driver/jobs/:jobType/:orderId ("Job Detail").
//
// CURRENT-JOB-ONLY (task §7): reuses the EXACT SAME current-job predicates
// as listDriverJobs above (COLLECTION_CURRENT_STATUSES / DELIVERY_CURRENT_
// STATUSES, ORDER_TERMINAL_STATUSES) — never a second, independently
// redefined "active" state set (task §8/§9). Once a job is no longer
// current (received at company, failed, delivered, cancelled, reassigned
// away from this Driver, ...), the exact same query that lists it also
// stops returning it here — there is no separate "is this job current"
// check to drift out of sync.
//
// IDOR / WRONG JOB TYPE (task §6/§25/§26): both branches require the
// authenticated Driver's id as a mandatory top-level `where` key
// (driver_id / current_driver_id), IN THE SAME QUERY as the orderId lookup
// — identical discipline to getDriverOrderById (Phase 7.1) and
// loadDriverOwnedAssignedJob (Phase 11.17.3). A wrong-owned Order, a
// nonexistent Order, and a wrong job type for an Order this Driver DOES
// currently own all produce the IDENTICAL safe 404 — never a 403 or a
// leak of which case applied. "Wrong job type" specifically needs no extra
// code: a DRIVER_COLLECTION Order not yet at RECEIVED_AT_COMPANY can never
// have current_driver_id set (order.service.ts forbids delivery-driver
// assignment until parcel receipt), so requesting the DELIVERY detail for
// a Driver's own current COLLECTION job naturally finds no row — and
// symmetrically, an Order already past RECEIVED_AT_COMPANY is outside the
// COLLECTION_CURRENT_STATUSES set, so requesting the COLLECTION detail for
// a Driver's own current DELIVERY job naturally finds no row either.
// ============================================================

function toCollectionJobDetail(row: CollectionAssignmentRow): CollectionDriverJobDetail {
  return {
    ...toCollectionJob(row),
    package: toDriverPackageSummary(row.orders),
  };
}

async function loadCollectionJobDetail(driverId: string, orderId: string): Promise<CollectionDriverJobDetail> {
  const row = await prisma.parcel_collection_assignments.findFirst({
    where: {
      order_id: orderId,
      driver_id: driverId,
      is_current: true,
      orders: {
        parcel_collection_status: { in: [...COLLECTION_CURRENT_STATUSES] },
        status: { notIn: [...ORDER_TERMINAL_STATUSES] },
      },
    },
    select: collectionAssignmentSelect,
  });
  if (!row) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Job not found" });
  }

  // Fail-closed consistency check (task §25) — reuses the established
  // Phase 11.17.3 helper. Cheap here because this is a single-job detail
  // read, never looped over a list. Throws a sanitized 500 if the
  // assignment/pointer invariant is somehow violated; never silently
  // repairs or guesses ownership.
  await assertConsistentCurrentParcelCollectionAssignment(prisma, orderId, driverId);

  return toCollectionJobDetail(row);
}

function toDeliveryJobDetail(row: Prisma.ordersGetPayload<{ select: typeof driverOrderSelect }>): DeliveryDriverJobDetail {
  return {
    ...toDeliveryJob(row),
    // payment_type is selected by driverOrderSelect but deliberately never
    // read by toDriverOrderSummary/toDeliveryJob (task §14/§16 — see the
    // select's own comment in driver-order.service.ts); read directly off
    // the raw row here, detail-only.
    paymentType: row.payment_type,
  };
}

async function loadDeliveryJobDetail(driverId: string, orderId: string): Promise<DeliveryDriverJobDetail> {
  const row = await prisma.orders.findFirst({
    where: {
      id: orderId,
      current_driver_id: driverId,
      status: { in: [...DELIVERY_CURRENT_STATUSES] },
    },
    select: driverOrderSelect,
  });
  if (!row) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Job not found" });
  }
  return toDeliveryJobDetail(row);
}

export async function getDriverJobDetail(driverId: string, jobType: DriverJobType, orderId: string): Promise<DriverJobDetail> {
  return jobType === "COLLECTION" ? loadCollectionJobDetail(driverId, orderId) : loadDeliveryJobDetail(driverId, orderId);
}
