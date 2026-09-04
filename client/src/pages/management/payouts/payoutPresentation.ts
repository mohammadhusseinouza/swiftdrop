import type { BadgeTone } from '../../../components/ui/Badge';
import { humanizeToken } from '../../../lib/format';

/**
 * Friendly badge mapping for the REAL persisted payout statuses only
 * (`PayoutStatusSchema` = COMPLETED | REVERSED | CANCELLED). No pending /
 * approval workflow exists in the backend — a payout is stored COMPLETED
 * immediately, or later moved to REVERSED / CANCELLED by an authorized finance
 * correction (Phase 8.8, out of scope here).
 */
export function payoutStatusTone(status: string): BadgeTone {
  switch (status) {
    case 'COMPLETED':
      return 'success';
    case 'REVERSED':
      return 'warning';
    case 'CANCELLED':
      return 'neutral';
    default:
      return 'neutral';
  }
}

export function payoutStatusLabel(status: string): string {
  return humanizeToken(status);
}
