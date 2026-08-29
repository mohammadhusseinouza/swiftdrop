import { z } from 'zod';
import type { UpdateOrderRequest } from '../../../../services/ordersApi';
import type { OrderDetail } from '../../../../services/domain.types';
import { parseMoneyToCents } from '../create/createOrderFinancialPreview';

/**
 * Frontend Edit Order validation — mirrors the live backend PATCH contract
 * (server/src/modules/orders/order.schema.ts `OrderUpdateSchema` +
 * order.service.ts `updateOrder` + the reused Phase 6.1
 * calculateOrderFinancials / validatePaymentTypeConsistency).
 *
 * UX validation only. The backend re-validates, recomputes every remaining
 * amount + amountToCollect, and re-derives the required/absent payment methods.
 *
 * Deliberately NOT editable here (matches the backend):
 *   - orderType   (immutable — financial ownership semantics)
 *   - status      (explicit workflow endpoints only)
 *   - driver      (assign / reassign endpoints only)
 *   - server-owned totals (remaining*, amountToCollect, actualAmountCollected)
 */

const PAYMENT_TYPES = [
  'CASH_ON_DELIVERY',
  'ALREADY_PAID',
  'PARTIALLY_PAID',
] as const;

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;
const WEIGHT_RE = /^\d+(?:\.\d{1,3})?$/;
const INT_RE = /^\d+$/;

const requiredMoney = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .regex(MONEY_RE, `${label} must be an amount with at most 2 decimals`);

const optionalMoney = z
  .string()
  .trim()
  .regex(MONEY_RE, 'Enter an amount with at most 2 decimals')
  .or(z.literal(''));

const optionalUuid = z.union([z.literal(''), z.uuid()]);

export const editOrderSchema = z
  .object({
    customerId: z
      .string()
      .min(1, 'Select a customer')
      .pipe(z.uuid('Select a customer')),
    paymentType: z.enum(PAYMENT_TYPES),

    receiverName: z.string().trim().min(1, 'Receiver name is required').max(200),
    receiverPhone: z.string().trim().min(1, 'Primary phone is required').max(30),
    receiverAltPhone: z.string().trim().max(30, 'At most 30 characters'),
    receiverAreaId: z
      .string()
      .min(1, 'Select an area')
      .pipe(z.uuid('Select an area')),
    receiverAddress: z
      .string()
      .trim()
      .min(1, 'Full address is required')
      .max(500),
    receiverBuildingFloor: z.string().trim().max(200, 'At most 200 characters'),
    receiverMapLink: z.string().trim().max(1000, 'At most 1000 characters'),
    receiverInstructions: z.string().trim(),

    description: z.string().trim().min(1, 'Description is required'),
    packageCount: z
      .string()
      .trim()
      .refine(
        (v) => INT_RE.test(v) && v !== '0',
        'Enter a whole number of 1 or more',
      ),
    quantity: z
      .string()
      .trim()
      .refine((v) => v === '' || INT_RE.test(v), 'Enter a whole number (0 or more)'),
    weightKg: z
      .string()
      .trim()
      .refine(
        (v) => v === '' || WEIGHT_RE.test(v),
        'Enter a weight with at most 3 decimals',
      ),
    packageNotes: z.string().trim(),

    orderAmount: requiredMoney('Order amount'),
    deliveryFee: requiredMoney('Delivery fee'),
    prepaidOrderAmount: optionalMoney,
    prepaidDeliveryFee: optionalMoney,
    prepaidPaymentMethodId: optionalUuid,
    collectionPaymentMethodId: optionalUuid,
  })
  .superRefine((v, ctx) => {
    const order = parseMoneyToCents(v.orderAmount);
    const fee = parseMoneyToCents(v.deliveryFee);
    const prepaidOrder = parseMoneyToCents(v.prepaidOrderAmount || '0');
    const prepaidFee = parseMoneyToCents(v.prepaidDeliveryFee || '0');
    if (
      order === null ||
      fee === null ||
      prepaidOrder === null ||
      prepaidFee === null
    ) {
      return;
    }

    if (prepaidOrder > order) {
      ctx.addIssue({
        code: 'custom',
        path: ['prepaidOrderAmount'],
        message: 'Prepaid order amount cannot exceed the order amount',
      });
    }
    if (prepaidFee > fee) {
      ctx.addIssue({
        code: 'custom',
        path: ['prepaidDeliveryFee'],
        message: 'Prepaid delivery fee cannot exceed the delivery fee',
      });
    }
    if (prepaidOrder > order || prepaidFee > fee) return;

    const remainingOrder = order - prepaidOrder;
    const remainingFee = fee - prepaidFee;
    const prepaidTotal = prepaidOrder + prepaidFee;
    const amountToCollect = remainingOrder + remainingFee;

    if (v.paymentType === 'CASH_ON_DELIVERY') {
      if (prepaidTotal > 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['paymentType'],
          message:
            'Cash on Delivery requires no prepaid amounts — clear the prepaid fields or choose another payment type',
        });
      }
    } else if (v.paymentType === 'ALREADY_PAID') {
      if (remainingOrder !== 0n) {
        ctx.addIssue({
          code: 'custom',
          path: ['prepaidOrderAmount'],
          message: 'Already Paid requires the full order amount to be prepaid',
        });
      }
    } else if (prepaidTotal === 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentType'],
        message:
          'Partially Paid needs at least one prepaid amount above zero — use Cash on Delivery otherwise',
      });
    } else if (remainingOrder === 0n && remainingFee === 0n) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentType'],
        message:
          'Partially Paid needs a remaining balance — use Already Paid if everything is prepaid',
      });
    }

    if (prepaidTotal > 0n && !v.prepaidPaymentMethodId) {
      ctx.addIssue({
        code: 'custom',
        path: ['prepaidPaymentMethodId'],
        message: 'Select the method used for the prepaid amount',
      });
    }
    if (prepaidTotal === 0n && v.prepaidPaymentMethodId) {
      ctx.addIssue({
        code: 'custom',
        path: ['prepaidPaymentMethodId'],
        message: 'Remove the prepaid method — nothing has been prepaid',
      });
    }
    if (amountToCollect > 0n && !v.collectionPaymentMethodId) {
      ctx.addIssue({
        code: 'custom',
        path: ['collectionPaymentMethodId'],
        message: 'Select the method for the amount collected on delivery',
      });
    }
    if (amountToCollect <= 0n && v.collectionPaymentMethodId) {
      ctx.addIssue({
        code: 'custom',
        path: ['collectionPaymentMethodId'],
        message: 'Remove the collection method — there is nothing left to collect',
      });
    }
  });

export type EditOrderFormValues = z.infer<typeof editOrderSchema>;

/** Seed the edit form from the current authoritative Order. */
export function orderToEditValues(order: OrderDetail): EditOrderFormValues {
  const f = order.financial;
  return {
    customerId: order.customer.id,
    // Seeded directly from the stored enum (Phase 11.5 correction — OrderDetail
    // now carries paymentType); never reconstructed from the prepaid amounts.
    paymentType: PAYMENT_TYPES.includes(
      order.paymentType as (typeof PAYMENT_TYPES)[number],
    )
      ? (order.paymentType as (typeof PAYMENT_TYPES)[number])
      : 'CASH_ON_DELIVERY',
    receiverName: order.receiver.name,
    receiverPhone: order.receiver.phone,
    receiverAltPhone: order.receiver.altPhone ?? '',
    receiverAreaId: order.receiver.areaId ?? '',
    receiverAddress: order.receiver.address,
    receiverBuildingFloor: order.receiver.buildingFloor ?? '',
    receiverMapLink: order.receiver.mapLink ?? '',
    receiverInstructions: order.receiver.instructions ?? '',
    description: order.package.description,
    packageCount: String(order.package.packageCount),
    quantity: order.package.quantity == null ? '' : String(order.package.quantity),
    weightKg: order.package.weightKg ?? '',
    packageNotes: order.package.notes ?? '',
    orderAmount: f.orderAmount,
    deliveryFee: f.deliveryFee,
    prepaidOrderAmount: f.prepaidOrderAmount,
    prepaidDeliveryFee: f.prepaidDeliveryFee,
    prepaidPaymentMethodId: order.prepaidPaymentMethod?.id ?? '',
    collectionPaymentMethodId: order.collectionPaymentMethod?.id ?? '',
  };
}

const trimmedOrNull = (value: string): string | null => {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

function toWholeNumber(value: string): number {
  let n = 0;
  for (const ch of value.trim()) n = n * 10 + (ch.charCodeAt(0) - 48);
  return n;
}

/**
 * Build the PATCH /api/v1/orders/:id body. The full editable field set is sent
 * every time: the backend no-ops an unchanged customer/area and recomputes all
 * derived totals. `null` is used to CLEAR an optional field (empty input);
 * money stays a string end-to-end.
 */
export function toUpdateOrderRequest(
  values: EditOrderFormValues,
): UpdateOrderRequest {
  return {
    customerId: values.customerId,
    paymentType: values.paymentType,

    receiverName: values.receiverName.trim(),
    receiverPhone: values.receiverPhone.trim(),
    receiverAltPhone: trimmedOrNull(values.receiverAltPhone),
    receiverAreaId: values.receiverAreaId,
    receiverAddress: values.receiverAddress.trim(),
    receiverBuildingFloor: trimmedOrNull(values.receiverBuildingFloor),
    receiverMapLink: trimmedOrNull(values.receiverMapLink),
    receiverInstructions: trimmedOrNull(values.receiverInstructions),

    description: values.description.trim(),
    packageCount: toWholeNumber(values.packageCount),
    quantity:
      values.quantity.trim() === '' ? null : toWholeNumber(values.quantity),
    weightKg: values.weightKg.trim() === '' ? null : values.weightKg.trim(),
    packageNotes: trimmedOrNull(values.packageNotes),

    orderAmount: values.orderAmount.trim(),
    deliveryFee: values.deliveryFee.trim(),
    prepaidOrderAmount: values.prepaidOrderAmount.trim() || '0',
    prepaidDeliveryFee: values.prepaidDeliveryFee.trim() || '0',
    prepaidPaymentMethodId: trimmedOrNull(values.prepaidPaymentMethodId),
    collectionPaymentMethodId: trimmedOrNull(values.collectionPaymentMethodId),
  };
}

export const EDIT_ORDER_FIELDS = new Set<keyof EditOrderFormValues>([
  'customerId',
  'paymentType',
  'receiverName',
  'receiverPhone',
  'receiverAltPhone',
  'receiverAreaId',
  'receiverAddress',
  'receiverBuildingFloor',
  'receiverMapLink',
  'receiverInstructions',
  'description',
  'packageCount',
  'quantity',
  'weightKg',
  'packageNotes',
  'orderAmount',
  'deliveryFee',
  'prepaidOrderAmount',
  'prepaidDeliveryFee',
  'prepaidPaymentMethodId',
  'collectionPaymentMethodId',
]);
