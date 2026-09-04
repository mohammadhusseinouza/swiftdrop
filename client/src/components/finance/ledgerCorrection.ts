import type { LedgerName } from '../../services/domain.types';
import { humanizeToken } from '../../lib/format';

/**
 * Shared presentation for the three-ledger correction UI (Phase 11.12).
 *
 * NON-NEGOTIABLE: Customer Wallet != Driver Cash != Company Finance. These
 * helpers only label; they never move money and never mix ledgers.
 */

export const LEDGER_LABEL: Record<LedgerName, string> = {
  WALLET: 'Customer wallet',
  DRIVER_CASH: 'Driver cash',
  COMPANY_FINANCE: 'Company finance',
};

/** What a manual ADJUSTMENT to this ledger means, in plain terms. */
export const LEDGER_ADJUST_EFFECT: Record<LedgerName, string> = {
  WALLET:
    'Changes the customer’s AVAILABLE wallet balance. Pending is not touched.',
  DRIVER_CASH: 'Changes the cash this driver is recorded as holding.',
  COMPANY_FINANCE:
    'Posts a signed company-finance row. Company Finance has no running balance.',
};

export function ledgerTypeLabel(type: string): string {
  switch (type) {
    case 'ORDER_CREDIT':
      return 'Order credit';
    case 'PAYOUT':
      return 'Payout';
    case 'COLLECTION':
      return 'Collection';
    case 'SETTLEMENT':
      return 'Settlement';
    case 'DELIVERY_FEE_REVENUE':
      return 'Delivery fee revenue';
    case 'COMPANY_ORDER_PRODUCT_REVENUE':
      return 'Company order revenue';
    case 'ADJUSTMENT':
      return 'Adjustment';
    case 'REVERSAL':
      return 'Reversal';
    default:
      return humanizeToken(type);
  }
}

/**
 * A non-REVERSAL row is the only kind the frontend offers a "Reverse" action
 * for. Whether it has ALREADY been reversed is NOT knowable from the read
 * DTOs — the backend enforces exactly-once and returns 409, which the dialog
 * surfaces as "already reversed". Never scan a paginated page to guess.
 */
export function isReversibleType(type: string): boolean {
  return type !== 'REVERSAL';
}
