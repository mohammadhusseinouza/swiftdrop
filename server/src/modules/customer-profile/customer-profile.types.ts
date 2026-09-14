// ============================================================
// Phase 13.7 — Customer Profile (self-scoped, read-only).
//
// A deliberately NARROW Customer-safe DTO (task §10). It never reuses the
// Management Customer DTO (customers.controller CustomerDetail), and it
// carries NONE of:
//   - internal ids (customers.id, portal_user_id, created_by_id, area id)
//   - Management notes (customers.notes)
//   - is_active / hasPortalAccount / portal metadata
//   - created_at / updated_at timestamps
//   - auth/security internals (password, tokens, sessions, role, permissions)
//   - any wallet / pending / transaction / payout / Driver Cash /
//     Company Finance / financial-review data
//   - any Order / receiver / tracking / parcel-collection data
//
// `email` is the CONTACT email stored on the `customers` record. It is NOT
// the portal login/account email (which lives on `users.email` and may
// legitimately differ). This endpoint never reads or exposes `users.email`
// (task §14).
//
// `defaultArea` / `defaultAddress` are the CURRENT profile defaults. They are
// read-only here and are unrelated to the immutable receiver / collection
// snapshots recorded on historical Orders (requirements.md §4 / Rule 21).
// ============================================================

export interface CustomerProfileArea {
  /** The area's display name only — no id, sort order, isActive, or metadata. */
  name: string;
}

export interface CustomerProfile {
  /** Stable business identifier (customers.customer_number). Read-only. */
  customerNumber: string;
  /** Authoritative Customer business/display name (customers.name). */
  name: string;
  /** customers.primary_phone — always present (NOT NULL column). */
  primaryPhone: string;
  /** customers.secondary_phone — null when the Customer has none. */
  secondaryPhone: string | null;
  /** customers.email — the Customer CONTACT email, null when unset. Never the
   *  portal login email. */
  email: string | null;
  /** customers.default_area relation name, or null when no default area. */
  defaultArea: CustomerProfileArea | null;
  /** customers.default_address — null when unset. */
  defaultAddress: string | null;
}
