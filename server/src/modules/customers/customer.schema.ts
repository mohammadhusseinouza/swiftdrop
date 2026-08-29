import { z } from "zod";

export const CUSTOMER_NUMBER_MAX_LENGTH = 50;
const NAME_MAX_LENGTH = 200;
const PHONE_MAX_LENGTH = 30;
const EMAIL_MAX_LENGTH = 255;
const ADDRESS_MAX_LENGTH = 500;

const uuid = z.string().uuid();

export const CustomerIdParamSchema = z.object({
  id: uuid,
});

// No documented customer_number generation convention exists anywhere in
// the approved requirements/implementation plan (only "unique customer
// number" as a constraint, no format). Consistent with the Phase 4.1
// employee_number precedent, it is required explicit input rather than an
// invented format.
export const CreateCustomerSchema = z.object({
  customerNumber: z
    .string()
    .trim()
    .min(1, "Customer number is required")
    .max(CUSTOMER_NUMBER_MAX_LENGTH, `Customer number must be at most ${CUSTOMER_NUMBER_MAX_LENGTH} characters`),
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX_LENGTH),
  primaryPhone: z.string().trim().min(1, "Primary phone is required").max(PHONE_MAX_LENGTH),
  secondaryPhone: z.string().trim().min(1).max(PHONE_MAX_LENGTH).optional(),
  email: z.string().trim().toLowerCase().email().max(EMAIL_MAX_LENGTH).optional(),
  defaultAddress: z.string().trim().min(1).max(ADDRESS_MAX_LENGTH).optional(),
  defaultAreaId: uuid.optional(),
  notes: z.string().trim().min(1).optional(),
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
