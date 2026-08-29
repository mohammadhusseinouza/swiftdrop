/**
 * DISPLAY-ONLY formatting helpers.
 *
 * Authoritative money is ALWAYS a decimal string from the backend. These
 * helpers never do monetary arithmetic and never feed a converted number back
 * into calculation state — they only produce text for the screen.
 */

/** Turn a snake/UPPER enum token into a Title Case label ("FAILED_DELIVERY" -> "Failed Delivery"). */
export function humanizeToken(token: string): string {
  return token
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Format a backend decimal string for display with a currency prefix.
 *
 * Keeps the server's exact digits (pads to 2 decimals, groups the integer part
 * with thousands separators via string ops only). Returns `fallback` for a
 * null / empty / non-numeric input rather than throwing.
 *
 * NOTE: this does string grouping, NOT `Number()` — so "12345678901234.55"
 * round-trips exactly. There is deliberately no `parseFloat` here.
 */
export function formatMoney(
  value: string | null | undefined,
  options: { currency?: string; fallback?: string } = {},
): string {
  const { currency = '$', fallback = '—' } = options;
  if (value == null || value.trim() === '') return fallback;

  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return fallback;

  const [, sign, intPart, fracRaw = ''] = match;
  const frac = (fracRaw + '00').slice(0, 2);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}${currency}${grouped}.${frac}`;
}

/** Format an ISO timestamp for display; returns `fallback` on bad input. */
export function formatDateTime(
  iso: string | null | undefined,
  fallback = '—',
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format an ISO timestamp as a date only. */
export function formatDate(
  iso: string | null | undefined,
  fallback = '—',
): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return fallback;
  return d.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}
