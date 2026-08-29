import type { Prisma } from "../../generated/prisma/client";

// Money is always a Prisma/decimal.js Decimal internally — never a JS
// number — matching orders.order_amount etc. (NUMERIC(14,2) in the
// approved schema) and the existing Customer wallet / Driver cash
// convention of serializing Decimal to a string only at the API boundary.
export type Money = Prisma.Decimal;

export type OrderTypeValue = "COMPANY_ORDER" | "DELIVERY_ONLY";
export type PaymentTypeValue = "CASH_ON_DELIVERY" | "ALREADY_PAID" | "PARTIALLY_PAID";

export interface OrderFinancialInput {
  orderAmount: Money;
  deliveryFee: Money;
  prepaidOrderAmount: Money;
  prepaidDeliveryFee: Money;
}

export interface OrderFinancialResult {
  orderAmount: Money;
  deliveryFee: Money;
  prepaidOrderAmount: Money;
  prepaidDeliveryFee: Money;
  remainingOrderAmount: Money;
  remainingDeliveryFee: Money;
  amountToCollect: Money;
}

// Expected ownership of the remaining (uncollected) components, derived
// purely from orderType — NOT an actual wallet credit or ledger write.
// Both COMPANY_ORDER and DELIVERY_ONLY fields are always present (zeroed
// out where not applicable) so callers never need to branch on orderType
// to read this result.
export interface FinancialOwnership {
  orderType: OrderTypeValue;
  companyOrderAmountDue: Money;
  customerOwnedOrderAmountDue: Money;
  companyDeliveryFeeDue: Money;
  // The amount that WOULD credit the customer wallet on an exact
  // successful delivery (CLAUDE.md §63) — equals customerOwnedOrderAmountDue
  // for DELIVERY_ONLY, 0 for COMPANY_ORDER. This is an expectation only;
  // no wallet is touched by this module.
  customerWalletAmountDue: Money;
  expectedDriverCollection: Money;
}

export interface OrderFinancialCalculation extends OrderFinancialResult {
  ownership: FinancialOwnership;
}

export interface CollectionDifferenceResult {
  expectedAmountToCollect: Money;
  actualAmountCollected: Money;
  // actualAmountCollected - expectedAmountToCollect. Negative = short,
  // positive = over-collected, zero = exact.
  collectionDifference: Money;
  needsFinancialReview: boolean;
}
