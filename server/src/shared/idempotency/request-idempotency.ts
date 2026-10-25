import { createHash } from "node:crypto";

export type RequestIdempotencyOperation =
  | "payout"
  | "settlement"
  | "settlement-shortfall"
  // FR.12A.5 — historical reconciliation workflow
  | "historical-reconciliation-proposal"
  | "historical-reconciliation-decision"
  // FR.12A.11 — historical ownership resolution / liability workflow
  | "historical-liability-policy-proposal"
  | "historical-liability-policy-decision"
  | "historical-ownership-resolution-proposal"
  | "historical-ownership-resolution-decision"
  | "historical-liability-record"
  | "historical-liability-review";

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
