import { z } from "zod";
import { dateOnlySchema, fromNotAfterTo } from "../../shared/date/date-range.schema";

// action/entityType/entityId are all VarChar(100) in the approved schema —
// trimmed, non-empty, bounded to that same length. entityId is deliberately
// NOT required to be a UUID (different audited entities may use different
// identifier formats — CLAUDE.md/Phase 9.4 contract). No canonical case
// normalization is applied: production audit writers always store the exact
// literal action/entityType strings they define, so exact matching is safer
// than guessing a normalization rule.
const boundedString = (max: number) => z.string().trim().min(1).max(max);

// GET /api/v1/audit-logs — every filter is optional and independently
// combinable (AND semantics, never OR). actorId filters the real UUID
// actor_user_id column, so IS validated as a UUID shape here — but a
// syntactically valid UUID that doesn't correspond to any User must still
// return an empty result set (enforced in audit-read.service.ts), never a
// 404: this is a search filter, not a User-detail lookup.
export const ListAuditLogsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).optional().default(1),
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
    actorId: z.string().uuid().optional(),
    action: boundedString(100).optional(),
    entityType: boundedString(100).optional(),
    entityId: boundedString(100).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
  })
  .refine(fromNotAfterTo, { message: "from must be on or before to", path: ["to"] });

export type ListAuditLogsQuery = z.infer<typeof ListAuditLogsQuerySchema>;
