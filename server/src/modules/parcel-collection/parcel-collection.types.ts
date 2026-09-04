import type {
  ParcelCollectionAssignmentEndReason,
  ParcelCollectionAttemptOutcome,
  ParcelCollectionStatus,
  ParcelIntakeMethod,
} from "../../generated/prisma/client";

// ============================================================
// Phase 11.17.3 — Parcel Collection DTOs.
//
// Financially neutral domain. These DTOs NEVER carry Customer Wallet,
// Driver Cash, Company Finance, payout, settlement or financial-review data.
// ============================================================

export interface ParcelCollectionDriverSummary {
  id: string;
  driverNumber: string;
  user: {
    firstName: string;
    lastName: string;
    phone: string | null;
  };
}

export interface ParcelCollectionActorSummary {
  id: string;
  firstName: string;
  lastName: string;
}

export interface ParcelCollectionSnapshot {
  contactName: string | null;
  phone: string | null;
  altPhone: string | null;
  areaId: string | null;
  area: string | null;
  address: string | null;
  notes: string | null;
}

export interface ParcelCollectionAssignmentEntry {
  id: string;
  driver: ParcelCollectionDriverSummary;
  assignedBy: ParcelCollectionActorSummary;
  assignedAt: string;
  endedAt: string | null;
  endReason: ParcelCollectionAssignmentEndReason | null;
  isCurrent: boolean;
}

export interface ParcelCollectionAttemptEntry {
  id: string;
  attemptNumber: number;
  driver: ParcelCollectionDriverSummary;
  outcome: ParcelCollectionAttemptOutcome;
  failedReason: { id: string; name: string } | null;
  notes: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// Management read DTO — GET /api/v1/orders/:id/parcel-collection.
export interface ParcelCollectionDetail {
  orderId: string;
  intakeMethod: ParcelIntakeMethod;
  status: ParcelCollectionStatus;
  collectionSnapshot: ParcelCollectionSnapshot;
  currentCollectionDriver: ParcelCollectionDriverSummary | null;
  parcelCollectedFromSenderAt: string | null;
  receivedAtCompanyAt: string | null;
  receivedAtCompanyBy: ParcelCollectionActorSummary | null;
  // assignments: oldest-first (same convention as Order Detail assignment history).
  assignments: ParcelCollectionAssignmentEntry[];
  // attempts: attemptNumber ascending.
  attempts: ParcelCollectionAttemptEntry[];
}

// Narrow Driver-facing response for the collected / failed mutations —
// deliberately NOT the Management DTO above (no Management actor identity,
// no assignment/attempt history, no snapshot).
export interface DriverParcelCollectionResult {
  orderId: string;
  parcelCollectionStatus: ParcelCollectionStatus;
  parcelCollectedFromSenderAt: string | null;
  latestAttempt: {
    attemptNumber: number;
    outcome: ParcelCollectionAttemptOutcome;
    completedAt: string | null;
  } | null;
}

export interface DriverFailedCollectionReasonSummary {
  id: string;
  name: string;
  requiresNotes: boolean;
  sortOrder: number;
}
