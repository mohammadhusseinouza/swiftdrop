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
  /**
   * `default`: unchanged (outline Previous, dark Next). `brand`: brand theme
   * (§4.2) — red Next, outline Previous with a red hover.
   */
  tone?: 'default' | 'brand';
  className?: string;
}

const LOOK = {
  default: {
    summary: 'text-sm text-ink-muted',
    strong: 'font-semibold text-ink',
    prev: 'inline-flex h-10 items-center gap-1.5 rounded-control border border-line bg-card px-4 text-sm font-semibold text-ink transition-colors hover:border-line-strong disabled:cursor-not-allowed disabled:border-line disabled:bg-canvas disabled:text-ink-muted',
    next: 'inline-flex h-10 items-center gap-1.5 rounded-control bg-ink px-4 text-sm font-semibold text-white transition-colors hover:bg-chrome disabled:cursor-not-allowed disabled:bg-line disabled:text-ink-muted',
  },
  brand: {
    summary: 'text-sm text-sd-text-muted',
    strong: 'font-semibold text-sd-ink',
    prev: 'sd-press inline-flex h-10 items-center gap-1.5 rounded-[9px] border border-sd-line bg-card px-4 text-sm font-semibold text-sd-ink hover:border-sd-red hover:text-sd-red-text disabled:cursor-not-allowed disabled:border-sd-line disabled:bg-sd-sunken disabled:text-sd-text-muted',
    next: 'sd-press inline-flex h-10 items-center gap-1.5 rounded-[9px] bg-sd-red px-4 text-sm font-semibold text-white hover:bg-sd-red-hover disabled:cursor-not-allowed disabled:bg-sd-line disabled:text-sd-text-muted',
  },
} as const;

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
  tone = 'default',
  className,
}: CustomerPaginationProps) {
  const state = getPaginationState(page, totalPages);
  const look = LOOK[tone];

  return (
    <nav
      aria-label="Pagination"
      className={cn('flex flex-wrap items-center justify-between gap-3', className)}
    >
      <p className={look.summary}>
        Page <span className={look.strong}>{page}</span> of{' '}
        <span className={look.strong}>{state.totalPages}</span> · {total} {noun}
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => state.canPrev && onPageChange(page - 1)}
          disabled={!state.canPrev}
          className={look.prev}
        >
          <ChevronLeft className="size-4" aria-hidden="true" />
          Previous
        </button>
        <button
          type="button"
          onClick={() => state.canNext && onPageChange(page + 1)}
          disabled={!state.canNext}
          className={look.next}
        >
          Next
          <ChevronRight className="size-4" aria-hidden="true" />
        </button>
      </div>
    </nav>
  );
}
