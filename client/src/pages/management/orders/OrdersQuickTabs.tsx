import { cn } from '../../../components/ui/cn';
import { QUICK_TABS, type QuickTab, type QuickTabId } from './ordersListParams';

interface OrdersQuickTabsProps {
  /** Derived from URL state — null when a custom status filter is active. */
  activeId: QuickTabId | null;
  onSelect: (tab: QuickTab) => void;
}

/**
 * Quick status tabs. Each tab only sets/clears the status + assignment
 * dimensions — every other filter (driver, customer, area, type, payment,
 * date, search) is preserved. "All" clears only status + assignment.
 * The active tab is derived from the URL, not a separate store.
 */
export function OrdersQuickTabs({ activeId, onSelect }: OrdersQuickTabsProps) {
  return (
    <div
      role="tablist"
      aria-label="Order status"
      className="flex gap-1.5 overflow-x-auto pb-1"
    >
      {QUICK_TABS.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onSelect(tab)}
            className={cn(
              'inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-[0.5rem] border px-3 text-[0.8125rem] transition-colors',
              active
                ? 'border-brand-600 bg-brand-50 font-semibold text-brand-700'
                : 'border-line bg-card font-medium text-ink-secondary hover:bg-sunken',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
