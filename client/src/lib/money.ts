/**
 * EXACT-DECIMAL money helpers — shared, display/preview only.
 *
 * Authoritative monetary validation and arithmetic ALWAYS stay server-side.
 * These helpers exist so a form can compare / preview 2-decimal money strings
 * without any JavaScript floating-point:
 *
 *   - `Number()` / `parseFloat` / `parseInt` are never used
 *   - validated <=2-decimal strings are parsed to integer cents as `bigint`
 *   - add / subtract / compare happen in `bigint`
 *   - results are formatted back to a 2-decimal string
 *
 * This is deliberately tiny — not a money library.
 */

const MONEY_RE = /^\d+(?:\.(\d{1,2}))?$/;

/**
 * Parse a plain non-negative decimal string ("100", "100.5", "100.55") to
 * integer cents. Returns `null` for anything that is not a valid <=2-decimal
 * money string (empty string included).
 */
export function parseMoneyToCents(value: string): bigint | null {
  const raw = value.trim();
  const match = MONEY_RE.exec(raw);
  if (!match) return null;

  const [intText, fracText = ''] = raw.split('.');
  const cents = `${fracText}00`.slice(0, 2);
  try {
    return BigInt(intText) * 100n + BigInt(cents);
  } catch {
    return null;
  }
}

/** Format integer cents back to a 2-decimal string ("6000" -> "60.00"). */
export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

/** `a === b` for two money strings, compared as exact cents. */
export function moneyEquals(a: string, b: string): boolean {
  const ca = parseMoneyToCents(a || '0');
  const cb = parseMoneyToCents(b || '0');
  return ca !== null && cb !== null && ca === cb;
}

/** `> 0` for a money string, compared as exact cents (invalid -> false). */
export function moneyIsPositive(value: string): boolean {
  const c = parseMoneyToCents(value || '0');
  return c !== null && c > 0n;
}

/**
 * Exact-cents comparison of two money strings.
 *   -1  a < b
 *    0  a === b
 *    1  a > b
 * `null` when either side is not a valid <=2-decimal money string.
 */
export function compareMoney(a: string, b: string): -1 | 0 | 1 | null {
  const ca = parseMoneyToCents(a);
  const cb = parseMoneyToCents(b);
  if (ca === null || cb === null) return null;
  if (ca < cb) return -1;
  if (ca > cb) return 1;
  return 0;
}

/**
 * `a - b` for two money strings, returned as a 2-decimal string.
 * `null` when either side is invalid. The result may be negative.
 */
export function subtractMoney(a: string, b: string): string | null {
  const ca = parseMoneyToCents(a);
  const cb = parseMoneyToCents(b);
  if (ca === null || cb === null) return null;
  return formatCents(ca - cb);
}

/**
 * `a + b` for two money strings, returned as a 2-decimal string.
 * `null` when either side is invalid. `a` may be signed/negative
 * (backend company-finance strings can be), `b` is a plain magnitude.
 */
export function addMoney(a: string, b: string): string | null {
  const raw = a.trim();
  const neg = raw.startsWith('-');
  const ca = parseMoneyToCents(neg ? raw.slice(1) : raw);
  const cb = parseMoneyToCents(b);
  if (ca === null || cb === null) return null;
  return formatCents((neg ? -ca : ca) + cb);
}
