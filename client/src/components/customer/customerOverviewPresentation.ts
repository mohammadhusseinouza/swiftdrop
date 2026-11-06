import { formatDate, formatMoney } from '../../lib/format';
import { moneyIsPositive } from '../../lib/money';
import { getPayoutStatusLabel } from './customerPayoutPresentation';
import type { CustomerPayoutSummary } from '../../services/domain.types';

/**
 * Customer Portal Redesign Step 2 — Overview presentation helpers.
 * DISPLAY ONLY; pure, so they are unit-tested. No money arithmetic.
 */

/** Time-of-day greeting from the viewer's local clock. */
export function getGreeting(now: Date): string {
  const h = now.getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

/** "Good evening, Nour." from the customer name's first token; "Welcome back." when blank. */
export function getOverviewTitle(customerName: string | null | undefined, now: Date): string {
  const first = (customerName ?? '').trim().split(/\s+/)[0];
  return first ? `${getGreeting(now)}, ${first}.` : 'Welcome back.';
}

/** Eyebrow date — weekday + day + month in the viewer's locale ("Friday, 6 November"). */
export function formatOverviewDate(now: Date): string {
  return now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
}

/**
 * "Ready for payout" chip rule: shown only when the available balance is
 * strictly greater than zero. Exact cents via lib/money (bigint) — never a
 * float comparison. An unparseable value hides the chip.
 */
export function isReadyForPayout(availableBalance: string | null | undefined): boolean {
  return availableBalance != null && moneyIsPositive(availableBalance);
}

export interface LastPayoutPresentation {
  amount: string;
  /** "6 Nov 2026 · Bank transfer", plus the status word when not Completed. */
  detail: string;
}

/**
 * The newest payout record (page 1, limit 1 — decision D3-A), or null when the
 * customer has none. A Reversed / Cancelled newest payout is still shown, with
 * its status in text, so the line never implies money was paid when it was not.
 */
export function getLastPayoutPresentation(
  payout: CustomerPayoutSummary | undefined,
): LastPayoutPresentation | null {
  if (!payout) return null;
  const parts = [formatDate(payout.createdAt), payout.paymentMethod.name];
  const status = getPayoutStatusSuffix(payout);
  if (status) parts.push(status);
  return { amount: formatMoney(payout.amount), detail: parts.filter(Boolean).join(' · ') };
}

/** The shared "Latest payout" status rule: the status word, unless Completed. */
function getPayoutStatusSuffix(payout: CustomerPayoutSummary): string | null {
  return payout.status === 'COMPLETED' ? null : getPayoutStatusLabel(payout.status);
}

/**
 * Wallet hero chip (handoff §3.4): "Latest payout · $X on <date>", with the
 * same status-word rule as the Overview ("… · Reversed"). Null when none.
 */
export function getLatestPayoutChipText(payout: CustomerPayoutSummary | undefined): string | null {
  if (!payout) return null;
  const base = `Latest payout · ${formatMoney(payout.amount)} on ${formatDate(payout.createdAt)}`;
  const status = getPayoutStatusSuffix(payout);
  return status ? `${base} · ${status}` : base;
}
