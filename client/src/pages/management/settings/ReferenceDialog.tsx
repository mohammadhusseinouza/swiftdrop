import { useEffect, useId, useRef, type FormEvent, type ReactNode } from 'react';
import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';

export interface ReferenceDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  submitLabel?: string;
  submitLoading?: boolean;
  submitDisabled?: boolean;
  error?: ReactNode;
  onSubmit: () => void;
  onClose: () => void;
  children: ReactNode;
}

/**
 * Native <dialog> form shell for the Settings reference-data create/edit
 * forms (Areas / Payment Methods / Failed Delivery Reasons). Focus trap,
 * Escape and backdrop are handled by the platform. Contains no API calls —
 * the parent owns the mutation.
 */
export function ReferenceDialog({
  open,
  title,
  description,
  submitLabel = 'Save',
  submitLoading = false,
  submitDisabled = false,
  error,
  onSubmit,
  onClose,
  children,
}: ReferenceDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const errId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!submitLoading && !submitDisabled) onSubmit();
  };

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] max-w-md rounded-card border border-line',
        'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
      )}
    >
      <form onSubmit={handleSubmit} className="flex max-h-[85vh] flex-col">
        <div className="border-b border-line px-5 py-4">
          <h2 id={titleId} className="text-base font-semibold text-ink">
            {title}
          </h2>
          {description && (
            <p className="mt-1 text-xs text-ink-muted">{description}</p>
          )}
        </div>
        <div className="space-y-4 overflow-y-auto px-5 py-4">{children}</div>
        {error && (
          <p
            id={errId}
            role="alert"
            className="mx-5 mb-2 rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700"
          >
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line px-5 py-4">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            loading={submitLoading}
            disabled={submitDisabled}
          >
            {submitLabel}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
