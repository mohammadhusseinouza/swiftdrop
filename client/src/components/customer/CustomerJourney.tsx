import { Check } from 'lucide-react';
import { cn } from '../ui/cn';
import { formatDateTime } from '../../lib/format';
import { ReviewNotice } from './ReviewNotice';
import { getTrackingStateWord } from './customerOrderDetailPresentation';
import { getCustomerPillPresentation } from './customerStagePresentation';
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
 *
 * Brand look (docs/brand-theme/brand-theme-handoff.md §4.3): done nodes
 * `sd-ink`, the current node a red ring with a red dot, done chips `#F0F1F3`.
 * The dot PULSES only while the order is out for delivery — decided by the
 * canonical customer mapping (the same "brand" tone the status pill pulses
 * on). For any other status, including exceptions (failed, rescheduled,
 * returned, cancelled), the current node keeps its colour but is still. The
 * pulse is off under reduced motion.
 */
export function isJourneyLive(status: string): boolean {
  return getCustomerPillPresentation(status).tone === 'brand';
}

const CHIP: Record<TrackingStageState, string> = {
  done: 'bg-sd-line-subtle text-sd-ink',
  current: 'bg-sd-red-50 text-sd-red-text',
  upcoming: 'bg-sd-line-subtle text-sd-text-muted',
};

function Node({ state, live }: { state: TrackingStageState; live: boolean }) {
  if (state === 'done') {
    return (
      <span className="flex size-[30px] items-center justify-center rounded-full bg-sd-ink text-white">
        <Check className="size-4" strokeWidth={2.5} />
      </span>
    );
  }
  if (state === 'current') {
    return (
      <span className="flex size-[30px] items-center justify-center rounded-full bg-card ring-2 ring-sd-red ring-inset">
        <span className={cn('size-2.5 rounded-full bg-sd-red text-sd-red', live && 'sd-pulse')} />
      </span>
    );
  }
  return <span className="block size-[30px] rounded-full bg-card ring-2 ring-sd-line ring-inset" />;
}

export function CustomerJourney({
  tracking,
  status,
}: {
  tracking: CustomerOrderTracking;
  /** The order's internal status — only gates the live pulse; stages stay as returned. */
  status: string;
}) {
  const stages = tracking.stages;
  const live = isJourneyLive(status);

  return (
    <div className="flex flex-col gap-5">
      {tracking.exception && <ReviewNotice>{tracking.exception.message}</ReviewNotice>}

      <ol className="sd-stagger">
        {stages.map((stage, i) => {
          const isLast = i === stages.length - 1;
          return (
            <li key={`${stage.code}-${i}`} className="relative flex gap-4 pb-6 last:pb-0">
              {!isLast && (
                <span
                  className={cn(
                    'absolute top-[34px] bottom-1 left-[14px] w-0.5 rounded-full',
                    stage.state === 'done' ? 'bg-sd-ink' : 'bg-sd-line',
                  )}
                  aria-hidden="true"
                />
              )}
              <span className="relative shrink-0" aria-hidden="true">
                <Node state={stage.state} live={live} />
              </span>
              <div className="min-w-0 pt-1">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <p className={cn('text-[0.9375rem] text-sd-ink', stage.state === 'upcoming' ? 'font-medium' : 'font-bold')}>
                    {stage.label}
                  </p>
                  <span className={cn('inline-flex h-[22px] items-center rounded-[5px] px-2 text-xs font-semibold', CHIP[stage.state])}>
                    {getTrackingStateWord(stage.state)}
                  </span>
                </div>
                {stage.occurredAt && (
                  <p className="mt-0.5 text-[0.8125rem] text-sd-text-muted">
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
