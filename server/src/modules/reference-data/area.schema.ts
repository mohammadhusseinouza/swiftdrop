import { z } from "zod";

const NAME_MAX_LENGTH = 150;

const uuid = z.string().uuid();

export const AreaIdParamSchema = z.object({
  id: uuid,
});

export const CreateAreaSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(NAME_MAX_LENGTH),
  sortOrder: z.coerce.number().int().min(0).optional(),
});

export type CreateAreaInput = z.infer<typeof CreateAreaSchema>;

export const UpdateAreaSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX_LENGTH).optional(),
    sortOrder: z.coerce.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateAreaInput = z.infer<typeof UpdateAreaSchema>;

const booleanQueryParam = z.enum(["true", "false"]).transform((value) => value === "true");

export const ListAreasQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  isActive: booleanQueryParam.optional(),
});

export type ListAreasQuery = z.infer<typeof ListAreasQuerySchema>;
