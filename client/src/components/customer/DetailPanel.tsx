import { useId, type ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface DetailPanelProps {
  /** The panel's heading text. */
  title: string;
  /**
   * `label` (default): 13px uppercase section label (detail panels).
   * `title`: 18px bold panel title (Overview panels, handoff §1.2).
   */
  titleStyle?: 'label' | 'title';
  /** Optional right-aligned header content (e.g. a "View all" link). */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * White customer panel with an uppercase section label (handoff §1.3 / §2):
 * hairline border, `rounded-panel`, no shadow.
 */
export function DetailPanel({
  title,
  titleStyle = 'label',
  action,
  children,
  className,
}: DetailPanelProps) {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className={cn('min-w-0 rounded-panel border border-line bg-card p-6 sm:p-8', className)}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2
          id={headingId}
          className={
            titleStyle === 'title'
              ? 'text-lg font-bold tracking-[-0.02em] text-ink'
              : 'text-[0.8125rem] font-bold uppercase tracking-[0.1em] text-ink-muted'
          }
        >
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}
