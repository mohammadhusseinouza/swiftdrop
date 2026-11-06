import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '../ui/cn';
import { getPaginationState } from '../data-display/Pagination';

export interface CustomerPaginationProps {
  page: number;
  totalPages: number;
  /** Server `meta.total` — never a count of the current page. */
  total: number;
  /** Plural noun for the summary, e.g. "orders". */
  noun: string;
  onPageChange: (page: number) => void;
  className?: string;
}

/**
 * Customer Portal pager (handoff §3.2): "Page X of Y · N orders", outline
 * Previous and dark Next. Same state rules as the shared `Pagination`
 * (`getPaginationState`) — only the styling differs. Reports the requested
 * page only; never slices data locally.
 */
export function CustomerPagination({
  page,
  totalPages,
  total,
  noun,
  onPageChange,
  className,
}: CustomerPaginationProps) {
  const state = getPaginationState(page, totalPages);

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      <p className="text-sm text-ink-muted">
        Page <span className="font-semibold text-ink">{page}</span> of{' '}
        <span className="font-semibold text-ink">{state.totalPages}</span> · {total} {noun}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => state.canPrev && onPageChange(page - 1)}
          disabled={!state.canPrev}
          className="inline-flex h-10 items-center gap-1.5 rounded-control border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-ink-muted"
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Previous
        </button>
        <button
          type="button"
          onClick={() => state.canNext && onPageChange(page + 1)}
          disabled={!state.canNext}
          className="inline-flex h-10 items-center gap-1.5 rounded-control bg-ink px-4 text-sm font-semibold text-white transition-colors hover:bg-chrome disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-muted"
        >
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
