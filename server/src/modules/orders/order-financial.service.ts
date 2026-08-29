import { Prisma } from "../../generated/prisma/client";
import { AppError } from "../../shared/errors/app-error";
import { MONEY_DECIMAL_PLACES, MONEY_MAX_VALUE } from "./order-financial.schema";
import type {
  CollectionDifferenceResult,
  FinancialOwnership,
  Money,
  OrderFinancialCalculation,
  OrderFinancialInput,
  OrderFinancialResult,
  OrderTypeValue,
  PaymentTypeValue,
} from "./order-financial.types";

const { Decimal } = Prisma;
const ZERO: Money = new Decimal(0);

// Defense in depth: these domain functions accept Decimal directly (they
// may be called from anywhere, not only after OrderFinancialInputSchema has
// run) so the scale/range/sign checks are re-asserted here rather than
// trusted from the caller.
function assertValidMoney(value: Money, field: string): void {
  if (!value.isFinite()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: `${field} is not a valid amount` });
  }
  if (value.isNegative()) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: `${field} must not be negative` });
  }
  if (value.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: `${field} supports at most ${MONEY_DECIMAL_PLACES} decimal places`,
    });
  }
  if (value.abs().greaterThan(MONEY_MAX_VALUE)) {
    throw new AppError({ statusCode: 400, code: "VALIDATION_ERROR", message: `${field} exceeds the supported range` });
  }
}

// Naive, unvalidated amountToCollect projection — pure arithmetic, never
// throws. Used only where a non-throwing computation is required (e.g. a
// Zod .superRefine over already field-validated Decimal inputs, deciding
// whether collectionPaymentMethodId is required) before the authoritative
// calculateOrderFinancials below — which also enforces prepaid <= total —
// runs later in the real Phase 6.2 service pipeline. Do not use this as a
// substitute for calculateOrderFinancials anywhere that must be
// authoritative.
export function projectAmountToCollect(
  orderAmount: Money,
  deliveryFee: Money,
  prepaidOrderAmount: Money,
  prepaidDeliveryFee: Money
): Money {
  return orderAmount.minus(prepaidOrderAmount).plus(deliveryFee.minus(prepaidDeliveryFee));
}

// remainingOrderAmount = orderAmount - prepaidOrderAmount
// remainingDeliveryFee = deliveryFee - prepaidDeliveryFee
// amountToCollect      = remainingOrderAmount + remainingDeliveryFee
//
// Pure, Decimal-safe, no I/O. Throws AppError (400 VALIDATION_ERROR) on any
// invalid money value or an overpayment (prepaid > total) — never silently
// clamps or rounds.
export function calculateOrderFinancials(input: OrderFinancialInput): OrderFinancialResult {
  const { orderAmount, deliveryFee, prepaidOrderAmount, prepaidDeliveryFee } = input;

  assertValidMoney(orderAmount, "orderAmount");
  assertValidMoney(deliveryFee, "deliveryFee");
  assertValidMoney(prepaidOrderAmount, "prepaidOrderAmount");
  assertValidMoney(prepaidDeliveryFee, "prepaidDeliveryFee");

  if (prepaidOrderAmount.greaterThan(orderAmount)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "prepaidOrderAmount cannot exceed orderAmount",
    });
  }
  if (prepaidDeliveryFee.greaterThan(deliveryFee)) {
    throw new AppError({
      statusCode: 400,
      code: "VALIDATION_ERROR",
      message: "prepaidDeliveryFee cannot exceed deliveryFee",
    });
  }

  const remainingOrderAmount = orderAmount.minus(prepaidOrderAmount);
  const remainingDeliveryFee = deliveryFee.minus(prepaidDeliveryFee);
  const amountToCollect = remainingOrderAmount.plus(remainingDeliveryFee);

  return {
    orderAmount,
    deliveryFee,
    prepaidOrderAmount,
    prepaidDeliveryFee,
    remainingOrderAmount,
    remainingDeliveryFee,
    amountToCollect,
  };
}

// Validates that the chosen paymentType is consistent with the computed
// financials. Business rules per docs/requirements.md §8:
//
// CASH_ON_DELIVERY — "Nothing has been paid beforehand": both prepaid
//   amounts must be exactly 0.
//
// ALREADY_PAID — "The order amount has already been paid. Depending on the
//   order, the delivery fee may still need to be collected" (§8.2). The
//   ORDER AMOUNT must be fully prepaid (remainingOrderAmount = 0); the
//   delivery fee is independent and may be unpaid, partially paid, or fully
//   paid — both the "fee still due" and "fee also prepaid" examples in the
//   docs are valid ALREADY_PAID states.
//
// PARTIALLY_PAID — "Part of the order has already been paid" (§8.3). Per
//   this task's own explicit test list (nothing-prepaid and everything-
//   prepaid must both be rejected as aliases of the other two payment
//   types), PARTIALLY_PAID requires a genuine partial state: at least one
//   prepaid amount > 0 AND at least one remaining amount > 0.
export function validatePaymentTypeConsistency(paymentType: PaymentTypeValue, financials: OrderFinancialResult): void {
  const { prepaidOrderAmount, prepaidDeliveryFee, remainingOrderAmount, remainingDeliveryFee } = financials;

  switch (paymentType) {
    case "CASH_ON_DELIVERY": {
      if (!prepaidOrderAmount.isZero() || !prepaidDeliveryFee.isZero()) {
        throw new AppError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "CASH_ON_DELIVERY requires no prepaid amounts",
        });
      }
      return;
    }
    case "ALREADY_PAID": {
      if (!remainingOrderAmount.isZero()) {
        throw new AppError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "ALREADY_PAID requires the order amount to be fully prepaid",
        });
      }
      return;
    }
    case "PARTIALLY_PAID": {
      const nothingPrepaid = prepaidOrderAmount.isZero() && prepaidDeliveryFee.isZero();
      if (nothingPrepaid) {
        throw new AppError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "PARTIALLY_PAID requires at least one prepaid amount greater than zero — use CASH_ON_DELIVERY otherwise",
        });
      }
      const everythingPrepaid = remainingOrderAmount.isZero() && remainingDeliveryFee.isZero();
      if (everythingPrepaid) {
        throw new AppError({
          statusCode: 400,
          code: "VALIDATION_ERROR",
          message: "PARTIALLY_PAID requires a remaining balance — use ALREADY_PAID if everything is prepaid",
        });
      }
      return;
    }
  }
}

// Expected ownership of the remaining components, purely from orderType.
// Does not read or write any ledger — see CLAUDE.md §63/§12 for the
// authoritative accounting rules this mirrors.
export function deriveFinancialOwnership(
  orderType: OrderTypeValue,
  remainingOrderAmount: Money,
  remainingDeliveryFee: Money,
  amountToCollect: Money
): FinancialOwnership {
  const isCompanyOrder = orderType === "COMPANY_ORDER";

  return {
    orderType,
    companyOrderAmountDue: isCompanyOrder ? remainingOrderAmount : ZERO,
    customerOwnedOrderAmountDue: isCompanyOrder ? ZERO : remainingOrderAmount,
    companyDeliveryFeeDue: remainingDeliveryFee,
    customerWalletAmountDue: isCompanyOrder ? ZERO : remainingOrderAmount,
    expectedDriverCollection: amountToCollect,
  };
}

// Convenience composition of the three pure functions above for future
// Order-create use (Phase 6.2). Each step remains independently callable
// and independently unit-tested.
export function deriveOrderFinancials(orderType: OrderTypeValue, paymentType: PaymentTypeValue, input: OrderFinancialInput): OrderFinancialCalculation {
  const financials = calculateOrderFinancials(input);
  validatePaymentTypeConsistency(paymentType, financials);
  const ownership = deriveFinancialOwnership(
    orderType,
    financials.remainingOrderAmount,
    financials.remainingDeliveryFee,
    financials.amountToCollect
  );

  return { ...financials, ownership };
}

// Deliberately returns ONLY the raw difference and a boolean review flag —
// it must NEVER guess how a Delivery Only shortfall/excess should be split
// between the customer-owned order amount and the company-owned delivery
// fee (CLAUDE.md §21/§62). That allocation is a later, explicitly-authorized
// finance-review decision, not a calculation.
export function calculateCollectionDifference(
  expectedAmountToCollect: Money,
  actualAmountCollected: Money
): CollectionDifferenceResult {
  assertValidMoney(expectedAmountToCollect, "expectedAmountToCollect");
  assertValidMoney(actualAmountCollected, "actualAmountCollected");

  const collectionDifference = actualAmountCollected.minus(expectedAmountToCollect);

  return {
    expectedAmountToCollect,
    actualAmountCollected,
    collectionDifference,
    needsFinancialReview: !collectionDifference.isZero(),
  };
}
