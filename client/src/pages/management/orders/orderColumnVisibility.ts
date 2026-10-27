import { useCallback, useMemo, useState } from 'react';

/**
 * Management Orders table — per-viewer column visibility.
 *
 * Presentation only: hiding a column never changes the query, filters, sort,
 * selection or row actions. The Order number (row link) and Actions columns,
 * plus the selection checkbox, are always shown and are not listed here.
 */
export interface OrderColumnOption {
  /** DataTable column id from `orderColumns`. */
  id: string;
  /** Label shown in the Columns menu. */
  label: string;
  defaultVisible: boolean;
}

export const ORDER_COLUMN_OPTIONS: readonly OrderColumnOption[] = [
  { id: 'customer', label: 'Customer', defaultVisible: true },
  { id: 'receiver', label: 'Receiver', defaultVisible: true },
  { id: 'phone', label: 'Receiver phone', defaultVisible: false },
  { id: 'area', label: 'Area', defaultVisible: true },
  { id: 'type', label: 'Order type', defaultVisible: true },
  { id: 'intake', label: 'Parcel intake', defaultVisible: false },
  { id: 'paymentType', label: 'Payment type', defaultVisible: false },
  { id: 'orderAmount', label: 'Order amount', defaultVisible: false },
  { id: 'deliveryFee', label: 'Delivery fee', defaultVisible: false },
  { id: 'collect', label: 'Amount to collect', defaultVisible: true },
  { id: 'collectionDriver', label: 'Collection driver', defaultVisible: false },
  { id: 'driver', label: 'Delivery driver', defaultVisible: true },
  { id: 'status', label: 'Status', defaultVisible: true },
  { id: 'created', label: 'Created date', defaultVisible: false },
  { id: 'delivered', label: 'Delivered date', defaultVisible: false },
];

const STORAGE_KEY = 'spring-delivery.management.ordersTable.columns';

/**
 * Stored shape. `known` records which options existed when the preference was
 * saved, so a column added later falls back to its default instead of being
 * treated as "hidden by the user". Ids that no longer exist are ignored.
 */
interface StoredPreference {
  visible: string[];
  known: string[];
}

function defaultVisibleIds(): Set<string> {
  return new Set(ORDER_COLUMN_OPTIONS.filter((o) => o.defaultVisible).map((o) => o.id));
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Per-viewer convenience only. Storage may be unavailable or hold stale /
 * malformed data — any problem falls back to the default layout.
 */
function readPreference(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultVisibleIds();
    const parsed: unknown = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      !isStringArray((parsed as StoredPreference).visible) ||
      !isStringArray((parsed as StoredPreference).known)
    ) {
      return defaultVisibleIds();
    }
    const visible = new Set((parsed as StoredPreference).visible);
    const known = new Set((parsed as StoredPreference).known);
    return new Set(
      ORDER_COLUMN_OPTIONS.filter((o) =>
        known.has(o.id) ? visible.has(o.id) : o.defaultVisible,
      ).map((o) => o.id),
    );
  } catch {
    return defaultVisibleIds();
  }
}

function persistPreference(visible: ReadonlySet<string>): void {
  try {
    const value: StoredPreference = {
      visible: ORDER_COLUMN_OPTIONS.filter((o) => visible.has(o.id)).map((o) => o.id),
      known: ORDER_COLUMN_OPTIONS.map((o) => o.id),
    };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Preference simply won't survive a refresh.
  }
}

export function useOrderColumnVisibility() {
  const [visibleIds, setVisibleIds] = useState<ReadonlySet<string>>(readPreference);

  const update = useCallback((next: Set<string>) => {
    setVisibleIds(next);
    persistPreference(next);
  }, []);

  const toggle = useCallback(
    (id: string) => {
      const next = new Set(visibleIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      update(next);
    },
    [visibleIds, update],
  );

  const reset = useCallback(() => update(defaultVisibleIds()), [update]);

  const isDefault = useMemo(
    () => ORDER_COLUMN_OPTIONS.every((o) => o.defaultVisible === visibleIds.has(o.id)),
    [visibleIds],
  );

  return { visibleIds, toggle, reset, isDefault };
}
