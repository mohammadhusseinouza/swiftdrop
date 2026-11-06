import { useId, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useLocation } from 'react-router-dom';
import { ArrowRight, CircleAlert, Eye, EyeOff } from 'lucide-react';

import { Button } from '../../components/ui/Button';
import { FieldShell, fieldMessageId } from '../../components/forms/Field';
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

const LABEL = 'text-sm font-semibold text-ink';
/** Field style (handoff §8.2): 2px brand-600 focus outline with 1px offset; invalid border is danger-700. */
const INPUT =
  'h-[50px] w-full rounded-xl border bg-card text-[0.9375rem] text-ink placeholder:text-ink-muted ' +
  'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600 disabled:opacity-50';

export default function LoginPage() {
  const { login, isLoading } = useLogin();
  const location = useLocation();
  const [showPassword, setShowPassword] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const formErrorId = useId();
  const emailId = useId();
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
    <div className="flex w-full max-w-[400px] flex-col gap-7">
      <div>
        <h1 className="text-[2.125rem] leading-[1.1] font-bold tracking-[-0.035em] text-ink">Welcome back</h1>
        <p className="mt-2 text-[0.9375rem] text-ink-secondary">
          Sign in with the email and password your company gave you.
        </p>
      </div>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        {formError && (
          <div
            id={formErrorId}
            role="alert"
            className="flex items-start gap-2.5 rounded-xl border border-danger-200 bg-danger-50 px-3.5 py-3 text-sm text-danger-700"
          >
            <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {formError}
          </div>
        )}

        <FieldShell
          label="Email"
          htmlFor={emailId}
          error={errors.email?.message}
          labelClassName={LABEL}
          messageClassName="text-[0.8125rem]"
        >
          <input
            id={emailId}
            type="email"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            placeholder="you@company.com"
            aria-invalid={errors.email ? true : undefined}
            aria-describedby={errors.email ? fieldMessageId(emailId) : undefined}
            className={cn(INPUT, 'px-4', errors.email ? 'border-danger-700' : 'border-line')}
            {...register('email')}
          />
        </FieldShell>

        <FieldShell
          label="Password"
          htmlFor={pwId}
          error={errors.password?.message}
          labelClassName={LABEL}
          messageClassName="text-[0.8125rem]"
        >
          <div className="relative">
            <input
              id={pwId}
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              aria-invalid={errors.password ? true : undefined}
              aria-describedby={errors.password ? fieldMessageId(pwId) : undefined}
              className={cn(INPUT, 'pr-[52px] pl-4', errors.password ? 'border-danger-700' : 'border-line')}
              {...register('password')}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}
              aria-pressed={showPassword}
              className="absolute top-1/2 right-1 flex size-[42px] -translate-y-1/2 items-center justify-center rounded-[10px] text-ink-muted hover:bg-sunken hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
            >
              {showPassword ? (
                <EyeOff className="size-[18px]" aria-hidden="true" />
              ) : (
                <Eye className="size-[18px]" aria-hidden="true" />
              )}
            </button>
          </div>
        </FieldShell>

        <Button
          type="submit"
          variant="ink"
          size="lg"
          className="mt-1 w-full focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brand-600"
          loading={isLoading || isSubmitting}
          aria-describedby={formError ? formErrorId : undefined}
        >
          Sign in
          {!(isLoading || isSubmitting) && <ArrowRight className="size-4" aria-hidden="true" />}
        </Button>
      </form>

      <p className="border-t border-line pt-6 text-[0.8125rem] text-ink-muted">
        No account yet, or locked out? Contact your Spring Delivery administrator.
      </p>
    </div>
  );
}
