import { useEffect, useRef, useState } from 'react';
import { ConfirmationModal } from '../feedback/ConfirmationModal';
import { LoadingState } from '../feedback/LoadingState';
import { SelectField, TextAreaField } from '../forms/Field';
import { useGetDriverFailedCollectionReasonsQuery } from '../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../services/apiError';

export interface DriverFailedCollectionDialogProps {
  open: boolean;
  /** True while the parent's failed-collection mutation is in flight. */
  loading?: boolean;
  /** The parent's mutation error message, if the last submit failed. */
  error?: string | null;
  onConfirm: (failedCollectionReasonId: string, notes: string | undefined) => void;
  onCancel: () => void;
}

/**
 * Report Collection Failed dialog (Phase 12.3). Loads the Driver-safe active
 * reasons from `GET /driver/failed-collection-reasons` (driver.orders.
 * read_own — never /settings/failed-collection-reasons, which needs
 * settings.read). Notes become required exactly when the selected reason's
 * `requiresNotes` says so — never a hard-coded reason name. This dialog owns
 * no mutation call itself; the parent (DriverJobDetailPage) runs
 * `reportParcelCollectionFailed` and passes back `loading`/`error`.
 */
export function DriverFailedCollectionDialog({
  open,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: DriverFailedCollectionDialogProps) {
  const reasonsQuery = useGetDriverFailedCollectionReasonsQuery(undefined, { skip: !open });
  const reasons = reasonsQuery.data ?? [];

  const [reasonId, setReasonId] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    if (!open) {
      setReasonId('');
      setNotes('');
    }
  }, [open]);

  // A reason may have gone inactive between load and submit (task §31) — the
  // backend rejects it with 400 and the parent surfaces that as `error`.
  // Refetch the active list so a retry offers only currently-valid reasons;
  // never silently substitute a different reason.
  const lastHandledError = useRef<string | null>(null);
  useEffect(() => {
    if (error && error !== lastHandledError.current) {
      void reasonsQuery.refetch();
    }
    lastHandledError.current = error;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  const selectedReason = reasons.find((r) => r.id === reasonId) ?? null;
  const notesRequired = selectedReason?.requiresNotes ?? false;
  const reasonOk = reasonId !== '';
  const notesOk = !notesRequired || notes.trim() !== '';
  const reasonsReady = !reasonsQuery.isLoading && !reasonsQuery.isError && reasons.length > 0;
  const canSubmit = reasonsReady && reasonOk && notesOk;

  const reasonOptions = reasons.map((r) => ({
    value: r.id,
    label: r.requiresNotes ? `${r.name} (notes required)` : r.name,
  }));

  return (
    <ConfirmationModal
      open={open}
      title="Report collection failed"
      confirmLabel="Report failed"
      confirmLoading={loading}
      confirmDisabled={!canSubmit}
      onCancel={onCancel}
      onConfirm={() => onConfirm(reasonId, notes.trim() === '' ? undefined : notes.trim())}
      description={
        <div className="space-y-3">
          <p>
            This does not cancel the order. Management will review it and can reassign or
            reschedule the collection.
          </p>

          {reasonsQuery.isLoading ? (
            <LoadingState variant="inline" label="Loading reasons…" />
          ) : reasonsQuery.isError ? (
            <div className="space-y-1.5">
              <p role="alert" className="text-xs text-danger-700">
                {getApiErrorMessage(reasonsQuery.error as UnknownApiError)}
              </p>
              <button
                type="button"
                onClick={() => void reasonsQuery.refetch()}
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                Try again
              </button>
            </div>
          ) : reasons.length === 0 ? (
            <p className="text-xs text-ink-muted">No failure reasons available.</p>
          ) : (
            <>
              <SelectField
                label="Reason"
                required
                placeholder="Select a reason"
                options={reasonOptions}
                value={reasonId}
                onChange={(e) => setReasonId(e.target.value)}
              />
              <TextAreaField
                label={notesRequired ? 'Notes (required for this reason)' : 'Notes (optional)'}
                required={notesRequired}
                rows={3}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
              />
            </>
          )}

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
