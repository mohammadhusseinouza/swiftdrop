import { z } from "zod";

export const DRIVER_NUMBER_MAX_LENGTH = 50;

const uuid = z.string().uuid();

export const DriverIdParamSchema = z.object({
  id: uuid,
});

// No documented driver_number generation convention exists anywhere in the
// approved requirements/implementation plan (only "unique driver number" as
// a DB constraint, no format). Consistent with the Phase 5.1 customer_number
// precedent, it is required explicit input rather than an invented format.
//
// userId links this Driver to an existing authenticated User (drivers.user_id
// is NOT NULL and UNIQUE in the approved schema) — the service must verify
// that user exists, currently has the DRIVER role (resolved from the
// database, never trusted from the client), and is not already linked to
// another driver.
export const CreateDriverSchema = z.object({
  driverNumber: z
    .string()
    .trim()
    .min(1, "Driver number is required")
    .max(DRIVER_NUMBER_MAX_LENGTH, `Driver number must be at most ${DRIVER_NUMBER_MAX_LENGTH} characters`),
  userId: uuid,
});

export type CreateDriverInput = z.infer<typeof CreateDriverSchema>;

// driver_number and the linked user are both treated as immutable after
// creation (reassigning driver identity has authentication/ownership
// implications outside V1 scope). is_active is the only other column the
// approved drivers table has, so it is the only editable field.
export const UpdateDriverSchema = z
  .object({
    isActive: z.boolean().optional(),
  })
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
