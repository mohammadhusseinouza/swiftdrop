import { useEffect, useState } from 'react';
import { ConfirmationModal } from '../feedback/ConfirmationModal';
import { CalculatedField } from '../forms/CalculatedField';
import { MoneyInput } from '../forms/MoneyInput';
import { TextAreaField } from '../forms/Field';
import { formatMoney, isZeroMoney } from '../../lib/format';
import { compareMoney, moneyEquals } from '../../lib/money';

export interface DriverDeliverDialogProps {
  open: boolean;
  /** Server-authoritative expected amount (DriverOrderCollectionSummary.amountToCollect) — never recalculated here. */
  amountToCollect: string;
  /** Already fixed at order creation — read-only, never a Driver-time selector (task §25/§27). */
  paymentMethodName: string | null;
  loading?: boolean;
  error?: string | null;
  onConfirm: (actualAmountCollected: string, collectionDifferenceReason: string | undefined) => void;
  onCancel: () => void;
}

/**
 * Complete Delivery dialog (Phase 12.4). The Driver reports what was
 * ACTUALLY collected — never pre-filled with the expected amount (task
 * §23: "Do not silently force actualAmountCollected = amountToCollect").
 * All money comparison is exact-cents string comparison (lib/money.ts) —
 * no `Number()`/`parseFloat` anywhere. The backend remains the sole
 * authority on the resulting financial posting; this dialog only decides
 * whether a difference REASON is required before submit, exactly mirroring
 * the server's own "collectionDifferenceReason required when it differs"
 * rule (DeliverOrderSchema / driver-order.service.ts).
 */
export function DriverDeliverDialog({
  open,
  amountToCollect,
  paymentMethodName,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: DriverDeliverDialogProps) {
  const zeroExpected = isZeroMoney(amountToCollect);
  const [actualAmount, setActualAmount] = useState('');
  const [differenceReason, setDifferenceReason] = useState('');

  useEffect(() => {
    if (open) {
      // Zero-expected orders never need a collection step (task §24) — the
      // backend-required value is submitted automatically. A non-zero
      // expected amount starts genuinely EMPTY; the Driver must type what
      // they actually collected.
      setActualAmount(zeroExpected ? '0' : '');
      setDifferenceReason('');
    }
  }, [open, zeroExpected]);

  const amountValid = actualAmount.trim() !== '' && compareMoney(actualAmount, '0') !== null;
  const isNegative = amountValid && compareMoney(actualAmount, '0') === -1;
  const exact = amountValid && moneyEquals(actualAmount, amountToCollect);
  const differs = amountValid && !isNegative && !exact;
  const direction = differs ? compareMoney(actualAmount, amountToCollect) : null;
  const reasonOk = !differs || differenceReason.trim() !== '';
  const canSubmit = amountValid && !isNegative && reasonOk;

  return (
    <ConfirmationModal
      open={open}
      title="Complete delivery?"
      confirmLabel="Complete delivery"
      confirmLoading={loading}
      confirmDisabled={!canSubmit}
      onCancel={onCancel}
      onConfirm={() =>
        onConfirm(actualAmount.trim(), differs ? differenceReason.trim() : undefined)
      }
      description={
        <div className="space-y-3">
          <p>Confirm that the order has been delivered and the collection information is correct.</p>

          <CalculatedField label="Expected to collect" value={formatMoney(amountToCollect)} emphasis />
          {paymentMethodName && <CalculatedField label="Payment method" value={paymentMethodName} />}

          {zeroExpected ? (
            <p className="text-xs text-ink-muted">No collection is required for this order.</p>
          ) : (
            <MoneyInput
              label="Actual amount collected"
              required
              value={actualAmount}
              onChange={setActualAmount}
            />
          )}

          {differs && (
            <>
              <p role="alert" className="text-xs font-medium text-warning-700">
                The collected amount is {direction === 1 ? 'more' : 'less'} than the expected amount
                and may require Finance review.
              </p>
              <TextAreaField
                label="Reason for the difference"
                required
                rows={2}
                value={differenceReason}
                onChange={(e) => setDifferenceReason(e.target.value)}
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
