import type { ReactNode } from 'react';
import { cn } from '../ui/cn';
import { formatMoney } from '../../lib/format';

export interface BalanceHeroCardProps {
  children: ReactNode;
  /**
   * `chrome` (default): the dark chrome panel with decorative rings, unchanged.
   * `red`: the brand red balance tile for the charcoal hero band
   * (brand theme §3.3) — `sd-red`, red shadow, no rings.
   */
  tone?: 'chrome' | 'red';
  className?: string;
}

/**
 * Dark "chrome" panel for a page's headline money figure (handoff §2). The
 * concentric rings are purely decorative (`aria-hidden`); no gradients.
 * Content is supplied by the page (Step 2+): this is layout only.
 */
export function BalanceHeroCard({ children, tone = 'chrome', className }: BalanceHeroCardProps) {
  if (tone === 'red') {
    return (
      <section
        className={cn(
          'relative isolate min-w-0 overflow-hidden rounded-[14px] bg-sd-red px-5 py-[18px] text-white shadow-sd-red sm:p-6',
          className,
        )}
      >
        {children}
      </section>
    );
  }

  return (
    <section
      className={cn(
        'relative isolate overflow-hidden rounded-hero bg-chrome p-6 text-white sm:p-8',
        className,
      )}
    >
      <div
        className="pointer-events-none absolute -top-28 -right-28 -z-10 size-[22rem]"
        aria-hidden="true"
      >
        <span className="absolute inset-0 rounded-full border border-white/7" />
        <span className="absolute inset-12 rounded-full border border-white/7" />
        <span className="absolute inset-24 rounded-full border border-brand-600 opacity-55" />
      </div>
      {children}
    </section>
  );
}

/** Label for a red tile / hero tile (Saira, uppercase, `sd-red-on` on red). */
export function HeroTileLabel({
  children,
  tone = 'red',
  className,
}: {
  children: ReactNode;
  tone?: 'red' | 'dark';
  className?: string;
}) {
  return (
    <p
      className={cn(
        'font-sd-display text-[0.8125rem] font-semibold tracking-[0.12em] uppercase',
        tone === 'red' ? 'text-sd-red-on' : 'text-sd-on-dark',
        className,
      )}
    >
      {children}
    </p>
  );
}

export interface HeroMoneyProps {
  /** Server money string — formatted with formatMoney, never parsed to a float. */
  value: string | null | undefined;
  /**
   * `chrome` (default): unchanged. `red`: white on the red tile, cents
   * `sd-red-on`. `dark`: white on charcoal / translucent tiles, cents
   * `sd-on-dark`. Brand tones use Saira (brand theme §1.3).
   */
  tone?: 'chrome' | 'red' | 'dark';
  className?: string;
}

const CENTS_TONE = {
  chrome: 'text-chrome-ink',
  red: 'text-sd-red-on',
  dark: 'text-sd-on-dark',
} as const;

/**
 * Hero money figure (handoff §1.2). The cents are split off the FORMATTED
 * string at its last "." purely for display — no arithmetic on the amount.
 */
export function HeroMoney({ value, tone = 'chrome', className }: HeroMoneyProps) {
  const formatted = formatMoney(value);
  const dot = formatted.lastIndexOf('.');
  const whole = dot === -1 ? formatted : formatted.slice(0, dot);
  const cents = dot === -1 ? '' : formatted.slice(dot);
  const brand = tone !== 'chrome';

  return (
    <p
      className={cn(
        brand
          ? 'font-sd-display text-[2.75rem] leading-none font-bold tracking-[-0.02em] tabular-nums text-white sm:text-[3.25rem]'
          : 'text-[2.75rem] leading-none font-bold tracking-[-0.04em] tabular-nums text-white sm:text-[3.75rem]',
        className,
      )}
    >
      {whole}
      {cents && (
        <span className={cn(brand ? 'text-[0.5em] tracking-normal' : 'text-[0.45em] tracking-[-0.02em]', CENTS_TONE[tone])}>
          {cents}
        </span>
      )}
    </p>
  );
}
