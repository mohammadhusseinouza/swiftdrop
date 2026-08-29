import { z } from "zod";

const NAME_MAX_LENGTH = 150;

const uuid = z.string().uuid();

export const FailedDeliveryReasonIdParamSchema = z.object({
  id: uuid,
});

export const CreateFailedDeliveryReasonSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX_LENGTH),
  requiresNotes: z.boolean().optional(),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

export type CreateFailedDeliveryReasonInput = z.infer<typeof CreateFailedDeliveryReasonSchema>;

export const UpdateFailedDeliveryReasonSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    requiresNotes: z.boolean().optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateFailedDeliveryReasonInput = z.infer<typeof UpdateFailedDeliveryReasonSchema>;

const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

// Small, fixed reference catalog (eight approved seeded rows) — the full
// list is returned rather than forcing pagination, consistent with the
// "small configuration lists" guidance for this phase.
export const ListFailedDeliveryReasonsQuerySchema = z.object({
  isActive: booleanQueryParam.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

export type ListFailedDeliveryReasonsQuery = z.infer<typeof ListFailedDeliveryReasonsQuerySchema>;
