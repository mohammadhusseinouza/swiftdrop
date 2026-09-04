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
import { useGetCustomersQuery } from '../../../services/customersApi';
import { useGetWalletQuery } from '../../../services/walletsApi';
import { useGetPaymentMethodsQuery } from '../../../services/settingsApi';
import { useCreatePayoutMutation } from '../../../services/payoutsApi';
import type { PayoutSummary } from '../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  getApiValidationDetails,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';

import {
  makeProcessPayoutDefaults,
  processPayoutSchema,
  toCreatePayoutRequest,
  PROCESS_PAYOUT_FIELDS,
  type ProcessPayoutFormValues,
} from './processPayout.schema';

/**
 * Phase 11.9 — Process Customer Payout.
 *
 * A payout pays money the company already owes the Customer:
 *   customer wallet available balance  ↓   (a PAYOUT debit ledger row)
 *   driver cash / company finance       unchanged
 *   pending amount                       not directly reduced
 *
 * Only finalized AVAILABLE balance is withdrawable — pending money is not.
 *
 * ONE atomic `POST /api/v1/payouts` per confirmed intent. The backend
 * (payout.service.ts) creates the payout row, the wallet debit and the audit
 * record in a single transaction and re-checks the balance with a
 * concurrency-safe conditional decrement — the frontend never PATCHes the
 * wallet or posts a ledger row itself.
 *
 * IDEMPOTENCY (Phase 8.9): every confirmed submission carries one
 * `Idempotency-Key`. The same key is reused when retrying an AMBIGUOUS
 * transport failure (so a possibly-succeeded payout is never charged twice); a
 * new key is generated only for a genuinely new intent (dialog opened, or the
 * body meaningfully changed after a definitive business failure). Keys live in
 * refs — never Redux, never localStorage.
 */

interface ProcessPayoutDialogProps {
  open: boolean;
  /** From `/management/payouts?customerId=<uuid>` (Wallet Detail entry). */
  initialCustomerId?: string;
  onClose: () => void;
  onProcessed?: (payout: PayoutSummary) => void;
}

type Step = 'form' | 'confirm' | 'done';

function genIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback for older / non-secure contexts — RFC-4122 v4 from getRandomValues.
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
  setError: UseFormSetError<ProcessPayoutFormValues>,
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
    if (!PROCESS_PAYOUT_FIELDS.has(key as keyof ProcessPayoutFormValues)) continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof ProcessPayoutFormValues, {
        type: 'server',
        message,
      });
      mapped = true;
    }
  }
  return mapped;
}

export function ProcessPayoutDialog({
  open,
  initialCustomerId = '',
  onClose,
  onProcessed,
}: ProcessPayoutDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const formErrorId = useId();

  const [step, setStep] = useState<Step>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [donePayout, setDonePayout] = useState<PayoutSummary | null>(null);

  // Idempotency intent — see the module comment.
  const keyRef = useRef<string | null>(null);
  const failedBodyRef = useRef<string | null>(null);

  const [createPayout, { isLoading: creating }] = useCreatePayoutMutation();

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    watch,
    formState: { errors },
  } = useForm<ProcessPayoutFormValues>({
    resolver: zodResolver(processPayoutSchema),
    mode: 'onTouched',
    defaultValues: makeProcessPayoutDefaults(initialCustomerId),
  });

  const values = watch();
  const customerId = values.customerId;

  /* ------------------------------ reference data ----------------------- */
  const [customerTerm, setCustomerTerm] = useState('');
  const debouncedTerm = useDebouncedValue(customerTerm, 300);
  const customers = useGetCustomersQuery({
    search: debouncedTerm.trim() || undefined,
    limit: 20,
  });
  const wallet = useGetWalletQuery(customerId, { skip: !customerId });
  const paymentMethods = useGetPaymentMethodsQuery({ isActive: true });

  const methodOptions = useMemo(
    () => (paymentMethods.data ?? []).map((m) => ({ value: m.id, label: m.name })),
    [paymentMethods.data],
  );

  const availableBalance = wallet.data?.wallet.availableBalance ?? null;
  const pendingAmount = wallet.data?.wallet.pendingAmount ?? null;
  const selectedCustomer = wallet.data?.customer ?? null;
  const walletStatus = getApiErrorStatus(wallet.error);
  const walletNotFound =
    !!customerId &&
    wallet.isError &&
    (walletStatus === 404 || getApiErrorCode(wallet.error) === 'NOT_FOUND');

  const zeroAvailable =
    availableBalance !== null && isZeroMoney(availableBalance);

  // Exact-cents balance guard against the AUTHORITATIVE server balance.
  const overBalance =
    availableBalance !== null &&
    values.amount.trim() !== '' &&
    compareMoney(values.amount.trim(), availableBalance) === 1;

  const balanceAfter =
    availableBalance !== null && !overBalance && values.amount.trim() !== ''
      ? subtractMoney(availableBalance, values.amount.trim())
      : null;

  const methodName =
    methodOptions.find((m) => m.value === values.paymentMethodId)?.label ?? '';

  /* --------------------------- open / close ---------------------------- */
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(makeProcessPayoutDefaults(initialCustomerId));
      setStep('form');
      setFormError(null);
      setAmbiguous(false);
      setDonePayout(null);
      setCustomerTerm('');
      keyRef.current = null;
      failedBodyRef.current = null;
    }
    wasOpen.current = open;
  }, [open, initialCustomerId, reset]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  /* ------------------------------- submit ------------------------------ */
  const canReview =
    !!wallet.data &&
    !zeroAvailable &&
    !overBalance &&
    !paymentMethods.isError;

  const goToConfirm = handleSubmit((v) => {
    if (!canReview) return;
    // guard again with the freshest values
    if (
      availableBalance !== null &&
      compareMoney(v.amount.trim(), availableBalance) === 1
    ) {
      return;
    }
    setFormError(null);
    setAmbiguous(false);
    setStep('confirm');
  });

  const runPayout = async () => {
    const body = toCreatePayoutRequest(values);
    const serial = JSON.stringify(body);

    if (keyRef.current === null) {
      keyRef.current = genIdempotencyKey();
    } else if (
      failedBodyRef.current !== null &&
      failedBodyRef.current !== serial
    ) {
      // Meaningful change after a definitive failure → a new payout intent.
      keyRef.current = genIdempotencyKey();
      failedBodyRef.current = null;
    }
    const idempotencyKey = keyRef.current;

    setFormError(null);
    setAmbiguous(false);
    try {
      const payout = await createPayout({ body, idempotencyKey }).unwrap();
      keyRef.current = null;
      failedBodyRef.current = null;
      setDonePayout(payout);
      setStep('done');
      onProcessed?.(payout);
    } catch (e) {
      const err = e as UnknownApiError;

      if (isTransportError(err)) {
        // Ambiguous — the payout may have completed. Keep the SAME key so a
        // retry is deduplicated by the backend instead of double-debiting.
        setAmbiguous(true);
        setFormError(
          'We could not confirm whether the payout was processed. Retry with the same request — the backend will not process it twice.',
        );
        return;
      }

      // Definitive business / validation failure — remember this body so a
      // later meaningful edit starts a fresh idempotency intent.
      failedBodyRef.current = serial;
      const status = getApiErrorStatus(err);
      const code = getApiErrorCode(err);
      const message = getApiErrorMessage(err);

      if (status === 409 || code === 'CONFLICT') {
        setStep('form');
        setFormError(
          'This request conflicts with a previous payout attempt. Review the amount and try again.',
        );
        return;
      }
      if (status === 403) {
        setStep('form');
        setFormError('You do not have permission to process payouts.');
        return;
      }
      if (
        (status === 400 || status === 422) &&
        /balance|insufficient/i.test(message)
      ) {
        setStep('form');
        setFormError(
          'Available balance changed. Review the current wallet balance before trying again.',
        );
        void wallet.refetch();
        return;
      }
      if (status === 404) {
        setStep('form');
        setFormError(
          'The customer or wallet could not be found. Refresh and try again.',
        );
        void wallet.refetch();
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
            ? 'Payout processed'
            : step === 'confirm'
              ? 'Confirm payout'
              : 'Process payout'}
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
            <FormSection title="Customer">
              <Controller
                control={control}
                name="customerId"
                render={({ field }) => (
                  <ServerSearchSelect
                    label="Customer"
                    variant="field"
                    required
                    anyLabel="Select a customer…"
                    searchPlaceholder="Search by number, name or phone…"
                    value={field.value}
                    onChange={field.onChange}
                    searchTerm={customerTerm}
                    onSearchTermChange={setCustomerTerm}
                    loading={customers.isFetching}
                    total={customers.data?.meta.total}
                    options={(customers.data?.items ?? []).map((c) => ({
                      id: c.id,
                      label: `${c.customerNumber} · ${c.name}${
                        c.primaryPhone ? ` · ${c.primaryPhone}` : ''
                      }`,
                    }))}
                    selectedLabel={
                      selectedCustomer
                        ? `${selectedCustomer.customerNumber} · ${selectedCustomer.name}`
                        : undefined
                    }
                    error={errors.customerId?.message}
                  />
                )}
              />

              {walletNotFound && (
                <p className="text-xs text-danger-700">
                  The selected customer could not be found. Choose another
                  customer.
                </p>
              )}

              {customerId && wallet.isLoading && (
                <p className="text-xs text-ink-muted">Loading wallet balance…</p>
              )}

              {customerId && wallet.isError && !walletNotFound && (
                <div className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
                  Could not load the wallet balance.{' '}
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => void wallet.refetch()}
                  >
                    Retry
                  </button>
                </div>
              )}

              {wallet.data && (
                <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2.5 text-sm">
                  {selectedCustomer && !selectedCustomer.isActive && (
                    <p className="mb-1.5 text-xs text-warning-700">
                      This customer is inactive. Money the company already owes
                      them can still be paid out.
                    </p>
                  )}
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-ink-muted">Available balance</span>
                    <span className="font-semibold tabular-nums text-ink">
                      {formatMoney(availableBalance)}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                    <span className="text-ink-muted">Pending amount</span>
                    <span className="tabular-nums text-ink-muted">
                      {formatMoney(pendingAmount)}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs text-ink-muted">
                    Only the available balance can be paid out. Pending money
                    from active delivery-only orders is <strong>not</strong>{' '}
                    withdrawable.
                  </p>
                </div>
              )}
            </FormSection>

            <FormSection title="Payout">
              {zeroAvailable ? (
                <p className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm text-ink-muted">
                  No available balance to pay out.
                </p>
              ) : (
                <>
                  <Controller
                    control={control}
                    name="amount"
                    render={({ field }) => (
                      <div className="space-y-1.5">
                        <MoneyInput
                          label="Amount"
                          required
                          value={field.value}
                          onChange={field.onChange}
                          error={
                            errors.amount?.message ??
                            (overBalance
                              ? `Amount exceeds the available balance (${formatMoney(
                                  availableBalance,
                                )}).`
                              : undefined)
                          }
                          disabled={!wallet.data}
                        />
                        {wallet.data && !zeroAvailable && (
                          <button
                            type="button"
                            className="text-xs font-medium text-brand-600 hover:text-brand-700"
                            onClick={() => {
                              // Exact backend cents, normalised to 2 decimals
                              // for display — no float arithmetic.
                              const c =
                                availableBalance !== null
                                  ? parseMoneyToCents(availableBalance)
                                  : null;
                              setValue(
                                'amount',
                                c !== null
                                  ? formatCents(c)
                                  : (availableBalance ?? ''),
                                { shouldValidate: true, shouldTouch: true },
                              );
                            }}
                          >
                            Use full available balance
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
                Review payout
              </Button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              You are about to pay{' '}
              <strong className="tabular-nums">
                {formatMoney(values.amount)}
              </strong>{' '}
              to <strong>{selectedCustomer?.name}</strong>
              {methodName ? (
                <>
                  {' '}
                  using <strong>{methodName}</strong>
                </>
              ) : null}
              . This reduces the customer&rsquo;s available wallet balance.
            </p>

            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <ConfirmRow
                label="Customer"
                value={
                  selectedCustomer
                    ? `${selectedCustomer.customerNumber} · ${selectedCustomer.name}`
                    : '—'
                }
              />
              <ConfirmRow
                label="Available balance"
                value={formatMoney(availableBalance)}
              />
              <ConfirmRow
                label="Payout amount"
                value={formatMoney(values.amount)}
                emphasis
              />
              <ConfirmRow label="Payment method" value={methodName || '—'} />
              {values.notes.trim() !== '' && (
                <ConfirmRow label="Notes" value={values.notes.trim()} />
              )}
              {balanceAfter !== null && (
                <ConfirmRow
                  label="Expected balance after payout"
                  value={formatMoney(balanceAfter)}
                />
              )}
            </dl>

            <p className="text-xs text-ink-muted">
              The server validates the final balance at processing time. Driver
              cash and company revenue are not affected.
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
                onClick={() => void runPayout()}
                loading={creating}
                disabled={creating}
              >
                {ambiguous ? 'Retry payout' : 'Process payout'}
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && donePayout && (
          <div className="space-y-4">
            <div className="rounded-control border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
              Payout processed successfully.
            </div>
            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <ConfirmRow label="Payout number" value={donePayout.payoutNumber} />
              <ConfirmRow
                label="Amount"
                value={formatMoney(donePayout.amount)}
                emphasis
              />
              <ConfirmRow
                label="Customer"
                value={`${donePayout.customer.customerNumber} · ${donePayout.customer.name}`}
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
