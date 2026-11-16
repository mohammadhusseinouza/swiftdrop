import type { ReactNode } from 'react';
import type { BadgeTone } from '../ui/Badge';
import { cn } from '../ui/cn';

/*
 * Brand theme badge colours (docs/brand-theme/brand-theme-handoff.md §4.4).
 * The TONE still comes from the existing presentation helpers
 * (getWalletTransactionTypeTone / getPayoutStatusTone) — only the colours
 * differ: the payout badge (tone `info` from getWalletTransactionTypeTone —
 * the brand palette has no cobalt) and `brand` are `sd-red-50` /
 * `sd-red-text`; `neutral` (reversal, cancelled) is `#EEF0F2` / `#3A4048`;
 * success / warning / danger keep the shared Badge colours. The shared
 * `ui/Badge` stays untouched for the other portals.
 */
const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-[#EEF0F2] text-[#3A4048]',
  brand: 'bg-sd-red-50 text-sd-red-text',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
  danger: 'bg-danger-50 text-danger-700',
  info: 'bg-sd-red-50 text-sd-red-text',
};

export interface BrandBadgeProps {
  tone?: BadgeTone;
  /** Optional leading dot — the label alone still carries the meaning. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

export function BrandBadge({ tone = 'neutral', dot = false, children, className }: BrandBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[5px] px-2 py-0.5 text-xs font-semibold whitespace-nowrap',
        TONES[tone],
        className,
      )}
    >
      {dot && <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />}
      {children}
    </span>
  );
}
