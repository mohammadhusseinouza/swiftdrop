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
  /**
   * `light` (default): unchanged. `dark`: on the charcoal hero band
   * (brand theme §3.3) — done white, current `sd-red-logo`, upcoming
   * `white/16`, delivered `success-700`; bars `rounded-[2px]`, growing in.
   * `brand`: the brand look on a white card (brand theme §3.3) — done
   * `sd-ink`, current `sd-red`, upcoming `sd-line`, delivered `success-700`.
   */
  tone?: 'light' | 'dark' | 'brand';
  className?: string;
}

const DARK_SEGMENTS = {
  done: 'bg-white',
  current: 'bg-sd-red-logo',
  upcoming: 'bg-white/16',
  exception: 'bg-white/40',
} as const;

const BRAND_SEGMENTS = {
  done: 'bg-sd-ink',
  current: 'bg-sd-red',
  upcoming: 'bg-sd-line',
  exception: 'bg-line-strong',
} as const;

/**
 * Four-segment customer progress bar (handoff §2 / §3.2). The bar itself is
 * decorative (`aria-hidden`); the stage is always also given as text.
 */
export function StageProgress({
  status,
  variant = 'compact',
  reachedStage,
  tone = 'light',
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

  const dark = tone === 'dark';
  const brand = tone === 'brand';

  /**
   * Brand tones: per-segment colour — done / current / upcoming (no new stage
   * logic; the filled count is the same as the light bar's).
   */
  const brandSegmentClass = (i: number) => {
    const look = dark ? DARK_SEGMENTS : BRAND_SEGMENTS;
    if (i >= filled) return look.upcoming;
    if (isException) return look.exception;
    if (stage === 4) return 'bg-success-700';
    return i === filled - 1 ? look.current : look.done;
  };

  const bar = dark || brand ? (
    <div className="sd-grow grid flex-1 grid-cols-4 gap-1" aria-hidden="true">
      {labels.map((label, i) => (
        <span key={label} className={cn('h-1.5 rounded-[2px]', brandSegmentClass(i))} />
      ))}
    </div>
  ) : (
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
                  ? dark
                    ? 'font-bold text-white'
                    : brand
                      ? 'font-bold text-sd-ink'
                      : 'font-bold text-ink'
                  : dark
                    ? 'font-medium text-sd-on-dark'
                    : brand
                      ? 'font-medium text-sd-text-muted'
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
      <span
        className={
          dark
            ? 'shrink-0 text-xs font-semibold text-sd-on-dark-strong'
            : brand
              ? 'shrink-0 text-xs font-semibold text-sd-text-2'
              : 'shrink-0 text-xs font-semibold text-ink-secondary'
        }
      >
        <span className="sr-only">{isException ? 'Status: ' : `Stage ${stage} of ${labels.length}: `}</span>
        {statusLabel}
      </span>
    </div>
  );
}
