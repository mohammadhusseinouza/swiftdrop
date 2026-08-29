import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface FormSectionProps {
  title: string;
  description?: ReactNode;
  children: ReactNode;
  /** Action(s) aligned to the section header (e.g. an "Add row" button). */
  headerAction?: ReactNode;
  className?: string;
}

/**
 * Structural wrapper for a group of form fields — a white card with the
 * standard border/radius/spacing. Owns NO form state; the page (with React
 * Hook Form in Phase 11) supplies the fields.
 */
export function FormSection({
  title,
  description,
  children,
  headerAction,
  className,
}: FormSectionProps) {
  return (
    <section
      className={cn(
        'rounded-card border border-line bg-card p-4 shadow-card sm:p-5',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {description && (
            <p className="mt-0.5 text-sm text-ink-muted">{description}</p>
          )}
        </div>
        {headerAction}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </section>
  );
}
