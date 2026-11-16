import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface CustomerPageHeaderProps {
  /** Small uppercase line above the title. */
  eyebrow?: ReactNode;
  title: ReactNode;
  /**
   * Optional highlight words rendered after the title in italic red
   * (brand theme §1.3 — e.g. title "Good evening," + highlight "Nour.").
   */
  highlight?: ReactNode;
  lead?: ReactNode;
  /** Optional right-aligned action (button / link / tabs). */
  action?: ReactNode;
  /**
   * `light` (default): the light page header, unchanged.
   * `dark`: hero colours for the charcoal brand band (brand theme §3.3).
   */
  tone?: 'light' | 'dark';
  className?: string;
}

/**
 * Customer page header (handoff §2 / §1.2): eyebrow + H1 + lead, with an
 * optional action that wraps under the text on narrow widths.
 */
export function CustomerPageHeader({
  eyebrow,
  title,
  highlight,
  lead,
  action,
  tone = 'light',
  className,
}: CustomerPageHeaderProps) {
  const dark = tone === 'dark';
  return (
    <header className={cn('flex flex-wrap items-end justify-between gap-x-8 gap-y-5', className)}>
      <div className="min-w-0 max-w-3xl">
        {eyebrow && (
          <p
            className={
              dark
                ? 'mb-3 font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.16em] text-sd-on-dark'
                : 'mb-3 text-xs font-bold uppercase tracking-[0.12em] text-ink-muted'
            }
          >
            {eyebrow}
          </p>
        )}
        <h1
          className={
            dark
              ? 'font-sd-display text-[1.875rem] leading-[1.02] font-bold tracking-[-0.02em] text-white [overflow-wrap:anywhere] sm:text-[2.625rem]'
              : 'text-[1.875rem] leading-[1.08] font-bold tracking-[-0.035em] text-ink sm:text-[2.625rem]'
          }
        >
          {title}
          {highlight != null && (
            <>
              {' '}
              <em className={cn('italic', dark ? 'text-sd-red-logo' : 'text-sd-red-text')}>{highlight}</em>
            </>
          )}
        </h1>
        {lead && <p className={dark ? 'mt-3 text-base text-sd-on-dark' : 'mt-3 text-base text-ink-secondary'}>{lead}</p>}
      </div>
      {action && <div className="flex shrink-0 flex-wrap items-center gap-3">{action}</div>}
    </header>
  );
}
