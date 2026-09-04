import { z } from 'zod';
import type { CreateOrderRequest } from '../../../../services/ordersApi';
import { parseMoneyToCents } from './createOrderFinancialPreview';

/**
 * Frontend Create Order validation — mirrors the live backend contract
 * (server/src/modules/orders/order-create.schema.ts `OrderCreateFoundationSchema`
 * + order-financial.service.ts `validatePaymentTypeConsistency`).
 *
 * This is UX validation only. The backend re-validates everything, recomputes
 * every monetary total and generates all identifiers/status. Server-owned
 * fields (id, orderNumber, trackingCode, status, financialStatus, the
 * remaining amounts, amountToCollect, currentDriverId, timestamps …) are never
 * part of this schema or the request body.
 *
 * All fields are strings so React Hook Form stays simple; `toCreateOrderRequest`
 * converts to the typed API body (money stays a string end-to-end — no
 * `Number()` / `parseFloat`).
 */

const ORDER_TYPES = ['COMPANY_ORDER', 'DELIVERY_ONLY'] as const;
const PAYMENT_TYPES = ['CASH_ON_DELIVERY', 'ALREADY_PAID', 'PARTIALLY_PAID'] as const;
const PARCEL_INTAKE_METHODS = ['ALREADY_AT_COMPANY', 'DRIVER_COLLECTION'] as const;

// Presentation guard — same shape the backend's Decimal parser accepts
// (non-negative, at most 2 decimal places). Range/precision stay authoritative
// server-side.
const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;
// weight_kg is NUMERIC(10,3) in the approved schema — up to 3 decimal places.
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

export const createOrderSchema = z
  .object({
    customerId: z.string().min(1, 'Select a customer').pipe(z.uuid('Select a customer')),
    orderType: z.enum(ORDER_TYPES),
    paymentType: z.enum(PAYMENT_TYPES),

    // Receiver snapshot (belongs to the order, not the customer).
    receiverName: z.string().trim().min(1, 'Receiver name is required').max(200),
    receiverPhone: z.string().trim().min(1, 'Primary phone is required').max(30),
    receiverAltPhone: z.string().trim().max(30, 'At most 30 characters'),
    receiverAreaId: z.string().min(1, 'Select an area').pipe(z.uuid('Select an area')),
    receiverAddress: z.string().trim().min(1, 'Full address is required').max(500),
    receiverBuildingFloor: z.string().trim().max(200, 'At most 200 characters'),
    receiverMapLink: z.string().trim().max(1000, 'At most 1000 characters'),
    receiverInstructions: z.string().trim(),

    // Package.
    description: z.string().trim().min(1, 'Description is required'),
    packageCount: z
      .string()
      .trim()
      .refine((v) => v === '' || (INT_RE.test(v) && v !== '0'), 'Enter a whole number of 1 or more'),
    quantity: z
      .string()
      .trim()
      .refine((v) => v === '' || INT_RE.test(v), 'Enter a whole number (0 or more)'),
    weightKg: z
      .string()
      .trim()
      .refine((v) => v === '' || WEIGHT_RE.test(v), 'Enter a weight with at most 3 decimals'),
    packageNotes: z.string().trim(),

    // Financial input.
    orderAmount: requiredMoney('Order amount'),
    deliveryFee: requiredMoney('Delivery fee'),
    prepaidOrderAmount: optionalMoney,
    prepaidDeliveryFee: optionalMoney,
    prepaidPaymentMethodId: optionalUuid,
    collectionPaymentMethodId: optionalUuid,

    // ---- Parcel Intake (Phase 11.17.5) ----
    // How the parcel reaches the company. Independent of order type — all four
    // (intake × order type) combinations are valid.
    parcelIntakeMethod: z.enum(PARCEL_INTAKE_METHODS),
    // DRIVER_COLLECTION snapshot (prefilled from the customer, editable per order).
    parcelCollectionContactName: z.string().trim().max(200),
    parcelCollectionPhone: z.string().trim().max(30),
    parcelCollectionAltPhone: z.string().trim().max(30, 'At most 30 characters'),
    parcelCollectionAreaId: optionalUuid,
    parcelCollectionAddress: z.string().trim().max(500),
    parcelCollectionNotes: z.string().trim(),
    // DRIVER_COLLECTION optional collection driver (needs orders.assign).
    parcelCollectionDriverId: optionalUuid,

    // ALREADY_AT_COMPANY optional immediate DELIVERY assignment (needs orders.assign).
    driverId: optionalUuid,
  })
  .superRefine((v, ctx) => {
    /* ---- Parcel Intake combination rules (mirror the backend schema) ---- */
    if (v.parcelIntakeMethod === 'DRIVER_COLLECTION') {
      if (!v.parcelCollectionContactName.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['parcelCollectionContactName'],
          message: 'Collection contact name is required',
        });
      }
      if (!v.parcelCollectionPhone.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['parcelCollectionPhone'],
          message: 'Collection phone is required',
        });
      }
      if (!v.parcelCollectionAddress.trim()) {
        ctx.addIssue({
          code: 'custom',
          path: ['parcelCollectionAddress'],
          message: 'Collection address is required',
        });
      }
      if (!v.parcelCollectionAreaId) {
        ctx.addIssue({
          code: 'custom',
          path: ['parcelCollectionAreaId'],
          message: 'Select a collection area',
        });
      }
      if (v.driverId) {
        ctx.addIssue({
          code: 'custom',
          path: ['driverId'],
          message:
            'A delivery driver cannot be assigned until the parcel is received at the company',
        });
      }
    } else {
      // ALREADY_AT_COMPANY — no collection-specific input is submitted.
      if (v.parcelCollectionDriverId) {
        ctx.addIssue({
          code: 'custom',
          path: ['parcelCollectionDriverId'],
          message:
            'A collection driver cannot be set when the parcel is already at the company',
        });
      }
    }

    const order = parseMoneyToCents(v.orderAmount);
    const fee = parseMoneyToCents(v.deliveryFee);
    const prepaidOrder = parseMoneyToCents(v.prepaidOrderAmount || '0');
    const prepaidFee = parseMoneyToCents(v.prepaidDeliveryFee || '0');
    // Field-level regex issues already cover malformed values.
    if (order === null || fee === null || prepaidOrder === null || prepaidFee === null) {
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

    // Payment-type consistency — mirrors validatePaymentTypeConsistency().
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
    } else {
      // PARTIALLY_PAID
      if (prepaidTotal === 0n) {
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
          message: 'Partially Paid needs a remaining balance — use Already Paid if everything is prepaid',
        });
      }
    }

    // Payment-method presence — mirrors the backend superRefine.
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

export type CreateOrderFormValues = z.infer<typeof createOrderSchema>;

export const CREATE_ORDER_DEFAULTS: CreateOrderFormValues = {
  customerId: '',
  orderType: 'DELIVERY_ONLY',
  paymentType: 'CASH_ON_DELIVERY',
  receiverName: '',
  receiverPhone: '',
  receiverAltPhone: '',
  receiverAreaId: '',
  receiverAddress: '',
  receiverBuildingFloor: '',
  receiverMapLink: '',
  receiverInstructions: '',
  description: '',
  packageCount: '1',
  quantity: '',
  weightKg: '',
  packageNotes: '',
  orderAmount: '',
  deliveryFee: '',
  prepaidOrderAmount: '0.00',
  prepaidDeliveryFee: '0.00',
  prepaidPaymentMethodId: '',
  collectionPaymentMethodId: '',
  parcelIntakeMethod: 'ALREADY_AT_COMPANY',
  parcelCollectionContactName: '',
  parcelCollectionPhone: '',
  parcelCollectionAltPhone: '',
  parcelCollectionAreaId: '',
  parcelCollectionAddress: '',
  parcelCollectionNotes: '',
  parcelCollectionDriverId: '',
  driverId: '',
};

const trimmedOrUndefined = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
};

/**
 * Build the exact POST /api/v1/orders body. The create is ATOMIC (Phase
 * 11.17.4): the collection driver (DRIVER_COLLECTION) and/or the delivery
 * driver (ALREADY_AT_COMPANY) are sent in this same body — never a second
 * request. Money values are passed through as strings; `weightKg` is passed as
 * its validated string and coerced by the backend.
 *
 * Only the fields relevant to the chosen `parcelIntakeMethod` are sent — the
 * backend rejects a collection snapshot / collection driver for
 * ALREADY_AT_COMPANY and a delivery driver for DRIVER_COLLECTION, so switching
 * methods must not leak stale hidden values.
 */
export function toCreateOrderRequest(values: CreateOrderFormValues): CreateOrderRequest {
  const driverCollection = values.parcelIntakeMethod === 'DRIVER_COLLECTION';
  const base: CreateOrderRequest = {
    customerId: values.customerId,
    orderType: values.orderType,
    paymentType: values.paymentType,
    parcelIntakeMethod: values.parcelIntakeMethod,

    receiverName: values.receiverName.trim(),
    receiverPhone: values.receiverPhone.trim(),
    receiverAltPhone: trimmedOrUndefined(values.receiverAltPhone),
    receiverAreaId: values.receiverAreaId,
    receiverAddress: values.receiverAddress.trim(),
    receiverBuildingFloor: trimmedOrUndefined(values.receiverBuildingFloor),
    receiverMapLink: trimmedOrUndefined(values.receiverMapLink),
    receiverInstructions: trimmedOrUndefined(values.receiverInstructions),

    description: values.description.trim(),
    packageCount: values.packageCount.trim() === '' ? undefined : toWholeNumber(values.packageCount),
    quantity: values.quantity.trim() === '' ? undefined : toWholeNumber(values.quantity),
    weightKg: trimmedOrUndefined(values.weightKg),
    packageNotes: trimmedOrUndefined(values.packageNotes),

    orderAmount: values.orderAmount.trim(),
    deliveryFee: values.deliveryFee.trim(),
    prepaidOrderAmount: values.prepaidOrderAmount.trim() || '0',
    prepaidDeliveryFee: values.prepaidDeliveryFee.trim() || '0',
    prepaidPaymentMethodId: trimmedOrUndefined(values.prepaidPaymentMethodId),
    collectionPaymentMethodId: trimmedOrUndefined(values.collectionPaymentMethodId),
  };

  if (driverCollection) {
    return {
      ...base,
      parcelCollectionContactName: trimmedOrUndefined(values.parcelCollectionContactName),
      parcelCollectionPhone: trimmedOrUndefined(values.parcelCollectionPhone),
      parcelCollectionAltPhone: trimmedOrUndefined(values.parcelCollectionAltPhone),
      parcelCollectionAreaId: trimmedOrUndefined(values.parcelCollectionAreaId),
      parcelCollectionAddress: trimmedOrUndefined(values.parcelCollectionAddress),
      parcelCollectionNotes: trimmedOrUndefined(values.parcelCollectionNotes),
      parcelCollectionDriverId: trimmedOrUndefined(values.parcelCollectionDriverId) ?? undefined,
    };
  }

  // ALREADY_AT_COMPANY — only an optional delivery driver ("Create & Assign
  // Delivery"). No collection snapshot / collection driver is sent.
  return {
    ...base,
    deliveryDriverId: trimmedOrUndefined(values.driverId) ?? undefined,
  };
}

// Integer-only conversion for a `/^\d+$/`-validated count — no float path.
function toWholeNumber(value: string): number {
  const digits = value.trim();
  let n = 0;
  for (const ch of digits) n = n * 10 + (ch.charCodeAt(0) - 48);
  return n;
}
