import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "../auth/auth.schema";

// ============================================================
// Employee Management (Phase 11.14)
//
// An Employee is a User + Employee(employee_number) linked pair whose User
// carries a MANAGEMENT role (ADMIN / DISPATCHER / FINANCE). Permissions are
// inherited through the role's role_permissions — there is no per-user /
// per-employee permission override model (see prisma/schema.prisma), and
// this module never invents one.
// ============================================================

export const MANAGEMENT_ROLE_CODES = ["ADMIN", "DISPATCHER", "FINANCE"] as const;
export type ManagementRoleCode = (typeof MANAGEMENT_ROLE_CODES)[number];

const EMPLOYEE_NUMBER_MAX_LENGTH = 50;
const USER_NAME_MAX_LENGTH = 100;
const USER_EMAIL_MAX_LENGTH = 255;
const USER_PHONE_MAX_LENGTH = 30;

const uuid = z.string().uuid();
const booleanQueryParam = z.enum(["true", "false"]).transform((v) => v === "true");

export const EmployeeIdParamSchema = z.object({ id: uuid });

// No documented employee_number format exists in the approved requirements
// (only "unique, VARCHAR(50)") — consistent with the customer_number /
// driver_number precedent it is required explicit input, never generated.
const employeeNumber = z
  .string()
  .trim()
  .min(1, "Employee number is required")
  .max(EMPLOYEE_NUMBER_MAX_LENGTH, `Employee number must be at most ${EMPLOYEE_NUMBER_MAX_LENGTH} characters`);

// POST /api/v1/employees — always creates a BRAND-NEW User + Employee. There
// is deliberately no "link an existing user" mode (that would risk a
// Driver/Customer user acquiring a management identity). `roleId` must
// resolve to a MANAGEMENT role server-side; the schema is strict so a
// caller-supplied roleCode / permissions / isAdmin is a 400.
export const CreateEmployeeSchema = z
  .object({
    employeeNumber,
    roleId: uuid,
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

export type CreateEmployeeInput = z.infer<typeof CreateEmployeeSchema>;

// PATCH /api/v1/employees/:id. employee_number and the linked user identity
// (id) stay immutable. Editable: linked-User profile fields + roleId + the
// account's isActive. Strict — password / passwordHash / userId /
// employeeNumber / permissions in the body are a 400.
export const UpdateEmployeeSchema = z
  .object({
    firstName: z.string().trim().min(1).max(USER_NAME_MAX_LENGTH).optional(),
    lastName: z.string().trim().min(1).max(USER_NAME_MAX_LENGTH).optional(),
    email: z.string().trim().toLowerCase().email().max(USER_EMAIL_MAX_LENGTH).optional(),
    phone: z.string().trim().min(1).max(USER_PHONE_MAX_LENGTH).nullable().optional(),
    roleId: uuid.optional(),
    isActive: z.boolean().optional(),
  })
  .strict()
  .refine((data) => Object.keys(data).length > 0, { message: "At least one field must be provided" });

export type UpdateEmployeeInput = z.infer<typeof UpdateEmployeeSchema>;

export const ListEmployeesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional().default(1),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  search: z.string().trim().min(1).max(200).optional(),
  roleId: uuid.optional(),
  isActive: booleanQueryParam.optional(),
});

export type ListEmployeesQuery = z.infer<typeof ListEmployeesQuerySchema>;
