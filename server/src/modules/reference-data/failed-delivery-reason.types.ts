export interface FailedDeliveryReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Narrow shape for the Driver-facing active-reasons endpoint (Phase 12.4) —
// mirrors DriverFailedCollectionReasonSummary exactly (failed-collection-
// reason.types.ts): no actor / timestamp / isActive metadata.
export interface DriverFailedDeliveryReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  sortOrder: number;
}
