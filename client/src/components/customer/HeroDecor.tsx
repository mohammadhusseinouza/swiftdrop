import { cn } from '../ui/cn';

/**
 * Brand hero decoration (docs/brand-theme/brand-theme-handoff.md §3.2).
 *
 * Purely decorative: every root is `aria-hidden` and `pointer-events-none`,
 * and none of them carries text. Render them inside a `relative isolate
 * overflow-hidden` charcoal surface; they sit at `-z-10` behind its content.
 * Default positions are the Customer hero band's; the sign-in panel (B4)
 * passes its own placement through `className`.
 */
const DECOR = 'pointer-events-none absolute -z-10';

export interface HeroDecorProps {
  /** Placement / size overrides (replaces the default position classes). */
  className?: string;
}

/** 680 px ring, steel-grey with a brighter top edge, turning once per 60 s. */
export function OrbitRing({ className }: HeroDecorProps) {
  return (
    <span
      aria-hidden="true"
      data-decor="orbit-ring"
      className={cn(
        DECOR,
        'sd-orbit rounded-full border-2 border-[rgba(207,216,220,0.10)] border-t-[rgba(207,216,220,0.35)]',
        className ?? '-top-[260px] -right-[180px] size-[680px]',
      )}
    />
  );
}

/** 440 px static red arc (right + bottom sides only). */
export function RedArc({ className }: HeroDecorProps) {
  return (
    <span
      aria-hidden="true"
      data-decor="red-arc"
      className={cn(
        DECOR,
        'rounded-full border-2 border-[rgba(239,49,63,0.4)] border-t-transparent border-l-transparent',
        className ?? '-top-[140px] -right-[60px] size-[440px]',
      )}
    />
  );
}

/** Bar widths in px (handoff: 3–4 bars, 90–260 px). */
const SPEED_LINE_WIDTHS = [260, 180, 130, 90] as const;

export interface SpeedLinesProps extends HeroDecorProps {
  /** `hero` = 3 px bars, right-aligned; `signin` = 4 px bars, left-aligned. */
  variant?: 'hero' | 'signin';
}

/**
 * Speed lines (Overview, Wallet and sign-in only). Each bar slides in from
 * +60 px with a fade, staggered 0.12 s; off under reduced motion. Hidden below
 * `md` (handoff §3.2): on phones they would sit behind the nav row.
 */
export function SpeedLines({ variant = 'hero', className }: SpeedLinesProps) {
  const signin = variant === 'signin';
  return (
    <span
      aria-hidden="true"
      data-decor="speed-lines"
      className={cn(
        DECOR,
        'hidden flex-col gap-2.5 md:flex',
        signin ? 'items-start' : 'items-end',
        className ?? (signin ? 'bottom-16 left-0' : 'top-24 right-8'),
      )}
    >
      {SPEED_LINE_WIDTHS.map((width, i) => (
        <span
          key={width}
          className={cn(
            'sd-speed-line block rounded-full bg-linear-to-r from-transparent to-sd-red-logo',
            signin ? 'h-1' : 'h-[3px]',
          )}
          style={{ width, animationDelay: `${i * 0.12}s` }}
        />
      ))}
    </span>
  );
}
