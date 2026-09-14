import type { OrderStatus, OrderType, ParcelIntakeMethod, PaymentType } from "../../generated/prisma/client";
import type { CustomerCollectionStage } from "../tracking/customer-collection-stage";
import type { TrackingException, TrackingStageEntry } from "../tracking/tracking.types";

// ============================================================
// Phase 13.2 — Customer "My Orders" list row (self-scoped, read-only).
//
// A deliberately NARROW Customer-safe DTO (task §8-§10). It is NOT the
// Management OrderSummary. It never carries: any Driver identity (collection
// or delivery), the receipt-confirming employee, sender/collection contact
// data, assignment / attempt history, Management notes, audit, wallet
// transaction ids, Driver Cash, Company Finance, financial allocation,
// needs_financial_review / financial_status / collection_difference_reason,
// settlement / payout internals, reversal ids, idempotency keys.
//
// Fields it DOES carry are all the Customer's own order snapshot data, and
// match docs/page_structure.md §34's recommended My-Orders columns:
//   orderNumber, receiverName, receiverArea, orderAmount, deliveryFee,
//   amountToCollect, status, createdAt, deliveredAt
// plus tracking code + parcel-intake progress for recognition.
//
// `status` / `orderType` / `parcelIntakeMethod` are raw enums carried as
// DATA — the frontend renders them through the shared Customer-safe
// presentation helpers (getCustomerStatusPresentation / getOrderTypeLabel),
// exactly as Management/Driver DTOs do; the raw token is never shown.
// `collectionStage` is already the Customer-safe wording (see
// customer-collection-stage.ts).
// ============================================================

export interface CustomerOrderSummary {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: OrderType;
  status: OrderStatus;
  createdAt: string;
  deliveredAt: string | null;

  receiverName: string;
  receiverArea: string;

  orderAmount: string;
  deliveryFee: string;
  amountToCollect: string;

  parcelIntakeMethod: ParcelIntakeMethod;
  /** null for ALREADY_AT_COMPANY (no collection stages shown — task §15). */
  collectionStage: CustomerCollectionStage | null;
}

// ============================================================
// Phase 13.3 — Customer Order Detail (self-scoped, read-only).
//
// Same privacy envelope as CustomerOrderSummary, PLUS the Customer's own
// stored Order snapshot (receiver / package / money) and the Customer-safe
// tracking progress. Still NEVER carries: any Driver identity, the
// receipt-confirming employee, sender/collection contact data, assignment /
// attempt internals, Management notes, audit, financial allocation,
// needs_financial_review / financial_status / collection_difference_reason /
// actual_amount_collected, Driver Cash, Company Finance, settlement / payout
// internals.
//
// `tracking.stages` / `tracking.exception` come from the ONE shared
// Phase 11.17.6 "customer" audience builder (buildCustomerTrackingProgress
// in tracking.service.ts) — no second timeline, no second privacy model.
// ============================================================

export interface CustomerOrderReceiver {
  name: string;
  phone: string;
  altPhone: string | null;
  area: string;
  address: string;
  buildingFloor: string | null;
  instructions: string | null;
  mapLink: string | null;
}

export interface CustomerOrderPackage {
  description: string;
  packageCount: number;
  quantity: number | null;
  weightKg: string | null;
}

export interface CustomerOrderPayment {
  /** Raw PaymentType enum — rendered via getPaymentTypePresentation. Payment
   *  METHOD is deliberately not exposed here (task §12 / page_structure §35). */
  type: PaymentType;
  orderAmount: string;
  deliveryFee: string;
  amountToCollect: string;
}

export interface CustomerOrderTracking {
  stages: TrackingStageEntry[];
  exception: TrackingException | null;
  isDelivered: boolean;
}

export interface CustomerOrderDetail {
  id: string;
  orderNumber: string;
  trackingCode: string;
  orderType: OrderType;
  status: OrderStatus;
  createdAt: string;
  deliveredAt: string | null;

  receiver: CustomerOrderReceiver;
  package: CustomerOrderPackage;
  payment: CustomerOrderPayment;

  parcelIntakeMethod: ParcelIntakeMethod;
  collectionStage: CustomerCollectionStage | null;

  tracking: CustomerOrderTracking;
}
