export interface CustomerAreaSummary {
  id: string;
  name: string;
}

export interface CustomerSummary {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone: string;
  secondaryPhone: string | null;
  email: string | null;
  defaultAddress: string | null;
  area: CustomerAreaSummary | null;
  hasPortalAccount: boolean;
  isActive: boolean;
  // Operational (NOT financial) — count of this customer's non-terminal
  // orders (ORDER_ACTIVE_STATUSES). Batched per result page, never N+1
  // (Phase 11.6 correction). Available to every customers.read caller.
  activeOrders: number;
  createdAt: string;
  updatedAt: string;
}

// Operational order summary for Customer Detail (Phase 11.6 correction).
// Server-derived DB counts — the client never counts orders.
export interface CustomerOrderSummary {
  activeOrders: number;
  deliveredOrders: number;
  totalOrders: number;
}

// GET /customers/totals — system-wide operational counts across ALL
// customers, same active/delivered definitions as CustomerOrderSummary.
// Operational only: wallet totals are served by GET /wallets/totals
// (wallets.read), never under customers.read.
export interface CustomerOrderTotals {
  activeOrders: number;
  deliveredOrders: number;
}

// CustomerDetail is management-safe OPERATIONAL data only. Wallet balance /
// pending / ledger data is NOT here — it is served exclusively by
// GET /wallets/:customerId (wallets.read). See the Phase 11.6 correction:
// exposing wallet.availableBalance under customers.read alone bypassed the
// separate wallets.read permission.
export interface CustomerDetail extends CustomerSummary {
  notes: string | null;
  orderSummary: CustomerOrderSummary;
}
