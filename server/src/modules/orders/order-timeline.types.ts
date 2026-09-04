// ============================================================
// Unified Order operational timeline (Phase 11.17.6, task §41-§48).
//
// GET /api/v1/orders/:id/timeline composes ALREADY-authoritative sources
// (order_status_history, order_assignments, delivery_attempts,
// order-scoped financial ledger events, parcel_collection_assignments,
// parcel_collection_attempts, orders.received_at_company_at) into one
// chronological list. It creates nothing new and reads no additional
// tables beyond those an authorized `orders.read` caller can already see
// via OrderDetail / GET /orders/:id/parcel-collection — this endpoint only
// re-shapes and interleaves them.
//
// The ONE narrow exception (task §46): PARCEL_COLLECTION_RESCHEDULED has no
// dedicated operational status-history row (RESCHEDULED carries no current
// assignment — order-lifecycle contract). For TIMELINE DISPLAY ONLY, the
// immutable PARCEL_COLLECTION_RESCHEDULED audit_logs row is used as the
// event source. Current Parcel Collection state is NEVER derived from audit
// data anywhere else in the system — this is purely a chronology entry.
//
// Every entry corresponds to exactly one persisted row; duplicate-avoidance
// rules (task §44/§45) are applied in order-timeline.service.ts, not here.
// ============================================================

export type OrderTimelineEventType =
  | "STATUS_CHANGED"
  | "DELIVERY_DRIVER_ASSIGNED"
  | "DELIVERY_ASSIGNMENT_ENDED"
  | "DELIVERY_ATTEMPT"
  | "FINANCIAL_EVENT"
  | "PARCEL_COLLECTION_DRIVER_ASSIGNED"
  | "PARCEL_COLLECTION_DRIVER_REASSIGNED"
  | "PARCEL_COLLECTION_FAILED"
  | "PARCEL_COLLECTION_RESCHEDULED"
  | "PARCEL_COLLECTED_FROM_SENDER"
  | "PARCEL_RECEIVED_AT_COMPANY"
  | "PARCEL_COLLECTION_ENDED_ORDER_CANCELLED";

export interface OrderTimelineActor {
  id: string;
  firstName: string;
  lastName: string;
}

export interface OrderTimelineDriverRef {
  id: string;
  driverNumber: string;
  firstName: string;
  lastName: string;
}

// A deliberately wide, flat DTO — only the fields relevant to `type` are
// populated for any given entry; the rest are null. Kept flat (rather than a
// discriminated union) to match this codebase's existing normalized-event
// convention (see OrderFinancialEvent in order.types.ts). Presentation
// (title text, icon, tone) is a frontend concern, exactly like every other
// event/status DTO in this codebase (StatusBadge, parcelCollection.ts, etc.)
export interface OrderTimelineEvent {
  id: string;
  type: OrderTimelineEventType;
  occurredAt: string;
  actor: OrderTimelineActor | null;
  /** The Driver this event is primarily about (assigned-to / attempted-by / collected-by). */
  driver: OrderTimelineDriverRef | null;
  /** Reassignment only — the NEW driver (`driver` holds the previous one). */
  toDriver: OrderTimelineDriverRef | null;
  /** STATUS_CHANGED only. */
  fromStatus: string | null;
  toStatus: string | null;
  /** DELIVERY_ASSIGNMENT_ENDED / PARCEL_COLLECTION_ENDED_ORDER_CANCELLED only. */
  endReason: string | null;
  /** DELIVERY_ATTEMPT / PARCEL_COLLECTION_FAILED / PARCEL_COLLECTED_FROM_SENDER only. */
  attemptNumber: number | null;
  outcome: string | null;
  reason: string | null;
  notes: string | null;
  /** DELIVERY_ATTEMPT (actual collection) / FINANCIAL_EVENT only — a money string. */
  amount: string | null;
  /** FINANCIAL_EVENT only. */
  ledger: string | null;
  financialType: string | null;
}
