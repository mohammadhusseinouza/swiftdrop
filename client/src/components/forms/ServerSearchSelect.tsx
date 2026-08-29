import { useId, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { FilterPopover } from './FilterPopover';

export interface ServerSearchOption {
  id: string;
  label: string;
}

export interface ServerSearchSelectProps {
  label: string;
  /** The currently chosen id, or '' for "any". */
  value: string;
  onChange: (id: string) => void;
  /** Live search term (parent debounces it before querying). */
  searchTerm: string;
  onSearchTermChange: (term: string) => void;
  /** Options for the current search term (already fetched by the parent). */
  options: ServerSearchOption[];
  /** Resolved label for `value` when it isn't in `options` (fetched by id). */
  selectedLabel?: string;
  loading?: boolean;
  /** Total server matches for the term — drives the "refine" hint. */
  total?: number;
  anyLabel?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** `'compact'` filter-bar trigger (default) or `'field'` form control. */
  variant?: 'compact' | 'field';
  required?: boolean;
  error?: ReactNode;
}

/**
 * Server-backed picker for a potentially-large, paginated dataset (Customers,
 * Drivers). Compact: a single trigger opens a small popover holding the search
 * input + option list. A search input narrows the option list via the backend
 * `search` param — options are NEVER silently truncated: when there are more
 * matches than shown, a "refine your search" hint appears. The current value
 * stays selectable even if it isn't in the latest results (its label is
 * resolved by the parent).
 *
 * Purely presentational — the parent owns the RTK Query requests. Interaction
 * uses native controls (input + select) inside the popover, so it is keyboard-
 * and screen-reader-accessible without a custom combobox widget.
 */
export function ServerSearchSelect({
  label,
  value,
  onChange,
  searchTerm,
  onSearchTermChange,
  options,
  selectedLabel,
  loading = false,
  total,
  anyLabel = 'Any',
  searchPlaceholder = 'Type to search…',
  disabled = false,
  variant = 'compact',
  required = false,
  error,
}: ServerSearchSelectProps) {
  const searchId = useId();
  const selectId = useId();
  const hintId = useId();

  const valueInOptions = options.some((o) => o.id === value);
  const truncated = typeof total === 'number' && total > options.length;
  const currentOption = options.find((o) => o.id === value);
  const triggerText = value
    ? (selectedLabel ?? currentOption?.label ?? value)
    : anyLabel;

  return (
    <FilterPopover
      label={label}
      valueLabel={triggerText}
      active={value !== ''}
      disabled={disabled}
      variant={variant}
      required={required}
      error={error}
      panelClassName="w-72"
    >
      {({ close }) => (
        <div className="flex flex-col gap-2">
          <label htmlFor={searchId} className="text-xs font-medium text-ink-muted">
            Search {label.toLowerCase()}
          </label>
          <input
            id={searchId}
            type="search"
            value={searchTerm}
            autoComplete="off"
            placeholder={searchPlaceholder}
            onChange={(e) => onSearchTermChange(e.target.value)}
            className="h-9 w-full rounded-control border border-line bg-card px-2.5 text-sm text-ink placeholder:text-ink-subtle"
          />

          <label htmlFor={selectId} className="sr-only">
            {label}
          </label>
          <select
            id={selectId}
            value={value}
            aria-describedby={hintId}
            size={Math.min(Math.max(options.length + 1, 3), 8)}
            onChange={(e) => {
              onChange(e.target.value);
              close();
            }}
            className="w-full rounded-control border border-line bg-card px-1.5 py-1 text-sm text-ink"
          >
            <option value="">{anyLabel}</option>
            {value && !valueInOptions && (
              <option value={value}>{selectedLabel ?? value}</option>
            )}
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>

          <p id={hintId} className={cn('text-[0.6875rem] text-ink-subtle')}>
            {loading
              ? 'Searching…'
              : truncated
                ? `Showing ${options.length} of ${total} — refine your search`
                : searchTerm
                  ? `${options.length} match${options.length === 1 ? '' : 'es'}`
                  : 'Type to search'}
          </p>
        </div>
      )}
    </FilterPopover>
  );
}
