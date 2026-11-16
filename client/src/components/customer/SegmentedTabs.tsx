import { useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../ui/cn';

const TRACK = 'inline-flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-neutral-200 p-1';
const SEGMENT = 'inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[11px] px-4 text-sm transition-colors';
const SEGMENT_ON = 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(15,20,34,.08),0_0_0_1px_rgba(15,20,34,.04)]';
const SEGMENT_OFF = 'font-medium text-ink-secondary hover:text-ink';

/*
 * `tone="dark"` (brand theme §3.3): the same control on the charcoal hero band.
 * Extends the light look above, which stays exactly as it was.
 */
const DARK_TRACK = 'inline-flex max-w-full gap-1 overflow-x-auto rounded-[10px] bg-white/8 p-1';
const DARK_SEGMENT = 'sd-press inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-4 text-sm';
const DARK_SEGMENT_ON = 'bg-sd-red font-semibold text-white';
const DARK_SEGMENT_OFF = 'font-medium text-sd-on-dark hover:bg-white/8 hover:text-white';

/*
 * `tone="brand"` (brand theme §4.4): the light track on a white card with the
 * active segment in `sd-red` — e.g. the Wallet history tabs.
 */
const BRAND_TRACK = 'inline-flex max-w-full gap-1 overflow-x-auto rounded-[10px] bg-sd-line-subtle p-1';
const BRAND_SEGMENT = 'sd-press inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[7px] px-4 text-sm';
const BRAND_SEGMENT_ON = 'bg-sd-red font-semibold text-white';
const BRAND_SEGMENT_OFF = 'font-medium text-sd-text-2 hover:bg-white hover:text-sd-ink';

export type SegmentedTone = 'light' | 'dark' | 'brand';

const LOOK = {
  light: { track: TRACK, segment: SEGMENT, on: SEGMENT_ON, off: SEGMENT_OFF },
  dark: { track: DARK_TRACK, segment: DARK_SEGMENT, on: DARK_SEGMENT_ON, off: DARK_SEGMENT_OFF },
  brand: { track: BRAND_TRACK, segment: BRAND_SEGMENT, on: BRAND_SEGMENT_ON, off: BRAND_SEGMENT_OFF },
} as const;

const COUNT_TONE = {
  light: { on: 'bg-ink text-white', off: 'bg-line-strong text-ink-secondary' },
  dark: { on: 'bg-black/22 text-white', off: 'bg-white/12 text-sd-on-dark-strong' },
  brand: { on: 'bg-black/22 text-white', off: 'bg-sd-line text-sd-text-2' },
} as const;

export interface SegmentedTabItem<T extends string> {
  value: T;
  label: string;
  /**
   * Optional count chip. Must come from a server total — never computed from
   * the current page. `null` / omitted hides the chip.
   */
  count?: number | null;
}

export interface SegmentedTabsProps<T extends string> {
  items: readonly SegmentedTabItem<T>[];
  value: T;
  onChange: (value: T) => void;
  /** Accessible name of the tablist. */
  label: string;
  /** Optional id of the tab panel the tabs control. */
  panelId?: string;
  /** `light` (default) or `dark` for the charcoal hero band. */
  tone?: SegmentedTone;
  className?: string;
}

/**
 * Segmented tab control (handoff §2): `tablist` / `tab` / `aria-selected`,
 * roving tabindex with Arrow / Home / End keys.
 */
export function SegmentedTabs<T extends string>({
  items,
  value,
  onChange,
  label,
  panelId,
  tone = 'light',
  className,
}: SegmentedTabsProps<T>) {
  const look = LOOK[tone];
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const focusAndSelect = (index: number) => {
    const item = items[index];
    if (!item) return;
    refs.current[index]?.focus();
    onChange(item.value);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = items.length - 1;
    if (e.key === 'ArrowRight') focusAndSelect(index === last ? 0 : index + 1);
    else if (e.key === 'ArrowLeft') focusAndSelect(index === 0 ? last : index - 1);
    else if (e.key === 'Home') focusAndSelect(0);
    else if (e.key === 'End') focusAndSelect(last);
    else return;
    e.preventDefault();
  };

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn(look.track, className)}
    >
      {items.map((item, index) => {
        const selected = item.value === value;
        return (
          <button
            key={item.value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-controls={panelId}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(item.value)}
            onKeyDown={(e) => onKeyDown(e, index)}
            className={cn(look.segment, selected ? look.on : look.off)}
          >
            {item.label}
            {item.count != null && (
              <span
                className={cn(
                  'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.6875rem] font-bold tabular-nums',
                  selected ? COUNT_TONE[tone].on : COUNT_TONE[tone].off,
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export interface SegmentedLinkItem {
  to: string;
  label: string;
  /** Whether this link is the current page (decided by the caller from the route). */
  current: boolean;
}

/**
 * Same segmented look as `SegmentedTabs`, but each segment is a route LINK
 * (e.g. the Wallet history Transactions / Payouts sub-pages, handoff §3.4
 * D1-B). Link semantics, not tab semantics: a `nav` landmark and
 * `aria-current="page"` on the current segment; ordinary Tab-key navigation.
 */
export function SegmentedLinkTabs({
  items,
  label,
  tone = 'light',
  className,
}: {
  items: readonly SegmentedLinkItem[];
  /** Accessible name of the nav landmark. */
  label: string;
  /** `light` (default), `dark` for the charcoal hero band, `brand` on a white card. */
  tone?: SegmentedTone;
  className?: string;
}) {
  const look = LOOK[tone];
  return (
    <nav aria-label={label} className={cn(look.track, className)}>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.current ? 'page' : undefined}
          className={cn(look.segment, item.current ? look.on : look.off)}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
