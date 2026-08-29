import { type ReactNode, useEffect, useState } from 'react';
import { ConfirmationModal } from '../../../../components/feedback/ConfirmationModal';
import { TextAreaField } from '../../../../components/forms/Field';

export interface ReasonDialogProps {
  open: boolean;
  title: string;
  description?: ReactNode;
  reasonLabel?: string;
  notesLabel?: string;
  /** Require notes as well as a reason (e.g. a settings-driven rule). */
  requireNotes?: boolean;
  confirmLabel: string;
  confirmVariant?: 'primary' | 'danger';
  loading?: boolean;
  error?: string | null;
  onConfirm: (reason: string, notes: string | undefined) => void;
  onCancel: () => void;
}

/**
 * Reusable "give a reason" action dialog for Reschedule / Cancel. Owns no API
 * call — the parent runs the mutation and passes back `loading` / `error`.
 * Reason is always required (mirrors RescheduleOrderSchema / CancelOrderSchema,
 * where `reason` is `z.string().trim().min(1)` and `notes` is optional).
 */
export function ReasonDialog({
  open,
  title,
  description,
  reasonLabel = 'Reason',
  notesLabel = 'Notes (optional)',
  requireNotes = false,
  confirmLabel,
  confirmVariant = 'primary',
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) {
      setReason('');
      setNotes('');
    }
  }, [open]);

  const reasonOk = reason.trim() !== '';
  const notesOk = !requireNotes || notes.trim() !== '';

  return (
    <ConfirmationModal
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      confirmVariant={confirmVariant}
      confirmLoading={loading}
      confirmDisabled={!reasonOk || !notesOk}
      onConfirm={() =>
        onConfirm(reason.trim(), notes.trim() === '' ? undefined : notes.trim())
      }
      onCancel={onCancel}
      description={
        <div className="space-y-3">
          {description && <div>{description}</div>}
          <TextAreaField
            label={reasonLabel}
            required
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <TextAreaField
            label={notesLabel}
            required={requireNotes}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
          {error && (
            <p role="alert" className="text-xs text-danger-700">
              {error}
            </p>
          )}
        </div>
      }
    />
  );
}
