import type { ReactNode } from 'react';
import { cn } from '../ui/cn';
import { formatMoney } from '../../lib/format';

export interface BalanceHeroCardProps {
  children: ReactNode;
  className?: string;
}

/**
 * Dark "chrome" panel for a page's headline money figure (handoff §2). The
 * concentric rings are purely decorative (`aria-hidden`); no gradients.
 * Content is supplied by the page (Step 2+): this is layout only.
 */
export function BalanceHeroCard({ children, className }: BalanceHeroCardProps) {
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

export interface HeroMoneyProps {
  /** Server money string — formatted with formatMoney, never parsed to a float. */
  value: string | null | undefined;
  className?: string;
}

/**
 * Hero money figure (handoff §1.2). The cents are split off the FORMATTED
 * string at its last "." purely for display — no arithmetic on the amount.
 */
export function HeroMoney({ value, className }: HeroMoneyProps) {
  const formatted = formatMoney(value);
  const dot = formatted.lastIndexOf('.');
  const whole = dot === -1 ? formatted : formatted.slice(0, dot);
  const cents = dot === -1 ? '' : formatted.slice(dot);

  return (
    <p
      className={cn(
        'text-[2.75rem] leading-none font-bold tracking-[-0.04em] tabular-nums text-white sm:text-[3.75rem]',
        className,
      )}
    >
      {whole}
      {cents && <span className="text-[0.45em] tracking-[-0.02em] text-chrome-ink">{cents}</span>}
    </p>
  );
}
