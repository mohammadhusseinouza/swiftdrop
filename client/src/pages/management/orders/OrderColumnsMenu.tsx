import { useEffect, useId, useRef, useState } from 'react';
import { Columns3 } from 'lucide-react';
import { Button } from '../../../components/ui/Button';
import { ORDER_COLUMN_OPTIONS } from './orderColumnVisibility';

export interface OrderColumnsMenuProps {
  visibleIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onReset: () => void;
  isDefault: boolean;
}

/**
 * "Columns" button + popover with one checkbox per optional Orders column.
 * Escape and outside-pointerdown close the panel (same behavior as
 * FilterPopover); Escape returns focus to the trigger.
 */
export function OrderColumnsMenu({
  visibleIds,
  onToggle,
  onReset,
  isDefault,
}: OrderColumnsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const visibleCount = ORDER_COLUMN_OPTIONS.filter((o) => visibleIds.has(o.id)).length;

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLElement>('input')?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
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

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={triggerRef}
        variant="secondary"
        size="sm"
        icon={<Columns3 />}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={panelId}
      >
        Columns
        <span className="text-ink-muted">
          {visibleCount}/{ORDER_COLUMN_OPTIONS.length}
        </span>
      </Button>

      {open && (
        <div
          ref={panelRef}
          id={panelId}
          role="dialog"
          aria-label="Visible columns"
          className="absolute right-0 z-30 mt-1 w-60 rounded-card border border-line bg-card p-2 shadow-overlay"
        >
          <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-ink-muted">
            Visible columns
          </p>
          <ul className="max-h-80 overflow-y-auto">
            {ORDER_COLUMN_OPTIONS.map((o) => (
              <li key={o.id}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-control px-2 py-1.5 text-sm text-ink hover:bg-sunken">
                  <input
                    type="checkbox"
                    checked={visibleIds.has(o.id)}
                    onChange={() => onToggle(o.id)}
                    className="size-4 rounded border-line"
                  />
                  {o.label}
                </label>
              </li>
            ))}
          </ul>
          <div className="mt-1 border-t border-line-subtle pt-2">
            <Button
              variant="ghost"
              size="sm"
              className="w-full"
              disabled={isDefault}
              onClick={onReset}
            >
              Reset to default
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
