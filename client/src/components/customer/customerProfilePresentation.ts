import { getInitials } from '../../lib/initials';

/**
 * Customer Portal Redesign Step 6 — Profile presentation helpers. DISPLAY ONLY.
 */

/**
 * Up to two initials from the profile name (shared getInitials rule), or
 * null when the name is empty — the tile then shows a generic icon instead
 * of "?" letters.
 */
export function getProfileInitials(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  if (trimmed === '') return null;
  return getInitials(trimmed).slice(0, 2);
}

/** True when an optional profile value should render as "—". */
export function isMissingValue(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}
