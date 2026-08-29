import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Small overline label above the title. */
  eyebrow?: ReactNode;
  /** Primary + secondary action slot (stacks below the title on mobile). */
  actions?: ReactNode;
  className?: string;
}

/** Consistent page title block. No business page is hard-coded here. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div
      className={cn(
        'flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        {eyebrow && (
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {eyebrow}
          </p>
        )}
        <h1 className="truncate text-xl font-semibold text-ink">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}
