import { cn } from '../ui/cn';
import { getCustomerPillPresentation, type CustomerPillTone } from './customerStagePresentation';

const TONES: Record<CustomerPillTone, string> = {
  neutral: 'bg-canvas text-ink-secondary',
  'neutral-strong': 'bg-canvas text-ink',
  brand: 'bg-brand-50 text-brand-600',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
};

/*
 * On the charcoal hero band (brand theme §3.3): brand-tone statuses are solid
 * `sd-red` with a white pulsing dot; neutral tones are translucent. Success and
 * warning keep their light pills (AA on their own background, legible on dark).
 */
const DARK_TONES: Record<CustomerPillTone, string> = {
  neutral: 'bg-white/10 text-sd-on-dark-strong',
  'neutral-strong': 'bg-white/10 text-sd-on-dark-strong',
  brand: 'bg-sd-red text-white',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
};

/*
 * Brand look on white cards (brand theme §1.1 / §5): "Out for delivery" (brand
 * tone) is `sd-red-50` / `sd-red-text` with a pulsing dot; neutral tones use
 * the brand greys. Success and warning are the existing semantic pills.
 */
const BRAND_TONES: Record<CustomerPillTone, string> = {
  neutral: 'bg-sd-line-subtle text-sd-text-2',
  'neutral-strong': 'bg-sd-line-subtle text-sd-ink',
  brand: 'bg-sd-red-50 text-sd-red-text',
  success: 'bg-success-50 text-success-700',
  warning: 'bg-warning-50 text-warning-700',
};

const TONE_SETS = { light: TONES, dark: DARK_TONES, brand: BRAND_TONES } as const;

export interface StatusPillProps {
  /** Internal order status; wording comes from the customer-safe mapping. */
  status: string;
  /**
   * `light` (default), `dark` for the charcoal hero band, or `brand` for the
   * brand look on white cards.
   */
  tone?: 'light' | 'dark' | 'brand';
  className?: string;
}

/**
 * Customer order status pill (handoff §2). The label text carries the
 * meaning — the dot and tone are secondary, never the only signal.
 */
export function StatusPill({ status, tone = 'light', className }: StatusPillProps) {
  const { label, tone: pillTone } = getCustomerPillPresentation(status);
  const live = tone !== 'light' && pillTone === 'brand';
  return (
    <span
      className={cn(
        'inline-flex h-[26px] shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs font-bold',
        TONE_SETS[tone][pillTone],
        className,
      )}
    >
      <span className={cn('size-1.5 rounded-full bg-current', live && 'sd-pulse')} aria-hidden="true" />
      {label}
    </span>
  );
}
