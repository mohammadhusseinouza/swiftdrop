import { AlertTriangle } from 'lucide-react';
import { cn } from '../ui/cn';
import { Button } from '../ui/Button';

/**
 * Shown when a background refresh fails while previously loaded data is
 * still on screen (FR.11A). The page — and any dialog open on it — stays
 * mounted; the notice makes clear the figures may be out of date.
 */
export function StaleDataNotice({
  message = 'Could not refresh — showing the last loaded data.',
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-2 rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700',
        className,
      )}
    >
      <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{message}</span>
      {onRetry && (
        <Button size="sm" variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
