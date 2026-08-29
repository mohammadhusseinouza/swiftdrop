import { useId } from 'react';
import { cn } from '../ui/cn';
import { FieldShell } from './Field';

export interface DriverOption {
  id: string;
  driverNumber: string;
  name: string;
  isActive?: boolean;
}

export interface DriverSelectorProps {
  label?: string;
  /** Options supplied by the parent — this component NEVER fetches and holds
   * NO assignment-eligibility rules (the backend validates assignment). */
  options: DriverOption[];
  value: string | null;
  onChange: (driverId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  placeholder?: string;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
}

export function DriverSelector({
  label = 'Driver',
  options,
  value,
  onChange,
  loading = false,
  disabled = false,
  placeholder = 'Select a driver…',
  hint,
  error,
  required,
  className,
}: DriverSelectorProps) {
  const id = useId();
  return (
    <FieldShell
      label={label}
      htmlFor={id}
      hint={loading ? 'Loading drivers…' : hint}
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
        {options.map((d) => (
          <option key={d.id} value={d.id}>
            {d.driverNumber} · {d.name}
            {d.isActive === false ? ' · inactive' : ''}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
