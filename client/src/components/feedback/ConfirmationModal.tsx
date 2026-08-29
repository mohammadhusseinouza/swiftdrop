import { useEffect, useId, useRef, type ReactNode } from 'react';
import { cn } from '../ui/cn';
import { Button, type ButtonVariant } from '../ui/Button';

export interface ConfirmationModalProps {
  open: boolean;
  title: string;
  /** Body content — a string, or arbitrary nodes. */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: Extract<ButtonVariant, 'primary' | 'danger'>;
  /** Disables/loads the confirm button (e.g. while the parent's mutation runs). */
  confirmLoading?: boolean;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Accessible confirmation dialog built on the native <dialog> element:
 * focus trap, Escape-to-close, backdrop, and focus restoration are handled by
 * the platform. Contains NO API calls — the parent owns the action.
 */
export function ConfirmationModal({
  open,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  confirmVariant = 'primary',
  confirmLoading = false,
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmationModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        // Native Escape -> route through onCancel so parent state stays in sync.
        e.preventDefault();
        onCancel();
      }}
      onClick={(e) => {
        // Click on the backdrop (the <dialog> itself, not its content).
        if (e.target === ref.current) onCancel();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] max-w-md rounded-card border border-line',
        'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
      )}
    >
      <div className="p-5">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {title}
        </h2>
        {description && (
          <div id={descId} className="mt-2 text-sm text-ink-muted">
            {description}
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button
            variant={confirmVariant}
            size="sm"
            loading={confirmLoading}
            disabled={confirmDisabled}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </dialog>
  );
}
