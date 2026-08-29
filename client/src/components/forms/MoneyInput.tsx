import { useId, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { FieldShell } from './Field';

export interface MoneyInputProps {
  label: string;
  /** Authoritative money is a decimal STRING — never a number. */
  value: string;
  onChange: (value: string) => void;
  currency?: string;
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  name?: string;
  className?: string;
}

// Presentation-level guard only: digits with at most one dot and <=2 decimals.
// This is NOT financial validation — the backend recalculates and validates.
const ALLOWED = /^\d*(\.\d{0,2})?$/;

/**
 * String-only money field. `value: string` / `onChange(value: string)` — there
 * is deliberately NO `value: number` API and NO `Number()` / `parseFloat`
 * anywhere. Authoritative monetary validation and arithmetic stay server-side.
 *
 * Safe values: "100.00", "5.50", "0.10", "".
 */
export function MoneyInput({
  label,
  value,
  onChange,
  currency = '$',
  placeholder = '0.00',
  hint,
  error,
  required,
  disabled,
  name,
  className,
}: MoneyInputProps) {
  const id = useId();

  const handleChange = (raw: string) => {
    const next = raw.trim();
    // Reject characters that can't be part of a plain decimal string.
    if (next === '' || ALLOWED.test(next)) {
      onChange(next);
    }
  };

  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={hint}
      error={error}
      required={required}
      className={className}
    >
      <div className="relative">
        <span
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-ink-muted"
          aria-hidden="true"
        >
          {currency}
        </span>
        <input
          id={id}
          name={name}
          type="text"
          inputMode="decimal"
          autoComplete="off"
          value={value}
          disabled={disabled}
          required={required}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          onChange={(e) => handleChange(e.target.value)}
          className={cn(
            'h-10 w-full rounded-control border bg-card pl-7 pr-3 text-sm text-ink',
            'placeholder:text-ink-subtle disabled:opacity-50',
            error ? 'border-danger-200' : 'border-line',
          )}
        />
      </div>
    </FieldShell>
  );
}
