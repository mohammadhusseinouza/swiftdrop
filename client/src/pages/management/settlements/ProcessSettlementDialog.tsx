import { useEffect, useId, useMemo, useRef, useState } from 'react';
import {
  Controller,
  useForm,
  type FieldErrors,
  type UseFormRegister,
  type UseFormSetError,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { ArrowLeft, X } from 'lucide-react';

import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { FormSection } from '../../../components/forms/FormSection';
import { SelectField, TextAreaField } from '../../../components/forms/Field';
import { MoneyInput } from '../../../components/forms/MoneyInput';
import { CalculatedField } from '../../../components/forms/CalculatedField';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';
import { LoadingState } from '../../../components/feedback/LoadingState';

import { usePermissions } from '../../../features/auth/usePermissions';
import { paths } from '../../../routes/paths';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { formatMoney, isZeroMoney } from '../../../lib/format';
import { formatCents, parseMoneyToCents, subtractMoney } from '../../../lib/money';
import { useGetDriversQuery, useGetDriverQuery } from '../../../services/driversApi';
import { useGetPaymentMethodsQuery } from '../../../services/settingsApi';
import {
  useCreateSettlementMutation,
  useGetOutstandingCollectionsQuery,
  type CreateSettlementRequest,
  type DriverOutstandingCollections,
} from '../../../services/settlementsApi';
import type { SettlementSummary } from '../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorStatus,
  getApiValidationDetails,
  type UnknownApiError,
} from '../../../services/apiError';

import {
  legacyAmountError,
  makeProcessSettlementDefaults,
  processSettlementSchema,
  toCreateSettlementRequest,
  PROCESS_SETTLEMENT_FIELDS,
  type ProcessSettlementFormValues,
} from './processSettlement.schema';
import {
  UNATTRIBUTED_REASON_MIN_LENGTH,
  applyAllocationRejection,
  buildAllocationRequest,
  buildSettlementPreview,
  chooseSettlementFormat,
  draftForDriver,
  emptyAllocationDraft,
  reconcileDraft,
  validateAllocationDraft,
  type AllocationDraft,
  type ReconcileResult,
} from './settlementAllocation';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  classifySettlementError,
  isAmbiguousSettlementFailure,
  generateIdempotencyKey,
  needsPositionRefresh,
  resolveIdempotencyKey,
  settlementErrorMessage,
  type IdempotencyState,
} from './settlementSubmission';
import { settlementCapabilities } from './settlementPresentation';
import { OutstandingCollectionsPanel } from './OutstandingCollectionsPanel';
import { SettlementPreviewPanel } from './SettlementPreviewPanel';

/**
 * Process Driver Settlement (Phase 11.10; settlement allocation FR.9).
 *
 * A settlement records physical cash a driver hands back to the company. It
 * reduces driver cash and NEVER debits a customer wallet. Two request formats
 * (contract §5.2):
 *
 *   ALLOCATION — the driver holds settlement-mode collections (or the server
 *     required it): Finance explicitly selects collections and amounts, plus
 *     an optional explained unattributed amount. amountReceived is CALCULATED
 *     (Σ allocations + unattributed). Collections this settlement fully
 *     settles release their already-earned wallet credit / revenue on the
 *     server, in the same transaction.
 *   LEGACY — no settlement-mode money: the existing amount-only workflow,
 *     unchanged.
 *
 * ONE atomic `POST /api/v1/driver-settlements` per confirmed intent; the
 * server re-validates everything. The preview is provisional and is rebuilt
 * from freshly fetched collections before confirmation.
 *
 * IDEMPOTENCY (Phase 8.9): one key per intended settlement, bound to the
 * exact body (settlementSubmission.ts). Reused on retry; after an ambiguous
 * failure the request is locked to that body until the dialog closes. Keys
 * live in refs — never Redux, never localStorage.
 */

interface ProcessSettlementDialogProps {
  open: boolean;
  /** From `/management/driver-settlements?driverId=<uuid>` (Driver Detail entry). */
  initialDriverId?: string;
  onClose: () => void;
  onProcessed?: (settlement: SettlementSummary) => void;
}

type Step = 'form' | 'confirm' | 'done';

/** Outstanding collections per page (backend default 50, max 100). */
const OUTSTANDING_PAGE_SIZE = 50;

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

function staleMessage(result: ReconcileResult): string | null {
  const parts: string[] = [];
  if (result.removed.length > 0)
    parts.push(`${result.removed.length} selected collection(s) are no longer outstanding and were removed`);
  if (result.overAllocated.length > 0)
    parts.push(`${result.overAllocated.length} amount(s) now exceed the outstanding amount`);
  if (result.changed.length > 0 && result.removed.length === 0 && result.overAllocated.length === 0)
    parts.push(`${result.changed.length} selected collection(s) changed`);
  return parts.length > 0
    ? `Collections changed since they were loaded: ${parts.join('; ')}. Review the selection before continuing.`
    : null;
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
  const isDesktop = useMediaQuery(MD_QUERY);
  const caps = settlementCapabilities(usePermissions());

  const [step, setStep] = useState<Step>('form');
  const [formError, setFormError] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [doneSettlement, setDoneSettlement] = useState<SettlementSummary | null>(null);
  const [contractRequired, setContractRequired] = useState(false);
  const [page, setPage] = useState(1);
  const [draft, setDraft] = useState<AllocationDraft>(() => emptyAllocationDraft(initialDriverId));
  const [serverRowErrors, setServerRowErrors] = useState<Record<string, string>>({});
  const [unattributedServerError, setUnattributedServerError] = useState<string | null>(null);
  const [showAllErrors, setShowAllErrors] = useState(false);
  const [checking, setChecking] = useState(false);

  const idemRef = useRef<IdempotencyState>(INITIAL_IDEMPOTENCY_STATE);
  // Synchronous double-submit guard: a second click can arrive before React
  // re-renders the disabled button.
  const submittingRef = useRef(false);

  const [createSettlement, { isLoading: creating }] = useCreateSettlementMutation();

  const {
    control,
    register,
    handleSubmit,
    reset,
    setValue,
    setError,
    clearErrors,
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
  const paymentMethods = useGetPaymentMethodsQuery({ isActive: true });

  // Cash position + outstanding collections from ONE server snapshot. Fresh on
  // every open / driver / page (never a cached position from an earlier
  // session); also refreshed by every settlement / adjustment for the driver.
  const outstanding = useGetOutstandingCollectionsQuery(
    { driverId, page, limit: OUTSTANDING_PAGE_SIZE },
    { skip: !open || !driverId || !caps.canReadFinance, refetchOnMountOrArgChange: true },
  );
  // currentData: never show the previous driver's position while switching.
  const position: DriverOutstandingCollections | undefined =
    outstanding.currentData?.driverId === driverId ? outstanding.currentData : undefined;
  const totalPages = outstanding.currentData?.meta.totalPages ?? 1;
  const totalOutstanding = outstanding.currentData?.meta.total ?? 0;

  const methodOptions = useMemo(
    () => (paymentMethods.data ?? []).map((m) => ({ value: m.id, label: m.name })),
    [paymentMethods.data],
  );
  const methodName = methodOptions.find((m) => m.value === values.paymentMethodId)?.label ?? '';

  const format = chooseSettlementFormat(position ?? null, contractRequired);
  const isAllocation = format === 'ALLOCATION';

  const cashHeld = position?.cashBalance ?? null;
  const zeroCash = cashHeld !== null && isZeroMoney(cashHeld);
  const positionStatus = getApiErrorStatus(outstanding.error);
  const driverNotFound =
    !!driverId &&
    (positionStatus === 404 ||
      getApiErrorCode(outstanding.error) === 'NOT_FOUND' ||
      getApiErrorStatus(driver.error) === 404);

  const validation = validateAllocationDraft(draft, position ?? null);
  const preview = buildSettlementPreview(draft, position ?? null);
  const rowErrors = { ...validation.rowErrors, ...serverRowErrors };
  const unattributedTouched = draft.unattributedAmount.trim() !== '' || showAllErrors;
  const unattributedAmountError =
    unattributedServerError ?? (unattributedTouched ? validation.unattributedAmountError : undefined);
  const unattributedReasonError =
    unattributedTouched || draft.unattributedReason.trim() !== ''
      ? validation.unattributedReasonError
      : undefined;

  const legacyError = legacyAmountError(values.amountReceived, cashHeld);
  const legacyOverBalance =
    values.amountReceived.trim() !== '' && legacyError === 'Amount exceeds the cash held';
  const legacyBalanceAfter =
    cashHeld !== null && !legacyError ? subtractMoney(cashHeld, values.amountReceived.trim()) : null;

  const driverLabel = driver.data
    ? `${driver.data.driverNumber} · ${driver.data.user.firstName} ${driver.data.user.lastName}`
    : undefined;
  const dataAsOf = outstanding.fulfilledTimeStamp
    ? new Date(outstanding.fulfilledTimeStamp).toLocaleTimeString()
    : null;

  const changeDraft = (next: AllocationDraft) => {
    setDraft(next);
    setServerRowErrors({});
    setUnattributedServerError(null);
  };

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
      setContractRequired(false);
      setPage(1);
      setDraft(emptyAllocationDraft(initialDriverId));
      setServerRowErrors({});
      setUnattributedServerError(null);
      setShowAllErrors(false);
      idemRef.current = INITIAL_IDEMPOTENCY_STATE;
      submittingRef.current = false;
    }
    wasOpen.current = open;
  }, [open, initialDriverId, reset]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  // Driver switch: selections never carry over to another driver.
  useEffect(() => {
    setDraft((d) => draftForDriver(d, driverId));
    setPage(1);
    setContractRequired(false);
    setServerRowErrors({});
    setUnattributedServerError(null);
    setShowAllErrors(false);
  }, [driverId]);

  // A preview is never final: if the collections change while it is shown
  // (another settlement, a correction), send Finance back to review them.
  // Not while an ambiguous attempt is pending: it may have committed (that
  // alone changes the collections), and the only safe action is retrying the
  // SAME request, which the server replays.
  useEffect(() => {
    if (step !== 'confirm' || !isAllocation || !position || creating || ambiguous) return;
    const result = reconcileDraft(draft, position, { completeList: totalPages <= 1 });
    const message = staleMessage(result);
    if (message) {
      setDraft(result.draft);
      setStep('form');
      setFormError(message);
    }
    // Re-run only when fresh server data arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position]);

  /* ------------------------------- review ------------------------------ */
  const canReview =
    caps.canReadFinance && !!position && !zeroCash && !paymentMethods.isError && !checking;

  const goToConfirm = handleSubmit(async (v) => {
    if (!canReview) return;
    setShowAllErrors(true);
    setFormError(null);

    if (!isAllocation) {
      const err = legacyAmountError(v.amountReceived, cashHeld);
      if (err) {
        setError('amountReceived', { type: 'manual', message: err });
        return;
      }
      setStep('confirm');
      return;
    }

    if (!validation.valid) return;
    // Rebuild the preview from fresh collections — never confirm a stale one.
    setChecking(true);
    try {
      const fresh = await outstanding.refetch();
      const data = fresh.data;
      if (!data || data.driverId !== driverId) {
        setFormError('Could not refresh the outstanding collections. Try again.');
        return;
      }
      const result = reconcileDraft(draft, data, { completeList: data.meta.totalPages <= 1 });
      const message = staleMessage(result);
      if (message) {
        changeDraft(result.draft);
        setFormError(message);
        return;
      }
      if (!validateAllocationDraft(result.draft, data).valid) return;
      setStep('confirm');
    } finally {
      setChecking(false);
    }
  });

  /* ------------------------------- submit ------------------------------ */
  const runSettlement = async () => {
    if (submittingRef.current) return;
    submittingRef.current = true;

    const body: CreateSettlementRequest = isAllocation
      ? buildAllocationRequest(draft, { paymentMethodId: values.paymentMethodId, notes: values.notes })
      : toCreateSettlementRequest(values);
    const resolution = resolveIdempotencyKey(idemRef.current, JSON.stringify(body), generateIdempotencyKey);
    if (!resolution.ok) {
      submittingRef.current = false;
      setFormError(
        'An earlier attempt may already have been processed. Retry it unchanged, or close this dialog and check the settlement history.',
      );
      return;
    }
    idemRef.current = resolution.state;
    const selections = Object.values(draft.selections);
    const affected = isAllocation
      ? {
          customerIds: selections.map((s) => s.item.customer.id),
          orderIds: selections.map((s) => s.item.order.id),
        }
      : undefined;

    setFormError(null);
    try {
      const settlement = await createSettlement({ body, idempotencyKey: resolution.key, affected }).unwrap();
      idemRef.current = afterSuccess();
      setAmbiguous(false);
      setDoneSettlement(settlement);
      setStep('done');
      onProcessed?.(settlement);
    } catch (e) {
      const err = e as UnknownApiError;
      const kind = classifySettlementError(err);
      const ambiguousFailure = isAmbiguousSettlementFailure(kind);
      idemRef.current = afterFailure(idemRef.current, ambiguousFailure);
      setAmbiguous(idemRef.current.ambiguous);
      setFormError(settlementErrorMessage(kind));
      if (ambiguousFailure) return; // stay on confirm: retry the same request only

      setStep('form');
      let nextDraft = draft;
      if (kind.kind === 'ALLOCATION_INVALID' && kind.releaseId) {
        const rejection = applyAllocationRejection(draft, kind.releaseId, kind.problem);
        nextDraft = rejection.draft;
        setDraft(nextDraft);
        setFormError(rejection.message);
        if (!rejection.removed) setServerRowErrors({ [kind.releaseId]: kind.problem });
      } else if (kind.kind === 'UNATTRIBUTED_EXCEEDS_BALANCE') {
        setUnattributedServerError(settlementErrorMessage(kind));
      } else if (kind.kind === 'ALLOCATION_CONTRACT_REQUIRED') {
        setContractRequired(true);
      } else if (kind.kind === 'VALIDATION' && applyServerFieldErrors(err, setError)) {
        setFormError('Please fix the highlighted fields and try again.');
      }
      if (needsPositionRefresh(kind) && caps.canReadFinance && driverId) {
        const fresh = await outstanding.refetch();
        if (fresh.data && fresh.data.driverId === driverId && isAllocation) {
          setDraft(reconcileDraft(nextDraft, fresh.data, { completeList: fresh.data.meta.totalPages <= 1 }).draft);
        }
      }
    } finally {
      submittingRef.current = false;
    }
  };

  /* ------------------------------- render ------------------------------ */
  const dialogClass = cn(
    'm-auto w-[calc(100vw-2rem)] rounded-card border border-line',
    'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
    'max-h-[calc(100vh-3rem)]',
    isAllocation ? 'max-w-5xl' : 'max-w-lg',
  );

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={formError ? formErrorId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        if (!creating) onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current && !creating) onClose();
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
          disabled={creating}
          aria-label="Close"
          className="rounded-control p-1 text-ink-muted hover:bg-neutral-50 hover:text-ink disabled:opacity-50"
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

              {!caps.canReadFinance && (
                <p role="alert" className="rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
                  Processing a settlement needs the driver&rsquo;s cash position,
                  which requires finance read access. Ask an administrator for
                  the <code>finance.read</code> permission.
                </p>
              )}

              {driverNotFound && (
                <p className="text-xs text-danger-700">
                  The selected driver could not be found. Choose another driver.
                </p>
              )}

              {driverId && caps.canReadFinance && outstanding.isLoading && (
                <LoadingState className="py-4" label="Loading driver cash and collections…" />
              )}

              {driverId && outstanding.isError && !driverNotFound && (
                <div className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
                  Could not load the driver&rsquo;s cash position.{' '}
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => void outstanding.refetch()}
                  >
                    Retry
                  </button>
                </div>
              )}

              {position && driver.data && !driver.data.isActive && (
                <p className="text-xs text-warning-700">
                  This driver is inactive. Cash they physically hold on behalf
                  of the company can still be settled.
                </p>
              )}

              {position && !isAllocation && (
                <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2.5 text-sm">
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

            {position && zeroCash ? (
              <p className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm text-ink-muted">
                No cash currently held by this driver.
              </p>
            ) : position && isAllocation ? (
              <>
                <FormSection title="Collections">
                  <OutstandingCollectionsPanel
                    position={position}
                    page={page}
                    totalPages={totalPages}
                    total={totalOutstanding}
                    onPageChange={setPage}
                    fetching={outstanding.isFetching}
                    draft={draft}
                    onDraftChange={changeDraft}
                    rowErrors={rowErrors}
                    isDesktop={isDesktop}
                    disabled={creating || checking}
                  />
                </FormSection>

                <FormSection title="Unattributed cash">
                  <p className="text-xs text-ink-muted">
                    Cash not reserved for any collection above (legacy
                    collections, adjustments, settlement corrections). It cannot
                    exceed the driver&rsquo;s unattributed cash of{' '}
                    <strong className="tabular-nums">{formatMoney(position.unattributedBalance)}</strong>{' '}
                    and never releases an order.
                  </p>
                  <MoneyInput
                    label="Unattributed amount (optional)"
                    value={draft.unattributedAmount}
                    onChange={(v) => changeDraft({ ...draft, unattributedAmount: v })}
                    error={unattributedAmountError}
                    disabled={creating || checking}
                  />
                  <TextAreaField
                    label="Reason for the unattributed amount"
                    rows={2}
                    required={(parseMoneyToCents(draft.unattributedAmount || '0') ?? 0n) > 0n}
                    hint={`Required when an unattributed amount is entered (at least ${UNATTRIBUTED_REASON_MIN_LENGTH} characters).`}
                    value={draft.unattributedReason}
                    onChange={(e) => changeDraft({ ...draft, unattributedReason: e.target.value })}
                    error={unattributedReasonError}
                    disabled={creating || checking}
                  />
                </FormSection>

                <FormSection title="Settlement">
                  <CalculatedField
                    label="Amount received"
                    supportingText="Allocated to orders + unattributed — calculated, exact cents"
                    value={formatMoney(formatCents(validation.amountReceivedCents))}
                    emphasis
                  />
                  {showAllErrors && validation.formErrors.length > 0 && (
                    <ul role="alert" className="space-y-1 text-xs text-danger-700">
                      {validation.formErrors.map((m) => (
                        <li key={m}>{m}</li>
                      ))}
                    </ul>
                  )}
                  <PaymentAndNotes
                    register={register}
                    errors={errors}
                    methodOptions={methodOptions}
                    paymentMethods={paymentMethods}
                  />
                </FormSection>
              </>
            ) : position ? (
              <FormSection title="Settlement">
                <Controller
                  control={control}
                  name="amountReceived"
                  render={({ field }) => (
                    <div className="space-y-1.5">
                      <MoneyInput
                        label="Amount received"
                        required
                        value={field.value}
                        onChange={(v) => {
                          field.onChange(v);
                          clearErrors('amountReceived');
                        }}
                        error={
                          errors.amountReceived?.message ??
                          (legacyOverBalance
                            ? `Amount exceeds the cash held (${formatMoney(cashHeld)}).`
                            : undefined)
                        }
                      />
                      <button
                        type="button"
                        className="text-xs font-medium text-brand-600 hover:text-brand-700"
                        onClick={() => {
                          const c = cashHeld !== null ? parseMoneyToCents(cashHeld) : null;
                          setValue('amountReceived', c !== null ? formatCents(c) : (cashHeld ?? ''), {
                            shouldTouch: true,
                          });
                          clearErrors('amountReceived');
                        }}
                      >
                        Settle full balance
                      </button>
                    </div>
                  )}
                />
                <PaymentAndNotes
                  register={register}
                  errors={errors}
                  methodOptions={methodOptions}
                  paymentMethods={paymentMethods}
                />
              </FormSection>
            ) : null}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={onClose} disabled={creating}>
                Cancel
              </Button>
              <Button type="submit" disabled={creating || !canReview} loading={checking}>
                Review settlement
              </Button>
            </div>
          </form>
        )}

        {step === 'confirm' && (
          <div className="space-y-4">
            {isAllocation ? (
              <SettlementPreviewPanel
                preview={preview}
                driverLabel={driverLabel ?? '—'}
                methodName={methodName}
                notes={values.notes.trim()}
                dataAsOf={dataAsOf}
              />
            ) : (
              <>
                <p className="text-sm text-ink-secondary">
                  You are recording that{' '}
                  <strong>{driver.data?.user.firstName} {driver.data?.user.lastName}</strong>{' '}
                  returned{' '}
                  <strong className="tabular-nums">{formatMoney(values.amountReceived)}</strong>{' '}
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
                  <ConfirmRow label="Driver" value={driverLabel ?? '—'} />
                  <ConfirmRow label="Current cash held" value={formatMoney(cashHeld)} />
                  <ConfirmRow label="Settlement amount" value={formatMoney(values.amountReceived)} emphasis />
                  <ConfirmRow label="Payment method" value={methodName || '—'} />
                  {values.notes.trim() !== '' && <ConfirmRow label="Notes" value={values.notes.trim()} />}
                  {legacyBalanceAfter !== null && (
                    <ConfirmRow label="Expected cash held after settlement" value={formatMoney(legacyBalanceAfter)} />
                  )}
                </dl>
                <p className="text-xs text-ink-muted">
                  The server validates the final balance at processing time. This
                  does <strong>not</strong> change customer wallet balances, customer
                  payouts, company revenue or order totals.
                </p>
              </>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              {ambiguous ? (
                <Button type="button" variant="secondary" onClick={onClose} disabled={creating}>
                  Close and check history
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="secondary"
                  icon={<ArrowLeft />}
                  onClick={() => {
                    setFormError(null);
                    setStep('form');
                  }}
                  disabled={creating}
                >
                  Back
                </Button>
              )}
              <Button
                type="button"
                onClick={() => void runSettlement()}
                loading={creating}
                disabled={creating || (isAllocation && outstanding.isFetching)}
              >
                {ambiguous ? 'Retry settlement' : 'Process settlement'}
              </Button>
            </div>
          </div>
        )}

        {step === 'done' && doneSettlement && (
          <div className="space-y-4">
            <div role="status" className="rounded-control border border-success-200 bg-success-50 px-4 py-3 text-sm text-success-700">
              Settlement processed successfully.
            </div>
            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <ConfirmRow label="Settlement number" value={doneSettlement.settlementNumber} />
              <ConfirmRow label="Amount received" value={formatMoney(doneSettlement.amountReceived)} emphasis />
              {doneSettlement.allocatedTotal !== null && (
                <ConfirmRow label="Allocated to orders" value={formatMoney(doneSettlement.allocatedTotal)} />
              )}
              {doneSettlement.unattributedAmount !== null && (
                <ConfirmRow label="Unattributed" value={formatMoney(doneSettlement.unattributedAmount)} />
              )}
              <ConfirmRow label="Driver cash after" value={formatMoney(doneSettlement.balanceAfter)} />
            </dl>
            <div className="flex flex-wrap justify-end gap-2 pt-1">
              <Link
                to={paths.management.driverSettlementDetail(doneSettlement.id)}
                onClick={onClose}
                className="inline-flex h-10 items-center rounded-control border border-line bg-card px-4 text-sm font-medium text-ink-secondary hover:bg-sunken"
              >
                View settlement
              </Link>
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

function PaymentAndNotes({
  register,
  errors,
  methodOptions,
  paymentMethods,
}: {
  register: UseFormRegister<ProcessSettlementFormValues>;
  errors: FieldErrors<ProcessSettlementFormValues>;
  methodOptions: { value: string; label: string }[];
  paymentMethods: { isLoading: boolean; isError: boolean; refetch: () => unknown };
}) {
  return (
    <>
      <SelectField
        label="Payment method"
        required
        placeholder={paymentMethods.isLoading ? 'Loading methods…' : 'Select a method…'}
        options={methodOptions}
        error={errors.paymentMethodId?.message}
        disabled={paymentMethods.isLoading || paymentMethods.isError}
        {...register('paymentMethodId')}
      />
      {paymentMethods.isError && (
        <div className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
          Could not load payment methods.{' '}
          <button type="button" className="font-medium underline" onClick={() => void paymentMethods.refetch()}>
            Retry
          </button>
        </div>
      )}
      <TextAreaField label="Notes (optional)" rows={2} error={errors.notes?.message} {...register('notes')} />
    </>
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
