// ============================================================
// Phase 13.1 — Customer Portal Dashboard (self-scoped, read-only).
//
// A deliberately NARROW Customer-safe DTO (task §10). It never reuses the
// Management Customer DTO, and it carries no internal accounting, no
// financial-review flags, no Driver Cash, no Company Finance, no Parcel
// Collection operational data.
//
// Money values are decimal strings (CLAUDE.md §15), serialized with the same
// `.toString()` convention as every other financial DTO in this codebase.
// Counts are plain integers.
// ============================================================

export interface CustomerDashboardSummary {
  /** Minimal safe display identity for the Customer shell / greeting. */
  customer: {
    name: string;
    customerNumber: string;
  };
  /**
   * Finalized money the company owes this Customer and that is available to
   * be paid out — the authoritative `customer_wallets.available_balance`.
   */
  availableWalletBalance: string;
  /**
   * Potential future Customer money on active DELIVERY_ONLY orders that has
   * not yet become withdrawable through a successful delivery. Derived from
   * the approved Phase 8.2 pending rule (SUM of `remaining_order_amount` on
   * active DELIVERY_ONLY orders) — the delivery fee is deliberately excluded
   * (it belongs to the company).
   */
  pendingAmount: string;
  /** Count of this Customer's non-terminal orders. */
  activeOrders: number;
  /** Count of this Customer's orders whose status is DELIVERED. */
  deliveredOrders: number;
}
