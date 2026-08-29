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
  className,
}: SearchInputProps) {
  const id = useId();
  return (
    <div className={cn('relative', className)}>
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-subtle"
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
          'h-10 w-full rounded-control border border-line bg-card pl-9 pr-9 text-sm',
          'text-ink placeholder:text-ink-subtle disabled:opacity-50',
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
