import type { BadgeTone } from '../ui/Badge';
import type { CustomerPayoutStatus } from '../../services/domain.types';

/**
 * Phase 13.6 — Customer Payout History presentation. DISPLAY ONLY.
 * Friendly labels for the raw PayoutStatus enum; the label text carries the
 * meaning (never colour alone). Historical payouts are always shown — a
 * "Reversed" payout still lists, with its current status.
 */

const STATUS_LABEL: Record<CustomerPayoutStatus, string> = {
  COMPLETED: 'Completed',
  REVERSED: 'Reversed',
  CANCELLED: 'Cancelled',
};

const STATUS_TONE: Record<CustomerPayoutStatus, BadgeTone> = {
  COMPLETED: 'success',
  REVERSED: 'neutral',
  CANCELLED: 'neutral',
};

export function getPayoutStatusLabel(status: string): string {
  return (STATUS_LABEL as Record<string, string>)[status] ?? 'Unknown';
}

export function getPayoutStatusTone(status: string): BadgeTone {
  return (STATUS_TONE as Record<string, BadgeTone>)[status] ?? 'neutral';
}
