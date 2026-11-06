import type { ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { cn } from '../ui/cn';

export interface ReviewNoticeProps {
  /** Optional bold first line. */
  title?: ReactNode;
  /** Notice copy. Under-review data is a COUNT only — never pass an amount. */
  children: ReactNode;
  /** Tighter padding + smaller icon tile (e.g. inside the Wallet pending panel). */
  compact?: boolean;
  className?: string;
}

/**
 * Warning notice for under-review orders / tracking exceptions (handoff §2).
 * `role="status"`; the icon is decorative — the text carries the meaning.
 */
export function ReviewNotice({ title, children, compact = false, className }: ReviewNoticeProps) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-3 rounded-2xl border border-warning-200 bg-warning-50 text-warning-800',
        compact ? 'p-3' : 'p-4',
        className,
      )}
    >
      <span
        className={cn(
          'flex shrink-0 items-center justify-center rounded-[10px] bg-warning-200 text-warning-700',
          compact ? 'size-7' : 'size-[34px]',
        )}
        aria-hidden="true"
      >
        <TriangleAlert className={compact ? 'size-3.5' : 'size-4'} strokeWidth={2} />
      </span>
      <div className={cn('min-w-0 self-center', compact ? 'text-[0.8125rem]' : 'text-sm')}>
        {title && <p className="font-bold">{title}</p>}
        <div className={cn(title && 'mt-0.5')}>{children}</div>
      </div>
    </div>
  );
}
