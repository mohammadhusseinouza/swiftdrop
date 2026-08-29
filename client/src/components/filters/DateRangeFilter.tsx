import { useId } from 'react';
import { cn } from '../ui/cn';

export interface DateRange {
  /** YYYY-MM-DD or empty string. */
  from: string;
  to: string;
}

export interface DateRangeFilterProps {
  value: DateRange;
  onChange: (value: DateRange) => void;
  disabled?: boolean;
  fromLabel?: string;
  toLabel?: string;
  className?: string;
}

/**
 * Controlled date-range filter. Values are `YYYY-MM-DD` strings — never
 * converted to `Date` here. UTC/calendar semantics belong to the report API.
 */
export function DateRangeFilter({
  value,
  onChange,
  disabled = false,
  fromLabel = 'From',
  toLabel = 'To',
  className,
}: DateRangeFilterProps) {
  const fromId = useId();
  const toId = useId();
  const field =
    'h-10 rounded-control border border-line bg-card px-2.5 text-sm text-ink disabled:opacity-50';

  return (
    <div className={cn('flex flex-wrap items-end gap-2', className)}>
      <div className="flex flex-col">
        <label htmlFor={fromId} className="mb-1 text-xs font-medium text-ink-muted">
          {fromLabel}
        </label>
        <input
          id={fromId}
          type="date"
          value={value.from}
          max={value.to || undefined}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
          className={field}
        />
      </div>
      <div className="flex flex-col">
        <label htmlFor={toId} className="mb-1 text-xs font-medium text-ink-muted">
          {toLabel}
        </label>
        <input
          id={toId}
          type="date"
          value={value.to}
          min={value.from || undefined}
          disabled={disabled}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
          className={field}
        />
      </div>
    </div>
  );
}
