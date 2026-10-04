import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "../auth/auth.schema";

const NAME_MAX_LENGTH = 200;
const PHONE_MAX_LENGTH = 30;
const EMAIL_MAX_LENGTH = 255;
const ADDRESS_MAX_LENGTH = 500;

const uuid = z.string().uuid();

// Customer Portal login password (same rule as Driver new-login). Optional:
// a customer without one has no portal account. The login identifier is the
// customer's own email, so a password requires an email. Never stored on the
// customers row — only a bcrypt hash on the linked users row.
const portalPasswordField = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`);

export const PORTAL_EMAIL_REQUIRED_MESSAGE = "Email is required for portal access — the customer signs in with it";

export const CustomerIdParamSchema = z.object({
  id: uuid,
});

// customer_number is backend-generated (sequential CUST-###### convention,
// see migrations/2026-09-22__5152__customer_driver_sequential_numbers.sql) —
// it is never accepted from the client. A caller-supplied customerNumber is
// simply not a recognized field (this schema is not `.strict()`, matching
// the rest of this file's convention) and is silently ignored.
export const CreateCustomerSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX_LENGTH),
  primaryPhone: z.string().trim().min(1, "Primary phone is required").max(PHONE_MAX_LENGTH),
  secondaryPhone: z.string().trim().min(1).max(PHONE_MAX_LENGTH).optional(),
  email: z.string().trim().toLowerCase().email().max(EMAIL_MAX_LENGTH).optional(),
  defaultAddress: z.string().trim().min(1).max(ADDRESS_MAX_LENGTH).optional(),
  defaultAreaId: uuid.optional(),
  notes: z.string().trim().min(1).optional(),
  portalPassword: portalPasswordField.optional(),
}).superRefine((data, ctx) => {
  if (data.portalPassword !== undefined && !data.email) {
    ctx.addIssue({ code: "custom", path: ["email"], message: PORTAL_EMAIL_REQUIRED_MESSAGE });
  }
});

export type CreateCustomerInput = z.infer<typeof CreateCustomerSchema>;

// customerNumber is treated as immutable after creation, consistent with
// other generated-once business identifiers in this schema (order_number,
// driver_number, employee_number) — none are described as editable.
export const UpdateCustomerSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    primaryPhone: z.string().trim().min(1).max(PHONE_MAX_LENGTH).optional(),
    secondaryPhone: z.string().trim().min(1).max(PHONE_MAX_LENGTH).nullable().optional(),
    email: z.string().trim().toLowerCase().email().max(EMAIL_MAX_LENGTH).nullable().optional(),
    defaultAddress: z.string().trim().min(1).max(ADDRESS_MAX_LENGTH).nullable().optional(),
    defaultAreaId: uuid.nullable().optional(),
    notes: z.string().trim().min(1).nullable().optional(),
    isActive: z.boolean().optional(),
    // No portal account yet -> grants one; existing account -> sets a new
    // password. Omitted -> the current password is left unchanged.
    portalPassword: portalPasswordField.optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateCustomerInput = z.infer<typeof UpdateCustomerSchema>;

const booleanQueryParam = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const ListCustomersQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  isActive: booleanQueryParam.optional(),
  areaId: uuid.optional(),
  hasPortalAccount: booleanQueryParam.optional(),
});

export type ListCustomersQuery = z.infer<typeof ListCustomersQuerySchema>;
