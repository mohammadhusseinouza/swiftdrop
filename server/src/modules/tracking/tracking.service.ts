import { Prisma } from "../../generated/prisma/client";
import { prisma } from "../../db/prisma";
import { AppError } from "../../shared/errors/app-error";
import { getCustomerProfileForUser } from "../auth/ownership.service";
import type { CustomerTrackingDetail, PublicTrackingDetail, TrackingException, TrackingStageCode, TrackingStageEntry } from "./tracking.types";

// ============================================================
// Shared safe tracking-progress builder (task §58) — the ONE place Customer
// and Public tracking derive their stage list, so the two can never drift
// independently. `audience` only controls exception WORDING (task §61); it
// never changes which fields exist — the stage/exception SHAPE is identical
// for both, and privacy is enforced entirely by which extra fields the two
// public functions below choose to add (orderId/orderNumber/createdAt for
// Customer only), never by this builder selecting different raw source data.
// ============================================================

const trackingSourceSelect = {
  id: true,
  order_number: true,
  tracking_code: true,
  status: true,
  parcel_intake_method: true,
  parcel_collection_status: true,
  created_at: true,
  parcel_collected_from_sender_at: true,
  received_at_company_at: true,
  assigned_at: true,
  picked_up_at: true,
  out_for_delivery_at: true,
  delivered_at: true,
} satisfies Prisma.ordersSelect;

type TrackingSourceOrder = Prisma.ordersGetPayload<{ select: typeof trackingSourceSelect }>;

type Audience = "customer" | "public";

const DRIVER_COLLECTION_STAGES: TrackingStageCode[] = [
  "ORDER_CREATED",
  "COLLECTION_SCHEDULED",
  "PARCEL_COLLECTED",
  "RECEIVED_AT_COMPANY",
  "PREPARING_FOR_DELIVERY",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
];

const ALREADY_AT_COMPANY_STAGES: TrackingStageCode[] = ["ORDER_RECEIVED", "READY_FOR_DELIVERY", "OUT_FOR_DELIVERY", "DELIVERED"];

const STAGE_LABEL: Record<TrackingStageCode, string> = {
  ORDER_CREATED: "Order Created",
  ORDER_RECEIVED: "Order Received",
  COLLECTION_SCHEDULED: "Collection Scheduled",
  PARCEL_COLLECTED: "Parcel Collected",
  RECEIVED_AT_COMPANY: "Received at Company",
  READY_FOR_DELIVERY: "Ready for Delivery",
  PREPARING_FOR_DELIVERY: "Preparing for Delivery",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
};

// Parcel Collection state -> how far along the DRIVER_COLLECTION stage list
// the order has progressed, PRE-receipt. Mirrors the operational state
// machine (parcel-intake-collection-database-contract.md §4.1) — never a
// second, independent interpretation.
const DRIVER_COLLECTION_RANK: Record<string, number> = {
  AWAITING_ASSIGNMENT: 0,
  RESCHEDULED: 0,
  FAILED: 0,
  ASSIGNED: 1,
  COLLECTED_FROM_SENDER: 2,
  RECEIVED_AT_COMPANY: 3,
};

interface ProgressResult {
  reachedIndex: number;
  timestamps: Partial<Record<TrackingStageCode, string>>;
}

// Every reached stage's timestamp is read from an EXISTING `orders` column
// (createdAt / parcel_collected_from_sender_at / received_at_company_at /
// assigned_at / out_for_delivery_at / delivered_at) — never fabricated
// (task §62: "Preparing for Delivery" has no timestamp of its own).
function driverCollectionProgress(order: TrackingSourceOrder): ProgressResult {
  const timestamps: Partial<Record<TrackingStageCode, string>> = { ORDER_CREATED: order.created_at.toISOString() };
  // ORDER_CREATED (index 0) is always immediately done — COLLECTION_SCHEDULED
  // (index 1) is therefore always at least the CURRENT stage, even at
  // AWAITING_ASSIGNMENT (nothing has happened yet, but it is the in-progress
  // stage the customer is waiting on — matches the ✓/●/○ semantics in
  // requirements.md §35's example).
  let reachedIndex = 1;

  const rank = DRIVER_COLLECTION_RANK[order.parcel_collection_status] ?? 0;
  if (rank >= 2) {
    reachedIndex = Math.max(reachedIndex, 2);
    if (order.parcel_collected_from_sender_at) timestamps.PARCEL_COLLECTED = order.parcel_collected_from_sender_at.toISOString();
  }
  if (rank >= 3) {
    // Once received, the order is always at least "Preparing for Delivery"
    // (no separate customer-facing stage for delivery-driver assigned/
    // picked-up — CLAUDE.md §40's READY_FOR_PICKUP/ASSIGNED/PICKED_UP -> one
    // customer-safe bucket).
    reachedIndex = Math.max(reachedIndex, 4);
    if (order.received_at_company_at) timestamps.RECEIVED_AT_COMPANY = order.received_at_company_at.toISOString();
    if (order.out_for_delivery_at) {
      timestamps.OUT_FOR_DELIVERY = order.out_for_delivery_at.toISOString();
      reachedIndex = Math.max(reachedIndex, 5);
    }
    if (order.delivered_at) {
      timestamps.DELIVERED = order.delivered_at.toISOString();
      reachedIndex = Math.max(reachedIndex, 6);
    }
  }
  return { reachedIndex, timestamps };
}

function alreadyAtCompanyProgress(order: TrackingSourceOrder): ProgressResult {
  const timestamps: Partial<Record<TrackingStageCode, string>> = { ORDER_RECEIVED: order.created_at.toISOString() };
  // received_at_company_at is set immediately at creation for
  // ALREADY_AT_COMPANY (order.service.ts) — "Ready for Delivery" is reached
  // as soon as the order exists.
  let reachedIndex = 1;
  if (order.out_for_delivery_at) {
    timestamps.OUT_FOR_DELIVERY = order.out_for_delivery_at.toISOString();
    reachedIndex = 2;
  }
  if (order.delivered_at) {
    timestamps.DELIVERED = order.delivered_at.toISOString();
    reachedIndex = 3;
  }
  return { reachedIndex, timestamps };
}

function buildStages(codes: TrackingStageCode[], reachedIndex: number, timestamps: ProgressResult["timestamps"], isDelivered: boolean): TrackingStageEntry[] {
  return codes.map((code, i) => ({
    code,
    label: STAGE_LABEL[code],
    state: i < reachedIndex ? "done" : i === reachedIndex ? (isDelivered ? "done" : "current") : "upcoming",
    occurredAt: timestamps[code] ?? null,
  }));
}

// Exception wording (task §61) — Customer gets a slightly more specific
// (still safe) message than Public, which stays maximally generic for
// collection-side exceptions. Order-level exceptions (failed/rescheduled/
// returned/cancelled delivery) use identical safe wording for both —
// neither exposes an internal reason/note either way.
function buildException(order: TrackingSourceOrder, audience: Audience): TrackingException | null {
  if (order.status === "CANCELLED") return { code: "CANCELLED", message: "Order Cancelled" };
  if (order.status === "RETURNED_TO_COMPANY" || order.status === "RETURNED_TO_CUSTOMER") {
    return { code: "RETURNED", message: "Returned" };
  }
  if (order.status === "FAILED_DELIVERY") return { code: "FAILED_DELIVERY", message: "Delivery Attempt Failed" };
  if (order.status === "RESCHEDULED") return { code: "RESCHEDULED", message: "Scheduled for Redelivery" };

  if (order.parcel_intake_method === "DRIVER_COLLECTION") {
    if (order.parcel_collection_status === "FAILED") {
      return {
        code: "COLLECTION_ATTENTION",
        message: audience === "customer" ? "Collection needs another attempt" : "Collection in progress",
      };
    }
    if (order.parcel_collection_status === "RESCHEDULED") {
      return {
        code: "COLLECTION_RESCHEDULED",
        message: audience === "customer" ? "Collection rescheduled" : "Collection in progress",
      };
    }
  }
  return null;
}

function buildTrackingProgress(
  order: TrackingSourceOrder,
  audience: Audience
): Pick<PublicTrackingDetail, "stages" | "exception" | "isDelivered" | "deliveredAt"> {
  const isDriverCollection = order.parcel_intake_method === "DRIVER_COLLECTION";
  const { reachedIndex, timestamps } = isDriverCollection ? driverCollectionProgress(order) : alreadyAtCompanyProgress(order);
  const codes = isDriverCollection ? DRIVER_COLLECTION_STAGES : ALREADY_AT_COMPANY_STAGES;
  const isDelivered = order.delivered_at !== null;

  return {
    stages: buildStages(codes, reachedIndex, timestamps, isDelivered),
    exception: buildException(order, audience),
    isDelivered,
    deliveredAt: order.delivered_at ? order.delivered_at.toISOString() : null,
  };
}

// ============================================================
// GET /api/v1/customer/me/orders/:id/tracking (customer.orders.read_own)
//
// Ownership enforced IN the query (id + customer_id together, matching the
// established driver-order.service.ts convention) — an Order that exists but
// belongs to a different Customer returns the identical 404 as a
// nonexistent Order (IDOR-safe, never a 403 that would leak existence).
// ============================================================
export async function getCustomerOrderTracking(userId: string, orderId: string): Promise<CustomerTrackingDetail> {
  const customer = await getCustomerProfileForUser(userId);

  const order = await prisma.orders.findFirst({
    where: { id: orderId, customer_id: customer.id },
    select: trackingSourceSelect,
  });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Order not found" });
  }

  return {
    orderId: order.id,
    orderNumber: order.order_number,
    createdAt: order.created_at.toISOString(),
    trackingCode: order.tracking_code,
    ...buildTrackingProgress(order, "customer"),
  };
}

// ============================================================
// GET /api/v1/track/:trackingCode — UNAUTHENTICATED (requirements.md §36).
// Deliberately the narrowest possible lookup: tracking_code only, and the
// response never includes the Order's internal id/order_number.
// ============================================================
export async function getPublicTracking(trackingCode: string): Promise<PublicTrackingDetail> {
  const order = await prisma.orders.findFirst({
    where: { tracking_code: trackingCode },
    select: trackingSourceSelect,
  });
  if (!order) {
    throw new AppError({ statusCode: 404, code: "NOT_FOUND", message: "Tracking code not found" });
  }

  return {
    trackingCode: order.tracking_code,
    ...buildTrackingProgress(order, "public"),
  };
}
