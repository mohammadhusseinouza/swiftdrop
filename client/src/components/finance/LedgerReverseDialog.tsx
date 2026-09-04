import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, X } from 'lucide-react';
import { z } from 'zod';

import { cn } from '../ui/cn';
import { Button } from '../ui/Button';
import { TextAreaField } from '../forms/Field';
import { formatDateTime, formatMoney } from '../../lib/format';
import {
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../services/apiError';

const schema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(2000),
});
type Values = z.infer<typeof schema>;

export interface ReverseOriginal {
  ledgerLabel: string;
  typeLabel: string;
  /** Magnitude string. */
  amount: string;
  direction?: 'CREDIT' | 'DEBIT';
  /** ISO date of the original. */
  date: string;
  /** Order / payout / settlement number, when the row has one. */
  reference: string | null;
  /** Extra sentence e.g. "Reversing this restores the customer's wallet balance." */
  effectNote?: string;
}

export interface LedgerReverseDialogProps {
  open: boolean;
  original: ReverseOriginal;
  onSubmit: (reason: string) => Promise<unknown>;
  submitting: boolean;
  /** Refetch the ledger/source (after ambiguous failure or an already-reversed result). */
  onRefetch: () => void;
  onClose: () => void;
}

type Step = 'form' | 'confirm' | 'done' | 'already';

/**
 * Reverse a finalized ledger transaction (Phase 8.8). Append-only: the
 * original row stays; a new REVERSAL row is created referencing it.
 *
 * Reversals ARE request-idempotent server-side (deterministic key +
 * exactly-once source guard). On an ambiguous transport failure the dialog
 * refetches and lets the user retry safely; a 409 ("already reversed") is
 * shown as an informational result, never raw JSON (§19B).
 */
export function LedgerReverseDialog({
  open,
  original,
  onSubmit,
  submitting,
  onRefetch,
  onClose,
}: LedgerReverseDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    getValues,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { reason: '' },
  });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset({ reason: '' });
      setStep('form');
      setFormError(null);
      setAmbiguous(false);
    }
    wasOpen.current = open;
  }, [open, reset]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const run = async () => {
    setFormError(null);
    setAmbiguous(false);
    try {
      await onSubmit(getValues('reason').trim());
      setStep('done');
    } catch (e) {
      const err = e as UnknownApiError;
      if (isTransportError(err)) {
        onRefetch();
        setAmbiguous(true);
        setFormError(
          'We couldn’t confirm the reversal. Financial data was refreshed — you can retry safely; the backend will not reverse the same transaction twice.',
        );
        return;
      }
      const status = getApiErrorStatus(err);
      const msg = getApiErrorMessage(err);
      if (status === 409) {
        onRefetch();
        setStep('already');
        return;
      }
      setStep('form');
      setFormError(
        status === 400
          ? msg // e.g. "A REVERSAL transaction cannot itself be reversed"
          : status === 404
            ? 'The original transaction could not be found.'
            : typeof status === 'number' && status >= 500
              ? 'Something went wrong on the server. Nothing was reversed.'
              : msg,
      );
    }
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
        'm-auto w-[calc(100vw-2rem)] max-w-lg rounded-card border border-line',
        'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
        'max-h-[calc(100vh-3rem)]',
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {step === 'done'
            ? 'Reversal posted'
            : step === 'already'
              ? 'Already reversed'
              : step === 'confirm'
                ? 'Confirm reversal'
                : 'Reverse transaction'}
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-control p-1 text-ink-muted hover:bg-neutral-50 hover:text-ink"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      <div className="max-h-[calc(100vh-11rem)] overflow-y-auto p-5">
        {formError && (
          <div
            role="alert"
            className={cn(
              'mb-4 rounded-control border px-3 py-2 text-sm',
              ambiguous
                ? 'border-warning-200 bg-warning-50 text-ink-secondary'
                : 'border-danger-200 bg-danger-50 text-danger-700',
            )}
          >
            {formError}
          </div>
        )}

        {(step === 'form' || step === 'confirm') && (
          <div className="space-y-4">
            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <Row label="Ledger" value={original.ledgerLabel} />
              <Row label="Original type" value={original.typeLabel} />
              <Row
                label="Original amount"
                value={
                  original.direction
                    ? `${original.direction === 'CREDIT' ? '+' : '−'}${formatMoney(
                        original.amount,
                      )}`
                    : formatMoney(original.amount)
                }
                emphasis
              />
              <Row label="Original date" value={formatDateTime(original.date)} />
              {original.reference && (
                <Row label="Reference" value={original.reference} />
              )}
            </dl>

            <p className="text-sm text-ink-secondary">
              The original transaction remains in history. A separate{' '}
              <strong>REVERSAL</strong> entry will be created with the opposite
              effect.
              {original.effectNote ? ` ${original.effectNote}` : ''}
            </p>

            {step === 'form' ? (
              <form
                noValidate
                onSubmit={handleSubmit(() => {
                  setFormError(null);
                  setStep('confirm');
                })}
                className="space-y-4"
              >
                <TextAreaField
                  label="Reason for reversal"
                  required
                  rows={2}
                  hint="Recorded on the reversal and in the audit log."
                  error={errors.reason?.message}
                  {...register('reason')}
                />
                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={onClose}
                    disabled={submitting}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" disabled={submitting}>
                    Review
                  </Button>
                </div>
              </form>
            ) : (
              <>
                <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
                  <Row label="Reason" value={getValues('reason').trim()} />
                </dl>
                <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                  <Button
                    type="button"
                    variant="secondary"
                    icon={<ArrowLeft />}
                    onClick={() => {
                      setFormError(null);
                      setAmbiguous(false);
                      setStep('form');
                    }}
                    disabled={submitting}
                  >
                    Back
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    onClick={() => void run()}
                    loading={submitting}
                    disabled={submitting}
                  >
                    {ambiguous ? 'Retry reversal' : 'Reverse transaction'}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {step === 'already' && (
          <div className="space-y-4">
            <div className="rounded-control border border-line bg-sunken px-4 py-3 text-sm text-ink-secondary">
              This transaction has already been reversed. The ledger has been
              refreshed — no second reversal was created.
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Close
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <div className="rounded-control border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
              Reversal posted. The original transaction stays in history; a new
              REVERSAL row now offsets it.
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}

function Row({
  label,
  value,
  emphasis,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
}) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd
        className={cn(
          'text-right',
          emphasis
            ? 'font-semibold tabular-nums text-ink'
            : 'font-medium text-ink-secondary',
        )}
      >
        {value}
      </dd>
    </div>
  );
}
