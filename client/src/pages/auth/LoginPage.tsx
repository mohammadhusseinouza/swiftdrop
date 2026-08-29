import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocation } from 'react-router-dom';
import { Eye, EyeOff, Truck } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { TextField, FieldShell, fieldMessageId } from '../../components/forms/Field';
import { cn } from '../../components/ui/cn';
import { useLogin } from '../../features/auth/useSession';
import {
  getApiErrorCode,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../services/apiError';
import { loginSchema, type LoginFormValues } from './login.schema';

/** Turn an auth error into a safe, user-facing form-level message. */
function toLoginErrorMessage(error: unknown): string {
  const e = error as UnknownApiError;
  const code = getApiErrorCode(e);
  const status = getApiErrorStatus(e);

  // The backend returns a single generic result for unknown email, wrong
  // password AND inactive account — never distinguish them here.
  if (code === 'INVALID_CREDENTIALS' || status === 401) {
    return 'Invalid email or password.';
  }
  if (isTransportError(e) || (typeof status === 'number' && status >= 500)) {
    return 'Unable to sign in right now. Please try again.';
  }
  if (code === 'VALIDATION_ERROR' || status === 400) {
    return 'Please check the details you entered and try again.';
  }
  return 'Something went wrong while signing in. Please try again.';
}

export default function LoginPage() {
  const { login, isLoading } = useLogin();
  const location = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const formErrorId = useId();
  const pwId = useId();

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    mode: 'onTouched',
    defaultValues: { email: '', password: '' },
  });

  // GuestOnly (Phase 10.5) already redirects an authenticated user away from
  // this route, so the page always renders for an unauthenticated visitor.
  const fromState = (location.state as { from?: unknown } | null)?.from;
  const redirectTo = typeof fromState === 'string' ? fromState : null;

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      // useLogin owns the token capture, cache reset, auth-slice hydration and
      // navigation (safe internal path or the role's default portal).
      await login(
        { email: values.email, password: values.password },
        { redirectTo },
      );
    } catch (error) {
      setFormError(toLoginErrorMessage(error));
    }
  });

  return (
    <div className="w-full max-w-sm">
      <div className="mb-6 flex items-center gap-2.5">
        <span
          className="flex size-9 items-center justify-center rounded-control bg-brand-600 text-white"
          aria-hidden="true"
        >
          <Truck className="size-5" />
        </span>
        <span className="text-lg font-semibold tracking-tight text-ink">
          SwiftDrop
        </span>
      </div>

      <div className="rounded-card border border-line bg-card p-6 shadow-card sm:p-7">
        <h1 className="text-xl font-semibold text-ink">Sign in</h1>
        <p className="mt-1 text-sm text-ink-muted">
          Sign in to manage deliveries and operations.
        </p>

        <form onSubmit={onSubmit} noValidate className="mt-5 space-y-4">
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

          <TextField
            label="Email"
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@company.com"
            error={errors.email?.message}
            {...register('email')}
          />

          <FieldShell
            label="Password"
            htmlFor={pwId}
            error={errors.password?.message}
          >
            <div className="relative">
              <input
                id={pwId}
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                aria-invalid={errors.password ? true : undefined}
                aria-describedby={
                  errors.password ? fieldMessageId(pwId) : undefined
                }
                className={cn(
                  'h-10 w-full rounded-control border bg-card pl-3 pr-10 text-sm text-ink',
                  'placeholder:text-ink-subtle disabled:opacity-50',
                  errors.password ? 'border-danger-200' : 'border-line',
                )}
                {...register('password')}
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-2 text-ink-subtle hover:text-ink"
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden="true" />
                ) : (
                  <Eye className="size-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </FieldShell>

          <Button
            type="submit"
            className="w-full"
            loading={isLoading || isSubmitting}
            aria-describedby={formError ? formErrorId : undefined}
          >
            Sign in
          </Button>
        </form>
      </div>
    </div>
  );
}
