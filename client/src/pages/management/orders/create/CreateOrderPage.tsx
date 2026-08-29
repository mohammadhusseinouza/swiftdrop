import { useEffect, useId, useMemo, useState } from 'react';
import { Controller, useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { paths } from '../../../../routes/paths';
import { useHasPermission } from '../../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../../features/auth/permissions';
import { useDebouncedValue } from '../../../../lib/useDebouncedValue';
import {
  useCreateOrderMutation,
  useAssignOrderMutation,
} from '../../../../services/ordersApi';
import type { OrderDetail } from '../../../../services/domain.types';
import { useGetCustomersQuery, useGetCustomerQuery } from '../../../../services/customersApi';
import { useGetDriversQuery, useGetDriverQuery } from '../../../../services/driversApi';
import { useGetAreasQuery, useGetPaymentMethodsQuery } from '../../../../services/settingsApi';
import {
  getApiErrorStatus,
  getApiValidationDetails,
  getApiErrorMessage,
  isTransportError,
  type UnknownApiError,
} from '../../../../services/apiError';

import { PageHeader } from '../../../../components/data-display/PageHeader';
import { FormSection } from '../../../../components/forms/FormSection';
import {
  TextField,
  TextAreaField,
  SelectField,
} from '../../../../components/forms/Field';
import { MoneyInput } from '../../../../components/forms/MoneyInput';
import { CalculatedField } from '../../../../components/forms/CalculatedField';
import { ServerSearchSelect } from '../../../../components/forms/ServerSearchSelect';
import { Button } from '../../../../components/ui/Button';
import { ConfirmationModal } from '../../../../components/feedback/ConfirmationModal';
import { formatMoney } from '../../../../lib/format';

import {
  createOrderSchema,
  CREATE_ORDER_DEFAULTS,
  toCreateOrderRequest,
  type CreateOrderFormValues,
} from './createOrder.schema';
import {
  calculateOrderPreview,
  moneyIsPositive,
} from './createOrderFinancialPreview';
import { CreateOrderReview } from './CreateOrderReview';

type SubmitMode = 'create' | 'createAndAssign';

const FORM_FIELDS = new Set<string>(Object.keys(CREATE_ORDER_DEFAULTS));

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Map a backend 400 VALIDATION_ERROR tree onto individual form fields. */
function applyServerFieldErrors(
  error: UnknownApiError,
  setError: UseFormSetError<CreateOrderFormValues>,
): boolean {
  const details = getApiValidationDetails(error);
  const props =
    details && typeof details === 'object'
      ? (details as { properties?: Record<string, { errors?: unknown }> }).properties
      : undefined;
  if (!props) return false;

  let mapped = false;
  for (const [key, node] of Object.entries(props)) {
    if (!FORM_FIELDS.has(key)) continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof CreateOrderFormValues, { type: 'server', message });
      mapped = true;
    }
  }
  return mapped;
}

function safeMutationMessage(error: UnknownApiError, serverFallback: string): string {
  if (isTransportError(error)) return 'Unable to reach the server. Please try again.';
  const status = getApiErrorStatus(error);
  if (typeof status === 'number' && status >= 500) return serverFallback;
  return getApiErrorMessage(error);
}

const ORDER_TYPE_OPTIONS = [
  {
    value: 'DELIVERY_ONLY',
    title: 'Delivery Only',
    hint: 'The product belongs to the customer / sender.',
  },
  {
    value: 'COMPANY_ORDER',
    title: 'Company Order',
    hint: 'The product belongs to the company.',
  },
] as const;

const PAYMENT_TYPE_OPTIONS = [
  {
    value: 'CASH_ON_DELIVERY',
    title: 'Cash on Delivery',
    hint: 'Nothing paid in advance.',
  },
  {
    value: 'ALREADY_PAID',
    title: 'Already Paid',
    hint: 'Order amount fully prepaid; the delivery fee may still be due.',
  },
  {
    value: 'PARTIALLY_PAID',
    title: 'Partially Paid',
    hint: 'Part of the order is prepaid; a balance remains.',
  },
] as const;

export default function CreateOrderPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const canAssign = useHasPermission(PERMISSIONS.ORDERS_ASSIGN);
  const formErrorId = useId();

  // Optional preselection: `/management/orders/new?customerId=<uuid>` (used by
  // the "Create order" action on the Customer Detail page). Only a well-formed
  // UUID is honoured; the customer picker resolves the label and the backend
  // still validates the reference on submit.
  const preselectedCustomerId = (() => {
    const raw = searchParams.get('customerId');
    return raw && UUID_RE.test(raw) ? raw : '';
  })();

  const {
    register,
    control,
    handleSubmit,
    watch,
    setValue,
    getValues,
    setError,
    formState: { errors, isDirty, isSubmitting },
  } = useForm<CreateOrderFormValues>({
    resolver: zodResolver(createOrderSchema),
    mode: 'onTouched',
    defaultValues: preselectedCustomerId
      ? { ...CREATE_ORDER_DEFAULTS, customerId: preselectedCustomerId }
      : CREATE_ORDER_DEFAULTS,
  });

  const [createOrder, { isLoading: creating }] = useCreateOrderMutation();
  const [assignOrder, { isLoading: assigning }] = useAssignOrderMutation();

  // The Order once it exists — set only after a successful POST /orders.
  // Its presence flips the page into "already created" mode: the create
  // actions disappear so the order can never be POSTed twice.
  const [created, setCreated] = useState<OrderDetail | null>(null);
  const [pending, setPending] = useState<SubmitMode | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);

  const values = watch();
  const preview = calculateOrderPreview(values);
  // `pending` / `isSubmitting` also cover the async validate + the create→assign
  // gap, so a rapid second click can never fire a second POST /orders.
  const busy = creating || assigning || isSubmitting || pending !== null;

  const prepaidPositive =
    moneyIsPositive(values.prepaidOrderAmount) ||
    moneyIsPositive(values.prepaidDeliveryFee);
  const collectPositive =
    preview.amountToCollect !== null && moneyIsPositive(preview.amountToCollect);

  /* -------------------- reference data -------------------- */
  const areas = useGetAreasQuery({ isActive: true, limit: 100 });
  const paymentMethods = useGetPaymentMethodsQuery({ isActive: true });

  const [customerTerm, setCustomerTerm] = useState('');
  const debouncedCustomerTerm = useDebouncedValue(customerTerm, 300);
  const customers = useGetCustomersQuery({
    search: debouncedCustomerTerm.trim() || undefined,
    isActive: true,
    limit: 20,
  });
  const selectedCustomer = useGetCustomerQuery(values.customerId, {
    skip: !values.customerId,
  });

  const [driverTerm, setDriverTerm] = useState('');
  const debouncedDriverTerm = useDebouncedValue(driverTerm, 300);
  const drivers = useGetDriversQuery(
    { search: debouncedDriverTerm.trim() || undefined, isActive: true, limit: 20 },
    { skip: !canAssign },
  );
  const selectedDriver = useGetDriverQuery(values.driverId, {
    skip: !values.driverId || !canAssign,
  });

  const areaOptions = useMemo(
    () =>
      (areas.data?.items ?? []).map((a) => ({ value: a.id, label: a.name })),
    [areas.data],
  );
  const methodOptions = useMemo(
    () => (paymentMethods.data ?? []).map((m) => ({ value: m.id, label: m.name })),
    [paymentMethods.data],
  );

  /* ---------- payment-type driven field normalization ---------- */
  const paymentType = values.paymentType;
  const orderAmount = values.orderAmount;
  useEffect(() => {
    if (paymentType === 'CASH_ON_DELIVERY') {
      if (getValues('prepaidOrderAmount') !== '0.00') {
        setValue('prepaidOrderAmount', '0.00', { shouldValidate: true });
      }
      if (getValues('prepaidDeliveryFee') !== '0.00') {
        setValue('prepaidDeliveryFee', '0.00', { shouldValidate: true });
      }
    } else if (paymentType === 'ALREADY_PAID') {
      // ALREADY_PAID means the order amount is fully prepaid — keep the
      // prepaid-order field mirrored (it is rendered disabled below).
      if (getValues('prepaidOrderAmount') !== orderAmount) {
        setValue('prepaidOrderAmount', orderAmount, { shouldValidate: true });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentType, orderAmount]);

  // Clear a payment method when its money reason disappears (predictable:
  // "no prepaid amount" / "nothing to collect" -> no method).
  useEffect(() => {
    if (!prepaidPositive && getValues('prepaidPaymentMethodId')) {
      setValue('prepaidPaymentMethodId', '', { shouldValidate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepaidPositive]);
  useEffect(() => {
    if (!collectPositive && getValues('collectionPaymentMethodId')) {
      setValue('collectionPaymentMethodId', '', { shouldValidate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectPositive]);

  /* -------------------- submit -------------------- */
  const goToOrder = (order: OrderDetail, assigned: boolean) => {
    navigate(paths.management.orderDetail(order.id), {
      state: {
        justCreated: true,
        assigned,
        orderNumber: order.orderNumber,
        trackingCode: order.trackingCode,
      },
    });
  };

  const run = async (formValues: CreateOrderFormValues, mode: SubmitMode) => {
    if (pending) return;
    setPending(mode);
    setFormError(null);
    setAssignError(null);

    try {
      let order = created;
      if (!order) {
        try {
          order = await createOrder(toCreateOrderRequest(formValues)).unwrap();
          setCreated(order);
        } catch (e) {
          const err = e as UnknownApiError;
          if (isTransportError(err)) {
            setFormError(
              'We could not confirm whether the order was created. Check the Orders list before submitting again.',
            );
            return;
          }
          if (!applyServerFieldErrors(err, setError)) {
            setFormError(safeMutationMessage(err, 'Could not create the order. Please try again.'));
          } else {
            setFormError('Please fix the highlighted fields and try again.');
          }
          return;
        }
      }

      if (mode === 'createAndAssign' && formValues.driverId) {
        try {
          const assignedOrder = await assignOrder({
            id: order.id,
            driverId: formValues.driverId,
          }).unwrap();
          goToOrder(assignedOrder, true);
          return;
        } catch (e) {
          setAssignError(
            safeMutationMessage(
              e as UnknownApiError,
              'Could not assign a driver. The order was still created.',
            ),
          );
          return;
        }
      }

      goToOrder(order, false);
    } finally {
      setPending(null);
    }
  };

  const runCreate = handleSubmit((v) => run(v, 'create'));
  const runCreateAndAssign = handleSubmit((v) => run(v, 'createAndAssign'));

  const attemptLeave = () => {
    if (isDirty && !created) setShowLeaveConfirm(true);
    else navigate(paths.management.orders);
  };

  /* -------------------- derived review labels -------------------- */
  const reviewLabels = {
    customer: selectedCustomer.data
      ? `${selectedCustomer.data.customerNumber} · ${selectedCustomer.data.name}`
      : null,
    area:
      areaOptions.find((o) => o.value === values.receiverAreaId)?.label ?? null,
    prepaidMethod:
      methodOptions.find((o) => o.value === values.prepaidPaymentMethodId)?.label ??
      null,
    collectionMethod:
      methodOptions.find((o) => o.value === values.collectionPaymentMethodId)
        ?.label ?? null,
    driver: selectedDriver.data
      ? `${selectedDriver.data.driverNumber} · ${selectedDriver.data.user.firstName} ${selectedDriver.data.user.lastName}`
      : null,
  };

  const previewMoney = (v: string | null) => (v ? formatMoney(v) : '—');
  const alreadyPaid = paymentType === 'ALREADY_PAID';
  const cod = paymentType === 'CASH_ON_DELIVERY';

  return (
    <div className="mx-auto max-w-3xl space-y-5 pb-4">
      <button
        type="button"
        onClick={attemptLeave}
        className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to orders
      </button>

      <PageHeader
        size="lg"
        title="Create Order"
        description="Create a new delivery order. The server generates the order number, tracking code and status."
      />

      {formError && (
        <div
          id={formErrorId}
          role="alert"
          className="flex items-start gap-2 rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700"
        >
          <span
            className="mt-0.5 size-1.5 shrink-0 rounded-full bg-current"
            aria-hidden="true"
          />
          {formError}
        </div>
      )}

      <form
        noValidate
        onSubmit={(e) => e.preventDefault()}
        className="space-y-5"
      >
        {/* Sections 1-4 lock once the order exists (no re-POST possible). */}
        <fieldset disabled={!!created} className="space-y-5 disabled:opacity-70">
          <FormSection
            title="Customer & order type"
            description="Who is sending this order, and which accounting model applies."
          >
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
                    label: `${c.customerNumber} · ${c.name}${c.primaryPhone ? ` · ${c.primaryPhone}` : ''}`,
                  }))}
                  selectedLabel={
                    selectedCustomer.data
                      ? `${selectedCustomer.data.customerNumber} · ${selectedCustomer.data.name}`
                      : undefined
                  }
                  error={errors.customerId?.message}
                />
              )}
            />

            {selectedCustomer.data && (
              <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm">
                <p className="font-medium text-ink">
                  {selectedCustomer.data.customerNumber} · {selectedCustomer.data.name}
                </p>
                <p className="text-ink-muted">
                  {selectedCustomer.data.primaryPhone}
                  {selectedCustomer.data.email ? ` · ${selectedCustomer.data.email}` : ''}
                  {selectedCustomer.data.area ? ` · ${selectedCustomer.data.area.name}` : ''}
                </p>
                {!selectedCustomer.data.isActive && (
                  <p className="mt-0.5 text-danger-700">
                    This customer is inactive and cannot receive new orders.
                  </p>
                )}
              </div>
            )}

            <RadioCards
              legend="Order type"
              name="orderType"
              options={ORDER_TYPE_OPTIONS}
              register={register}
              error={errors.orderType?.message}
            />
          </FormSection>

          <FormSection
            title="Receiver"
            description="Delivery contact and address. Stored as a snapshot on the order — it does not change if the customer's details change later."
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Receiver name"
                required
                autoComplete="off"
                error={errors.receiverName?.message}
                {...register('receiverName')}
              />
              <TextField
                label="Primary phone"
                required
                inputMode="tel"
                autoComplete="off"
                error={errors.receiverPhone?.message}
                {...register('receiverPhone')}
              />
              <TextField
                label="Alternative phone"
                inputMode="tel"
                autoComplete="off"
                error={errors.receiverAltPhone?.message}
                {...register('receiverAltPhone')}
              />
              <SelectField
                label="Area"
                required
                placeholder={areas.isLoading ? 'Loading areas…' : 'Select an area…'}
                options={areaOptions}
                error={errors.receiverAreaId?.message}
                {...register('receiverAreaId')}
              />
            </div>
            <TextAreaField
              label="Full address"
              required
              rows={2}
              error={errors.receiverAddress?.message}
              {...register('receiverAddress')}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField
                label="Building / floor"
                autoComplete="off"
                error={errors.receiverBuildingFloor?.message}
                {...register('receiverBuildingFloor')}
              />
              <TextField
                label="Map / location link"
                hint="Plain URL or text — no map picker in V1."
                autoComplete="off"
                error={errors.receiverMapLink?.message}
                {...register('receiverMapLink')}
              />
            </div>
            <TextAreaField
              label="Delivery instructions"
              rows={2}
              error={errors.receiverInstructions?.message}
              {...register('receiverInstructions')}
            />
          </FormSection>

          <FormSection title="Package">
            <TextAreaField
              label="Description"
              required
              rows={2}
              error={errors.description?.message}
              {...register('description')}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              <TextField
                label="Number of packages"
                inputMode="numeric"
                error={errors.packageCount?.message}
                {...register('packageCount')}
              />
              <TextField
                label="Quantity"
                inputMode="numeric"
                error={errors.quantity?.message}
                {...register('quantity')}
              />
              <TextField
                label="Weight (kg)"
                inputMode="decimal"
                hint="Up to 3 decimals."
                error={errors.weightKg?.message}
                {...register('weightKg')}
              />
            </div>
            <TextAreaField
              label="Package notes"
              rows={2}
              error={errors.packageNotes?.message}
              {...register('packageNotes')}
            />
          </FormSection>

          <FormSection
            title="Payment"
            description="Order value and delivery fee are tracked separately, and so are their prepaid portions."
          >
            <RadioCards
              legend="Payment type"
              name="paymentType"
              options={PAYMENT_TYPE_OPTIONS}
              register={register}
              error={errors.paymentType?.message}
            />

            <div className="grid gap-4 sm:grid-cols-2">
              <Controller
                control={control}
                name="orderAmount"
                render={({ field }) => (
                  <MoneyInput
                    label="Order amount"
                    required
                    value={field.value}
                    onChange={field.onChange}
                    error={errors.orderAmount?.message}
                  />
                )}
              />
              <Controller
                control={control}
                name="deliveryFee"
                render={({ field }) => (
                  <MoneyInput
                    label="Delivery fee"
                    required
                    value={field.value}
                    onChange={field.onChange}
                    error={errors.deliveryFee?.message}
                  />
                )}
              />
              <Controller
                control={control}
                name="prepaidOrderAmount"
                render={({ field }) => (
                  <MoneyInput
                    label="Prepaid order amount"
                    value={field.value}
                    onChange={field.onChange}
                    disabled={cod || alreadyPaid}
                    hint={
                      cod
                        ? 'Cash on Delivery — must be 0.'
                        : alreadyPaid
                          ? 'Already Paid — mirrors the order amount.'
                          : undefined
                    }
                    error={errors.prepaidOrderAmount?.message}
                  />
                )}
              />
              <Controller
                control={control}
                name="prepaidDeliveryFee"
                render={({ field }) => (
                  <MoneyInput
                    label="Prepaid delivery fee"
                    value={field.value}
                    onChange={field.onChange}
                    disabled={cod}
                    hint={cod ? 'Cash on Delivery — must be 0.' : undefined}
                    error={errors.prepaidDeliveryFee?.message}
                  />
                )}
              />
              <SelectField
                label="Prepaid payment method"
                placeholder={
                  paymentMethods.isLoading ? 'Loading methods…' : 'Select a method…'
                }
                options={methodOptions}
                disabled={!prepaidPositive}
                hint={
                  !prepaidPositive
                    ? 'Enabled once a prepaid amount is entered.'
                    : undefined
                }
                error={errors.prepaidPaymentMethodId?.message}
                {...register('prepaidPaymentMethodId')}
              />
              <SelectField
                label="Collection payment method"
                placeholder={
                  paymentMethods.isLoading ? 'Loading methods…' : 'Select a method…'
                }
                options={methodOptions}
                disabled={!collectPositive}
                hint={
                  !collectPositive
                    ? 'Enabled when an amount remains to collect.'
                    : undefined
                }
                error={errors.collectionPaymentMethodId?.message}
                {...register('collectionPaymentMethodId')}
              />
            </div>

            <div className="space-y-2">
              <CalculatedField
                label="Remaining order amount"
                value={previewMoney(preview.remainingOrderAmount)}
              />
              <CalculatedField
                label="Remaining delivery fee"
                value={previewMoney(preview.remainingDeliveryFee)}
              />
              <CalculatedField
                label="Amount to collect"
                value={previewMoney(preview.amountToCollect)}
                emphasis
              />
              <p className="text-xs text-ink-muted">
                Preview only. Final totals are recalculated by the server when the
                order is created.
              </p>
            </div>
          </FormSection>
        </fieldset>

        {/* Assignment stays editable after create so a failed assignment can
            be retried without re-creating the order. */}
        {canAssign && (
          <FormSection
            title="Delivery assignment"
            description="Optional. Assigning a driver here runs a separate request after the order is created (RECEIVED → ASSIGNED)."
          >
            <Controller
              control={control}
              name="driverId"
              render={({ field }) => (
                <ServerSearchSelect
                  label="Driver"
                  variant="field"
                  anyLabel="Leave unassigned"
                  searchPlaceholder="Search active drivers…"
                  value={field.value}
                  onChange={field.onChange}
                  searchTerm={driverTerm}
                  onSearchTermChange={setDriverTerm}
                  loading={drivers.isFetching}
                  total={drivers.data?.meta.total}
                  options={(drivers.data?.items ?? []).map((d) => ({
                    id: d.id,
                    label: `${d.driverNumber} · ${d.user.firstName} ${d.user.lastName}${d.user.phone ? ` · ${d.user.phone}` : ''}`,
                  }))}
                  selectedLabel={
                    selectedDriver.data
                      ? `${selectedDriver.data.driverNumber} · ${selectedDriver.data.user.firstName} ${selectedDriver.data.user.lastName}`
                      : undefined
                  }
                  error={errors.driverId?.message}
                />
              )}
            />
          </FormSection>
        )}

        <FormSection title="Review">
          <CreateOrderReview values={values} labels={reviewLabels} preview={preview} />
        </FormSection>

        {/* Actions / partial-success */}
        {created && assignError ? (
          <div
            role="alert"
            className="space-y-3 rounded-card border border-warning-200 bg-warning-50 p-4 text-sm"
          >
            <p className="font-medium text-ink">
              Order {created.orderNumber} was created, but the driver assignment
              failed.
            </p>
            <p className="text-ink-secondary">{assignError}</p>
            <p className="text-ink-muted">
              Tracking code: {created.trackingCode}. The order exists — do not
              create it again. Pick a driver above and retry, or open the order.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={runCreateAndAssign}
                loading={pending === 'createAndAssign'}
                disabled={busy || !values.driverId}
              >
                Retry assignment
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => goToOrder(created, false)}
              >
                Open order
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => navigate(paths.management.orders)}
              >
                Back to orders
              </Button>
            </div>
          </div>
        ) : created ? (
          <div className="rounded-card border border-line bg-card p-4 text-sm text-ink-muted">
            Order {created.orderNumber} created. Finishing up…
          </div>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button type="button" variant="secondary" onClick={attemptLeave} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant={canAssign ? 'secondary' : 'primary'}
              onClick={runCreate}
              loading={pending === 'create'}
              disabled={busy}
            >
              Create order
            </Button>
            {canAssign && (
              <Button
                type="button"
                onClick={runCreateAndAssign}
                loading={pending === 'createAndAssign'}
                disabled={busy || !values.driverId}
                title={
                  !values.driverId
                    ? 'Select a driver to enable Create & Assign'
                    : undefined
                }
              >
                Create &amp; assign
              </Button>
            )}
          </div>
        )}
      </form>

      <ConfirmationModal
        open={showLeaveConfirm}
        title="Discard this order?"
        description="The details you entered will be lost."
        confirmLabel="Discard"
        confirmVariant="danger"
        cancelLabel="Keep editing"
        onConfirm={() => {
          setShowLeaveConfirm(false);
          navigate(paths.management.orders);
        }}
        onCancel={() => setShowLeaveConfirm(false)}
      />
    </div>
  );
}

/* --------------------------------------------------------------- */

interface RadioCardsProps {
  legend: string;
  name: 'orderType' | 'paymentType';
  options: readonly { value: string; title: string; hint: string }[];
  register: ReturnType<typeof useForm<CreateOrderFormValues>>['register'];
  error?: string;
}

/**
 * Card-styled radio group built on real <input type="radio"> — fully keyboard
 * accessible, one tab stop, arrow keys move between options.
 */
function RadioCards({ legend, name, options, register, error }: RadioCardsProps) {
  const errorId = useId();
  return (
    <fieldset>
      <legend className="text-sm font-medium text-ink-secondary">{legend}</legend>
      <div
        className="mt-1.5 grid gap-2 sm:grid-cols-2"
        role="radiogroup"
        aria-describedby={error ? errorId : undefined}
      >
        {options.map((o) => (
          <label
            key={o.value}
            className="flex cursor-pointer gap-2.5 rounded-control border border-line bg-card p-3 text-sm has-[:checked]:border-brand-600 has-[:checked]:bg-brand-50 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-brand-600"
          >
            <input
              type="radio"
              value={o.value}
              className="mt-0.5 size-4 shrink-0 accent-brand-600"
              {...register(name)}
            />
            <span>
              <span className="block font-medium text-ink">{o.title}</span>
              <span className="block text-xs text-ink-muted">{o.hint}</span>
            </span>
          </label>
        ))}
      </div>
      {error && (
        <p id={errorId} className="mt-1 text-xs text-danger-700">
          {error}
        </p>
      )}
    </fieldset>
  );
}
