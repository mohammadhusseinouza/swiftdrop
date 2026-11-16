import { cn } from '../ui/cn';

export interface FilterChipOption<T extends string> {
  value: T;
  label: string;
}

export interface FilterChipsProps<T extends string> {
  options: readonly FilterChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the chip group. */
  label: string;
  className?: string;
}

/**
 * Single-select filter chips (handoff §2; brand look §4.4 — active `sd-ink`).
 * Each chip is a toggle button with `aria-pressed`; the selected state is also
 * shown by weight + fill.
 */
export function FilterChips<T extends string>({
  options,
  value,
  onChange,
  label,
  className,
}: FilterChipsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn('flex flex-wrap gap-2', className)}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(option.value)}
            className={cn(
              'sd-press inline-flex h-[34px] items-center whitespace-nowrap rounded-[8px] border px-3.5 text-[0.8125rem]',
              on
                ? 'border-sd-ink bg-sd-ink font-semibold text-white'
                : 'border-sd-line bg-card font-medium text-sd-text-2 hover:border-sd-ink hover:text-sd-ink',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
