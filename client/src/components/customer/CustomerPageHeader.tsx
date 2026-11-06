import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface CustomerPageHeaderProps {
  /** Small uppercase line above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  /** Optional right-aligned action (button / link / tabs). */
  action?: ReactNode;
  className?: string;
}

/**
 * Customer page header (handoff §2 / §1.2): eyebrow + H1 + lead, with an
 * optional action that wraps under the text on narrow widths.
 */
export function CustomerPageHeader({
  eyebrow,
  title,
  lead,
  action,
  className,
}: CustomerPageHeaderProps) {
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-8 gap-y-5', className)}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && (
          <p className="mb-3 text-xs font-bold uppercase tracking-[0.12em] text-ink-muted">
            {eyebrow}
          </p>
        )}
        <h1 className="text-[1.875rem] leading-[1.08] font-bold tracking-[-0.035em] text-ink sm:text-[2.625rem]">
          {title}
        </h1>
        {lead && <p className="mt-3 text-base text-ink-secondary">{lead}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-3">{action}</div>}
    </header>
  );
}
