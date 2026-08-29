import { useId } from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '../ui/cn';

export interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible label (visually hidden). */
  label?: string;
  /**
   * `'md'` (default) is the standard `h-10` field. `'lg'` is a taller, sunken
   * field for a page's primary search (e.g. the Orders list).
   */
  size?: 'md' | 'lg';
  className?: string;
}

/**
 * Controlled search field. Does NOT call any API and does NOT debounce — the
 * page owns URL params / query dispatch / debouncing.
 */
export function SearchInput({
  value,
  onChange,
  onClear,
  placeholder = 'Search…',
  disabled = false,
  label = 'Search',
  size = 'md',
  className,
}: SearchInputProps) {
  const id = useId();
  const large = size === 'lg';
  return (
    <div className={cn('relative', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        className={cn(
          'pointer-events-none absolute top-1/2 size-4 -translate-y-1/2 text-ink-subtle',
          large ? 'left-3.5' : 'left-3',
        )}
        aria-hidden="true"
      />
      <input
        id={id}
        type="search"
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'w-full rounded-control border border-line pr-9 text-sm',
          'text-ink placeholder:text-ink-subtle disabled:opacity-50',
          large ? 'h-11 bg-sunken pl-10' : 'h-10 bg-card pl-9',
        )}
      />
      {value !== '' && (
        <button
          type="button"
          onClick={() => (onClear ? onClear() : onChange(''))}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-subtle hover:text-ink"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
