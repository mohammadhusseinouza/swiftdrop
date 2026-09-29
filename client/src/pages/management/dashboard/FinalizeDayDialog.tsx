import { useEffect, useId, useRef } from 'react';

import { useGetDailyDeliverySummaryQuery } from '../../../services/dashboardApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import type { DailyDeliverySummary } from '../../../lib/dailyDeliverySummary';
import { formatMoney } from '../../../lib/format';
import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';

export interface FinalizeDayDialogProps {
  open: boolean;
  /** UTC calendar day (YYYY-MM-DD) — the Dashboard's "today" convention. */
  date: string;
  onClose: () => void;
}

/**
 * Finalize Day — currently a DISPLAY-ONLY daily summary of today's completed
 * deliveries. It performs no mutation and persists nothing; the real closing
 * action will be added to the footer later.
 *
 * Same native-<dialog> pattern as ConfirmationModal (focus trap, Escape,
 * backdrop click, focus restoration).
 */
export function FinalizeDayDialog({ open, date, onClose }: FinalizeDayDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  // Only fetch while open, and always refetch on open so the totals are fresh.
  const query = useGetDailyDeliverySummaryQuery(date, {
    skip: !open,
    refetchOnMountOrArgChange: true,
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const displayDate = new Date(`${date}T00:00:00.000Z`).toLocaleDateString(
    undefined,
    { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' },
  );

  let body;
  if (query.isFetching || (!query.data && !query.isError)) {
    body = <LoadingState className="py-8" label="Loading today's summary…" />;
  } else if (query.isError || !query.data) {
    const error = query.error as UnknownApiError;
    const message =
      error && 'status' in error && error.status === 'CUSTOM_ERROR'
        ? error.error
        : getApiErrorMessage(error);
    body = (
      <ErrorState
        className="py-6"
        title="Could not load today's summary"
        message={message}
        onRetry={() => void query.refetch()}
      />
    );
  } else {
    body = <DailySummary summary={query.data} />;
  }

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] max-w-md rounded-card border border-line',
        'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
      )}
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          Finalize Day
        </h2>
        <p className="mt-0.5 text-sm text-ink-muted">{displayDate} · UTC day</p>

        <div className="mt-4">{open && body}</div>

        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </dialog>
  );
}

function DailySummary({ summary }: { summary: DailyDeliverySummary }) {
  return (
    <section aria-label="Today's summary">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
        Today's Summary
      </h3>
      <dl className="mt-3 space-y-2 text-sm">
        <SummaryRow
          label="Orders Delivered Today"
          value={String(summary.deliveredCount)}
        />
        <SummaryRow
          className="pt-2"
          label="Order Total"
          value={formatMoney(summary.orderTotal)}
        />
        <SummaryRow
          label="Delivery Fees"
          value={formatMoney(summary.deliveryFeeTotal)}
        />
        <SummaryRow
          className="border-t border-line pt-2"
          label="Total"
          value={formatMoney(summary.combinedTotal)}
          strong
        />
      </dl>
      <p className="mt-4 text-xs text-ink-muted">
        Daily summary of today's completed deliveries (by delivery time, UTC).
        Order Total and Delivery Fees are shown separately and the Total is not
        company revenue. Final day closing will be added later.
      </p>
    </section>
  );
}

function SummaryRow({
  label,
  value,
  strong = false,
  className,
}: {
  label: string;
  value: string;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex items-baseline justify-between gap-4', className)}>
      <dt className={strong ? 'font-semibold text-ink' : 'text-ink-secondary'}>
        {label}
      </dt>
      <dd
        className={cn(
          'min-w-0 break-all text-right tabular-nums',
          strong ? 'font-semibold text-ink' : 'text-ink',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
