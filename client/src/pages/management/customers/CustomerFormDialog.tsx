import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X } from 'lucide-react';

import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { FormSection } from '../../../components/forms/FormSection';
import {
  TextField,
  TextAreaField,
  SelectField,
} from '../../../components/forms/Field';
import { useGetAreasQuery } from '../../../services/settingsApi';
import {
  useCreateCustomerMutation,
  useUpdateCustomerMutation,
} from '../../../services/customersApi';
import type { CustomerDetail } from '../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  getApiValidationDetails,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';
import {
  CUSTOMER_FORM_DEFAULTS,
  CUSTOMER_FORM_FIELDS,
  customerFormSchema,
  customerToFormValues,
  toCreateCustomerRequest,
  toUpdateCustomerRequest,
  type CustomerFormValues,
} from './customerForm.schema';

function applyServerFieldErrors(
  error: UnknownApiError,
  setError: UseFormSetError<CustomerFormValues>,
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
    if (!CUSTOMER_FORM_FIELDS.has(key)) continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof CustomerFormValues, { type: 'server', message });
      mapped = true;
    }
  }
  return mapped;
}

export interface CustomerFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Required when mode === 'edit'. */
  customer?: CustomerDetail;
  onClose: () => void;
  onCreated: (customer: CustomerDetail) => void;
  onSaved: () => void;
}

export function CustomerFormDialog({
  open,
  mode,
  customer,
  onClose,
  onCreated,
  onSaved,
}: CustomerFormDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const isEdit = mode === 'edit';

  const [createCustomer, { isLoading: creating }] = useCreateCustomerMutation();
  const [updateCustomer, { isLoading: updating }] = useUpdateCustomerMutation();
  const saving = creating || updating;
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<CustomerFormValues>({
    resolver: zodResolver(customerFormSchema),
    mode: 'onTouched',
    defaultValues: CUSTOMER_FORM_DEFAULTS,
  });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(
        isEdit && customer
          ? customerToFormValues(customer)
          : CUSTOMER_FORM_DEFAULTS,
      );
      setFormError(null);
    }
    wasOpen.current = open;
  }, [open, isEdit, customer, reset]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const areas = useGetAreasQuery({ isActive: true, limit: 100 }, { skip: !open });
  const areaOptions = useMemo(() => {
    const opts = (areas.data?.items ?? []).map((a) => ({
      value: a.id,
      label: a.name,
    }));
    if (
      isEdit &&
      customer?.area &&
      !opts.some((o) => o.value === customer.area!.id)
    ) {
      opts.unshift({
        value: customer.area.id,
        label: `${customer.area.name} (inactive)`,
      });
    }
    return opts;
  }, [areas.data, isEdit, customer]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (isEdit && customer) {
        await updateCustomer({
          id: customer.id,
          body: toUpdateCustomerRequest(values),
        }).unwrap();
        onSaved();
      } else {
        const created = await createCustomer(
          toCreateCustomerRequest(values),
        ).unwrap();
        onCreated(created);
      }
    } catch (e) {
      const err = e as UnknownApiError;
      if (isTransportError(err)) {
        setFormError('Unable to reach the server. Please try again.');
        return;
      }
      const status = getApiErrorStatus(err);
      const code = getApiErrorCode(err);
      if (!isEdit && (status === 409 || code === 'CONFLICT')) {
        setError('customerNumber', {
          type: 'server',
          message: 'A customer with this number already exists.',
        });
        setFormError('Please fix the highlighted fields and try again.');
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
          {isEdit ? `Edit ${customer?.name ?? 'customer'}` : 'Add customer'}
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
          <TextField
            label="Customer number"
            required
            readOnly={isEdit}
            autoComplete="off"
            hint={
              isEdit
                ? 'The customer number cannot be changed.'
                : 'A unique identifier for this customer (not generated automatically).'
            }
            error={errors.customerNumber?.message}
            {...register('customerNumber')}
          />
          <TextField
            label="Name"
            required
            autoComplete="off"
            error={errors.name?.message}
            {...register('name')}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="Primary phone"
              required
              inputMode="tel"
              autoComplete="off"
              error={errors.primaryPhone?.message}
              {...register('primaryPhone')}
            />
            <TextField
              label="Secondary phone"
              inputMode="tel"
              autoComplete="off"
              error={errors.secondaryPhone?.message}
              {...register('secondaryPhone')}
            />
          </div>
          <TextField
            label="Email"
            type="email"
            autoComplete="off"
            error={errors.email?.message}
            {...register('email')}
          />
        </FormSection>

        <FormSection title="Default delivery">
          <SelectField
            label="Default area"
            placeholder={
              areas.isLoading
                ? 'Loading areas…'
                : areas.isError
                  ? 'Areas unavailable'
                  : 'No default area'
            }
            options={areaOptions}
            disabled={areas.isLoading || areas.isError}
            hint={
              areas.isError
                ? 'Area list could not load — you can still save without a default area.'
                : undefined
            }
            error={errors.defaultAreaId?.message}
            {...register('defaultAreaId')}
          />
          <TextAreaField
            label="Default address"
            rows={2}
            error={errors.defaultAddress?.message}
            {...register('defaultAddress')}
          />
        </FormSection>

        <FormSection title="Notes">
          <TextAreaField
            label="Internal notes"
            rows={3}
            error={errors.notes?.message}
            {...register('notes')}
          />
        </FormSection>

        <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            loading={saving}
            disabled={saving || (isEdit && !isDirty)}
          >
            {isEdit ? 'Save changes' : 'Create customer'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
