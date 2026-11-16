import type { ReactNode } from 'react';
import { cn } from '../ui/cn';

export interface HeroStatTileProps {
  /** Card label (Saira, uppercase) — e.g. "Pending delivery". */
  label?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Translucent key-figure tile for the charcoal hero band
 * (docs/brand-theme/brand-theme-handoff.md §3.3). Layout only: the page
 * supplies the content (money via `HeroMoney tone="dark"` / `formatMoney`).
 */
export function HeroStatTile({ label, children, className }: HeroStatTileProps) {
  return (
    <section
      className={cn(
        'min-w-0 rounded-[14px] border border-white/8 bg-white/5 px-5 py-[18px] text-white',
        className,
      )}
    >
      {label && (
        <p className="font-sd-display text-[0.8125rem] font-semibold tracking-[0.12em] text-sd-on-dark uppercase">
          {label}
        </p>
      )}
      {children}
    </section>
  );
}
