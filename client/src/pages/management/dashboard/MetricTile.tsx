import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';

import { cn } from '../../../components/ui/cn';

export interface MetricTileProps {
  label: string;
  /** Already display-safe (a formatted integer or money string). */
  value: ReactNode;
  hint?: ReactNode;
  /** When set, the whole tile becomes a keyboard-accessible link. */
  to?: string;
  /** Visually lift the primary operational tiles. */
  emphasis?: boolean;
  /** `cash` = subtle green treatment for the Finance Cash tile. */
  tone?: 'default' | 'cash';
  className?: string;
}

/**
 * Dashboard metric tile. A plain informational card by default; a real
 * `<Link>` when `to` is provided (never a fake button / clickable div).
 * Performs NO calculation — the value is handed in pre-formatted.
 */
export function MetricTile({
  label,
  value,
  hint,
  to,
  emphasis = false,
  tone = 'default',
  className,
}: MetricTileProps) {
  const body = (
    <>
      <div className="flex items-start justify-between gap-2">
        <p
          className={cn(
            'text-xs font-medium uppercase tracking-wide',
            tone === 'cash' ? 'text-success-700' : 'text-ink-muted',
          )}
        >
          {label}
        </p>
        {to && (
          <ArrowUpRight
            className="size-4 shrink-0 text-ink-subtle transition-colors group-hover:text-brand-600"
            aria-hidden="true"
          />
        )}
      </div>
      <p
        className={cn(
          'mt-1.5 font-semibold tracking-tight tabular-nums',
          tone === 'cash' ? 'text-success-700' : 'text-ink',
          emphasis ? 'text-3xl' : 'text-2xl',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-1 text-xs text-ink-muted">{hint}</p>}
    </>
  );

  const base = cn(
    'rounded-card border p-4 shadow-card',
    tone === 'cash'
      ? 'border-success-200 bg-success-50'
      : cn('bg-card', emphasis ? 'border-line-strong' : 'border-line'),
    className,
  );

  if (to) {
    return (
      <Link
        to={to}
        className={cn(
          base,
          'group block transition-colors hover:border-brand-600',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-600',
        )}
      >
        {body}
      </Link>
    );
  }

  return <div className={base}>{body}</div>;
}
