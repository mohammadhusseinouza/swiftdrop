import { Loader2 } from 'lucide-react';
import { cn } from '../ui/cn';

export interface LoadingStateProps {
  /** 'inline' (small, in-flow) or 'section' (centred block, default). */
  variant?: 'inline' | 'section';
  label?: string;
  className?: string;
}

/**
 * Restrained loading indicator. Spinner animation is `motion-safe` only
 * (respects prefers-reduced-motion). The label is announced politely.
 */
export function LoadingState({
  variant = 'section',
  label = 'Loading…',
  className,
}: LoadingStateProps) {
  if (variant === 'inline') {
    return (
      <span
        role="status"
        className={cn('inline-flex items-center gap-2 text-sm text-ink-muted', className)}
      >
        <Loader2 className="size-4 motion-safe:animate-spin" aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <div
      role="status"
      className={cn(
        'flex flex-col items-center justify-center gap-3 py-12 text-center',
        className,
      )}
    >
      <Loader2
        className="size-6 text-ink-subtle motion-safe:animate-spin"
        aria-hidden="true"
      />
      <p className="text-sm text-ink-muted">{label}</p>
    </div>
  );
}

/** Simple content-shaped skeleton block (no animation beyond a subtle pulse). */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'block rounded-md bg-neutral-50 motion-safe:animate-pulse',
        className,
      )}
    />
  );
}
