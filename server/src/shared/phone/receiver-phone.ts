// Receiver phone normalization — used ONLY to identify a saved Customer
// Receiver (customer_receivers: customer_id + normalized_phone). The phone
// the employee typed is never rewritten: orders.receiver_phone and
// customer_receivers.phone keep the original text.
//
// Output is an E.164-style string ("+<country><number>") or null. null means
// "cannot be identified safely" — the caller must then skip receiver memory
// for that phone, never guess a match.
//
// Rules:
//   * Surrounding whitespace and common formatting characters (spaces,
//     hyphens, dots, parentheses, slashes) are ignored; Arabic-Indic digits
//     are read as ASCII digits.
//   * "+" or "00" marks an international number. The country code is kept.
//     +961 numbers are validated as Lebanese (an optional trunk "0" after the
//     country code is dropped: "+961 03 123456" = "+961 3 123456").
//   * Without "+" / "00", only valid Lebanese representations are accepted:
//     a 7-digit number with trunk "0" ("03 123456", "01 234567"), an 8-digit
//     mobile ("70 123456", optionally "070 123456"), or the country code
//     without the plus ("961 3 123456"). Any other local-looking number has no
//     known country and is rejected rather than assumed Lebanese.
//   * Anything else (letters, extensions, stray "+", too short / too long) -> null.
//
// Intentionally WIDER than the input format rule (phone-format.ts): it also
// reads "/" and non-breaking spaces so phones saved before that rule existed
// keep matching. Everything the format rule accepts normalizes the same way.

import { toAsciiDigits } from "./phone-format";

const FORMATTING_CHARS = /[\s\-.()/\u00A0]/g;
const LEBANON_COUNTRY_CODE = "961";

// Lebanese national significant numbers: 7 digits for landlines and the
// legacy 03 mobile range (leading 1, 3-9 — never 0 or 2), 8 digits for the
// 7x / 8x mobile ranges.
const LEBANESE_NSN_7 = /^[13-9]\d{6}$/;
const LEBANESE_NSN_8 = /^[78]\d{7}$/;

// E.164: at most 15 digits including the country code. 8 is a conservative
// lower bound that still admits short-numbered countries.
const INTERNATIONAL_MIN_DIGITS = 8;
const INTERNATIONAL_MAX_DIGITS = 15;

function isLebaneseNsn(nsn: string): boolean {
  return LEBANESE_NSN_7.test(nsn) || LEBANESE_NSN_8.test(nsn);
}

/** National number written after +961 / 961 (a single trunk "0" is tolerated after "+961"). */
function lebaneseFromCountryCode(rest: string, allowTrunkZero: boolean): string | null {
  const nsn = allowTrunkZero && rest.startsWith("0") ? rest.slice(1) : rest;
  return isLebaneseNsn(nsn) ? `+${LEBANON_COUNTRY_CODE}${nsn}` : null;
}

/** A number written without any country prefix — accepted only when it is unambiguously Lebanese. */
function lebaneseFromLocal(digits: string): string | null {
  if (digits.startsWith("0")) {
    const nsn = digits.slice(1);
    return isLebaneseNsn(nsn) ? `+${LEBANON_COUNTRY_CODE}${nsn}` : null;
  }
  if (LEBANESE_NSN_8.test(digits)) return `+${LEBANON_COUNTRY_CODE}${digits}`;
  return null;
}

export function normalizeReceiverPhone(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const compact = toAsciiDigits(raw.trim()).replace(FORMATTING_CHARS, "");
  if (compact === "") return null;

  let digits: string;
  let international: boolean;
  if (compact.startsWith("+")) {
    digits = compact.slice(1);
    international = true;
  } else if (compact.startsWith("00")) {
    digits = compact.slice(2);
    international = true;
  } else {
    digits = compact;
    international = false;
  }

  if (!/^\d+$/.test(digits)) return null;

  if (international) {
    if (digits.startsWith(LEBANON_COUNTRY_CODE)) {
      return lebaneseFromCountryCode(digits.slice(LEBANON_COUNTRY_CODE.length), true);
    }
    if (digits.startsWith("0")) return null;
    if (digits.length < INTERNATIONAL_MIN_DIGITS || digits.length > INTERNATIONAL_MAX_DIGITS) return null;
    return `+${digits}`;
  }

  if (digits.startsWith(LEBANON_COUNTRY_CODE)) {
    return lebaneseFromCountryCode(digits.slice(LEBANON_COUNTRY_CODE.length), false);
  }
  return lebaneseFromLocal(digits);
}

/**
 * Digits usable for a partial phone search against normalized_phone: the
 * typed digits without leading zeros (so "03 12" finds "+9613123456").
 * Returns null when too few digits remain to be a meaningful phone search.
 */
export function receiverPhoneSearchDigits(term: string): string | null {
  const digits = toAsciiDigits(term).replace(/\D/g, "").replace(/^0+/, "");
  return digits.length >= 3 ? digits : null;
}
