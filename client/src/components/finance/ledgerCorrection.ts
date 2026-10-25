import type { FinanceFeedLedger, LedgerName } from '../../services/domain.types';
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

/**
 * Labels for the unified Finance feed, which also lists READ-ONLY direct
 * company collections (never adjustable or reversible).
 */
export const FEED_LEDGER_LABEL: Record<FinanceFeedLedger, string> = {
  ...LEDGER_LABEL,
  DIRECT_COMPANY_COLLECTION: 'Direct company collection',
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
    case 'DIRECT_COMPANY_COLLECTION':
      return 'Direct collection';
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

/* ------------- FR.10 closure: dedicated correction workflows ------------- */

/**
 * Transactions owned by a settlement-based release or an allocation-format
 * settlement can only be corrected through their dedicated workflow; the
 * backend refuses a generic reversal with 409 and an explicit
 * `details.reason`. That backend answer is the ONLY signal used here — never
 * the date, order, payment method, amount or the activation setting (the
 * read DTOs do not yet expose the linkage; see the FR.10 closure report).
 */
export type DedicatedWorkflow = 'RELEASE_CORRECTION' | 'SETTLEMENT_CORRECTION';

export type ReverseRejection =
  | { kind: 'DEDICATED_WORKFLOW'; workflow: DedicatedWorkflow; message: string }
  | { kind: 'ALREADY_REVERSED' }
  | { kind: 'OTHER' };

export function classifyReverseRejection(
  status: number | string | undefined,
  details: unknown,
  message: string,
): ReverseRejection {
  if (status !== 409) return { kind: 'OTHER' };
  const reason =
    details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string'
      ? (details as { reason: string }).reason
      : null;
  if (reason === 'USE_RELEASE_CORRECTION') return { kind: 'DEDICATED_WORKFLOW', workflow: 'RELEASE_CORRECTION', message };
  if (reason === 'USE_SETTLEMENT_CORRECTION') return { kind: 'DEDICATED_WORKFLOW', workflow: 'SETTLEMENT_CORRECTION', message };
  return { kind: 'ALREADY_REVERSED' };
}

export const DEDICATED_WORKFLOW_LABEL: Record<DedicatedWorkflow, string> = {
  RELEASE_CORRECTION: 'Requires financial release correction',
  SETTLEMENT_CORRECTION: 'Requires settlement correction',
};

export type ReverseActionState =
  | { kind: 'REVERSE' }
  | { kind: 'DEDICATED'; label: string }
  | { kind: 'INFO'; label: string }
  | { kind: 'NONE' };

/** FR.10.1 — read-only eligibility the backend attaches to ledger list rows. */
export interface RowCorrectionEligibility {
  correctionWorkflow?: 'GENERIC' | 'RELEASE_CORRECTION' | 'SETTLEMENT_CORRECTION';
  canReverseGenerically?: boolean;
  reversed?: boolean;
}

/**
 * The one rule the desktop table and the mobile card share for a row's
 * reversal control, following the backend's own check order:
 *   no permission / a REVERSAL row          → nothing
 *   a 409 seen this session (stale read)    → the dedicated-workflow explanation
 *   reversed                                → "Already reversed"
 *   RELEASE_ / SETTLEMENT_CORRECTION        → the dedicated-workflow explanation
 *   otherwise not generically reversible    → "Not reversible"
 *   otherwise                               → the generic Reverse
 * Rows from an older API without the eligibility fields keep the previous
 * behaviour (Reverse; the backend decides). The row itself is always shown.
 */
export function reverseActionState(
  tx: { id: string; type: string } & RowCorrectionEligibility,
  opts: { canReverse: boolean; dedicated: ReadonlyMap<string, DedicatedWorkflow> },
): ReverseActionState {
  if (!opts.canReverse || !isReversibleType(tx.type)) return { kind: 'NONE' };
  const seen = opts.dedicated.get(tx.id);
  if (seen) return { kind: 'DEDICATED', label: DEDICATED_WORKFLOW_LABEL[seen] };
  if (tx.canReverseGenerically === undefined) return { kind: 'REVERSE' };
  if (tx.reversed) return { kind: 'INFO', label: 'Already reversed' };
  if (tx.correctionWorkflow === 'RELEASE_CORRECTION' || tx.correctionWorkflow === 'SETTLEMENT_CORRECTION') {
    return { kind: 'DEDICATED', label: DEDICATED_WORKFLOW_LABEL[tx.correctionWorkflow] };
  }
  if (!tx.canReverseGenerically) return { kind: 'INFO', label: 'Not reversible' };
  return { kind: 'REVERSE' };
}
