import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface CalculatedFieldProps {
  label: string;
  /**
   * An already-computed DISPLAY value (normally a formatted string). This
   * component performs NO calculation — not remaining amounts, delivery fees,
   * amount-to-collect, wallet allocation, or company revenue. The backend is
   * authoritative; pages may pass a safe preview.
   */
  value: ReactNode;
  supportingText?: ReactNode;
  /** Visually emphasise (e.g. the final "Amount to collect"). */
  emphasis?: boolean;
  className?: string;
}

export function CalculatedField({
  label,
  value,
  supportingText,
  emphasis = false,
  className,
}: CalculatedFieldProps) {
  return (
    <div
      className={cn(
        'flex items-baseline justify-between gap-4 rounded-control border border-line-subtle bg-sunken px-3 py-2.5',
        className,
      )}
    >
      <div className="min-w-0">
        <p className="text-sm text-ink-secondary">{label}</p>
        {supportingText && (
          <p className="text-xs text-ink-muted">{supportingText}</p>
        )}
      </div>
      <p
        className={cn(
          'shrink-0 tabular-nums',
          emphasis
            ? 'text-base font-semibold text-ink'
            : 'text-sm font-medium text-ink-secondary',
        )}
      >
        {value}
      </p>
    </div>
  );
}
