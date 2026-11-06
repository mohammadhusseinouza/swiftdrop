import { cn } from '../ui/cn';
import { getCustomerStatusPresentation } from '../orders/orderStatus';
import {
  getCustomerStageLabels,
  getCustomerStageNumber,
  type CustomerStageNumber,
} from './customerStagePresentation';

export interface StageProgressProps {
  /** Internal order status; stage + wording come from the customer-safe mapping. */
  status: string;
  /**
   * `compact`: bar + the current stage label beside it (Overview rows).
   * `labelled`: bar + all four stage labels underneath, current in bold (order cards).
   */
  variant?: 'compact' | 'labelled';
  /**
   * Exception statuses only (failed / rescheduled / returned / cancelled): the
   * last stage the order actually reached, when the caller knows it (e.g. from
   * the server's `tracking.stages`). The bar is then frozen at that stage in
   * `line-strong`. Never guessed here — omitted means nothing is filled.
   */
  reachedStage?: CustomerStageNumber;
  className?: string;
}

/**
 * Four-segment customer progress bar (handoff §2 / §3.2). The bar itself is
 * decorative (`aria-hidden`); the stage is always also given as text.
 */
export function StageProgress({
  status,
  variant = 'compact',
  reachedStage,
  className,
}: StageProgressProps) {
  const labels = getCustomerStageLabels();
  const stage = getCustomerStageNumber(status);
  const isException = stage === null;
  const filled = isException ? (reachedStage ?? 0) : stage;
  const statusLabel = getCustomerStatusPresentation(status).label;

  const fillClass = isException
    ? 'bg-line-strong'
    : stage === 4
      ? 'bg-success-700'
      : stage === 3
        ? 'bg-brand-600'
        : 'bg-ink';

  const textSummary = isException
    ? `Status: ${statusLabel}`
    : `Stage ${stage} of ${labels.length}: ${statusLabel}`;

  const bar = (
    <div className="grid flex-1 grid-cols-4 gap-1" aria-hidden="true">
      {labels.map((label, i) => (
        <span
          key={label}
          className={cn('h-1.5 rounded-full', i < filled ? fillClass : 'bg-line')}
        />
      ))}
    </div>
  );

  if (variant === 'labelled') {
    return (
      <div className={cn('min-w-0', className)}>
        <p className="sr-only">{textSummary}</p>
        {bar}
        <ol className="mt-2 grid grid-cols-4 gap-1" aria-hidden="true">
          {labels.map((label, i) => (
            <li
              key={label}
              className={cn(
                'text-[0.6875rem] leading-tight sm:text-xs',
                !isException && i + 1 === stage
                  ? 'font-bold text-ink'
                  : 'font-medium text-ink-muted',
              )}
            >
              {label}
            </li>
          ))}
        </ol>
      </div>
    );
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-3', className)}>
      {bar}
      <span className="shrink-0 text-xs font-semibold text-ink-secondary">
        <span className="sr-only">{isException ? 'Status: ' : `Stage ${stage} of ${labels.length}: `}</span>
        {statusLabel}
      </span>
    </div>
  );
}
