import type { ReactNode } from 'react';
import { cn } from '../ui/cn';
import type { BadgeTone } from '../ui/Badge';

export interface TimelineItem {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Pre-formatted timestamp text. */
  timestamp?: ReactNode;
  actor?: ReactNode;
  tone?: BadgeTone;
  icon?: ReactNode;
}

export interface OrderTimelineProps {
  /**
   * Ordered timeline items. Order Detail (Phase 11.5) maps backend status
   * history / assignments / delivery attempts into these — this component
   * performs NO status logic and does NOT auto-merge private audit data.
   */
  items: TimelineItem[];
  className?: string;
}

const DOT_TONE: Record<BadgeTone, string> = {
  neutral: 'bg-neutral-200',
  brand: 'bg-brand-600',
  success: 'bg-success-700',
  warning: 'bg-warning-700',
  danger: 'bg-danger-700',
  info: 'bg-info-700',
};

export function OrderTimeline({ items, className }: OrderTimelineProps) {
  return (
    <ol className={cn('space-y-0', className)}>
      {items.map((item, i) => {
        const last = i === items.length - 1;
        return (
          <li key={item.id} className="relative flex gap-3 pb-5 last:pb-0">
            {!last && (
              <span
                className="absolute left-[7px] top-4 bottom-0 w-px bg-line"
                aria-hidden="true"
              />
            )}
            <span
              className={cn(
                'relative mt-1 size-3.5 shrink-0 rounded-full ring-4 ring-card',
                DOT_TONE[item.tone ?? 'neutral'],
              )}
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-sm font-medium text-ink">{item.title}</p>
                {item.timestamp && (
                  <span className="text-xs text-ink-muted">{item.timestamp}</span>
                )}
              </div>
              {item.description && (
                <p className="mt-0.5 text-sm text-ink-muted">{item.description}</p>
              )}
              {item.actor && (
                <p className="mt-0.5 text-xs text-ink-subtle">{item.actor}</p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
