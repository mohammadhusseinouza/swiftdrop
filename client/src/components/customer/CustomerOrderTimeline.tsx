import { Check, Circle, CircleDot, TriangleAlert } from 'lucide-react';
import { cn } from '../ui/cn';
import { formatDateTime } from '../../lib/format';
import type {
  CustomerOrderTracking,
  TrackingStageState,
} from '../../services/domain.types';

/**
 * Phase 13.3 — Customer-safe tracking timeline.
 *
 * Renders the server's already-safe `stages` (one shared Phase 11.17.6
 * builder — no actor / Driver / attempt / assignment / audit) as an ordered
 * list. The stage STATE is spelled out in text ("Done" / "In progress" /
 * "Upcoming") and marked with a distinct icon — never conveyed by colour
 * alone (task §22 / §71).
 */
const STATE_META: Record<
  TrackingStageState,
  { word: string; Icon: typeof Check; iconClass: string; textClass: string }
> = {
  done: { word: 'Done', Icon: Check, iconClass: 'text-success-700', textClass: 'text-ink' },
  current: { word: 'In progress', Icon: CircleDot, iconClass: 'text-brand-600', textClass: 'font-semibold text-ink' },
  upcoming: { word: 'Upcoming', Icon: Circle, iconClass: 'text-ink-subtle', textClass: 'text-ink-muted' },
};

export function CustomerOrderTimeline({ tracking }: { tracking: CustomerOrderTracking }) {
  return (
    <div className="space-y-3">
      {tracking.exception && (
        <div
          role="status"
          className="flex items-start gap-2 rounded-control border border-warning-200 bg-warning-50 p-3 text-sm text-warning-700"
        >
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{tracking.exception.message}</span>
        </div>
      )}

      <ol className="space-y-3">
        {tracking.stages.map((stage) => {
          const meta = STATE_META[stage.state];
          const { Icon } = meta;
          return (
            <li key={stage.code} className="flex items-start gap-3">
              <Icon className={cn('mt-0.5 size-4 shrink-0', meta.iconClass)} aria-hidden="true" />
              <div className="min-w-0">
                <p className={cn('text-sm', meta.textClass)}>
                  {stage.label}
                  <span className="ml-2 text-xs font-normal text-ink-subtle">
                    · {meta.word}
                  </span>
                </p>
                {stage.occurredAt && (
                  <p className="text-xs text-ink-subtle">{formatDateTime(stage.occurredAt)}</p>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
