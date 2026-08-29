import { useEffect, useId, useRef, useState } from 'react';
import { useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { X } from 'lucide-react';

import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { FormSection } from '../../../components/forms/FormSection';
import { TextField } from '../../../components/forms/Field';
import {
  useCreateDriverMutation,
  useUpdateDriverMutation,
} from '../../../services/driversApi';
import type { DriverDetail } from '../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  getApiValidationDetails,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';
import {
  DRIVER_CREATE_DEFAULTS,
  DRIVER_CREATE_FIELDS,
  DRIVER_EDIT_FIELDS,
  driverCreateSchema,
  driverEditSchema,
  driverToEditValues,
  toCreateDriverRequest,
  toUpdateDriverRequest,
  type DriverCreateValues,
  type DriverEditValues,
} from './driverForm.schema';

type AnyValues = DriverCreateValues & Partial<DriverEditValues>;

function applyServerFieldErrors(
  error: UnknownApiError,
  fields: Set<string>,
  setError: UseFormSetError<AnyValues>,
): boolean {
  const details = getApiValidationDetails(error);
  // The backend union / strict schema nests new-login errors under `user.*`;
  // flatten one level so `user.email` maps onto the `email` field.
  const root =
    details && typeof details === 'object'
      ? (details as { properties?: Record<string, unknown> }).properties
      : undefined;
  if (!root) return false;
  const userProps =
    root.user && typeof root.user === 'object'
      ? (root.user as { properties?: Record<string, { errors?: unknown }> })
          .properties
      : undefined;
  const merged: Record<string, { errors?: unknown }> = {
    ...(root as Record<string, { errors?: unknown }>),
    ...(userProps ?? {}),
  };
  let mapped = false;
  for (const [key, node] of Object.entries(merged)) {
    if (!fields.has(key)) continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof AnyValues, { type: 'server', message });
      mapped = true;
    }
  }
  return mapped;
}

export interface DriverFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Required when mode === 'edit'. */
  driver?: DriverDetail;
  onClose: () => void;
  onCreated: (driver: DriverDetail) => void;
  onSaved: () => void;
}

export function DriverFormDialog({
  open,
  mode,
  driver,
  onClose,
  onCreated,
  onSaved,
}: DriverFormDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const isEdit = mode === 'edit';

  const [createDriver, { isLoading: creating }] = useCreateDriverMutation();
  const [updateDriver, { isLoading: updating }] = useUpdateDriverMutation();
  const saving = creating || updating;
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isDirty },
  } = useForm<AnyValues>({
    resolver: zodResolver(
      isEdit ? driverEditSchema : driverCreateSchema,
    ) as never,
    mode: 'onTouched',
    defaultValues: DRIVER_CREATE_DEFAULTS as AnyValues,
  });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(
        isEdit && driver
          ? (driverToEditValues(driver) as AnyValues)
          : (DRIVER_CREATE_DEFAULTS as AnyValues),
      );
      setFormError(null);
    }
    wasOpen.current = open;
  }, [open, isEdit, driver, reset]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (isEdit && driver) {
        await updateDriver({
          id: driver.id,
          body: toUpdateDriverRequest(values as DriverEditValues),
        }).unwrap();
        onSaved();
      } else {
        const created = await createDriver(
          toCreateDriverRequest(values as DriverCreateValues),
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
      const fields = isEdit ? DRIVER_EDIT_FIELDS : DRIVER_CREATE_FIELDS;
      if (status === 409 || code === 'CONFLICT') {
        const msg = getApiErrorMessage(err).toLowerCase();
        if (msg.includes('email')) {
          setError('email', {
            type: 'server',
            message: 'An account with this email already exists.',
          });
        } else if (!isEdit && msg.includes('number')) {
          setError('driverNumber', {
            type: 'server',
            message: 'A driver with this number already exists.',
          });
        }
        setFormError('Please fix the highlighted fields and try again.');
        return;
      }
      if (applyServerFieldErrors(err, fields, setError)) {
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
          {isEdit
            ? `Edit ${driver?.user.firstName ?? 'driver'}`
            : 'Add driver'}
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

        {!isEdit && (
          <FormSection title="Driver">
            <TextField
              label="Driver number"
              required
              autoComplete="off"
              hint="A unique identifier for this driver (not generated automatically)."
              error={errors.driverNumber?.message}
              {...register('driverNumber')}
            />
          </FormSection>
        )}

        <FormSection title={isEdit ? 'Profile' : 'Login profile'}>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField
              label="First name"
              required
              autoComplete="off"
              error={errors.firstName?.message}
              {...register('firstName')}
            />
            <TextField
              label="Last name"
              required
              autoComplete="off"
              error={errors.lastName?.message}
              {...register('lastName')}
            />
          </div>
          <TextField
            label="Email"
            type="email"
            required
            autoComplete="off"
            hint={
              isEdit
                ? 'This is the address the driver signs in with.'
                : 'The driver will sign in to the Driver Portal with this address.'
            }
            error={errors.email?.message}
            {...register('email')}
          />
          <TextField
            label="Phone"
            inputMode="tel"
            autoComplete="off"
            error={errors.phone?.message}
            {...register('phone')}
          />
        </FormSection>

        {!isEdit && (
          <FormSection title="Initial password">
            <TextField
              label="Password"
              type="password"
              required
              autoComplete="new-password"
              hint="At least 8 characters. Share it with the driver securely; they can change it later."
              error={errors.password?.message}
              {...register('password')}
            />
          </FormSection>
        )}

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
            {isEdit ? 'Save changes' : 'Create driver'}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
