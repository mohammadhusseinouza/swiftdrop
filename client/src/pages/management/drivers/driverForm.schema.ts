import { z } from 'zod';
import type {
  CreateDriverNewLoginRequest,
  UpdateDriverRequest,
} from '../../../services/driversApi';
import type { DriverDetail } from '../../../services/domain.types';

/**
 * Frontend Driver create/edit validation — mirrors the live backend contract
 * (server/src/modules/drivers/driver.schema.ts). UX validation only; the
 * backend re-validates and is the security boundary.
 *
 *   Create uses NEW-LOGIN mode only: `{ driverNumber, user: { email,
 *   password, firstName, lastName, phone? } }`. No role selector, no
 *   permissions — the backend FORCES role = DRIVER.
 *
 *   Edit manages `driverNumber` is immutable and absent from the edit form;
 *   the editable set is the linked User profile (firstName / lastName /
 *   email / phone). isActive is a separate confirmed deactivate/reactivate
 *   action, never this form.
 */

const DRIVER_NUMBER_MAX = 50;
const NAME_MAX = 100;
const EMAIL_MAX = 255;
const PHONE_MAX = 30;
const PASSWORD_MIN = 8;

const nameField = (label: string) =>
  z.string().trim().min(1, `${label} is required`).max(NAME_MAX, `At most ${NAME_MAX} characters`);
const emailField = z
  .string()
  .trim()
  .min(1, 'Email is required')
  .max(EMAIL_MAX, `At most ${EMAIL_MAX} characters`)
  .email('Enter a valid email address');
const phoneField = z.string().trim().max(PHONE_MAX, `At most ${PHONE_MAX} characters`);

export const driverCreateSchema = z.object({
  driverNumber: z
    .string()
    .trim()
    .min(1, 'Driver number is required')
    .max(DRIVER_NUMBER_MAX, `At most ${DRIVER_NUMBER_MAX} characters`),
  firstName: nameField('First name'),
  lastName: nameField('Last name'),
  email: emailField,
  phone: phoneField,
  password: z
    .string()
    .min(PASSWORD_MIN, `Password must be at least ${PASSWORD_MIN} characters`),
});
export type DriverCreateValues = z.infer<typeof driverCreateSchema>;

export const DRIVER_CREATE_DEFAULTS: DriverCreateValues = {
  driverNumber: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  password: '',
};

export const driverEditSchema = z.object({
  firstName: nameField('First name'),
  lastName: nameField('Last name'),
  email: emailField,
  phone: phoneField,
});
export type DriverEditValues = z.infer<typeof driverEditSchema>;

export function driverToEditValues(driver: DriverDetail): DriverEditValues {
  return {
    firstName: driver.user.firstName,
    lastName: driver.user.lastName,
    email: driver.user.email,
    phone: driver.user.phone ?? '',
  };
}

const trimmedOrUndefined = (v: string): string | undefined => {
  const t = v.trim();
  return t === '' ? undefined : t;
};

export function toCreateDriverRequest(
  values: DriverCreateValues,
): CreateDriverNewLoginRequest {
  return {
    driverNumber: values.driverNumber.trim(),
    user: {
      email: values.email.trim().toLowerCase(),
      password: values.password,
      firstName: values.firstName.trim(),
      lastName: values.lastName.trim(),
      phone: trimmedOrUndefined(values.phone),
    },
  };
}

export function toUpdateDriverRequest(
  values: DriverEditValues,
): UpdateDriverRequest {
  return {
    firstName: values.firstName.trim(),
    lastName: values.lastName.trim(),
    email: values.email.trim().toLowerCase(),
    // empty -> null clears the optional phone column server-side
    phone: values.phone.trim() === '' ? null : values.phone.trim(),
  };
}

export const DRIVER_CREATE_FIELDS = new Set<string>([
  'driverNumber',
  'firstName',
  'lastName',
  'email',
  'phone',
  'password',
]);
export const DRIVER_EDIT_FIELDS = new Set<string>([
  'firstName',
  'lastName',
  'email',
  'phone',
]);
