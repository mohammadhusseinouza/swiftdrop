import { useEffect, useState } from 'react';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { useReadyOrderMutation } from '../../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';

interface MarkReadyDialogProps {
  open: boolean;
  orderId: string | null;
  orderNumber: string | null;
  onClose: () => void;
  onReady: (orderNumber: string) => void;
}

/**
 * Single shared confirmation dialog for the Orders table row-level
 * "Mark ready" action. Uses the same `POST /orders/:id/ready` RTK Query
 * mutation (`useReadyOrderMutation`) as the Order Detail page — no separate
 * endpoint, no separate transition logic. On success the mutation's own
 * `invalidatesTags` (Order:id, Order:LIST, Dashboard:ROOT) refresh the table
 * row and dashboard; this component only reports the outcome to the parent.
 */
export function MarkReadyDialog({
  open,
  orderId,
  orderNumber,
  onClose,
  onReady,
}: MarkReadyDialogProps) {
  const [error, setError] = useState<string | null>(null);
  const [ready, { isLoading }] = useReadyOrderMutation();

  useEffect(() => {
    if (!open) setError(null);
  }, [open]);

  const handleConfirm = async () => {
    if (!orderId) return;
    setError(null);
    try {
      await ready(orderId).unwrap();
      onReady(orderNumber ?? orderId);
    } catch (e) {
      // Keep the dialog open with the order's current state unchanged —
      // matches the Order Detail page's error handling for this mutation.
      setError(getApiErrorMessage(e as UnknownApiError));
    }
  };

  return (
    <ConfirmationModal
      open={open}
      title="Mark order ready for pickup?"
      confirmLabel="Mark ready"
      confirmLoading={isLoading}
      onConfirm={() => void handleConfirm()}
      onCancel={onClose}
      description={
        <div className="space-y-2">
          <p>
            {orderNumber ? (
              <span className="font-medium">{orderNumber}</span>
            ) : (
              'This order'
            )}{' '}
            will move from Received to Ready for Pickup and become available
            for driver assignment.
          </p>
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
