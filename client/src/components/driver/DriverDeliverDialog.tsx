import { useEffect, useState } from 'react';
import { ConfirmationModal } from '../feedback/ConfirmationModal';
import { CalculatedField } from '../forms/CalculatedField';
import { MoneyInput } from '../forms/MoneyInput';
import { TextAreaField, SelectField } from '../forms/Field';
import { formatMoney, isZeroMoney } from '../../lib/format';
import { compareMoney, moneyEquals } from '../../lib/money';
import type { DriverPaymentMethodSummary } from '../../services/domain.types';

export interface DriverDeliverDialogProps {
  open: boolean;
  /** Server-authoritative expected amount (DriverOrderCollectionSummary.amountToCollect) — never recalculated here. */
  amountToCollect: string;
  /** The order's EXISTING collection payment method (set at Create Order) — preselected, and the Driver may correct it before confirming. */
  currentPaymentMethodId: string | null;
  /** Display name for currentPaymentMethodId — used only as a fallback label if that method has since been deactivated (so it may be absent from paymentMethodOptions). */
  currentPaymentMethodName: string | null;
  /** Same active payment methods already used by Create Order — no second/new payment-method concept. */
  paymentMethodOptions: DriverPaymentMethodSummary[];
  loading?: boolean;
  error?: string | null;
  onConfirm: (
    actualAmountCollected: string,
    collectionDifferenceReason: string | undefined,
    paymentMethodId: string | undefined,
  ) => void;
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
 *
 * Payment Method reuses the order's EXISTING collectionPaymentMethodId —
 * preselected here, editable, and submitted only when the Driver actually
 * changes it (paymentMethodId omitted otherwise, leaving it unchanged
 * server-side). There is no separate expected/actual payment-method field.
 */
export function DriverDeliverDialog({
  open,
  amountToCollect,
  currentPaymentMethodId,
  currentPaymentMethodName,
  paymentMethodOptions,
  loading = false,
  error = null,
  onConfirm,
  onCancel,
}: DriverDeliverDialogProps) {
  const zeroExpected = isZeroMoney(amountToCollect);
  const [actualAmount, setActualAmount] = useState('');
  const [differenceReason, setDifferenceReason] = useState('');
  const [paymentMethodId, setPaymentMethodId] = useState('');

  useEffect(() => {
    if (open) {
      // Zero-expected orders never need a collection step (task §24) — the
      // backend-required value is submitted automatically. A non-zero
      // expected amount starts genuinely EMPTY; the Driver must type what
      // they actually collected.
      setActualAmount(zeroExpected ? '0' : '');
      setDifferenceReason('');
      setPaymentMethodId(currentPaymentMethodId ?? '');
    }
  }, [open, zeroExpected, currentPaymentMethodId]);

  const amountValid = actualAmount.trim() !== '' && compareMoney(actualAmount, '0') !== null;
  const isNegative = amountValid && compareMoney(actualAmount, '0') === -1;
  const exact = amountValid && moneyEquals(actualAmount, amountToCollect);
  const differs = amountValid && !isNegative && !exact;
  const direction = differs ? compareMoney(actualAmount, amountToCollect) : null;
  const reasonOk = !differs || differenceReason.trim() !== '';
  const canSubmit = amountValid && !isNegative && reasonOk;

  // If the order's current method has since been deactivated, it won't be in
  // paymentMethodOptions — keep it selectable (as itself) rather than
  // silently dropping the Driver's preselected value.
  const hasCurrentInOptions =
    !currentPaymentMethodId || paymentMethodOptions.some((m) => m.id === currentPaymentMethodId);
  const selectOptions = [
    ...(!hasCurrentInOptions && currentPaymentMethodId
      ? [{ value: currentPaymentMethodId, label: `${currentPaymentMethodName ?? 'Current method'} (inactive)` }]
      : []),
    ...paymentMethodOptions.map((m) => ({ value: m.id, label: m.name })),
  ];

  return (
    <ConfirmationModal
      open={open}
      title="Complete delivery?"
      confirmLabel="Complete delivery"
      confirmLoading={loading}
      confirmDisabled={!canSubmit}
      onCancel={onCancel}
      onConfirm={() =>
        onConfirm(
          actualAmount.trim(),
          differs ? differenceReason.trim() : undefined,
          paymentMethodId.trim() || undefined,
        )
      }
      description={
        <div className="space-y-3">
          <p>Confirm that the order has been delivered and the collection information is correct.</p>

          <CalculatedField label="Expected to collect" value={formatMoney(amountToCollect)} emphasis />

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

          {selectOptions.length > 0 && (
            <SelectField
              label="Payment method"
              placeholder={!currentPaymentMethodId ? 'Select a payment method…' : undefined}
              options={selectOptions}
              value={paymentMethodId}
              onChange={(e) => setPaymentMethodId(e.target.value)}
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
