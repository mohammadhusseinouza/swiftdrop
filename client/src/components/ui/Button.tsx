import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './cn';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Icon element rendered before the label. Decorative (aria-hidden). */
  icon?: ReactNode;
  /** Shows a spinner and disables the button. Keeps the accessible label. */
  loading?: boolean;
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-600/50',
  secondary:
    'bg-card text-ink-secondary border border-line hover:bg-sunken disabled:opacity-50',
  ghost:
    'bg-transparent text-ink-secondary hover:bg-neutral-50 disabled:opacity-50',
  danger:
    'bg-danger-700 text-white hover:bg-danger-700/90 disabled:bg-danger-700/50',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-10 px-4 text-sm gap-2',
};

/**
 * Presentational button primitive. Never contains permission or business
 * logic — wrap it in <PermissionGuard> for action visibility.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', icon, loading = false, disabled, className, children, type, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'inline-flex items-center justify-center rounded-control font-medium',
        'transition-colors disabled:cursor-not-allowed',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
      ) : (
        icon && (
          <span className="shrink-0 [&>svg]:size-4" aria-hidden="true">
            {icon}
          </span>
        )
      )}
      {children}
    </button>
  );
});
