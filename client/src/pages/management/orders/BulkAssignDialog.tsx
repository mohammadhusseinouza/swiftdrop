import { useEffect, useState } from 'react';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { useGetDriversQuery } from '../../../services/driversApi';
import { useBulkAssignOrdersMutation } from '../../../services/ordersApi';
import type { BulkAssignResult } from '../../../services/domain.types';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';

interface BulkAssignDialogProps {
  open: boolean;
  /** Order ids — already pruned to the current result page by the parent. */
  orderIds: string[];
  /** How many of those already have a driver (backend will reject the batch). */
  alreadyAssignedCount: number;
  onClose: () => void;
  onAssigned: (result: BulkAssignResult) => void;
}

/**
 * Bulk driver assignment. Uses the real atomic backend endpoint
 * `POST /api/v1/orders/bulk-assign` (one request, whole batch validated
 * server-side) — never a per-order loop. The backend remains authoritative for
 * eligibility; the "already assigned" note below is only a courtesy hint.
 */
export function BulkAssignDialog({
  open,
  orderIds,
  alreadyAssignedCount,
  onClose,
  onAssigned,
}: BulkAssignDialogProps) {
  const [driverId, setDriverId] = useState('');
  const [term, setTerm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const debouncedTerm = useDebouncedValue(term, 300);

  const [bulkAssign, { isLoading }] = useBulkAssignOrdersMutation();
  const drivers = useGetDriversQuery(
    { search: debouncedTerm.trim() || undefined, isActive: true, limit: 20 },
    { skip: !open },
  );

  useEffect(() => {
    if (!open) {
      setDriverId('');
      setTerm('');
      setError(null);
    }
  }, [open]);

  const handleConfirm = async () => {
    setError(null);
    try {
      const result = await bulkAssign({ orderIds, driverId }).unwrap();
      onAssigned(result);
    } catch (e) {
      setError(getApiErrorMessage(e as UnknownApiError));
    }
  };

  return (
    <ConfirmationModal
      open={open}
      title={`Assign ${orderIds.length} order${orderIds.length === 1 ? '' : 's'} to a driver`}
      confirmLabel="Assign driver"
      confirmLoading={isLoading}
      confirmDisabled={!driverId || orderIds.length === 0}
      onConfirm={handleConfirm}
      onCancel={onClose}
      description={
        <div className="space-y-3">
          <ServerSearchSelect
            label="Driver"
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
              label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}`,
            }))}
          />

          {alreadyAssignedCount > 0 && (
            <p className="text-xs text-warning-700">
              {alreadyAssignedCount} of the selected order
              {alreadyAssignedCount === 1 ? '' : 's'} already{' '}
              {alreadyAssignedCount === 1 ? 'has' : 'have'} a driver. Bulk assign
              is for initial assignment — the backend will reject the whole batch
              if any order is not eligible.
            </p>
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
