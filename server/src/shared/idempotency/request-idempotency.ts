import { createHash } from "node:crypto";

export type RequestIdempotencyOperation = "payout" | "settlement";

// Derives a bounded, non-reversible internal ledger idempotency_key from a
// raw client-supplied Idempotency-Key header, scoped to the authenticated
// actor so two different Finance users reusing the same raw token never
// collide (Phase 8.9). Never persist the raw client key.
export function deriveRequestIdempotencyKey(
  operation: RequestIdempotencyOperation,
  actorUserId: string,
  rawIdempotencyKey: string
): string {
  const hash = createHash("sha256").update(`${actorUserId}:${rawIdempotencyKey}`).digest("hex");
  return `request:${operation}:${hash}`;
}
