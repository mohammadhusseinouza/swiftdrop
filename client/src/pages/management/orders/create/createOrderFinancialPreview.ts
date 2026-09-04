/**
 * PREVIEW-ONLY exact-decimal helper for the Create Order form.
 *
 * The backend (`order-financial.service.ts`) is the sole authority for every
 * monetary total persisted on an Order. This module exists purely so the form
 * can show the operator a live "remaining / to collect" preview without any
 * JavaScript floating-point arithmetic:
 *
 *   - `Number()` / `parseFloat` / `parseInt` are never used
 *   - validated 2-decimal strings are parsed to integer cents as `bigint`
 *   - add / subtract happen in `bigint`
 *   - the result is formatted back to a 2-decimal string
 *
 * It is deliberately tiny and local — not a money library.
 */

// The exact-decimal primitives now live in a shared module (they are reused by
// the Payouts workflow). Re-exported here so existing importers are unchanged.
import { parseMoneyToCents, formatCents } from '../../../../lib/money';

export {
  parseMoneyToCents,
  formatCents,
  moneyEquals,
  moneyIsPositive,
} from '../../../../lib/money';

export interface OrderFinancialPreviewInput {
  orderAmount: string;
  deliveryFee: string;
  prepaidOrderAmount: string;
  prepaidDeliveryFee: string;
}

export interface OrderFinancialPreview {
  /** True only when every input parsed AND no prepaid amount exceeds its total. */
  valid: boolean;
  /** 2-decimal strings, or `null` when the preview can't be computed safely. */
  remainingOrderAmount: string | null;
  remainingDeliveryFee: string | null;
  amountToCollect: string | null;
  /** Individual problems, for field-level messaging. */
  prepaidOrderExceedsTotal: boolean;
  prepaidDeliveryExceedsTotal: boolean;
}

const EMPTY: OrderFinancialPreview = {
  valid: false,
  remainingOrderAmount: null,
  remainingDeliveryFee: null,
  amountToCollect: null,
  prepaidOrderExceedsTotal: false,
  prepaidDeliveryExceedsTotal: false,
};

/**
 * Mirrors the backend formulae for display only:
 *   remainingOrderAmount = orderAmount - prepaidOrderAmount
 *   remainingDeliveryFee = deliveryFee - prepaidDeliveryFee
 *   amountToCollect      = remainingOrderAmount + remainingDeliveryFee
 *
 * An empty prepaid string is treated as "0.00". A negative remainder never
 * appears as a valid preview — it is reported via the `*ExceedsTotal` flags
 * and the amounts come back `null`.
 */
export function calculateOrderPreview(
  input: OrderFinancialPreviewInput,
): OrderFinancialPreview {
  const order = parseMoneyToCents(input.orderAmount);
  const fee = parseMoneyToCents(input.deliveryFee);
  const prepaidOrder = parseMoneyToCents(input.prepaidOrderAmount || '0');
  const prepaidFee = parseMoneyToCents(input.prepaidDeliveryFee || '0');

  if (order === null || fee === null || prepaidOrder === null || prepaidFee === null) {
    return EMPTY;
  }

  const prepaidOrderExceedsTotal = prepaidOrder > order;
  const prepaidDeliveryExceedsTotal = prepaidFee > fee;
  if (prepaidOrderExceedsTotal || prepaidDeliveryExceedsTotal) {
    return { ...EMPTY, prepaidOrderExceedsTotal, prepaidDeliveryExceedsTotal };
  }

  const remainingOrder = order - prepaidOrder;
  const remainingFee = fee - prepaidFee;
  const toCollect = remainingOrder + remainingFee;

  return {
    valid: true,
    remainingOrderAmount: formatCents(remainingOrder),
    remainingDeliveryFee: formatCents(remainingFee),
    amountToCollect: formatCents(toCollect),
    prepaidOrderExceedsTotal: false,
    prepaidDeliveryExceedsTotal: false,
  };
}
