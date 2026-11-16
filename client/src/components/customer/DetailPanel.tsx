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
  /**
   * `default`: unchanged. `brand`: brand theme card (§1.2) — `sd-line` border,
   * card shadow, 16 px radius; a `title` heading in Saira 20 px, a `label`
   * heading as a Saira card label (§1.3).
   */
  tone?: 'default' | 'brand';
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
  tone = 'default',
  children,
  className,
}: DetailPanelProps) {
  const headingId = useId();
  const brand = tone === 'brand';
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        brand
          ? 'min-w-0 rounded-2xl border border-sd-line bg-card p-5 shadow-sd-card sm:p-7'
          : 'min-w-0 rounded-panel border border-line bg-card p-6 sm:p-8',
        className,
      )}
    >
      <div className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h2
          id={headingId}
          className={
            titleStyle === 'title'
              ? brand
                ? 'font-sd-display text-xl font-bold text-sd-ink'
                : 'text-lg font-bold tracking-[-0.02em] text-ink'
              : brand
                ? 'font-sd-display text-[0.8125rem] font-semibold uppercase tracking-[0.12em] text-sd-text-muted'
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
