import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../ui/cn';
import { fieldMessageId } from './Field';

export interface FilterPopoverProps {
  /** Small label shown above the trigger. */
  label: string;
  /** Current-selection text shown inside the trigger (e.g. "Any customer"). */
  valueLabel: string;
  /** Whether a non-default value is selected — drives the brand tint. */
  active?: boolean;
  /** Panel contents. `close()` dismisses the popover and refocuses the trigger. */
  children: (api: { close: () => void }) => ReactNode;
  /** Panel width utility (default `w-72`). */
  panelClassName?: string;
  disabled?: boolean;
  /**
   * `'compact'` (default) is the filter-bar trigger (fixed `sm:w-44`, quiet
   * label). `'field'` is a full-width form control with a form-style label,
   * a required marker and an error message — for use inside a `<form>`.
   */
  variant?: 'compact' | 'field';
  required?: boolean;
  error?: ReactNode;
}

/**
 * Compact filter/selection control: a button trigger that opens a small
 * popover panel. Folds a two-field server-search control (search input +
 * select) behind a single trigger so a filter row or a form stays tidy.
 *
 * Accessibility: the trigger is a real button with `aria-expanded` /
 * `aria-controls`, labelled by the visible label and (in `field` mode)
 * described by its error text; Escape and outside-pointerdown close the panel
 * and return focus to the trigger; focus moves into the panel on open. The
 * panel contains native form controls, so keyboard interaction and
 * screen-reader semantics come for free.
 */
export function FilterPopover({
  label,
  valueLabel,
  active = false,
  children,
  panelClassName = 'w-72',
  disabled = false,
  variant = 'compact',
  required = false,
  error,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const labelId = useId();
  const triggerId = useId();
  const isField = variant === 'field';

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;

    const focusable = panelRef.current?.querySelector<HTMLElement>(
      'input, select, button, [tabindex]',
    );
    focusable?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex min-w-0 flex-col gap-1',
        isField ? 'w-full gap-1.5' : 'w-full sm:w-44',
      )}
    >
      <span
        id={labelId}
        className={
          isField
            ? 'text-sm font-medium text-ink-secondary'
            : 'text-xs font-medium text-ink-muted'
        }
      >
        {label}
        {required && (
          <span className="ml-0.5 text-danger-700" aria-hidden="true">
            *
          </span>
        )}
      </span>
      <div className="relative">
        <button
          ref={triggerRef}
          id={triggerId}
          type="button"
          disabled={disabled}
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={panelId}
          aria-labelledby={`${labelId} ${triggerId}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? fieldMessageId(triggerId) : undefined}
          className={cn(
            'flex h-9 w-full items-center justify-between gap-2 rounded-control border px-2.5 text-sm',
            'disabled:opacity-50',
            !isField && 'sm:w-44',
            error
              ? 'border-danger-200 bg-card text-ink'
              : active
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-line bg-card text-ink hover:bg-sunken',
          )}
        >
          <span className="truncate">{valueLabel}</span>
          <ChevronDown
            className="size-4 shrink-0 text-ink-subtle"
            aria-hidden="true"
          />
        </button>

        {open && (
          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-label={label}
            className={cn(
              'absolute left-0 z-30 mt-1 rounded-card border border-line bg-card p-3 shadow-overlay',
              panelClassName,
            )}
          >
            {children({ close })}
          </div>
        )}
      </div>
      {error && (
        <p id={fieldMessageId(triggerId)} className="text-xs text-danger-700">
          {error}
        </p>
      )}
    </div>
  );
}
