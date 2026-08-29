// Driver Portal DTOs (Phase 7.1) — deliberately NOT the Management
// OrderSummary/OrderDetail types. Those carry customer wallet ownership
// concepts, full payment-method objects for both prepaid and collection,
// status/assignment history, and other Management-only data a Driver must
// never see (CLAUDE.md §37). This is a fresh, narrow, operational DTO.
//
// One shape serves both the list and the detail endpoint — Phase 7.1 has no
// additional detail-only data (no history, no attempts yet), so a second,
// near-identical type would just be duplicate mapping logic to keep in sync.
// A later phase is free to diverge DriverOrderDetail from DriverOrderSummary
// once it has something genuinely detail-only to add (e.g. delivery
// attempts in Phase 7.4).

export interface DriverOrderReceiverSummary {
  name: string;
  phone: string;
  altPhone: string | null;
  area: string;
  address: string;
  buildingFloor: string | null;
  mapLink: string | null;
  instructions: string | null;
}

export interface DriverOrderPackageSummary {
  description: string;
  packageCount: number;
  quantity: number | null;
  weightKg: string | null;
  notes: string | null;
}

export interface DriverOrderPaymentMethodSummary {
  id: string;
  code: string;
  name: string;
}

// Only what the Driver needs to collect — no prepaid breakdown, no
// order-amount/delivery-fee split, no company-vs-customer ownership
// accounting (CLAUDE.md §37, Phase 7.1 task's "What the Driver Needs
// Financially" section). actualAmountCollected (Phase 7.5) is the Driver's
// own submitted value — safe to echo back — but financialStatus,
// needsFinancialReview, and collectionDifferenceReason remain internal
// Management/Finance concerns and are deliberately never exposed here.
export interface DriverOrderCollectionSummary {
  amountToCollect: string;
  actualAmountCollected: string | null;
  paymentMethod: DriverOrderPaymentMethodSummary | null;
}

export interface DriverOrderTimestamps {
  assignedAt: string | null;
  pickedUpAt: string | null;
  outForDeliveryAt: string | null;
  deliveredAt: string | null;
}

export interface DriverOrderSummary {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: string;
  status: string;

  receiver: DriverOrderReceiverSummary;
  package: DriverOrderPackageSummary;
  collection: DriverOrderCollectionSummary;
  timestamps: DriverOrderTimestamps;
}

export type DriverOrderDetail = DriverOrderSummary;
