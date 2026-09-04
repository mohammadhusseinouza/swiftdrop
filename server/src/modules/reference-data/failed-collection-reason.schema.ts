import { z } from "zod";

// Mirrors failed-delivery-reason.schema.ts exactly — a separate, small,
// configurable catalog for FAILED parcel-collection attempts. NEVER merged
// with failed_delivery_reasons.

const NAME_MAX_LENGTH = 150;

const uuid = z.string().uuid();

export const FailedCollectionReasonIdParamSchema = z.object({
  id: uuid,
});

export const CreateFailedCollectionReasonSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX_LENGTH),
  requiresNotes: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});
export type CreateFailedCollectionReasonInput = z.infer<typeof CreateFailedCollectionReasonSchema>;

export const UpdateFailedCollectionReasonSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    requiresNotes: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });
export type UpdateFailedCollectionReasonInput = z.infer<typeof UpdateFailedCollectionReasonSchema>;

const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

export const ListFailedCollectionReasonsQuerySchema = z.object({
  isActive: booleanQueryParam.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});
export type ListFailedCollectionReasonsQuery = z.infer<typeof ListFailedCollectionReasonsQuerySchema>;
