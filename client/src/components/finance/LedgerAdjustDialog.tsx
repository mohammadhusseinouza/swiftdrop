import { useEffect, useId, useRef, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, X } from 'lucide-react';
import { z } from 'zod';

import { cn } from '../ui/cn';
import { Button } from '../ui/Button';
import { FormSection } from '../forms/FormSection';
import { TextAreaField } from '../forms/Field';
import { MoneyInput } from '../forms/MoneyInput';
import { formatMoney } from '../../lib/format';
import {
  addMoney,
  compareMoney,
  parseMoneyToCents,
  subtractMoney,
} from '../../lib/money';
import {
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../services/apiError';
import type { LedgerName } from '../../services/domain.types';

import { LEDGER_ADJUST_EFFECT, LEDGER_LABEL } from './ledgerCorrection';

const MONEY_RE = /^\d+(?:\.\d{1,2})?$/;

const schema = z.object({
  direction: z.enum(['CREDIT', 'DEBIT']),
  amount: z
    .string()
    .trim()
    .min(1, 'Enter an amount')
    .regex(MONEY_RE, 'Enter an amount with at most 2 decimals')
    .refine((v) => {
      const c = parseMoneyToCents(v);
      return c !== null && c > 0n;
    }, 'Amount must be greater than zero'),
  reason: z.string().trim().min(1, 'A reason is required').max(2000),
});

type Values = z.infer<typeof schema>;

export interface LedgerAdjustDialogProps {
  open: boolean;
  ledger: LedgerName;
  /** e.g. "Aya Nasser · CUST-0001" or "Company finance". */
  entityLabel: string;
  /** Current authoritative balance string; null for Company Finance. */
  currentBalance: string | null;
  onSubmit: (body: {
    direction: 'CREDIT' | 'DEBIT';
    amount: string;
    reason: string;
  }) => Promise<unknown>;
  submitting: boolean;
  /** Refetch the balance + ledger for this entity (used after an ambiguous failure). */
  onRefetch: () => void;
  onClose: () => void;
}

type Step = 'form' | 'confirm' | 'done' | 'unconfirmed';

/**
 * Manual ledger ADJUSTMENT (Phase 8.8 correction). Append-only: this creates a
 * new ADJUSTMENT row, it never edits history.
 *
 * Manual adjustments are NOT request-idempotent. On an ambiguous transport
 * failure the dialog does NOT retry — it refetches the ledger and asks the
 * user to verify before deliberately creating another adjustment (§19A).
 */
export function LedgerAdjustDialog({
  open,
  ledger,
  entityLabel,
  currentBalance,
  onSubmit,
  submitting,
  onRefetch,
  onClose,
}: LedgerAdjustDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [step, setStep] = useState<Step>('form');
  const [formError, setFormError] = useState<string | null>(null);

  const {
    control,
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    mode: 'onTouched',
    defaultValues: { direction: 'CREDIT', amount: '', reason: '' },
  });

  const values = watch();
  const hasBalance = currentBalance !== null;

  const overdraw =
    hasBalance &&
    values.direction === 'DEBIT' &&
    values.amount.trim() !== '' &&
    compareMoney(values.amount.trim(), currentBalance) === 1;

  const expectedBalance =
    hasBalance && values.amount.trim() !== '' && !overdraw
      ? values.direction === 'CREDIT'
        ? addMoney(currentBalance, values.amount.trim())
        : subtractMoney(currentBalance, values.amount.trim())
      : null;

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset({ direction: 'CREDIT', amount: '', reason: '' });
      setStep('form');
      setFormError(null);
    }
    wasOpen.current = open;
  }, [open, reset]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const goConfirm = handleSubmit((v) => {
    if (overdraw) return;
    if (
      hasBalance &&
      v.direction === 'DEBIT' &&
      compareMoney(v.amount.trim(), currentBalance) === 1
    )
      return;
    setFormError(null);
    setStep('confirm');
  });

  const run = async () => {
    setFormError(null);
    try {
      await onSubmit({
        direction: values.direction,
        amount: values.amount.trim(),
        reason: values.reason.trim(),
      });
      setStep('done');
    } catch (e) {
      const err = e as UnknownApiError;
      if (isTransportError(err)) {
        // NOT idempotent — do not retry. Refresh and make the user verify.
        onRefetch();
        setStep('unconfirmed');
        return;
      }
      const status = getApiErrorStatus(err);
      const msg = getApiErrorMessage(err);
      setStep('form');
      if (
        (status === 400 || status === 422) &&
        /balance|insufficient|negative/i.test(msg)
      ) {
        setFormError(
          'That debit would take the balance negative. It was not applied — reduce the amount.',
        );
        onRefetch();
      } else if (status === 404) {
        setFormError('This record could not be found. It was not adjusted.');
        onRefetch();
      } else if (typeof status === 'number' && status >= 500) {
        setFormError('Something went wrong on the server. Nothing was changed.');
      } else {
        setFormError(msg);
      }
    }
  };

  const ledgerLabel = LEDGER_LABEL[ledger];

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
            ? 'Adjustment posted'
            : step === 'unconfirmed'
              ? 'Adjustment not confirmed'
              : step === 'confirm'
                ? 'Confirm adjustment'
                : `Adjust ${ledgerLabel.toLowerCase()}`}
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
            className="mb-4 rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700"
          >
            {formError}
          </div>
        )}

        {step === 'form' && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void goConfirm();
            }}
            className="space-y-4"
          >
            <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2.5 text-sm">
              <p className="font-medium text-ink">{entityLabel}</p>
              <p className="mt-0.5 text-xs text-ink-muted">
                Ledger: {ledgerLabel}. {LEDGER_ADJUST_EFFECT[ledger]}
              </p>
              {hasBalance && (
                <p className="mt-1 flex items-baseline justify-between gap-4">
                  <span className="text-ink-muted">Current balance</span>
                  <span className="font-semibold tabular-nums text-ink">
                    {formatMoney(currentBalance)}
                  </span>
                </p>
              )}
            </div>

            <FormSection title="Adjustment">
              <fieldset>
                <legend className="text-sm font-medium text-ink-secondary">
                  Direction
                </legend>
                <div className="mt-1.5 grid grid-cols-2 gap-2" role="radiogroup">
                  {(['CREDIT', 'DEBIT'] as const).map((d) => (
                    <label
                      key={d}
                      className="flex cursor-pointer items-center gap-2 rounded-control border border-line bg-card p-2.5 text-sm has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50"
                    >
                      <input
                        type="radio"
                        value={d}
                        className="size-4 accent-brand-600"
                        {...register('direction')}
                      />
                      <span>
                        <span className="block font-medium text-ink">
                          {d === 'CREDIT' ? 'Credit (+)' : 'Debit (−)'}
                        </span>
                        <span className="block text-xs text-ink-muted">
                          {d === 'CREDIT' ? 'Increase' : 'Decrease'} the balance
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <Controller
                control={control}
                name="amount"
                render={({ field }) => (
                  <MoneyInput
                    label="Amount"
                    required
                    value={field.value}
                    onChange={field.onChange}
                    error={
                      errors.amount?.message ??
                      (overdraw
                        ? `A debit of ${formatMoney(
                            values.amount,
                          )} exceeds the current balance (${formatMoney(
                            currentBalance,
                          )}).`
                        : undefined)
                    }
                  />
                )}
              />

              <TextAreaField
                label="Reason"
                required
                rows={2}
                hint="Recorded on the adjustment and in the audit log."
                error={errors.reason?.message}
                {...register('reason')}
              />
            </FormSection>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={submitting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={submitting || overdraw}>
                Review
              </Button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              This creates a new <strong>ADJUSTMENT</strong> row on the{' '}
              <strong>{ledgerLabel}</strong> ledger. It does not edit any
              existing transaction.
            </p>
            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <Row label="Ledger" value={ledgerLabel} />
              <Row label="Applies to" value={entityLabel} />
              <Row
                label="Direction"
                value={values.direction === 'CREDIT' ? 'Credit (+)' : 'Debit (−)'}
              />
              <Row label="Amount" value={formatMoney(values.amount)} emphasis />
              {hasBalance && (
                <Row label="Current balance" value={formatMoney(currentBalance)} />
              )}
              {expectedBalance !== null && (
                <Row
                  label="Balance after"
                  value={formatMoney(expectedBalance)}
                />
              )}
              <Row label="Reason" value={values.reason.trim()} />
            </dl>
            {hasBalance && (
              <p className="text-xs text-ink-muted">
                The server re-checks the balance at processing time and will
                never let it go negative.
              </p>
            )}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                icon={<ArrowLeft />}
                onClick={() => {
                  setFormError(null);
                  setStep('form');
                }}
                disabled={submitting}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void run()}
                loading={submitting}
                disabled={submitting}
              >
                Post adjustment
              </Button>
            </div>
          </div>
        )}

        {step === 'unconfirmed' && (
          <div className="space-y-4">
            <div
              role="alert"
              className="rounded-control border border-warning-200 bg-warning-50 px-4 py-3 text-sm text-ink-secondary"
            >
              We couldn’t confirm whether this adjustment was applied. Financial
              data has been refreshed — check the ledger below before creating
              another adjustment. This action is not retried automatically.
            </div>
            <div className="flex justify-end">
              <Button type="button" onClick={onClose}>
                Close and review
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && (
          <div className="space-y-4">
            <div className="rounded-control border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
              Adjustment posted. The new {ledgerLabel.toLowerCase()} ADJUSTMENT
              row is now in the ledger.
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
