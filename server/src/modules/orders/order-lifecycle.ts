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
