import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';

import { cn } from '../../../../components/ui/cn';

/**
 * Native <dialog> frame shared by the historical reconciliation dialogs —
 * the same markup and classes as FinancialCorrectionDialog. Escape / close
 * are ignored while a request is in flight.
 */
export function ReconciliationDialogShell({
  open,
  title,
  busy,
  wide,
  onClose,
  children,
}: {
  open: boolean;
  title: string;
  busy: boolean;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] rounded-card border border-line bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40 max-h-[calc(100vh-3rem)]',
        wide ? 'max-w-4xl' : 'max-w-xl',
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          aria-label="Close"
          className="rounded-control p-1 text-ink-muted hover:bg-neutral-50 hover:text-ink disabled:opacity-50"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>
      <div className="max-h-[calc(100vh-11rem)] space-y-4 overflow-y-auto p-5">{open ? children : null}</div>
    </dialog>
  );
}

export function DialogMessage({ tone, children }: { tone: 'danger' | 'warning' | 'success' | 'info'; children: ReactNode }) {
  const tones = {
    danger: 'border-danger-200 bg-danger-50 text-danger-700',
    warning: 'border-warning-200 bg-warning-50 text-warning-700',
    success: 'border-success-200 bg-success-50 text-success-700',
    info: 'border-line-subtle bg-sunken text-ink-secondary',
  } as const;
  return (
    <div role={tone === 'success' ? 'status' : tone === 'info' ? undefined : 'alert'} className={cn('rounded-control border px-3 py-2 text-sm', tones[tone])}>
      {children}
    </div>
  );
}
