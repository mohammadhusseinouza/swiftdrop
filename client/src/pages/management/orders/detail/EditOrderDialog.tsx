import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Controller, useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X } from 'lucide-react';

import { cn } from '../../../../components/ui/cn';
import { Button } from '../../../../components/ui/Button';
import { FormSection } from '../../../../components/forms/FormSection';
import {
  TextField,
  TextAreaField,
  SelectField,
} from '../../../../components/forms/Field';
import { MoneyInput } from '../../../../components/forms/MoneyInput';
import { CalculatedField } from '../../../../components/forms/CalculatedField';
import { ServerSearchSelect } from '../../../../components/forms/ServerSearchSelect';

import { useDebouncedValue } from '../../../../lib/useDebouncedValue';
import { formatMoney } from '../../../../lib/format';
import {
  useGetCustomersQuery,
  useGetCustomerQuery,
} from '../../../../services/customersApi';
import {
  useGetAreasQuery,
  useGetPaymentMethodsQuery,
} from '../../../../services/settingsApi';
import { useUpdateOrderMutation } from '../../../../services/ordersApi';
import type { OrderDetail } from '../../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  getApiValidationDetails,
  isTransportError,
  type UnknownApiError,
} from '../../../../services/apiError';
import {
  calculateOrderPreview,
  moneyIsPositive,
} from '../create/createOrderFinancialPreview';
import {
  EDIT_ORDER_FIELDS,
  editOrderSchema,
  orderToEditValues,
  toUpdateOrderRequest,
  type EditOrderFormValues,
} from './editOrder.schema';

const PAYMENT_TYPE_OPTIONS = [
  { value: 'CASH_ON_DELIVERY', label: 'Cash on Delivery' },
  { value: 'ALREADY_PAID', label: 'Already Paid' },
  { value: 'PARTIALLY_PAID', label: 'Partially Paid' },
] as const;

function applyServerFieldErrors(
  error: UnknownApiError,
  setError: UseFormSetError<EditOrderFormValues>,
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
    if (!EDIT_ORDER_FIELDS.has(key as keyof EditOrderFormValues)) continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof EditOrderFormValues, { type: 'server', message });
      mapped = true;
    }
  }
  return mapped;
}

export interface EditOrderDialogProps {
  open: boolean;
  order: OrderDetail;
  onClose: () => void;
  onSaved: () => void;
  /** Called when the backend rejects the edit because the order state changed. */
  onStale: () => void;
}

export function EditOrderDialog({
  open,
  order,
  onClose,
  onSaved,
  onStale,
}: EditOrderDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  const [updateOrder, { isLoading: saving }] = useUpdateOrderMutation();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    control,
    handleSubmit,
    watch,
    reset,
    setValue,
    getValues,
    setError,
    formState: { errors, isDirty },
  } = useForm<EditOrderFormValues>({
    resolver: zodResolver(editOrderSchema),
    mode: 'onTouched',
    defaultValues: orderToEditValues(order),
  });

  // Re-seed only on the closed -> open transition, so a background refetch of
  // the order while the operator is mid-edit never wipes their changes.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(orderToEditValues(order));
      setFormError(null);
    }
    wasOpen.current = open;
  }, [open, order, reset]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const values = watch();
  const preview = calculateOrderPreview(values);
  const prepaidPositive =
    moneyIsPositive(values.prepaidOrderAmount) ||
    moneyIsPositive(values.prepaidDeliveryFee);
  const collectPositive =
    preview.amountToCollect !== null && moneyIsPositive(preview.amountToCollect);
  const cod = values.paymentType === 'CASH_ON_DELIVERY';
  const alreadyPaid = values.paymentType === 'ALREADY_PAID';

  /* reference data — only once the dialog is actually opened */
  const areas = useGetAreasQuery({ isActive: true, limit: 100 }, { skip: !open });
  const paymentMethods = useGetPaymentMethodsQuery(
    { isActive: true },
    { skip: !open },
  );

  const [customerTerm, setCustomerTerm] = useState('');
  const debouncedCustomerTerm = useDebouncedValue(customerTerm, 300);
  const customers = useGetCustomersQuery(
    {
      search: debouncedCustomerTerm.trim() || undefined,
      isActive: true,
      limit: 20,
    },
    { skip: !open },
  );
  const selectedCustomer = useGetCustomerQuery(values.customerId, {
    skip: !open || !values.customerId,
  });

  const areaOptions = useMemo(
    () => (areas.data?.items ?? []).map((a) => ({ value: a.id, label: a.name })),
    [areas.data],
  );
  const methodOptions = useMemo(
    () => (paymentMethods.data ?? []).map((m) => ({ value: m.id, label: m.name })),
    [paymentMethods.data],
  );
  // Keep the order's existing area/methods selectable even if now inactive.
  const areaSelectOptions = useMemo(() => {
    const opts = [...areaOptions];
    if (
      order.receiver.areaId &&
      !opts.some((o) => o.value === order.receiver.areaId)
    ) {
      opts.unshift({
        value: order.receiver.areaId,
        label: `${order.receiver.area} (inactive)`,
      });
    }
    return opts;
  }, [areaOptions, order.receiver]);

  /* payment-type normalization (mirrors CreateOrderPage) */
  const paymentType = values.paymentType;
  const orderAmount = values.orderAmount;
  useEffect(() => {
    if (paymentType === 'CASH_ON_DELIVERY') {
      if (getValues('prepaidOrderAmount') !== '0.00')
        setValue('prepaidOrderAmount', '0.00', { shouldValidate: true });
      if (getValues('prepaidDeliveryFee') !== '0.00')
        setValue('prepaidDeliveryFee', '0.00', { shouldValidate: true });
    } else if (paymentType === 'ALREADY_PAID') {
      if (getValues('prepaidOrderAmount') !== orderAmount)
        setValue('prepaidOrderAmount', orderAmount, { shouldValidate: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paymentType, orderAmount]);

  useEffect(() => {
    if (!prepaidPositive && getValues('prepaidPaymentMethodId'))
      setValue('prepaidPaymentMethodId', '', { shouldValidate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prepaidPositive]);
  useEffect(() => {
    if (!collectPositive && getValues('collectionPaymentMethodId'))
      setValue('collectionPaymentMethodId', '', { shouldValidate: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collectPositive]);

  const submit = handleSubmit(async (formValues) => {
    setFormError(null);
    try {
      await updateOrder({
        id: order.id,
        body: toUpdateOrderRequest(formValues),
      }).unwrap();
      onSaved();
    } catch (e) {
      const err = e as UnknownApiError;
      if (isTransportError(err)) {
        setFormError('Unable to reach the server. Please try again.');
        return;
      }
      const status = getApiErrorStatus(err);
      const code = getApiErrorCode(err);
      if (status === 409 || code === 'CONFLICT') {
        setFormError(
          'This order changed while you were editing it. Close and review the latest details before trying again.',
        );
        onStale();
        return;
      }
      if (applyServerFieldErrors(err, setError)) {
        setFormError('Please fix the highlighted fields and try again.');
        return;
      }
      if (typeof status === 'number' && status >= 500) {
        setFormError('Something went wrong on the server. Please try again.');
        return;
      }
      setFormError(getApiErrorMessage(err));
    }
  });

  const previewMoney = (v: string | null) => (v ? formatMoney(v) : '—');

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
        'm-auto w-[calc(100vw-2rem)] max-w-2xl rounded-card border border-line',
        'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
        'max-h-[calc(100vh-3rem)]',
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          Edit order {order.orderNumber}
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

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="max-h-[calc(100vh-11rem)] space-y-4 overflow-y-auto p-5"
      >
        {formError && (
          <div
            role="alert"
            className="rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700"
          >
            {formError}
          </div>
        )}

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
                  selectedCustomer.data
                    ? `${selectedCustomer.data.customerNumber} · ${selectedCustomer.data.name}`
                    : `${order.customer.customerNumber} · ${order.customer.name}`
                }
                error={errors.customerId?.message}
              />
            )}
          />
          <p className="text-xs text-ink-muted">
            Changing the customer does not rewrite the receiver snapshot below.
          </p>
        </FormSection>

        <FormSection title="Receiver">
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Receiver name"
              required
              error={errors.receiverName?.message}
              {...register('receiverName')}
            />
            <TextField
              label="Primary phone"
              required
              inputMode="tel"
              error={errors.receiverPhone?.message}
              {...register('receiverPhone')}
            />
            <TextField
              label="Alternative phone"
              inputMode="tel"
              error={errors.receiverAltPhone?.message}
              {...register('receiverAltPhone')}
            />
            <SelectField
              label="Area"
              required
              placeholder={areas.isLoading ? 'Loading areas…' : 'Select an area…'}
              options={areaSelectOptions}
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
              error={errors.receiverBuildingFloor?.message}
              {...register('receiverBuildingFloor')}
            />
            <TextField
              label="Map / location link"
              hint="Plain URL or text."
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
          title="Financial"
          description="Order type is not editable. The server recalculates every remaining amount and the amount to collect."
        >
          <SelectField
            label="Payment type"
            options={[...PAYMENT_TYPE_OPTIONS]}
            error={errors.paymentType?.message}
            {...register('paymentType')}
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
              Preview only. Final totals are recalculated by the server.
            </p>
          </div>
        </FormSection>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" loading={saving} disabled={saving || !isDirty}>
            Save changes
          </Button>
        </div>
      </form>
    </dialog>
  );
}
