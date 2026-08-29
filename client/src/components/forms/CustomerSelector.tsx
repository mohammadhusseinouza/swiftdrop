import { useId } from 'react';
import { cn } from '../ui/cn';
import { FieldShell } from './Field';

export interface CustomerOption {
  id: string;
  customerNumber: string;
  name: string;
  primaryPhone?: string;
}

export interface CustomerSelectorProps {
  label?: string;
  /** Options are supplied by the parent — this component NEVER fetches. */
  options: CustomerOption[];
  value: string | null;
  onChange: (customerId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
}

/**
 * Controlled, presentational customer picker. No API calls, no client-side
 * customer cache. Phase 11 pages decide how server-backed search/pagination
 * supplies `options`.
 */
export function CustomerSelector({
  label = 'Customer',
  options,
  value,
  onChange,
  loading = false,
  disabled = false,
  placeholder = 'Select a customer…',
  hint,
  error,
  required,
  className,
}: CustomerSelectorProps) {
  const id = useId();
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={loading ? 'Loading customers…' : hint}
      error={error}
      required={required}
      className={className}
    >
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled || loading}
        required={required}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          'h-10 w-full rounded-control border bg-card px-3 text-sm text-ink disabled:opacity-50',
          error ? 'border-danger-200' : 'border-line',
        )}
      >
        <option value="">{placeholder}</option>
        {options.map((c) => (
          <option key={c.id} value={c.id}>
            {c.customerNumber} · {c.name}
            {c.primaryPhone ? ` · ${c.primaryPhone}` : ''}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
