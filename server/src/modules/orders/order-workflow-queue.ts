import type { Prisma } from "../../generated/prisma/client";
import { ORDER_INITIAL_ASSIGNMENT_STATUSES, ORDER_TERMINAL_STATUSES } from "./order-lifecycle";

// ============================================================
// Parcel Intake & Collection operational queues (Phase 11.17.6).
//
// This is the SINGLE authoritative definition of each operational queue —
// reused unchanged by:
//   - order.service.ts's listOrders() (?workflowQueue= filter, Orders List)
//   - dashboard.service.ts (operational counts + attention queue)
//   - order-report.service.ts (Orders Report parcel summary)
// so the Dashboard, Orders List quick tabs, and Reports can never drift into
// disagreeing, independently-maintained SQL (CLAUDE.md §18/§80).
//
// A leaf module — imports only from order-lifecycle.ts (which itself has no
// dependency on order.service.ts) so it can safely be imported BY
// order.service.ts without a circular import.
// ============================================================

export const WORKFLOW_QUEUE_VALUES = [
  "AWAITING_COLLECTION_ASSIGNMENT",
  "COLLECTION_IN_PROGRESS",
  "COLLECTION_ATTENTION",
  "AWAITING_COMPANY_RECEIPT",
  "READY_FOR_DELIVERY_ASSIGNMENT",
] as const;

export type WorkflowQueue = (typeof WORKFLOW_QUEUE_VALUES)[number];

const NOT_TERMINAL_STATUS_FILTER = { notIn: [...ORDER_TERMINAL_STATUSES] };

// Definitions per the approved contract (task §13-§17):
//   AWAITING_COLLECTION_ASSIGNMENT: DRIVER_COLLECTION intake, collection
//     status AWAITING_ASSIGNMENT/RESCHEDULED, no current collection driver,
//     order not terminal.
//   COLLECTION_IN_PROGRESS: collection status ASSIGNED, a current collection
//     driver exists, order not terminal. A cancelled order's HISTORICAL
//     ASSIGNED collection status is excluded by the terminal-status check —
//     order terminal state always wins.
//   COLLECTION_ATTENTION: collection status FAILED, order not terminal.
//   AWAITING_COMPANY_RECEIPT: collection status COLLECTED_FROM_SENDER, a
//     current collection driver exists (custody), order not terminal.
//   READY_FOR_DELIVERY_ASSIGNMENT: collection status RECEIVED_AT_COMPANY,
//     no current delivery driver, AND the order satisfies the exact same
//     source-status eligibility as a real Delivery assignment (order.
//     service.ts's assignOrder) — never a second, looser definition.
export function buildWorkflowQueueWhere(queue: WorkflowQueue): Prisma.ordersWhereInput {
  switch (queue) {
    case "AWAITING_COLLECTION_ASSIGNMENT":
      return {
        status: NOT_TERMINAL_STATUS_FILTER,
        parcel_intake_method: "DRIVER_COLLECTION",
        parcel_collection_status: { in: ["AWAITING_ASSIGNMENT", "RESCHEDULED"] },
        current_parcel_collection_driver_id: null,
      };
    case "COLLECTION_IN_PROGRESS":
      return {
        status: NOT_TERMINAL_STATUS_FILTER,
        parcel_collection_status: "ASSIGNED",
        current_parcel_collection_driver_id: { not: null },
      };
    case "COLLECTION_ATTENTION":
      return {
        status: NOT_TERMINAL_STATUS_FILTER,
        parcel_collection_status: "FAILED",
      };
    case "AWAITING_COMPANY_RECEIPT":
      return {
        status: NOT_TERMINAL_STATUS_FILTER,
        parcel_collection_status: "COLLECTED_FROM_SENDER",
        current_parcel_collection_driver_id: { not: null },
      };
    case "READY_FOR_DELIVERY_ASSIGNMENT":
      // Already restricted to RECEIVED/READY_FOR_PICKUP, both non-terminal —
      // no separate terminal-status filter needed.
      return {
        status: { in: [...ORDER_INITIAL_ASSIGNMENT_STATUSES] },
        current_driver_id: null,
        parcel_collection_status: "RECEIVED_AT_COMPANY",
      };
    default: {
      const exhaustive: never = queue;
      throw new Error(`Unknown workflow queue: ${String(exhaustive)}`);
    }
  }
}
