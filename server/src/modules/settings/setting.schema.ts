import { z } from "zod";

const KEY_MAX_LENGTH = 150;
const DESCRIPTION_MAX_LENGTH = 500;

export const SettingKeyParamSchema = z.object({
  key: z.string().trim().min(1, "Key is required").max(KEY_MAX_LENGTH),
});

// No approved system_settings key catalog or creation workflow is documented
// in requirements.md / implementation_plan.md, and the live table currently
// has zero rows. Per the Business Rule Gap Rule (CLAUDE.md §62), this phase
// does not invent one — there is intentionally no create/POST schema here.
// Only existing rows (however they come to exist — e.g. a later approved
// seed/migration) may be updated.
export const UpdateSettingSchema = z
  .object({
    value: z.unknown().optional(),
    description: z.string().trim().max(DESCRIPTION_MAX_LENGTH).nullable().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateSettingInput = z.infer<typeof UpdateSettingSchema>;
