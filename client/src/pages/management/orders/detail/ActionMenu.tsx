import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '../../../../components/ui/cn';

export interface ActionMenuItem {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  hint?: string;
}

/**
 * Small accessible "More actions" disclosure menu (same interaction model as the
 * navbar UserMenu): real button trigger with aria-haspopup / aria-expanded,
 * Escape + outside-pointerdown close, focus moves to the first item on open and
 * back to the trigger on close.
 */
export function ActionMenu({
  label = 'More actions',
  items,
  disabled = false,
}: {
  label?: string;
  items: ActionMenuItem[];
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const firstItemRef = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    firstItemRef.current?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
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

  if (items.length === 0) return null;

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        className={cn(
          'inline-flex h-10 items-center gap-1.5 rounded-control border border-line bg-card px-3',
          'text-sm font-medium text-ink-secondary hover:bg-sunken disabled:opacity-50',
        )}
      >
        {label}
        <ChevronDown className="size-4 text-ink-subtle" aria-hidden="true" />
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          aria-label={label}
          className="absolute right-0 z-30 mt-1 w-60 rounded-card border border-line bg-card p-1 shadow-overlay"
        >
          {items.map((item, i) => (
            <button
              key={item.key}
              ref={i === 0 ? firstItemRef : undefined}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
                item.onSelect();
              }}
              className={cn(
                'flex w-full flex-col items-start gap-0.5 rounded-control px-3 py-2 text-left text-sm',
                'hover:bg-neutral-50 disabled:opacity-50 disabled:hover:bg-transparent',
                item.danger ? 'text-danger-700' : 'text-ink-secondary',
              )}
            >
              <span className="flex items-center gap-2">
                {item.icon && (
                  <span className="[&>svg]:size-4" aria-hidden="true">
                    {item.icon}
                  </span>
                )}
                {item.label}
              </span>
              {item.hint && (
                <span className="text-xs text-ink-subtle">{item.hint}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
