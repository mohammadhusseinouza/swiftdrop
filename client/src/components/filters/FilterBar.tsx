import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface FilterBarProps {
  /** Filter controls (SearchInput, selects, DateRangeFilter, …). */
  children: ReactNode;
  /** Shown when `onClear` is provided AND `active` is true. */
  onClear?: () => void;
  active?: boolean;
  className?: string;
}

/**
 * Layout container for a page's filter controls: aligns them, wraps on small
 * screens, keeps spacing consistent, and offers a reset affordance.
 *
 * Owns NO filter state and performs NO fetching/local filtering — the page
 * supplies the controls and their handlers.
 */
export function FilterBar({ children, onClear, active, className }: FilterBarProps) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        className,
      )}
      role="search"
    >
      {children}
      {onClear && active && (
        <button
          type="button"
          onClick={onClear}
          className="text-sm font-medium text-brand-600 hover:text-brand-700"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
