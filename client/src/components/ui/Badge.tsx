import type { ReactNode } from 'react';
import { cn } from './cn';

export type BadgeTone =
  | 'neutral'
  | 'brand'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-50 text-neutral-700 ring-neutral-200',
  brand: 'bg-brand-50 text-brand-700 ring-brand-100',
  success: 'bg-success-50 text-success-700 ring-success-200',
  warning: 'bg-warning-50 text-warning-700 ring-warning-200',
  danger: 'bg-danger-50 text-danger-700 ring-danger-200',
  info: 'bg-info-50 text-info-700 ring-info-200',
};

export interface BadgeProps {
  tone?: BadgeTone;
  /** Optional leading dot — the label alone still communicates meaning. */
  dot?: boolean;
  children: ReactNode;
  className?: string;
}

/**
 * Base pill. The label text carries the meaning; colour is secondary (never
 * the only signal). Semantic wrappers (StatusBadge / OrderTypeBadge /
 * PaymentTypeBadge) pick the tone so callers never hand-pick colours.
 */
export function Badge({ tone = 'neutral', dot = false, children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-badge px-2 py-0.5',
        'text-xs font-medium ring-1 ring-inset',
        TONES[tone],
        className,
      )}
    >
      {dot && (
        <span
          className="size-1.5 rounded-full bg-current opacity-70"
          aria-hidden="true"
        />
      )}
      {children}
    </span>
  );
}
