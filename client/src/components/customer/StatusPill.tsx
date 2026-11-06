import { cn } from '../ui/cn';
import { getCustomerPillPresentation, type CustomerPillTone } from './customerStagePresentation';

const TONES: Record<CustomerPillTone, string> = {
  neutral: 'bg-canvas text-ink-secondary',
  'neutral-strong': 'bg-canvas text-ink',
  brand: 'bg-brand-50 text-brand-600',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
};

export interface StatusPillProps {
  /** Internal order status; wording comes from the customer-safe mapping. */
  status: string;
  className?: string;
}

/**
 * Customer order status pill (handoff §2). The label text carries the
 * meaning — the dot and tone are secondary, never the only signal.
 */
export function StatusPill({ status, className }: StatusPillProps) {
  const { label, tone } = getCustomerPillPresentation(status);
  return (
    <span
      className={cn(
        'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-bold',
        TONES[tone],
        className,
      )}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}
