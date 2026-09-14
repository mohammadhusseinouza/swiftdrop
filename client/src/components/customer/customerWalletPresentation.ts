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
