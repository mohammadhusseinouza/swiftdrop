// ============================================================
// Phase 13.4 — Customer Wallet summary (self-scoped, read-only).
//
// The narrowest possible Customer-safe DTO: the two figures the Wallet page
// shows, plus minimal display identity. It is NOT the Management WalletDetail
// (which carries wallet id, created/updated timestamps, a Management customer
// summary, last-transaction / last-payout pointers). No wallet transaction
// rows, no payout data, no processedBy, no notes, no audit, no Driver Cash,
// no Company Finance, no financial-review fields.
//
// Money values are decimal strings (CLAUDE.md §15). `availableBalance` and
// `pendingAmount` are produced by the ONE shared helper
// (getCustomerWalletFigures) that /customer/dashboard also uses.
// ============================================================

export interface CustomerWalletSummary {
  customer: {
    name: string;
    customerNumber: string;
  };
  /** customer_wallets.available_balance — money owed to the Customer and
   *  available for company payout. */
  availableBalance: string;
  /** Potential Customer money on active DELIVERY_ONLY orders — not yet
   *  available (approved Phase 8.2 pending rule; delivery fee excluded). */
  pendingAmount: string;
}

// ============================================================
// Phase 13.5 — Customer Wallet Transactions (self-scoped, read-only).
//
// A narrow Customer-safe row over the authoritative append-only
// wallet_transactions ledger. NOT the Management WalletTransactionEntry —
// which additionally carries balanceBefore, credit/debit columns, notes,
// paymentMethod, and processedBy (the Finance user). This DTO never exposes:
// wallet_id, processed_by_id / processedBy, notes / any reason, payment
// method, reversal_of_id, idempotency_key, created_by, actor ids, Company
// Finance / Driver Cash / settlement ids, financial allocation, financial
// review, or audit.
//
// `direction` + `amount` are derived from balance_before / balance_after
// with exact Decimal arithmetic (task §13) — never from the type and never
// from JS floating point. `id` is included only as a stable React key /
// pagination cursor.
// ============================================================

export type CustomerWalletTransactionType = "ORDER_CREDIT" | "PAYOUT" | "ADJUSTMENT" | "REVERSAL";

export type CustomerWalletTransactionDirection = "CREDIT" | "DEBIT" | "NONE";

export interface CustomerWalletTransactionReference {
  kind: "ORDER" | "PAYOUT";
  /** The bare Order number / payout number — the frontend prefixes the noun. */
  label: string;
}

export interface CustomerWalletTransactionSummary {
  id: string;
  type: CustomerWalletTransactionType;
  occurredAt: string;
  /** CREDIT = money added, DEBIT = money removed, NONE = no balance movement. */
  direction: CustomerWalletTransactionDirection;
  /** Absolute magnitude of the balance movement, decimal string. */
  amount: string;
  /** Resulting wallet balance after this row, decimal string. balanceBefore
   *  is deliberately NOT exposed (task §19). */
  balanceAfter: string;
  reference: CustomerWalletTransactionReference | null;
}
