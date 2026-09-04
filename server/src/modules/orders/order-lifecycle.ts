import type { OrderStatus } from "../../generated/prisma/client";

// ============================================================
// Shared Order-lifecycle status sets (Phase 11.6 correction).
//
// A "terminal" Order is one whose workflow has reached a final resting state:
// it will not move to another status through any normal operational action.
// An "active" Order is any non-terminal Order — it still has unresolved work.
//
// This is the single authoritative definition. wallet.service.ts's
// PENDING_ACTIVE_STATUSES (which additionally filters order_type =
// DELIVERY_ONLY for the pending-money calculation) is derived from
// ORDER_ACTIVE_STATUSES here rather than re-listing the statuses.
// ============================================================

export const ORDER_TERMINAL_STATUSES: readonly OrderStatus[] = [
  "DELIVERED",
  "RETURNED_TO_COMPANY",
  "RETURNED_TO_CUSTOMER",
  "CANCELLED",
] as const;

export const ORDER_ACTIVE_STATUSES: readonly OrderStatus[] = [
  "RECEIVED",
  "READY_FOR_PICKUP",
  "ASSIGNED",
  "PICKED_UP",
  "OUT_FOR_DELIVERY",
  "FAILED_DELIVERY",
  "RESCHEDULED",
] as const;

// ============================================================
// Delivery-assignment eligibility (moved here from order.service.ts in
// Phase 11.17.6 so the new workflow-queue/dashboard/report modules can share
// the exact same predicate instead of re-deriving a second, possibly
// inconsistent, definition — CLAUDE.md §18/§80).
// ============================================================

// The only two OrderStatus values a FINAL delivery driver may be assigned
// from (order.service.ts's assignOrder / the "Create & Assign" path).
export const ORDER_INITIAL_ASSIGNMENT_STATUSES: readonly OrderStatus[] = ["RECEIVED", "READY_FOR_PICKUP"] as const;

export const PARCEL_NOT_READY_FOR_DELIVERY_MESSAGE =
  "Parcel must be received at the company before assigning a delivery driver";

// Parcel Intake (Phase 11.17.4) — a FINAL Delivery driver may only be
// assigned once the parcel is physically at the company. Single
// authoritative predicate, reused by order.service.ts, order-workflow-
// queue.ts, dashboard.service.ts and order-report.service.ts.
export function isParcelReadyForDelivery(parcelCollectionStatus: string): boolean {
  return parcelCollectionStatus === "RECEIVED_AT_COMPANY";
}
