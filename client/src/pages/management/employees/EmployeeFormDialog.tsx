import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useForm, type UseFormSetError } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { ArrowLeft, Eye, EyeOff, X } from 'lucide-react';

import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { FormSection } from '../../../components/forms/FormSection';
import { TextField, SelectField } from '../../../components/forms/Field';
import {
  useGetEmployeeRolesQuery,
  useCreateEmployeeMutation,
  useUpdateEmployeeMutation,
} from '../../../services/employeesApi';
import type { EmployeeDetail } from '../../../services/domain.types';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  getApiValidationDetails,
  isTransportError,
  type UnknownApiError,
} from '../../../services/apiError';

import {
  EMPLOYEE_CREATE_DEFAULTS,
  EMPLOYEE_FORM_FIELDS,
  employeeCreateSchema,
  employeeEditSchema,
  toCreateEmployeeRequest,
  toUpdateEmployeeRequest,
  type EmployeeCreateValues,
  type EmployeeEditValues,
} from './employeeForm.schema';

type AnyValues = EmployeeCreateValues & Partial<EmployeeEditValues>;

function applyServerFieldErrors(
  error: UnknownApiError,
  setError: UseFormSetError<AnyValues>,
): boolean {
  const details = getApiValidationDetails(error);
  const props =
    details && typeof details === 'object'
      ? (details as { properties?: Record<string, unknown> }).properties
      : undefined;
  if (!props) return false;
  // new-login create nests under `user.*`
  const userProps =
    (props.user as { properties?: Record<string, { errors?: unknown }> })
      ?.properties ?? {};
  const merged: Record<string, { errors?: unknown }> = {
    ...(props as Record<string, { errors?: unknown }>),
    ...userProps,
  };
  let mapped = false;
  for (const [key, node] of Object.entries(merged)) {
    if (!EMPLOYEE_FORM_FIELDS.has(key)) continue;
    const message = Array.isArray(node?.errors) ? node.errors[0] : undefined;
    if (typeof message === 'string' && message) {
      setError(key as keyof AnyValues, { type: 'server', message });
      mapped = true;
    }
  }
  return mapped;
}

export interface EmployeeFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  /** Required when mode === 'edit'. */
  employee?: EmployeeDetail;
  onClose: () => void;
  onCreated: (employee: EmployeeDetail) => void;
  onSaved: () => void;
}

export function EmployeeFormDialog({
  open,
  mode,
  employee,
  onClose,
  onCreated,
  onSaved,
}: EmployeeFormDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const isEdit = mode === 'edit';

  const roles = useGetEmployeeRolesQuery();
  const [createEmployee, { isLoading: creating }] = useCreateEmployeeMutation();
  const [updateEmployee, { isLoading: updating }] = useUpdateEmployeeMutation();
  const saving = creating || updating;

  const [formError, setFormError] = useState<string | null>(null);
  const [step, setStep] = useState<'form' | 'confirm-role'>('form');
  const [showPassword, setShowPassword] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    watch,
    formState: { errors, isDirty },
  } = useForm<AnyValues>({
    resolver: zodResolver(isEdit ? employeeEditSchema : employeeCreateSchema) as never,
    mode: 'onTouched',
    defaultValues: EMPLOYEE_CREATE_DEFAULTS as AnyValues,
  });

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset(
        isEdit && employee
          ? ({
              roleId: employee.role.id,
              firstName: employee.firstName,
              lastName: employee.lastName,
              email: employee.email,
              phone: employee.phone ?? '',
            } as AnyValues)
          : (EMPLOYEE_CREATE_DEFAULTS as AnyValues),
      );
      setFormError(null);
      setStep('form');
      setShowPassword(false);
    }
    wasOpen.current = open;
  }, [open, isEdit, employee, reset]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    else if (!open && d.open) d.close();
  }, [open]);

  const roleOptions = useMemo(
    () =>
      (roles.data ?? []).map((r) => ({
        value: r.id,
        label: `${r.name} · ${r.permissionCount} permission${r.permissionCount === 1 ? '' : 's'}`,
      })),
    [roles.data],
  );

  const selectedRoleId = watch('roleId');
  const currentRole = employee
    ? roles.data?.find((r) => r.id === employee.role.id)
    : undefined;
  const nextRole = roles.data?.find((r) => r.id === selectedRoleId);
  const roleChanged = isEdit && !!employee && selectedRoleId !== employee.role.id;

  const submitCreate = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const created = await createEmployee(
        toCreateEmployeeRequest(values as EmployeeCreateValues),
      ).unwrap();
      onCreated(created);
    } catch (e) {
      handleMutationError(e as UnknownApiError);
    }
  });

  const goToConfirmOrSave = handleSubmit(async (values) => {
    if (!employee) return;
    if (roleChanged && step === 'form') {
      setFormError(null);
      setStep('confirm-role');
      return;
    }
    await doSave(values as EmployeeEditValues);
  });

  const doSave = async (values: EmployeeEditValues) => {
    if (!employee) return;
    setFormError(null);
    try {
      const body = toUpdateEmployeeRequest(values, {
        firstName: employee.firstName,
        lastName: employee.lastName,
        email: employee.email,
        phone: employee.phone,
        roleId: employee.role.id,
      });
      if (Object.keys(body).length === 0) {
        onSaved();
        return;
      }
      await updateEmployee({
        id: employee.id,
        body,
        selfUserId: employee.userId,
      }).unwrap();
      onSaved();
    } catch (e) {
      setStep('form');
      handleMutationError(e as UnknownApiError);
    }
  };

  function handleMutationError(err: UnknownApiError) {
    if (isTransportError(err)) {
      setFormError('Unable to reach the server. Please try again.');
      return;
    }
    const status = getApiErrorStatus(err);
    const code = getApiErrorCode(err);
    const message = getApiErrorMessage(err);
    if (status === 409 || code === 'CONFLICT') {
      const m = message.toLowerCase();
      if (m.includes('last active administrator') || m.includes('administrator access')) {
        setFormError(message);
      } else if (m.includes('email')) {
        setError('email', {
          type: 'server',
          message: 'An account with this email already exists.',
        });
        setFormError('Please fix the highlighted fields and try again.');
      } else if (m.includes('number')) {
        setError('employeeNumber', {
          type: 'server',
          message: 'An employee with this number already exists.',
        });
        setFormError('Please fix the highlighted fields and try again.');
      } else {
        setFormError(message);
      }
      return;
    }
    if (
      status === 400 &&
      /your own account/i.test(message)
    ) {
      setFormError(message);
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
    setFormError(message);
  }

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
          {step === 'confirm-role'
            ? 'Confirm role change'
            : isEdit
              ? `Edit ${employee?.firstName ?? 'employee'}`
              : 'Add employee'}
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
              void (isEdit ? goToConfirmOrSave() : submitCreate());
            }}
            className="space-y-4"
          >
            {!isEdit && (
              <FormSection title="Employee">
                <TextField
                  label="Employee number"
                  required
                  autoComplete="off"
                  hint="A unique identifier (not generated automatically). Immutable once set."
                  error={errors.employeeNumber?.message}
                  {...register('employeeNumber')}
                />
              </FormSection>
            )}

            <FormSection title="Profile">
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
                hint="The address this employee signs in with."
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

            <FormSection title="Role & access">
              <SelectField
                label="Role"
                required
                placeholder={roles.isLoading ? 'Loading roles…' : 'Select a role…'}
                options={roleOptions}
                error={errors.roleId?.message}
                disabled={roles.isLoading || roles.isError}
                {...register('roleId')}
              />
              {roles.isError && (
                <p className="text-xs text-danger-700">
                  Could not load roles.{' '}
                  <button
                    type="button"
                    className="font-medium underline"
                    onClick={() => void roles.refetch()}
                  >
                    Retry
                  </button>
                </p>
              )}
              {nextRole && (
                <p className="text-xs text-ink-muted">
                  {nextRole.name} inherits {nextRole.permissionCount} permission
                  {nextRole.permissionCount === 1 ? '' : 's'}. Permissions come
                  from the role — they are not set per employee.
                </p>
              )}
            </FormSection>

            {!isEdit && (
              <FormSection title="Initial password">
                <div className="relative">
                  <TextField
                    label="Password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="new-password"
                    hint="At least 8 characters. Share it securely; the employee can change it later."
                    error={errors.password?.message}
                    {...register('password')}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-8 rounded p-1 text-ink-muted hover:text-ink"
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" aria-hidden="true" />
                    ) : (
                      <Eye className="size-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
                <TextField
                  label="Confirm password"
                  type={showPassword ? 'text' : 'password'}
                  required
                  autoComplete="new-password"
                  error={errors.confirmPassword?.message}
                  {...register('confirmPassword')}
                />
              </FormSection>
            )}

            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button type="button" variant="secondary" onClick={onClose} disabled={saving}>
                Cancel
              </Button>
              <Button
                type="submit"
                loading={saving}
                disabled={saving || (isEdit && !isDirty)}
              >
                {isEdit ? (roleChanged ? 'Review changes' : 'Save changes') : 'Create employee'}
              </Button>
            </div>
          </form>
        )}

        {step === 'confirm-role' && employee && (
          <div className="space-y-4">
            <p className="text-sm text-ink-secondary">
              Changing this employee&rsquo;s role changes the access they inherit.
              The backend re-resolves their permissions from the new role — it
              takes effect on their next request.
            </p>
            <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
              <div className="flex justify-between gap-4 px-3 py-2 text-sm">
                <dt className="text-ink-muted">Current role</dt>
                <dd className="font-medium text-ink-secondary">
                  {currentRole?.name ?? employee.role.name}
                  {currentRole
                    ? ` · ${currentRole.permissionCount} permissions`
                    : ''}
                </dd>
              </div>
              <div className="flex justify-between gap-4 px-3 py-2 text-sm">
                <dt className="text-ink-muted">New role</dt>
                <dd className="font-semibold text-ink">
                  {nextRole?.name}
                  {nextRole ? ` · ${nextRole.permissionCount} permissions` : ''}
                </dd>
              </div>
              {currentRole && nextRole && (
                <div className="flex justify-between gap-4 px-3 py-2 text-sm">
                  <dt className="text-ink-muted">Inherited permissions</dt>
                  <dd className="font-medium text-ink-secondary tabular-nums">
                    {currentRole.permissionCount} → {nextRole.permissionCount}
                  </dd>
                </div>
              )}
            </dl>
            <p className="text-xs text-ink-muted">
              This does not change any financial data, orders or history — only
              authorization.
            </p>
            <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="secondary"
                icon={<ArrowLeft />}
                onClick={() => {
                  setFormError(null);
                  setStep('form');
                }}
                disabled={saving}
              >
                Back
              </Button>
              <Button
                type="button"
                loading={saving}
                disabled={saving}
                onClick={() => void goToConfirmOrSave()}
              >
                Change role &amp; save
              </Button>
            </div>
          </div>
        )}
      </div>
    </dialog>
  );
}
