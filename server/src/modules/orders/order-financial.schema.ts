import { z } from "zod";
import { Prisma } from "../../generated/prisma/client";

const { Decimal } = Prisma;

// orders.order_amount / delivery_fee / prepaid_order_amount /
// prepaid_delivery_fee / remaining_order_amount / remaining_delivery_fee /
// amount_to_collect / actual_amount_collected are all NUMERIC(14,2) in the
// approved schema — 14 total significant digits, 2 after the decimal point,
// i.e. at most 12 digits before the decimal point.
export const MONEY_DECIMAL_PLACES = 2;
export const MONEY_MAX_VALUE = new Decimal("999999999999.99");

export const OrderTypeSchema = z.enum(["COMPANY_ORDER", "DELIVERY_ONLY"]);
export const PaymentTypeSchema = z.enum(["CASH_ON_DELIVERY", "ALREADY_PAID", "PARTIALLY_PAID"]);

const rawMoneyInput = z.union([z.string(), z.number()]);

// Parses and validates one monetary value against the real DB scale/range.
// Never performs the parse via plain JS float arithmetic — the client value
// (string or number) is handed directly to decimal.js's Decimal
// constructor, which parses the exact decimal text losslessly.
function parseMoneyValue(raw: string | number, ctx: z.RefinementCtx): Prisma.Decimal {
  let decimal: Prisma.Decimal;
  try {
    decimal = new Decimal(raw);
  } catch {
    ctx.addIssue({ code: "custom", message: "Invalid monetary amount" });
    return z.NEVER;
  }

  if (!decimal.isFinite()) {
    ctx.addIssue({ code: "custom", message: "Invalid monetary amount" });
    return z.NEVER;
  }
  if (decimal.isNegative()) {
    ctx.addIssue({ code: "custom", message: "Amount must not be negative" });
    return z.NEVER;
  }
  if (decimal.decimalPlaces() > MONEY_DECIMAL_PLACES) {
    ctx.addIssue({ code: "custom", message: `Amount supports at most ${MONEY_DECIMAL_PLACES} decimal places` });
    return z.NEVER;
  }
  if (decimal.abs().greaterThan(MONEY_MAX_VALUE)) {
    ctx.addIssue({ code: "custom", message: "Amount exceeds the supported range" });
    return z.NEVER;
  }

  return decimal;
}

// Required money field (e.g. orderAmount, deliveryFee — no DB default).
export const moneySchema = rawMoneyInput.transform(parseMoneyValue);

// Optional money field that defaults to 0 when omitted, matching
// prepaid_order_amount/prepaid_delivery_fee's DB @default(0).
export const optionalMoneySchema = rawMoneyInput
  .optional()
  .transform((value, ctx) => (value === undefined ? new Decimal(0) : parseMoneyValue(value, ctx)));

// The financial subset of a future Order create body. Deliberately does
// NOT include remainingOrderAmount / remainingDeliveryFee / amountToCollect
// / actualAmountCollected — those are always server-derived (see
// order-financial.service.ts) and must never be accepted as create input.
export const OrderFinancialInputSchema = z.object({
  orderAmount: moneySchema,
  deliveryFee: moneySchema,
  prepaidOrderAmount: optionalMoneySchema,
  prepaidDeliveryFee: optionalMoneySchema,
});

export type OrderFinancialInputParsed = z.infer<typeof OrderFinancialInputSchema>;
