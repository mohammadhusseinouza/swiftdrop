import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Controller, useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, X } from 'lucide-react';

import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { FormSection } from '../../../components/forms/FormSection';
import { SelectField, TextAreaField } from '../../../components/forms/Field';
import { MoneyInput } from '../../../components/forms/MoneyInput';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';

import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { formatMoney, isZeroMoney } from '../../../lib/format';
import {
  compareMoney,
  formatCents,
  parseMoneyToCents,
  subtractMoney,
} from '../../../lib/money';
import {
  useGetDriversQuery,
  useGetDriverQuery,
  useGetManagementDriverCashQuery,
} from '../../../services/driversApi';
import { useGetPaymentMethodsQuery } from '../../../services/settingsApi';
import { useCreateSettlementMutation } from '../../../services/settlementsApi';
import type { SettlementSummary } from '../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  getApiValidationDetails,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';

import {
  makeProcessSettlementDefaults,
  processSettlementSchema,
  toCreateSettlementRequest,
  PROCESS_SETTLEMENT_FIELDS,
  type ProcessSettlementFormValues,
} from './processSettlement.schema';

/**
 * Phase 11.10 — Process Driver Settlement.
 *
 * A settlement records physical cash a driver hands back to the company —
 * a transfer of CUSTODY, never revenue:
 *   driver cash-held balance   ↓   (a SETTLEMENT debit ledger row)
 *   customer wallet / payouts   unchanged
 *   company revenue             unchanged
 *   order financial allocation  unchanged
 *
 * Only cash the driver currently holds is settleable. ONE atomic
 * `POST /api/v1/driver-settlements` per confirmed intent — the backend
 * (settlement.service.ts) runs the driver-cash debit, the settlement row and
 * the audit record in a single transaction with an advisory lock +
 * concurrency-safe conditional decrement. The frontend never PATCHes the cash
 * account or posts a ledger row itself.
 *
 * IDEMPOTENCY (Phase 8.9): every confirmed submission carries one
 * `Idempotency-Key`. Same key reused when retrying an AMBIGUOUS transport
 * failure (so a possibly-succeeded settlement is never charged twice); a new
 * key only for a genuinely new intent (dialog reopened, or the body
 * meaningfully changed after a definitive business failure). Keys live in
 * refs — never Redux, never localStorage.
 */

interface ProcessSettlementDialogProps {
  open: boolean;
  /** From `/management/driver-settlements?driverId=<uuid>` (Driver Detail entry). */
  initialDriverId?: string;
  onClose: () => void;
  onProcessed?: (settlement: SettlementSummary) => void;
}

type Step = 'form' | 'confirm' | 'done';

function genIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0'));
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h
    .slice(6, 8)
    .join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

function applyServerFieldErrors(
  error: UnknownApiError,
  setError: UseFormSetError<ProcessSettlementFormValues>,
): boolean {
  const details = getApiValidationDetails(error);
  const props =
    details && typeof details === 'object'
      ? (details as { properties?: Record<string, { errors?: unknown }> })
          .properties
      : undefined;
  if (!props) return false;
  let mapped = false;
  for (const [key, node] of Object.entries(props)) {
    if (!PROCESS_SETTLEMENT_FIELDS.has(key as keyof ProcessSettlementFormValues))
      continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof ProcessSettlementFormValues, {
        type: 'server',
        message,
      });
      mapped = true;
    }
  }
  return mapped;
}

export function ProcessSettlementDialog({
  open,
  initialDriverId = '',
  onClose,
  onProcessed,
}: ProcessSettlementDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const formErrorId = useId();

  const [step, setStep] = useState<Step>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [doneSettlement, setDoneSettlement] = useState<SettlementSummary | null>(
    null,
  );

  const keyRef = useRef<string | null>(null);
  const failedBodyRef = useRef<string | null>(null);

  const [createSettlement, { isLoading: creating }] =
    useCreateSettlementMutation();

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    watch,
    formState: { errors },
  } = useForm<ProcessSettlementFormValues>({
    resolver: zodResolver(processSettlementSchema),
    mode: 'onTouched',
    defaultValues: makeProcessSettlementDefaults(initialDriverId),
  });

  const values = watch();
  const driverId = values.driverId;

  /* ------------------------------ reference data ----------------------- */
  const [driverTerm, setDriverTerm] = useState('');
  const debouncedTerm = useDebouncedValue(driverTerm, 300);
  // Not restricted to active drivers — an inactive driver can still hold and
  // settle company cash (backend `createSettlement` never checks is_active).
  const drivers = useGetDriversQuery({
    search: debouncedTerm.trim() || undefined,
    limit: 20,
  });
  const driver = useGetDriverQuery(driverId, { skip: !driverId });
  const cash = useGetManagementDriverCashQuery(driverId, { skip: !driverId });
  const paymentMethods = useGetPaymentMethodsQuery({ isActive: true });

  const methodOptions = useMemo(
    () => (paymentMethods.data ?? []).map((m) => ({ value: m.id, label: m.name })),
    [paymentMethods.data],
  );

  const cashHeld = cash.data?.currentBalance ?? null;
  const cashStatus = getApiErrorStatus(cash.error);
  const driverNotFound =
    !!driverId &&
    (driver.isError || cash.isError) &&
    (cashStatus === 404 ||
      getApiErrorCode(cash.error) === 'NOT_FOUND' ||
      getApiErrorStatus(driver.error) === 404);

  const zeroCash = cashHeld !== null && isZeroMoney(cashHeld);

  const overBalance =
    cashHeld !== null &&
    values.amountReceived.trim() !== '' &&
    compareMoney(values.amountReceived.trim(), cashHeld) === 1;

  const balanceAfter =
    cashHeld !== null && !overBalance && values.amountReceived.trim() !== ''
      ? subtractMoney(cashHeld, values.amountReceived.trim())
      : null;

  const methodName =
    methodOptions.find((m) => m.value === values.paymentMethodId)?.label ?? '';

  const driverLabel = driver.data
    ? `${driver.data.driverNumber} · ${driver.data.user.firstName} ${driver.data.user.lastName}`
    : undefined;

  /* --------------------------- open / close ---------------------------- */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(makeProcessSettlementDefaults(initialDriverId));
      setStep('form');
      setFormError(null);
      setAmbiguous(false);
      setDoneSettlement(null);
      setDriverTerm('');
      keyRef.current = null;
      failedBodyRef.current = null;
    }
    wasOpen.current = open;
  }, [open, initialDriverId, reset]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  /* ------------------------------- submit ------------------------------ */
  const canReview =
    !!cash.data && !zeroCash && !overBalance && !paymentMethods.isError;

  const goToConfirm = handleSubmit((v) => {
    if (!canReview) return;
    if (
      cashHeld !== null &&
      compareMoney(v.amountReceived.trim(), cashHeld) === 1
    ) {
      return;
    }
    setFormError(null);
    setAmbiguous(false);
    setStep('confirm');
  });

  const runSettlement = async () => {
    const body = toCreateSettlementRequest(values);
    const serial = JSON.stringify(body);

    if (keyRef.current === null) {
      keyRef.current = genIdempotencyKey();
    } else if (
      failedBodyRef.current !== null &&
      failedBodyRef.current !== serial
    ) {
      keyRef.current = genIdempotencyKey();
      failedBodyRef.current = null;
    }
    const idempotencyKey = keyRef.current;

    setFormError(null);
    setAmbiguous(false);
    try {
      const settlement = await createSettlement({
        body,
        idempotencyKey,
      }).unwrap();
      keyRef.current = null;
      failedBodyRef.current = null;
      setDoneSettlement(settlement);
      setStep('done');
      onProcessed?.(settlement);
    } catch (e) {
      const err = e as UnknownApiError;

      if (isTransportError(err)) {
        setAmbiguous(true);
        setFormError(
          'We could not confirm whether the settlement was processed. Retry with the same request — the backend will not process it twice.',
        );
        return;
      }

      failedBodyRef.current = serial;
      const status = getApiErrorStatus(err);
      const code = getApiErrorCode(err);
      const message = getApiErrorMessage(err);

      if (status === 409 || code === 'CONFLICT') {
        setStep('form');
        setFormError(
          'This request conflicts with a previous settlement attempt. Review the amount and try again.',
        );
        return;
      }
      if (status === 403) {
        setStep('form');
        setFormError('You do not have permission to process settlements.');
        return;
      }
      if (
        (status === 400 || status === 422) &&
        /balance|insufficient|cash/i.test(message)
      ) {
        setStep('form');
        setFormError(
          'Driver cash balance changed. Review the current balance before trying again.',
        );
        void cash.refetch();
        return;
      }
      if (status === 404) {
        setStep('form');
        setFormError(
          'The driver or cash account could not be found. Refresh and try again.',
        );
        void cash.refetch();
        return;
      }

      setStep('form');
      if (applyServerFieldErrors(err, setError)) {
        setFormError('Please fix the highlighted fields and try again.');
      } else if (typeof status === 'number' && status >= 500) {
        setFormError('Something went wrong on the server. Please try again.');
      } else {
        setFormError(message);
      }
    }
  };

  /* ------------------------------- render ------------------------------ */
  const dialogClass = cn(
    'm-auto w-[calc(100vw-2rem)] max-w-lg rounded-card border border-line',
    'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
    'max-h-[calc(100vh-3rem)]',
  );

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
      className={dialogClass}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          {step === 'done'
            ? 'Settlement processed'
            : step === 'confirm'
              ? 'Confirm settlement'
              : 'Process settlement'}
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
            id={formErrorId}
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
              void goToConfirm();
            }}
            className="space-y-4"
          >
            <FormSection title="Driver">
              <Controller
                control={control}
                name="driverId"
                render={({ field }) => (
                  <ServerSearchSelect
                    label="Driver"
                    variant="field"
                    required
                    anyLabel="Select a driver…"
                    searchPlaceholder="Search by number, name or phone…"
                    value={field.value}
                    onChange={field.onChange}
                    searchTerm={driverTerm}
                    onSearchTermChange={setDriverTerm}
                    loading={drivers.isFetching}
                    total={drivers.data?.meta.total}
                    options={(drivers.data?.items ?? []).map((d) => ({
                      id: d.id,
                      label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}${
                        d.user.phone ? ` · ${d.user.phone}` : ''
                      }`,
                    }))}
                    selectedLabel={driverLabel}
                    error={errors.driverId?.message}
                  />
                )}
              />

              {driverNotFound && (
                <p className="text-xs text-danger-700">
                  The selected driver could not be found. Choose another driver.
                </p>
              )}

              {driverId && cash.isLoading && (
                <p className="text-xs text-ink-muted">
                  Loading driver cash balance…
                </p>
              )}

              {driverId && cash.isError && !driverNotFound && (
                <div className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
                  Could not load the driver cash balance.{' '}
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => void cash.refetch()}
                  >
                    Retry
                  </button>
                </div>
              )}

              {cash.data && (
                <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2.5 text-sm">
                  {driver.data && !driver.data.isActive && (
                    <p className="mb-1.5 text-xs text-warning-700">
                      This driver is inactive. Cash they physically hold on
                      behalf of the company can still be settled.
                    </p>
                  )}
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-ink-muted">Current cash held</span>
                    <span className="font-semibold tabular-nums text-ink">
                      {formatMoney(cashHeld)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-ink-muted">
                    Collected, not yet handed to the company. This is the maximum
                    settleable amount.
                  </p>
                </div>
              )}
            </FormSection>

            <FormSection title="Settlement">
              {zeroCash ? (
                <p className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm text-ink-muted">
                  No cash currently held by this driver.
                </p>
              ) : (
                <>
                  <Controller
                    control={control}
                    name="amountReceived"
                    render={({ field }) => (
                      <div className="space-y-1.5">
                        <MoneyInput
                          label="Amount received"
                          required
                          value={field.value}
                          onChange={field.onChange}
                          error={
                            errors.amountReceived?.message ??
                            (overBalance
                              ? `Amount exceeds the cash held (${formatMoney(
                                  cashHeld,
                                )}).`
                              : undefined)
                          }
                          disabled={!cash.data}
                        />
                        {cash.data && !zeroCash && (
                          <button
                            type="button"
                            className="text-xs font-medium text-brand-600 hover:text-brand-700"
                            onClick={() => {
                              const c =
                                cashHeld !== null
                                  ? parseMoneyToCents(cashHeld)
                                  : null;
                              setValue(
                                'amountReceived',
                                c !== null ? formatCents(c) : (cashHeld ?? ''),
                                { shouldValidate: true, shouldTouch: true },
                              );
                            }}
                          >
                            Settle full balance
                          </button>
                        )}
                      </div>
                    )}
                  />

                  <SelectField
                    label="Payment method"
                    required
                    placeholder={
                      paymentMethods.isLoading
                        ? 'Loading methods…'
                        : 'Select a method…'
                    }
                    options={methodOptions}
                    error={errors.paymentMethodId?.message}
                    disabled={paymentMethods.isLoading || paymentMethods.isError}
                    {...register('paymentMethodId')}
                  />
                  {paymentMethods.isError && (
                    <div className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
                      Could not load payment methods.{' '}
                      <button
                        type="button"
                        className="font-medium underline"
                        onClick={() => void paymentMethods.refetch()}
                      >
                        Retry
                      </button>
                    </div>
                  )}

                  <TextAreaField
                    label="Notes (optional)"
                    rows={2}
                    error={errors.notes?.message}
                    {...register('notes')}
                  />
                </>
              )}
            </FormSection>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                onClick={onClose}
                disabled={creating}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !canReview}>
                Review settlement
              </Button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              You are recording that{' '}
              <strong>{driver.data?.user.firstName} {driver.data?.user.lastName}</strong>{' '}
              returned{' '}
              <strong className="tabular-nums">
                {formatMoney(values.amountReceived)}
              </strong>{' '}
              to the company
              {methodName ? (
                <>
                  {' '}
                  using <strong>{methodName}</strong>
                </>
              ) : null}
              . This reduces the driver&rsquo;s cash-held balance.
            </p>

            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <ConfirmRow
                label="Driver"
                value={driverLabel ?? '—'}
              />
              <ConfirmRow
                label="Current cash held"
                value={formatMoney(cashHeld)}
              />
              <ConfirmRow
                label="Settlement amount"
                value={formatMoney(values.amountReceived)}
                emphasis
              />
              <ConfirmRow label="Payment method" value={methodName || '—'} />
              {values.notes.trim() !== '' && (
                <ConfirmRow label="Notes" value={values.notes.trim()} />
              )}
              {balanceAfter !== null && (
                <ConfirmRow
                  label="Expected cash held after settlement"
                  value={formatMoney(balanceAfter)}
                />
              )}
            </dl>

            <p className="text-xs text-ink-muted">
              The server validates the final balance at processing time. This
              does <strong>not</strong> change customer wallet balances, customer
              payouts, company revenue or order totals.
            </p>

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
                disabled={creating}
              >
                Back
              </Button>
              <Button
                type="button"
                onClick={() => void runSettlement()}
                loading={creating}
                disabled={creating}
              >
                {ambiguous ? 'Retry settlement' : 'Process settlement'}
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && doneSettlement && (
          <div className="space-y-4">
            <div className="rounded-control border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
              Settlement processed successfully.
            </div>
            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <ConfirmRow
                label="Settlement number"
                value={doneSettlement.settlementNumber}
              />
              <ConfirmRow
                label="Amount received"
                value={formatMoney(doneSettlement.amountReceived)}
                emphasis
              />
              <ConfirmRow
                label="Driver cash after"
                value={formatMoney(doneSettlement.balanceAfter)}
              />
            </dl>
            <div className="flex justify-end pt-1">
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

function ConfirmRow({
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
