import { useRef, type KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '../ui/cn';

const TRACK = 'inline-flex max-w-full gap-1 overflow-x-auto rounded-[14px] bg-neutral-200 p-1';
const SEGMENT = 'inline-flex h-10 shrink-0 items-center gap-2 whitespace-nowrap rounded-[11px] px-4 text-sm transition-colors';
const SEGMENT_ON = 'bg-card font-semibold text-ink shadow-[0_1px_2px_rgba(15,20,34,.08),0_0_0_1px_rgba(15,20,34,.04)]';
const SEGMENT_OFF = 'font-medium text-ink-secondary hover:text-ink';

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
  className,
}: SegmentedTabsProps<T>) {
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
      className={cn(TRACK, className)}
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
            className={cn(SEGMENT, selected ? SEGMENT_ON : SEGMENT_OFF)}
          >
            {item.label}
            {item.count != null && (
              <span
                className={cn(
                  'inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[0.6875rem] font-bold tabular-nums',
                  selected ? 'bg-ink text-white' : 'bg-line-strong text-ink-secondary',
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
  className,
}: {
  items: readonly SegmentedLinkItem[];
  /** Accessible name of the nav landmark. */
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={cn(TRACK, className)}>
      {items.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          aria-current={item.current ? 'page' : undefined}
          className={cn(SEGMENT, item.current ? SEGMENT_ON : SEGMENT_OFF)}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  );
}
