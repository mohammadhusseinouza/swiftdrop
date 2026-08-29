import { z } from 'zod';

/**
 * Frontend login validation — mirrors the backend contract
 * (server/src/modules/auth/auth.schema.ts `LoginInputSchema`):
 *   email: string, trimmed + lower-cased, must be a valid email
 *   password: string, required (min length 1)
 *
 * Deliberately NO password-complexity rule at login time — the backend
 * accepts any existing password regardless of the account-creation policy.
 * The password is never trimmed (a leading/trailing space could be part of it).
 */
export const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .min(1, 'Email is required.')
    .pipe(z.email('Enter a valid email address.')),
  password: z.string().min(1, 'Password is required.'),
});

export type LoginFormValues = z.infer<typeof loginSchema>;
