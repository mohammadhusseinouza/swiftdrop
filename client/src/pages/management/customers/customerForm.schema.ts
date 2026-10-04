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
 *   - customerNumber is BACKEND-GENERATED (sequential CUST-###### convention)
 *     and IMMUTABLE — it is not part of this form at all, on create or edit.
 *     It is displayed read-only on Customer Detail once the record exists.
 *   - isActive is NOT edited through this form — deactivate / reactivate is a
 *     separate confirmed action (`{ isActive }` PATCH).
 *   - email is lowercased + validated as an email by the backend.
 *   - secondaryPhone / email / defaultAddress / notes / defaultAreaId are all
 *     optional; on PATCH, `null` clears them.
 *   - portalPassword (Customer Portal login, same rule as the Driver initial
 *     password) is optional and never prefilled. The customer signs in with
 *     their email, so a password requires an email, and an email cannot be
 *     cleared while a portal account exists. Blank -> sent as omitted, so an
 *     existing password is never changed by an ordinary edit.
 */

const NAME_MAX = 200;
const PHONE_MAX = 30;
const EMAIL_MAX = 255;
const ADDRESS_MAX = 500;
const PASSWORD_MIN = 8;

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
  portalPassword: z
    .string()
    .refine(
      (v) => v === '' || v.length >= PASSWORD_MIN,
      `Password must be at least ${PASSWORD_MIN} characters`,
    ),
};

/**
 * One schema / one form type for both create and edit — customerNumber is
 * never part of it; the backend generates it. `hasPortalAccount` is the
 * customer's current state (false on create).
 */
export function buildCustomerFormSchema(hasPortalAccount: boolean) {
  return z.object({ ...baseShape }).superRefine((values, ctx) => {
    const needsEmail = hasPortalAccount || values.portalPassword !== '';
    if (needsEmail && values.email.trim() === '') {
      ctx.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'Email is required for portal access — the customer signs in with it',
      });
    }
  });
}

export const customerFormSchema = buildCustomerFormSchema(false);

export type CustomerFormValues = z.infer<typeof customerFormSchema>;

export const CUSTOMER_FORM_DEFAULTS: CustomerFormValues = {
  name: '',
  primaryPhone: '',
  secondaryPhone: '',
  email: '',
  defaultAddress: '',
  defaultAreaId: '',
  notes: '',
  portalPassword: '',
};

export function customerToFormValues(
  customer: CustomerDetail,
): CustomerFormValues {
  return {
    name: customer.name,
    primaryPhone: customer.primaryPhone,
    secondaryPhone: customer.secondaryPhone ?? '',
    email: customer.email ?? '',
    defaultAddress: customer.defaultAddress ?? '',
    defaultAreaId: customer.area?.id ?? '',
    notes: customer.notes ?? '',
    // Never prefilled — blank keeps the current password.
    portalPassword: '',
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
    name: values.name.trim(),
    primaryPhone: values.primaryPhone.trim(),
    secondaryPhone: trimmedOrUndefined(values.secondaryPhone),
    email: trimmedOrUndefined(values.email)?.toLowerCase(),
    defaultAddress: trimmedOrUndefined(values.defaultAddress),
    defaultAreaId: trimmedOrUndefined(values.defaultAreaId),
    notes: trimmedOrUndefined(values.notes),
    // Passwords are sent exactly as typed (never trimmed); blank = no portal account.
    portalPassword: values.portalPassword === '' ? undefined : values.portalPassword,
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
    // Blank -> omitted -> the current password (if any) is left unchanged.
    ...(values.portalPassword === ''
      ? {}
      : { portalPassword: values.portalPassword }),
  };
}

export const CUSTOMER_FORM_FIELDS = new Set<string>([
  'name',
  'primaryPhone',
  'secondaryPhone',
  'email',
  'defaultAddress',
  'defaultAreaId',
  'notes',
  'portalPassword',
]);
