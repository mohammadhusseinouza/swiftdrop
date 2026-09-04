import { z } from "zod";

// ============================================================
// Phase 11.17.3 — Parcel Collection request schemas.
//
// "Parcel collection" is a DIFFERENT domain from financial cash collection
// (amountToCollect / actualAmountCollected / DriverCashTransactionType.COLLECTION).
// Everything here is Parcel-prefixed. No money field appears in this module.
//
// Unknown / spoofed body fields (driverId on Driver-own routes, status,
// outcome, attemptNumber, endReason, timestamps, actor ids, ...) are
// silently stripped by Zod's default object behaviour — never read.
// ============================================================

export const ParcelCollectionOrderIdParamSchema = z.object({
  id: z.string().uuid(),
});

// Management — assign / reassign a Collection Driver. driverId is legitimate
// input here because Management is choosing whom to assign.
export const AssignParcelCollectionDriverSchema = z.object({
  driverId: z.string().uuid(),
});
export type AssignParcelCollectionDriverInput = z.infer<typeof AssignParcelCollectionDriverSchema>;

export const ReassignParcelCollectionDriverSchema = z.object({
  driverId: z.string().uuid(),
});
export type ReassignParcelCollectionDriverInput = z.infer<typeof ReassignParcelCollectionDriverSchema>;

// Driver — record a failed collection. Only shape validation happens here;
// "notes required when the reason's requires_notes = true" needs a DB lookup
// and is enforced in the service (identical convention to Phase 7.4 /fail).
export const FailParcelCollectionSchema = z.object({
  failedCollectionReasonId: z.string().uuid(),
  notes: z.string().trim().min(1).optional(),
});
export type FailParcelCollectionInput = z.infer<typeof FailParcelCollectionSchema>;

// Driver-facing "active Failed Collection Reasons" list — no filters; the
// endpoint always returns exactly the active set the failure UI needs.
export const DriverFailedCollectionReasonsQuerySchema = z.object({});
