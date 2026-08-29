import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "../auth/auth.schema";

export const DRIVER_NUMBER_MAX_LENGTH = 50;
const USER_NAME_MAX_LENGTH = 100;
const USER_EMAIL_MAX_LENGTH = 255;
const USER_PHONE_MAX_LENGTH = 30;

const uuid = z.string().uuid();

export const DriverIdParamSchema = z.object({
  id: uuid,
});

// No documented driver_number generation convention exists anywhere in the
// approved requirements/implementation plan (only "unique driver number" as
// a DB constraint, no format). Consistent with the Phase 5.1 customer_number
// precedent, it is required explicit input rather than an invented format.
const driverNumber = z
  .string()
  .trim()
  .min(1, "Driver number is required")
  .max(DRIVER_NUMBER_MAX_LENGTH, `Driver number must be at most ${DRIVER_NUMBER_MAX_LENGTH} characters`);

// ============================================================
// Create Driver — two modes (Phase 11.7 correction).
//
//   Existing-link mode  { driverNumber, userId }
//     Links a driver profile to an EXISTING user whose DB role is already
//     DRIVER (resolved server-side, never trusted from the client). Kept for
//     backward compatibility.
//
//   New-login mode  { driverNumber, user: { email, password, firstName,
//                     lastName, phone? } }
//     Atomically creates a brand-new DRIVER-role login + driver profile +
//     zero-balance cash account. The role is FORCED to DRIVER server-side;
//     the schema is strict so a caller-supplied roleId / roleCode /
//     permissions / isAdmin is a 400, never silently honoured.
// ============================================================

export const CreateDriverExistingUserSchema = z.object({
  driverNumber,
  userId: uuid,
});

export const CreateDriverNewLoginSchema = z
  .object({
    driverNumber,
    user: z
      .object({
        email: z.string().trim().toLowerCase().email().max(USER_EMAIL_MAX_LENGTH),
        password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
        firstName: z.string().trim().min(1, "First name is required").max(USER_NAME_MAX_LENGTH),
        lastName: z.string().trim().min(1, "Last name is required").max(USER_NAME_MAX_LENGTH),
        phone: z.string().trim().min(1).max(USER_PHONE_MAX_LENGTH).optional(),
      })
      .strict(),
  })
  .strict();

// New-login is tried first so a `{ driverNumber, user: {...} }` body reports
// the new-login field errors; a `{ driverNumber, userId }` body falls through
// to the (non-strict, backward-compatible) existing-link schema.
export const CreateDriverSchema = z.union([CreateDriverNewLoginSchema, CreateDriverExistingUserSchema]);

export type CreateDriverInput = z.infer<typeof CreateDriverSchema>;
export type CreateDriverNewLoginInput = z.infer<typeof CreateDriverNewLoginSchema>;
export type CreateDriverExistingUserInput = z.infer<typeof CreateDriverExistingUserSchema>;

export function isNewLoginCreateInput(input: CreateDriverInput): input is CreateDriverNewLoginInput {
  return "user" in input;
}

// ============================================================
// Update Driver (Phase 11.7 correction).
//
// driver_number and the linked user identity stay immutable. The editable
// set is the driver's operational state (isActive) plus the approved linked
// User PROFILE fields the management page needs (name / email / phone). The
// schema is strict: role / permissions / password / cash / userId /
// driverNumber in the body are a 400, never silently applied.
// ============================================================
export const UpdateDriverSchema = z
  .object({
    isActive: z.boolean().optional(),
    firstName: z.string().trim().min(1).max(USER_NAME_MAX_LENGTH).optional(),
    lastName: z.string().trim().min(1).max(USER_NAME_MAX_LENGTH).optional(),
    email: z.string().trim().toLowerCase().email().max(USER_EMAIL_MAX_LENGTH).optional(),
    phone: z.string().trim().min(1).max(USER_PHONE_MAX_LENGTH).nullable().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateDriverInput = z.infer<typeof UpdateDriverSchema>;

const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

export const ListDriversQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  isActive: booleanQueryParam.optional(),
});

export type ListDriversQuery = z.infer<typeof ListDriversQuerySchema>;

// Shared pagination for the driver-scoped current-orders / delivery-history
// endpoints (Phase 11.7 correction).
export const DriverWorkListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export type DriverWorkListQuery = z.infer<typeof DriverWorkListQuerySchema>;
