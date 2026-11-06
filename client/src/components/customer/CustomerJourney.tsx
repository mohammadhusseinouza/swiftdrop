import { Check } from 'lucide-react';
import { cn } from '../ui/cn';
import { formatDateTime } from '../../lib/format';
import { ReviewNotice } from './ReviewNotice';
import { getTrackingStateWord } from './customerOrderDetailPresentation';
import type { CustomerOrderTracking, TrackingStageState } from '../../services/domain.types';

/**
 * Customer Order Detail "Journey" (Customer Portal Redesign Step 4, handoff
 * §3.3). Renders `tracking.stages` EXACTLY as the server returns them — same
 * order, nothing added or removed. Each stage states its progress in text
 * ("Done" / "In progress" / "Upcoming"); the node graphics are decorative.
 * No ETAs: only the server's `occurredAt`, when present.
 *
 * The older `CustomerOrderTimeline` is kept unchanged for the Public Tracking
 * page (Phase 14.2); this component is the Customer Portal's redesign of it.
 */
const CHIP: Record<TrackingStageState, string> = {
  done: 'bg-canvas text-ink',
  current: 'bg-brand-50 text-brand-600',
  upcoming: 'bg-canvas text-ink-muted',
};

function Node({ state }: { state: TrackingStageState }) {
  if (state === 'done') {
    return (
      <span className="flex size-[30px] items-center justify-center rounded-full bg-ink text-white">
        <Check className="size-4" strokeWidth={2.5} />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="flex size-[30px] items-center justify-center rounded-full bg-card ring-2 ring-brand-600 ring-inset">
        <span className="size-2.5 rounded-full bg-brand-600" />
      </span>
    );
  }
  return <span className="block size-[30px] rounded-full bg-card ring-2 ring-line-strong ring-inset" />;
}

export function CustomerJourney({ tracking }: { tracking: CustomerOrderTracking }) {
  const stages = tracking.stages;

  return (
    <div className="flex flex-col gap-5">
      {tracking.exception && <ReviewNotice>{tracking.exception.message}</ReviewNotice>}

      <ol>
        {stages.map((stage, i) => {
          const isLast = i === stages.length - 1;
          return (
            <li key={`${stage.code}-${i}`} className="relative flex gap-4 pb-6 last:pb-0">
              {!isLast && (
                <span
                  className={cn(
                    'absolute top-[34px] bottom-1 left-[14px] w-0.5 rounded-full',
                    stage.state === 'done' ? 'bg-ink' : 'bg-line',
                  )}
                  aria-hidden="true"
                />
              )}
              <span className="relative shrink-0" aria-hidden="true">
                <Node state={stage.state} />
              </span>
              <div className="min-w-0 pt-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <p className={cn('text-[0.9375rem] text-ink', stage.state === 'upcoming' ? 'font-medium' : 'font-bold')}>
                    {stage.label}
                  </p>
                  <span className={cn('inline-flex h-[22px] items-center rounded-full px-2 text-xs font-semibold', CHIP[stage.state])}>
                    {getTrackingStateWord(stage.state)}
                  </span>
                </div>
                {stage.occurredAt && (
                  <p className="mt-0.5 text-[0.8125rem] text-ink-muted">
                    <time dateTime={stage.occurredAt}>{formatDateTime(stage.occurredAt)}</time>
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
