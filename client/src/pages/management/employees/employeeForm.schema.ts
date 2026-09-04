import { z } from 'zod';

import type {
  CreateEmployeeRequest,
  UpdateEmployeeRequest,
} from '../../../services/employeesApi';

/**
 * Mirrors the live backend contract
 * (server/src/modules/employees/employee.schema.ts). `confirmPassword` is
 * FRONTEND-ONLY and is never sent. The backend re-validates everything and
 * re-resolves permissions from the role.
 */

const MIN_PASSWORD_LENGTH = 8; // matches auth.schema.ts MIN_PASSWORD_LENGTH

const email = z.string().trim().toLowerCase().email('Enter a valid email').max(255);
const name = (label: string) =>
  z.string().trim().min(1, `${label} is required`).max(100);
const phone = z.string().trim().max(30, 'At most 30 characters');

export const employeeCreateSchema = z
  .object({
    employeeNumber: z
      .string()
      .trim()
      .min(1, 'Employee number is required')
      .max(50, 'At most 50 characters'),
    roleId: z.string().min(1, 'Select a role').pipe(z.uuid('Select a role')),
    firstName: name('First name'),
    lastName: name('Last name'),
    email,
    phone,
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`),
    confirmPassword: z.string().min(1, 'Confirm the password'),
  })
  .refine((v) => v.password === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export type EmployeeCreateValues = z.infer<typeof employeeCreateSchema>;

export const EMPLOYEE_CREATE_DEFAULTS: EmployeeCreateValues = {
  employeeNumber: '',
  roleId: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  password: '',
  confirmPassword: '',
};

export const employeeEditSchema = z
  .object({
    roleId: z.string().min(1, 'Select a role').pipe(z.uuid('Select a role')),
    firstName: name('First name'),
    lastName: name('Last name'),
    email,
    phone,
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: 'Nothing to update',
  });

export type EmployeeEditValues = z.infer<typeof employeeEditSchema>;

export function toCreateEmployeeRequest(
  v: EmployeeCreateValues,
): CreateEmployeeRequest {
  return {
    employeeNumber: v.employeeNumber.trim(),
    roleId: v.roleId,
    user: {
      email: v.email.trim().toLowerCase(),
      password: v.password,
      firstName: v.firstName.trim(),
      lastName: v.lastName.trim(),
      ...(v.phone.trim() === '' ? {} : { phone: v.phone.trim() }),
    },
  };
}

/** Only the fields that actually changed from the current record. */
export function toUpdateEmployeeRequest(
  v: EmployeeEditValues,
  current: {
    firstName: string;
    lastName: string;
    email: string;
    phone: string | null;
    roleId: string;
  },
): UpdateEmployeeRequest {
  const body: UpdateEmployeeRequest = {};
  if (v.firstName.trim() !== current.firstName) body.firstName = v.firstName.trim();
  if (v.lastName.trim() !== current.lastName) body.lastName = v.lastName.trim();
  const nextEmail = v.email.trim().toLowerCase();
  if (nextEmail !== current.email) body.email = nextEmail;
  const nextPhone = v.phone.trim() === '' ? null : v.phone.trim();
  if (nextPhone !== current.phone) body.phone = nextPhone;
  if (v.roleId !== current.roleId) body.roleId = v.roleId;
  return body;
}

export const EMPLOYEE_FORM_FIELDS = new Set<string>([
  'employeeNumber',
  'roleId',
  'firstName',
  'lastName',
  'email',
  'phone',
  'password',
]);
