import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface EmptyStateProps {
  title: string;
  description?: string;
  /** Decorative icon element (rendered aria-hidden). */
  icon?: ReactNode;
  /** Optional action(s) — e.g. a <Button>. */
  action?: ReactNode;
  className?: string;
}

/** Generic "nothing here" block. All copy is supplied by the caller. */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {icon && (
        <span
          className="mb-1 text-ink-subtle [&>svg]:size-8"
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {description && (
        <p className="max-w-sm text-sm text-ink-muted">{description}</p>
      )}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}
