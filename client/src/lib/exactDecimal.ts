/**
 * EXACT arbitrary-scale decimal helpers — preview/display only.
 *
 * Driver Expenses values (cost per km, estimated expense) carry up to 10
 * decimal places, beyond the 2-decimal `lib/money.ts` cents helpers. A value
 * is held as an integer mantissa (`bigint`) plus a decimal scale, so add and
 * multiply are exact. `Number()` / `parseFloat` are never used.
 *
 * The backend stays authoritative for every saved figure; these helpers only
 * mirror its formula for live previews and sum server-provided exact strings.
 */

export interface ExactDecimal {
  /** value = mantissa / 10^scale */
  mantissa: bigint;
  scale: number;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

export function parseExactDecimal(value: string): ExactDecimal | null {
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) return null;
  const [, sign, intPart, frac = ''] = match;
  const mantissa = BigInt(`${intPart}${frac}`);
  return { mantissa: sign ? -mantissa : mantissa, scale: frac.length };
}

function pow10(n: number): bigint {
  return 10n ** BigInt(n);
}

function align(a: ExactDecimal, b: ExactDecimal): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [a.mantissa * pow10(scale - a.scale), b.mantissa * pow10(scale - b.scale), scale];
}

export function addExact(a: ExactDecimal, b: ExactDecimal): ExactDecimal {
  const [x, y, scale] = align(a, b);
  return { mantissa: x + y, scale };
}

export function multiplyExact(...values: ExactDecimal[]): ExactDecimal {
  return values.reduce(
    (acc, v) => ({ mantissa: acc.mantissa * v.mantissa, scale: acc.scale + v.scale }),
    { mantissa: 1n, scale: 0 },
  );
}

/** Exact text with no trailing zeros and no exponent ("1.6147875", "0"). */
export function formatExactDecimal(value: ExactDecimal): string {
  const negative = value.mantissa < 0n;
  const digits = (negative ? -value.mantissa : value.mantissa).toString().padStart(value.scale + 1, '0');
  const intPart = digits.slice(0, digits.length - value.scale);
  const frac = value.scale > 0 ? digits.slice(digits.length - value.scale).replace(/0+$/, '') : '';
  const text = frac ? `${intPart}.${frac}` : intPart;
  return negative && /[1-9]/.test(text) ? `-${text}` : text;
}

/**
 * Round half away from zero to `places` decimals, as fixed text ("1.61",
 * "0.00"). Display rounding only — never fed back into a calculation.
 */
export function roundExactToFixed(value: ExactDecimal, places: number): string {
  let mantissa = value.mantissa;
  let scale = value.scale;
  if (scale > places) {
    const divisor = pow10(scale - places);
    const negative = mantissa < 0n;
    const abs = negative ? -mantissa : mantissa;
    let q = abs / divisor;
    if ((abs % divisor) * 2n >= divisor) q += 1n;
    mantissa = negative ? -q : q;
    scale = places;
  }
  mantissa *= pow10(places - scale);
  const negative = mantissa < 0n;
  const digits = (negative ? -mantissa : mantissa).toString().padStart(places + 1, '0');
  const intPart = digits.slice(0, digits.length - places);
  const frac = places > 0 ? `.${digits.slice(digits.length - places)}` : '';
  return `${negative && mantissa !== 0n ? '-' : ''}${intPart}${frac}`;
}

/** Sum exact decimal strings; null if any value is not a decimal. */
export function sumExactStrings(values: readonly string[]): ExactDecimal | null {
  let total: ExactDecimal = { mantissa: 0n, scale: 0 };
  for (const v of values) {
    const parsed = parseExactDecimal(v);
    if (!parsed) return null;
    total = addExact(total, parsed);
  }
  return total;
}
