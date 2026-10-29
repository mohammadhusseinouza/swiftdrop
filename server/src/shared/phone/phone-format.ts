import { z } from "zod";

// Receiver phone FORMAT validation (Create / Edit Order primary + alternative
// receiver phone). Character policy only — no fixed digit count, since
// international numbers vary in length. Kept in sync with the frontend copy
// in client/src/lib/phoneFormat.ts.
//
// Compatible with normalizeReceiverPhone() (receiver-phone.ts): every value
// accepted here is read by the normalizer the same way; the normalizer stays
// wider on purpose so historical phones keep matching.

export const PHONE_MAX_LENGTH = 30;

// After digit conversion: an optional single leading "+", then digits,
// spaces, parentheses, dots and hyphens. Letters of any script and every
// other symbol are rejected; "+" anywhere but the start is rejected.
export const PHONE_ALLOWED_PATTERN = /^\+?[0-9 ().-]+$/;
// Same character set, allowing "nothing after the +", so a bare "+" or "( )"
// reports the missing digit rather than a character problem.
const PHONE_CHARACTERS_ONLY = /^\+?[0-9 ().-]*$/;

export const PHONE_CHARACTERS_MESSAGE =
  "Phone can contain only digits, spaces, dots, hyphens, parentheses and a leading +";
export const PHONE_DIGIT_REQUIRED_MESSAGE = "Phone must contain at least one digit";

/** Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits -> ASCII. */
export function toAsciiDigits(value: string): string {
  return value
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The validation message for a (digit-converted, trimmed) phone, or null when it is valid. */
export function phoneFormatIssue(value: string): string | null {
  if (!PHONE_CHARACTERS_ONLY.test(value)) return PHONE_CHARACTERS_MESSAGE;
  if (!/[0-9]/.test(value)) return PHONE_DIGIT_REQUIRED_MESSAGE;
  // Implied by the two checks above; kept explicit as the documented policy.
  return PHONE_ALLOWED_PATTERN.test(value) ? null : PHONE_CHARACTERS_MESSAGE;
}

/**
 * Zod schema for a receiver phone: trimmed, Arabic-Indic digits converted to
 * ASCII, at most 30 characters, format-checked. Callers add .optional() /
 * .nullable() as their contract needs.
 */
export function receiverPhoneSchema(requiredMessage?: string) {
  return z
    .string()
    .trim()
    .overwrite(toAsciiDigits)
    .min(1, requiredMessage)
    .max(PHONE_MAX_LENGTH)
    .superRefine((value, ctx) => {
      const issue = phoneFormatIssue(value);
      if (issue) ctx.addIssue({ code: "custom", message: issue });
    });
}
