import type { ReactNode } from 'react';

import { Card } from '../../../components/ui/Card';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';

/**
 * Shared report scaffolding. Every report renders: controls → summary →
 * grouped results, and shares the same loading / error / empty treatment.
 * On a background refetch that fails, the last good data stays visible.
 */

export function ReportSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

interface ReportResultProps {
  isLoading: boolean;
  isError: boolean;
  error?: UnknownApiError;
  onRetry: () => void;
  /** True when the query succeeded but there is nothing to show. */
  isEmpty: boolean;
  emptyTitle: string;
  emptyDescription?: string;
  children: ReactNode;
}

/** Wraps a report's result block with the standard state handling. */
export function ReportResult({
  isLoading,
  isError,
  error,
  onRetry,
  isEmpty,
  emptyTitle,
  emptyDescription,
  children,
}: ReportResultProps) {
  if (isLoading) {
    return (
      <Card flush>
        <LoadingState className="py-16" />
      </Card>
    );
  }
  if (isError) {
    return (
      <Card flush>
        <ErrorState
          className="py-16"
          message={getApiErrorMessage(error)}
          onRetry={onRetry}
        />
      </Card>
    );
  }
  if (isEmpty) {
    return (
      <Card flush>
        <EmptyState
          className="py-16"
          title={emptyTitle}
          description={emptyDescription}
        />
      </Card>
    );
  }
  return <>{children}</>;
}

/** A `YYYY-MM-DD` (or `YYYY-MM`) period bucket as a readable label. */
export function periodLabel(period: string): string {
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [y, m] = period.split('-');
    const d = new Date(Date.UTC(Number(y), Number(m) - 1, 1));
    return Number.isNaN(d.getTime())
      ? period
      : d.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        });
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    const d = new Date(`${period}T00:00:00Z`);
    return Number.isNaN(d.getTime())
      ? period
      : d.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'short',
          day: 'numeric',
          timeZone: 'UTC',
        });
  }
  return period;
}
