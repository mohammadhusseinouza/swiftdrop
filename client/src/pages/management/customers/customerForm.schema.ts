import { z } from 'zod';
import type {
  CreateCustomerRequest,
  UpdateCustomerRequest,
} from '../../../services/customersApi';
import type { CustomerDetail } from '../../../services/domain.types';

/**
 * Frontend Customer create/edit validation — mirrors the live backend contract
 * (server/src/modules/customers/customer.schema.ts `CreateCustomerSchema` /
 * `UpdateCustomerSchema`). UX validation only; the backend re-validates.
 *
 * Field notes from the live schema:
 *   - customerNumber is REQUIRED client input on create (no server generation)
 *     and IMMUTABLE — it is not part of the edit form or `UpdateCustomerSchema`.
 *   - isActive is NOT edited through this form — deactivate / reactivate is a
 *     separate confirmed action (`{ isActive }` PATCH).
 *   - email is lowercased + validated as an email by the backend.
 *   - secondaryPhone / email / defaultAddress / notes / defaultAreaId are all
 *     optional; on PATCH, `null` clears them.
 */

const CUSTOMER_NUMBER_MAX = 50;
const NAME_MAX = 200;
const PHONE_MAX = 30;
const EMAIL_MAX = 255;
const ADDRESS_MAX = 500;

const optionalEmail = z
  .string()
  .trim()
  .max(EMAIL_MAX, `At most ${EMAIL_MAX} characters`)
  .email('Enter a valid email address')
  .or(z.literal(''));

const optionalUuid = z.union([z.literal(''), z.uuid()]);

const baseShape = {
  name: z.string().trim().min(1, 'Name is required').max(NAME_MAX),
  primaryPhone: z
    .string()
    .trim()
    .min(1, 'Primary phone is required')
    .max(PHONE_MAX, `At most ${PHONE_MAX} characters`),
  secondaryPhone: z
    .string()
    .trim()
    .max(PHONE_MAX, `At most ${PHONE_MAX} characters`),
  email: optionalEmail,
  defaultAddress: z
    .string()
    .trim()
    .max(ADDRESS_MAX, `At most ${ADDRESS_MAX} characters`),
  defaultAreaId: optionalUuid,
  notes: z.string().trim(),
};

/**
 * One schema / one form type for both create and edit. `customerNumber` is
 * always in the form (pre-filled + shown read-only in edit mode) so a single
 * RHF type covers both; `toUpdateCustomerRequest` simply never sends it, since
 * it is immutable server-side.
 */
export const customerFormSchema = z.object({
  customerNumber: z
    .string()
    .trim()
    .min(1, 'Customer number is required')
    .max(CUSTOMER_NUMBER_MAX, `At most ${CUSTOMER_NUMBER_MAX} characters`),
  ...baseShape,
});

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

export const CUSTOMER_FORM_DEFAULTS: CustomerFormValues = {
  customerNumber: '',
  name: '',
  primaryPhone: '',
  secondaryPhone: '',
  email: '',
  defaultAddress: '',
  defaultAreaId: '',
  notes: '',
};

export function customerToFormValues(
  customer: CustomerDetail,
): CustomerFormValues {
  return {
    customerNumber: customer.customerNumber,
    name: customer.name,
    primaryPhone: customer.primaryPhone,
    secondaryPhone: customer.secondaryPhone ?? '',
    email: customer.email ?? '',
    defaultAddress: customer.defaultAddress ?? '',
    defaultAreaId: customer.area?.id ?? '',
    notes: customer.notes ?? '',
  };
}

const trimmedOrUndefined = (v: string): string | undefined => {
  const t = v.trim();
  return t === '' ? undefined : t;
};
const trimmedOrNull = (v: string): string | null => {
  const t = v.trim();
  return t === '' ? null : t;
};

export function toCreateCustomerRequest(
  values: CustomerFormValues,
): CreateCustomerRequest {
  return {
    customerNumber: values.customerNumber.trim(),
    name: values.name.trim(),
    primaryPhone: values.primaryPhone.trim(),
    secondaryPhone: trimmedOrUndefined(values.secondaryPhone),
    email: trimmedOrUndefined(values.email)?.toLowerCase(),
    defaultAddress: trimmedOrUndefined(values.defaultAddress),
    defaultAreaId: trimmedOrUndefined(values.defaultAreaId),
    notes: trimmedOrUndefined(values.notes),
  };
}

/**
 * Full editable set every time — required fields always sent, optionals sent as
 * `null` to clear. The backend no-ops an unchanged value and `.refine` is
 * satisfied by the always-present name/primaryPhone.
 */
export function toUpdateCustomerRequest(
  values: CustomerFormValues,
): UpdateCustomerRequest {
  return {
    name: values.name.trim(),
    primaryPhone: values.primaryPhone.trim(),
    secondaryPhone: trimmedOrNull(values.secondaryPhone),
    email: trimmedOrNull(values.email)?.toLowerCase() ?? null,
    defaultAddress: trimmedOrNull(values.defaultAddress),
    defaultAreaId: trimmedOrNull(values.defaultAreaId),
    notes: trimmedOrNull(values.notes),
  };
}

export const CUSTOMER_FORM_FIELDS = new Set<string>([
  'customerNumber',
  'name',
  'primaryPhone',
  'secondaryPhone',
  'email',
  'defaultAddress',
  'defaultAreaId',
  'notes',
]);
