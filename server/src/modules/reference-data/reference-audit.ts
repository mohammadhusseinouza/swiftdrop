// ============================================================
// Shared audit helpers for reference-data mutations (Phase 11.16).
//
// Phase 5.3 built the Areas / Payment Methods / Failed Delivery Reasons
// mutation APIs BEFORE the audit infrastructure existed and explicitly
// deferred audit. Audit infrastructure now exists (src/shared/audit), and
// Phase 11.16 is the final Settings phase, so every reference-data mutation
// is now traceable. Each producer writes its row via createAuditLog INSIDE
// the same transaction as the mutation it documents (§38 audit atomicity).
// ============================================================

/**
 * Classifies an update into a specific audit action. A change that ONLY
 * flips `is_active` is recorded as DEACTIVATED / REACTIVATED (mirroring the
 * Customer / Driver / Employee producers); anything else is a generic
 * UPDATED with previous/new field snapshots.
 */
export function classifyReferenceUpdate(opts: {
  wasActive: boolean;
  nextActive: boolean | undefined;
  otherFieldsTouched: boolean;
}): "UPDATED" | "DEACTIVATED" | "REACTIVATED" {
  const { wasActive, nextActive, otherFieldsTouched } = opts;
  if (!otherFieldsTouched && nextActive === false && wasActive) return "DEACTIVATED";
  if (!otherFieldsTouched && nextActive === true && !wasActive) return "REACTIVATED";
  return "UPDATED";
}

/** Builds the previous/new snapshot objects for an update audit row. */
export function diffReferenceFields<T extends Record<string, unknown>>(
  existing: T,
  next: Partial<T>,
): { previousValues: Record<string, unknown>; newValues: Record<string, unknown>; otherFieldsTouched: boolean } {
  const previousValues: Record<string, unknown> = {};
  const newValues: Record<string, unknown> = {};
  let otherFieldsTouched = false;

  for (const key of Object.keys(next) as (keyof T)[]) {
    const nextValue = next[key];
    if (nextValue === undefined || nextValue === existing[key]) continue;
    previousValues[key as string] = existing[key];
    newValues[key as string] = nextValue;
    if (key !== "isActive") otherFieldsTouched = true;
  }

  return { previousValues, newValues, otherFieldsTouched };
}
