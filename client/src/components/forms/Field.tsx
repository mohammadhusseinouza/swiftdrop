import { useId, type ReactNode } from 'react';
import { cn } from '../ui/cn';

/**
 * Field shell: label + optional hint + error wiring. Used by TextField /
 * SelectField / MoneyInput and reusable by Phase 11.1's login form.
 */
export interface FieldShellProps {
  label: string;
  htmlFor: string;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  children: ReactNode;
  className?: string;
}

/** The id of a field's hint/error `<p>`, for wiring `aria-describedby`. */
export function fieldMessageId(fieldId: string): string {
  return `${fieldId}-message`;
}

export function FieldShell({
  label,
  htmlFor,
  hint,
  error,
  required,
  children,
  className,
}: FieldShellProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={htmlFor} className="text-sm font-medium text-ink-secondary">
        {label}
        {required && (
          <span className="ml-0.5 text-danger-700" aria-hidden="true">
            *
          </span>
        )}
      </label>
      {children}
      {error ? (
        <p id={fieldMessageId(htmlFor)} className="text-xs text-danger-700">
          {error}
        </p>
      ) : (
        hint && (
          <p id={fieldMessageId(htmlFor)} className="text-xs text-ink-muted">
            {hint}
          </p>
        )
      )}
    </div>
  );
}

const CONTROL =
  'h-10 w-full rounded-control border bg-card px-3 text-sm text-ink placeholder:text-ink-subtle disabled:opacity-50';

export interface TextFieldProps
  extends Omit<
    React.InputHTMLAttributes<HTMLInputElement>,
    'id' | 'className'
  > {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}

export function TextField({ label, hint, error, required, ...input }: TextFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} hint={hint} error={error} required={required}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? fieldMessageId(id) : undefined}
        className={cn(CONTROL, error ? 'border-danger-200' : 'border-line')}
        required={required}
        {...input}
      />
    </FieldShell>
  );
}

export interface TextAreaFieldProps
  extends Omit<
    React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    'id' | 'className'
  > {
  label: string;
  hint?: ReactNode;
  error?: ReactNode;
}

/** Multiline counterpart to TextField — same label/hint/error wiring. */
export function TextAreaField({
  label,
  hint,
  error,
  required,
  rows = 3,
  ...textarea
}: TextAreaFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} hint={hint} error={error} required={required}>
      <textarea
        id={id}
        rows={rows}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? fieldMessageId(id) : undefined}
        className={cn(
          'w-full rounded-control border bg-card px-3 py-2 text-sm text-ink placeholder:text-ink-subtle disabled:opacity-50',
          error ? 'border-danger-200' : 'border-line',
        )}
        required={required}
        {...textarea}
      />
    </FieldShell>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}
export interface SelectFieldProps
  extends Omit<
    React.SelectHTMLAttributes<HTMLSelectElement>,
    'id' | 'className' | 'children'
  > {
  label: string;
  options: SelectOption[];
  placeholder?: string;
  hint?: ReactNode;
  error?: ReactNode;
}

export function SelectField({
  label,
  options,
  placeholder,
  hint,
  error,
  required,
  ...select
}: SelectFieldProps) {
  const id = useId();
  return (
    <FieldShell label={label} htmlFor={id} hint={hint} error={error} required={required}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? fieldMessageId(id) : undefined}
        className={cn(CONTROL, error ? 'border-danger-200' : 'border-line')}
        required={required}
        {...select}
      >
        {placeholder && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled}>
            {o.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}
