import { compareMoney } from '../../lib/money';
import type { BadgeTone } from '../ui/Badge';

/**
 * Phase 12.5 — Driver "My Cash" presentation helpers. DISPLAY ONLY.
 *
 * IMPORTANT (task §41): `DriverCashTransactionType.COLLECTION` means MONEY
 * collected from a Delivery — it is NOT Parcel Collection. The Driver-facing
 * label must never read "Parcel Collection".
 */
interface CashTypePresentation {
  label: string;
  tone: BadgeTone;
}

const CASH_TYPE: Record<string, CashTypePresentation> = {
  COLLECTION: { label: 'Cash Collected', tone: 'info' },
  SETTLEMENT: { label: 'Settlement', tone: 'brand' },
  ADJUSTMENT: { label: 'Adjustment', tone: 'warning' },
  REVERSAL: { label: 'Reversal', tone: 'neutral' },
};

const UNKNOWN_CASH_TYPE: CashTypePresentation = { label: 'Activity', tone: 'neutral' };

export function getCashTypePresentation(type: string): CashTypePresentation {
  return CASH_TYPE[type] ?? UNKNOWN_CASH_TYPE;
}

export type CashDirection = 'CREDIT' | 'DEBIT' | 'NONE';

/**
 * Direction from the exact balance movement — never JS floating point
 * (task §42). `balanceAfter > balanceBefore` -> CREDIT; `<` -> DEBIT; equal
 * (or an unparseable pair) -> NONE. This is authoritative for every type,
 * including ADJUSTMENT / REVERSAL where the direction is not known from the
 * type alone.
 */
export function cashDirection(balanceBefore: string, balanceAfter: string): CashDirection {
  const cmp = compareMoney(balanceAfter, balanceBefore);
  if (cmp === null || cmp === 0) return 'NONE';
  return cmp > 0 ? 'CREDIT' : 'DEBIT';
}

/** "+" / "−" / "" sign prefix for a direction. */
export function cashSignPrefix(direction: CashDirection): string {
  if (direction === 'CREDIT') return '+';
  if (direction === 'DEBIT') return '−';
  return '';
}
