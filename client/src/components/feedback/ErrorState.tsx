import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '../ui/cn';
import { Button } from '../ui/Button';

export interface ErrorStateProps {
  title?: string;
  /**
   * Human-readable message. Pass `getApiErrorMessage(error)` from the pages;
   * this component takes a plain string so it never depends on RTK Query
   * internals and never surfaces raw stack / SQL / Prisma text.
   */
  message?: string;
  /** Shows a "Try again" button wired to this callback. */
  onRetry?: () => void;
  /** Extra action(s) beyond retry. */
  action?: ReactNode;
  className?: string;
}

export function ErrorState({
  title = 'Something went wrong',
  message,
  onRetry,
  action,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      <AlertTriangle className="size-8 text-danger-700" aria-hidden="true" />
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {message && (
        <p className="max-w-sm text-sm text-ink-muted">{message}</p>
      )}
      {(onRetry || action) && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button variant="secondary" size="sm" onClick={onRetry}>
              Try again
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
