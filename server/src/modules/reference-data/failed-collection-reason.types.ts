export interface FailedCollectionReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

// Narrow shape for the Driver-facing active-reasons endpoint — no actor /
// timestamp / isActive metadata.
export interface DriverFailedCollectionReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  sortOrder: number;
}
