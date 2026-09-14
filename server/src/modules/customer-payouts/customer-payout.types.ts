// ============================================================
// Phase 13.6 — Customer Payout History (self-scoped, read-only).
//
// A deliberately tiny Customer-safe view of the authoritative
// customer_payouts business record. It is NOT the Management PayoutSummary —
// which additionally carries the payout id's customer block, processedBy
// (the Finance user), notes, updatedAt, and the payment method id / code.
//
// This DTO NEVER exposes: processed_by_id / processedBy, any Finance /
// employee / actor identity, notes / Management notes, the idempotency key,
// the linked wallet_transactions id, any reversal-transaction id, audit
// metadata, previous/new values, the customer_wallets id, Driver Cash,
// Driver settlements, Company Finance, financial allocation / review,
// collection-difference internals, payment_method_id, or any raw Prisma
// relation object.
//
// `amount` is a positive decimal string (CLAUDE.md §15) — the page itself
// establishes that this is money paid TO the Customer, so it is not signed
// (signed wallet movement belongs to /customer/transactions).
//
// `status` is the raw PayoutStatus enum token; the frontend maps it to a
// friendly label. Historical payouts are always returned as-is — a payout
// that was later reversed still appears, with its current status.
// ============================================================

export type CustomerPayoutStatus = "COMPLETED" | "REVERSED" | "CANCELLED";

export interface CustomerPayoutPaymentMethod {
  /** The safe human-readable method name only ("Cash", "Whish", …). No id,
   *  no code, no active flag, no sort order, no settings metadata. */
  name: string;
}

export interface CustomerPayoutSummary {
  id: string;
  payoutNumber: string;
  amount: string;
  paymentMethod: CustomerPayoutPaymentMethod;
  status: CustomerPayoutStatus;
  createdAt: string;
}
