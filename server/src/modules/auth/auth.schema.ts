import { z } from "zod";

// Minimum length is a technical security baseline; no project-specific
// password policy is defined in the requirements yet.
export const MIN_PASSWORD_LENGTH = 8;

// Matches the employees.employee_number column: VARCHAR(50), no documented
// format/prefix convention exists in the approved requirements, so any
// non-empty value up to the column length is accepted as-is.
export const EMPLOYEE_NUMBER_MAX_LENGTH = 50;

export const AdminBootstrapInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().min(1).max(100),
  lastName: z.string().trim().min(1).max(100),
  phone: z
    .string()
    .trim()
    .min(1)
    .max(30)
    .optional(),
  employeeNumber: z
    .string()
    .trim()
    .min(1, "Employee number is required")
    .max(
      EMPLOYEE_NUMBER_MAX_LENGTH,
      `Employee number must be at most ${EMPLOYEE_NUMBER_MAX_LENGTH} characters`
    ),
  password: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

export type AdminBootstrapInput = z.infer<typeof AdminBootstrapInputSchema>;

// Login must accept any existing valid password, even one that would fail
// the current account-creation minimum-length rule — only presence/shape
// is validated here.
export const LoginInputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1, "Password is required"),
});

export type LoginInput = z.infer<typeof LoginInputSchema>;
