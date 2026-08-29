import { z } from "zod";

const CODE_MAX_LENGTH = 50;
const NAME_MAX_LENGTH = 100;

const uuid = z.string().uuid();

export const PaymentMethodIdParamSchema = z.object({
  id: uuid,
});

// No documented code generation convention exists for payment_methods.code
// (only "unique code" as a DB constraint). Consistent with the customer_number
// / driver_number precedent, it is required explicit input and treated as
// immutable after creation — payment methods may already be referenced by
// financial records (company_financial_transactions, customer_payouts,
// driver_settlements, orders, wallet_transactions), so their identity must
// stay stable.
export const CreatePaymentMethodSchema = z.object({
  code: z.string().trim().min(1, "Code is required").max(CODE_MAX_LENGTH),
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX_LENGTH),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

export type CreatePaymentMethodInput = z.infer<typeof CreatePaymentMethodSchema>;

// code is immutable after creation (see rationale above).
export const UpdatePaymentMethodSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdatePaymentMethodInput = z.infer<typeof UpdatePaymentMethodSchema>;

const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

// This is a small, fixed reference catalog (five seeded rows) — the full
// list is returned rather than forcing pagination, consistent with the
// "small configuration lists" guidance for this phase.
export const ListPaymentMethodsQuerySchema = z.object({
  isActive: booleanQueryParam.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export type ListPaymentMethodsQuery = z.infer<typeof ListPaymentMethodsQuerySchema>;
