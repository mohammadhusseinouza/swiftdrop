import { useEffect, useState } from 'react';
import { ConfirmationModal } from '../../../../components/feedback/ConfirmationModal';
import { ServerSearchSelect } from '../../../../components/forms/ServerSearchSelect';
import { TextAreaField } from '../../../../components/forms/Field';
import { useDebouncedValue } from '../../../../lib/useDebouncedValue';
import { useGetDriversQuery } from '../../../../services/driversApi';

export interface DriverDialogProps {
  open: boolean;
  mode: 'assign' | 'reassign';
  /** For reassign: the id + display label of the current driver. */
  currentDriverId?: string | null;
  currentDriverLabel?: string | null;
  loading?: boolean;
  error?: string | null;
  onConfirm: (driverId: string, reason: string | undefined) => void;
  onCancel: () => void;
}

/**
 * Driver picker for POST /orders/:id/assign and POST /orders/:id/reassign.
 *
 * assign   -> body { driverId }
 * reassign -> body { driverId, reason }  (reason is required by ReassignOrderSchema)
 *
 * The backend re-validates eligibility (active driver + active login), order
 * state and "new driver must differ from current"; the same-driver guard here
 * is only a courtesy.
 */
export function DriverDialog({
  open,
  mode,
  currentDriverId = null,
  currentDriverLabel = null,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: DriverDialogProps) {
  const [driverId, setDriverId] = useState('');
  const [reason, setReason] = useState('');
  const [term, setTerm] = useState('');
  const debouncedTerm = useDebouncedValue(term, 300);

  const drivers = useGetDriversQuery(
    { search: debouncedTerm.trim() || undefined, isActive: true, limit: 20 },
    { skip: !open },
  );

  useEffect(() => {
    if (!open) {
      setDriverId('');
      setReason('');
      setTerm('');
    }
  }, [open]);

  const isReassign = mode === 'reassign';
  const sameDriver = isReassign && driverId !== '' && driverId === currentDriverId;
  const reasonOk = !isReassign || reason.trim() !== '';
  const canConfirm = driverId !== '' && !sameDriver && reasonOk;

  return (
    <ConfirmationModal
      open={open}
      title={isReassign ? 'Reassign driver' : 'Assign driver'}
      confirmLabel={isReassign ? 'Reassign' : 'Assign'}
      confirmLoading={loading}
      confirmDisabled={!canConfirm}
      onConfirm={() =>
        onConfirm(driverId, isReassign ? reason.trim() : undefined)
      }
      onCancel={onCancel}
      description={
        <div className="space-y-3">
          {isReassign && (
            <p className="text-sm text-ink-secondary">
              Current driver:{' '}
              <span className="font-medium text-ink">
                {currentDriverLabel ?? '—'}
              </span>
            </p>
          )}

          <ServerSearchSelect
            label={isReassign ? 'New driver' : 'Driver'}
            variant="field"
            required
            anyLabel="Select a driver…"
            searchPlaceholder="Search active drivers…"
            value={driverId}
            onChange={setDriverId}
            searchTerm={term}
            onSearchTermChange={setTerm}
            loading={drivers.isFetching}
            total={drivers.data?.meta.total}
            options={(drivers.data?.items ?? []).map((d) => ({
              id: d.id,
              label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}${
                d.user.phone ? ` · ${d.user.phone}` : ''
              }`,
            }))}
            error={
              sameDriver
                ? 'Choose a driver other than the current one.'
                : undefined
            }
          />

          {isReassign && (
            <TextAreaField
              label="Reason"
              required
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint="Recorded on the assignment being ended."
            />
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
