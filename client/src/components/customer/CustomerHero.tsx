import {
  createContext,
  useContext,
  useLayoutEffect,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { cn } from '../ui/cn';

/**
 * Hero slot of the brand hero band (docs/brand-theme/brand-theme-handoff.md
 * §3.1, decision B-D4 A).
 *
 * `CustomerLayout` renders the charcoal band (header + hero section) and
 * provides this context. A page fills the hero section by rendering
 * `<CustomerHero>…</CustomerHero>` anywhere in its tree: the children are
 * portalled into the band, so they keep the page's own React context, data
 * and state. Registration happens in a layout effect (before paint), so the
 * layout's fallback hero never flashes for a page that has one.
 *
 * One hero at a time: the last mounted `CustomerHero` wins; unmounting it
 * restores the fallback.
 */
export interface CustomerHeroOptions {
  /** Speed-line decoration (Overview, Wallet only — handoff §3.2). */
  speedLines: boolean;
  /** `narrow` = 960 px content column (Profile), otherwise 1200 px. */
  width: 'default' | 'narrow';
}

export interface CustomerHeroContextValue {
  /** The band's hero element, once mounted. */
  target: HTMLElement | null;
  setHero: (options: CustomerHeroOptions | null) => void;
}

export const CustomerHeroContext = createContext<CustomerHeroContextValue | null>(null);

export interface CustomerHeroProps {
  children: ReactNode;
  speedLines?: boolean;
  width?: CustomerHeroOptions['width'];
  className?: string;
}

export function CustomerHero({
  children,
  speedLines = false,
  width = 'default',
  className,
}: CustomerHeroProps) {
  const ctx = useContext(CustomerHeroContext);
  const setHero = ctx?.setHero;

  useLayoutEffect(() => {
    if (!setHero) return;
    setHero({ speedLines, width });
    return () => setHero(null);
  }, [setHero, speedLines, width]);

  const content = <div className={cn('sd-stagger flex flex-col gap-6', className)}>{children}</div>;

  // Outside the brand shell (e.g. an isolated render): render in place.
  if (!ctx) return content;
  if (!ctx.target) return null;
  return createPortal(content, ctx.target);
}
