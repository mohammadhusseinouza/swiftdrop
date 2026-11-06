import type { BadgeTone } from '../ui/Badge';
import type {
  CustomerWalletTransactionDirection,
  CustomerWalletTransactionType,
} from '../../services/domain.types';

/**
 * Phase 13.5 — Customer Wallet Transactions presentation. DISPLAY ONLY.
 * Friendly labels for the raw ledger enum; the signed movement and the
 * "Added" / "Deducted" wording come from the server's `direction` (derived
 * from balances), never from the type.
 */

const TYPE_LABEL: Record<CustomerWalletTransactionType, string> = {
  ORDER_CREDIT: 'Order Credit',
  PAYOUT: 'Payout',
  ADJUSTMENT: 'Adjustment',
  REVERSAL: 'Reversal',
};

const TYPE_TONE: Record<CustomerWalletTransactionType, BadgeTone> = {
  ORDER_CREDIT: 'success',
  PAYOUT: 'info',
  ADJUSTMENT: 'warning',
  REVERSAL: 'neutral',
};

export function getWalletTransactionTypeLabel(type: string): string {
  return (TYPE_LABEL as Record<string, string>)[type] ?? 'Transaction';
}

export function getWalletTransactionTypeTone(type: string): BadgeTone {
  return (TYPE_TONE as Record<string, BadgeTone>)[type] ?? 'neutral';
}

export interface DirectionPresentation {
  /** '+', '-' or '' */
  sign: string;
  /** 'Added', 'Deducted' or '' — text carries the meaning, not colour. */
  word: string;
  amountClass: string;
}

export function getDirectionPresentation(
  direction: CustomerWalletTransactionDirection,
): DirectionPresentation {
  if (direction === 'CREDIT') {
    return { sign: '+', word: 'Added', amountClass: 'text-success-700' };
  }
  if (direction === 'DEBIT') {
    return { sign: '-', word: 'Deducted', amountClass: 'text-danger-700' };
  }
  return { sign: '', word: '', amountClass: 'text-ink' };
}

/* ------------------- Customer Portal Redesign Step 5 ------------------- */

/**
 * Transactions table "Description": the server's reference label, falling
 * back to the friendly type label when there is no reference.
 */
export function getTransactionDescription(tx: {
  type: string;
  reference: { label: string } | null;
}): string {
  const label = tx.reference?.label?.trim();
  return label || getWalletTransactionTypeLabel(tx.type);
}

/**
 * Proportional weights for the Wallet "pending" bar — LAYOUT ONLY.
 *
 * The only place `Number()` touches a money string: the two values become
 * flex-grow weights and are never displayed or fed into any calculation. The
 * bar is hidden (null) when the breakdown is missing, either part is
 * unreadable or negative, or both parts are zero.
 */
export function getPendingBarWeights(b: {
  hasBreakdown: boolean;
  pendingDelivery: string | null;
  pendingSettlement: string | null;
}): { delivery: number; settlement: number } | null {
  if (!b.hasBreakdown || b.pendingDelivery == null || b.pendingSettlement == null) return null;
  const MONEY = /^\d+(\.\d+)?$/;
  const d = b.pendingDelivery.trim();
  const s = b.pendingSettlement.trim();
  if (!MONEY.test(d) || !MONEY.test(s)) return null;
  const delivery = Number(d);
  const settlement = Number(s);
  if (!Number.isFinite(delivery) || !Number.isFinite(settlement)) return null;
  if (delivery <= 0 && settlement <= 0) return null;
  return { delivery, settlement };
}

/**
 * One display model per transaction row, shared by the Transactions table
 * (sm and up) and the stacked phone rows (below sm), so description, direction
 * and tone logic exist exactly once. Money is formatted, never computed.
 * Debits are ink, not red — the direction word carries the meaning.
 */
export interface TransactionRowView {
  description: string;
  balanceAfter: string;
  amount: string;
  directionWord: string;
  amountClass: string;
  typeLabel: string;
  typeTone: BadgeTone;
}

export function getTransactionRowView(
  tx: {
    type: string;
    direction: CustomerWalletTransactionDirection;
    amount: string;
    balanceAfter: string;
    reference: { label: string } | null;
  },
  format: (value: string) => string,
): TransactionRowView {
  const dir = getDirectionPresentation(tx.direction);
  return {
    description: getTransactionDescription(tx),
    balanceAfter: `Balance after ${format(tx.balanceAfter)}`,
    amount: `${dir.sign}${format(tx.amount)}`,
    directionWord: dir.word,
    amountClass: tx.direction === 'CREDIT' ? 'text-success-700' : 'text-ink',
    typeLabel: getWalletTransactionTypeLabel(tx.type),
    typeTone: getWalletTransactionTypeTone(tx.type),
  };
}
