import { addMoney } from './money';

/**
 * Finalize Day summary — DISPLAY-ONLY helpers (no mutation, no accounting).
 *
 * "Delivered today" reuses the Dashboard's exact contract
 * (dashboard.service.ts): `orders.delivered_at` inside the current UTC
 * calendar day [00:00:00.000Z, next 00:00:00.000Z), regardless of the
 * Order's current status. The rows come from the existing Orders list read
 * (`GET /orders?sortBy=deliveredAt&sortOrder=desc`), so these helpers only
 * select the rows inside that window and add up their decimal-string money
 * in exact integer cents (lib/money.ts — never floating point).
 *
 * `combinedTotal` is Order Total + Delivery Fees for display only. It is NOT
 * company revenue: order value and delivery fee have different ownership
 * rules (COMPANY_ORDER vs DELIVERY_ONLY), which is why they stay separate.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface UtcDay {
  /** YYYY-MM-DD — the same form the Dashboard uses for its "today" links. */
  date: string;
  /** Inclusive start, epoch ms (00:00:00.000Z). */
  startMs: number;
  /** Exclusive end, epoch ms (next day 00:00:00.000Z). */
  endMs: number;
}

/** The UTC calendar day containing `now` — the Dashboard's "today" boundary. */
export function getUtcDay(now: Date = new Date()): UtcDay {
  const date = now.toISOString().slice(0, 10);
  const startMs = Date.parse(`${date}T00:00:00.000Z`);
  return { date, startMs, endMs: startMs + DAY_MS };
}

export interface DeliveredOrderRow {
  id: string;
  orderAmount: string;
  deliveryFee: string;
  deliveredAt: string | null;
}

export interface DeliveredPageScan<T extends DeliveredOrderRow> {
  /** Rows of this page delivered inside the day window. */
  inDay: T[];
  /**
   * True once the page reached a row that sorts past the window (not yet
   * delivered, or delivered before the day started) — no later page can
   * contain an in-window row, so pagination can stop.
   */
  reachedEnd: boolean;
}

/**
 * Scan one page of Orders sorted by `deliveredAt` DESC (NULLS LAST) and keep
 * the rows delivered inside `[startMs, endMs)`.
 */
export function scanDeliveredPage<T extends DeliveredOrderRow>(
  rows: readonly T[],
  day: Pick<UtcDay, 'startMs' | 'endMs'>,
): DeliveredPageScan<T> {
  const inDay: T[] = [];
  for (const row of rows) {
    if (!row.deliveredAt) return { inDay, reachedEnd: true };
    const at = Date.parse(row.deliveredAt);
    if (Number.isNaN(at)) continue;
    if (at < day.startMs) return { inDay, reachedEnd: true };
    if (at < day.endMs) inDay.push(row);
  }
  return { inDay, reachedEnd: false };
}

export interface DailyDeliverySummary {
  /** UTC day (YYYY-MM-DD) the summary covers. */
  date: string;
  deliveredCount: number;
  /** Sum of `orderAmount` — 2-decimal string. */
  orderTotal: string;
  /** Sum of `deliveryFee` — 2-decimal string. */
  deliveryFeeTotal: string;
  /** orderTotal + deliveryFeeTotal — display only, NOT revenue. */
  combinedTotal: string;
}

/**
 * Exact-cents totals for the given delivered rows. Returns `null` if any
 * money string is not a valid backend decimal, so the UI shows an error
 * instead of a silently wrong total.
 */
export function summarizeDeliveredOrders(
  date: string,
  rows: readonly DeliveredOrderRow[],
): DailyDeliverySummary | null {
  let orderTotal = '0.00';
  let deliveryFeeTotal = '0.00';
  for (const row of rows) {
    const nextOrder = addMoney(orderTotal, row.orderAmount);
    const nextFee = addMoney(deliveryFeeTotal, row.deliveryFee);
    if (nextOrder === null || nextFee === null) return null;
    orderTotal = nextOrder;
    deliveryFeeTotal = nextFee;
  }
  const combinedTotal = addMoney(orderTotal, deliveryFeeTotal);
  if (combinedTotal === null) return null;
  return {
    date,
    deliveredCount: rows.length,
    orderTotal,
    deliveryFeeTotal,
    combinedTotal,
  };
}
