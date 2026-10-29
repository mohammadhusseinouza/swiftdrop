import type { ChangeEvent, KeyboardEvent } from 'react';
import type { UseFormRegisterReturn } from 'react-hook-form';

/**
 * Receiver phone format (Create / Edit Order primary + alternative phone).
 * Mirrors server/src/shared/phone/phone-format.ts — keep the two in sync. The
 * backend re-validates; this is UX validation only.
 *
 * Policy: an optional single leading "+", then digits, spaces, dots, hyphens
 * and parentheses, with at least one digit; at most 30 characters; no fixed
 * digit count. Arabic-Indic digits are converted to ASCII as they are entered.
 */

export const PHONE_MAX_LENGTH = 30;
export const PHONE_ALLOWED_PATTERN = /^\+?[0-9 ().-]+$/;
const PHONE_CHARACTERS_ONLY = /^\+?[0-9 ().-]*$/;

export const PHONE_CHARACTERS_MESSAGE =
  'Use only digits, spaces, dots, hyphens, parentheses and a leading +';
export const PHONE_DIGIT_REQUIRED_MESSAGE = 'Enter at least one digit';

/** Arabic-Indic (U+0660–0669) and Eastern Arabic-Indic (U+06F0–06F9) digits -> ASCII. */
export function toAsciiDigits(value: string): string {
  return value
    .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/** The validation message for a trimmed phone, or null when it is valid. */
export function phoneFormatIssue(value: string): string | null {
  if (!PHONE_CHARACTERS_ONLY.test(value)) return PHONE_CHARACTERS_MESSAGE;
  if (!/[0-9]/.test(value)) return PHONE_DIGIT_REQUIRED_MESSAGE;
  return PHONE_ALLOWED_PATTERN.test(value) ? null : PHONE_CHARACTERS_MESSAGE;
}

// A single typed character that can ever be part of a phone (position rules,
// e.g. "+" only at the start, are left to validation so editing stays natural).
const TYPEABLE = /^[0-9 ().+\-\u0660-\u0669\u06F0-\u06F9]$/;

/**
 * Wraps a phone input's RHF registration:
 *   - ordinary typing of a character that can never be in a phone (a letter,
 *     "#", "/", …) is blocked;
 *   - Arabic-Indic digits are converted to ASCII as they are entered (typed or
 *     pasted);
 *   - pasted text is otherwise kept AS IS, so an invalid paste shows the
 *     validation error instead of being silently stripped.
 */
export function phoneInput<T extends UseFormRegisterReturn>(registration: T) {
  return {
    ...registration,
    onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => {
      if (
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.nativeEvent.isComposing &&
        !TYPEABLE.test(e.key)
      ) {
        e.preventDefault();
      }
    },
    onChange: (e: ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      const converted = toAsciiDigits(input.value);
      if (converted !== input.value) {
        // Same length (one digit for one digit), so the caret can be restored.
        const { selectionStart, selectionEnd } = input;
        input.value = converted;
        input.setSelectionRange(selectionStart, selectionEnd);
      }
      return registration.onChange(e);
    },
  };
}
