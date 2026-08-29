import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../ui/cn';

export interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  /** Optional summary text, e.g. "120 results". */
  total?: number;
  className?: string;
}

/**
 * Controlled pager. Reports the requested page only — the server remains the
 * authoritative source of the current page of data. Never slices data locally.
 */
export function Pagination({
  page,
  totalPages,
  onPageChange,
  total,
  className,
}: PaginationProps) {
  const safeTotal = Math.max(totalPages, 1);
  const canPrev = page > 1;
  const canNext = page < safeTotal;

  return (
    <nav
      aria-label="Pagination"
      className={cn(
        'flex flex-col items-center justify-between gap-2 text-sm sm:flex-row',
        className,
      )}
    >
      <p className="text-ink-muted">
        Page <span className="font-medium text-ink">{page}</span> of{' '}
        <span className="font-medium text-ink">{safeTotal}</span>
        {typeof total === 'number' && (
          <span className="ml-2 hidden sm:inline">· {total} results</span>
        )}
      </p>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => canPrev && onPageChange(page - 1)}
          disabled={!canPrev}
          aria-label="Previous page"
          className="inline-flex items-center gap-1 rounded-control border border-line px-2.5 py-1.5 text-ink-secondary disabled:opacity-40"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          <span className="hidden sm:inline">Previous</span>
        </button>
        <button
          type="button"
          onClick={() => canNext && onPageChange(page + 1)}
          disabled={!canNext}
          aria-label="Next page"
          className="inline-flex items-center gap-1 rounded-control border border-line px-2.5 py-1.5 text-ink-secondary disabled:opacity-40"
        >
          <span className="hidden sm:inline">Next</span>
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
