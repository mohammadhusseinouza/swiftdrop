import type { TimelineItem } from '../../../../components/orders/OrderTimeline';
import type { BadgeTone } from '../../../../components/ui/Badge';
import { getOrderStatusPresentation } from '../../../../components/orders/orderStatus';
import { formatDateTime, formatMoney } from '../../../../lib/format';
import type {
  OrderDetail,
  OrderFinancialEvent,
} from '../../../../services/domain.types';

/**
 * Build the Management Order Timeline for one Order from the authoritative
 * OrderDetail response — operational events (statusHistory + assignmentHistory
 * + deliveryAttempts) AND financial events (financialEvents), as required by
 * page-structure §6.7.
 *
 * DISPLAY ONLY:
 *   - never mutates the source arrays (spreads before sorting)
 *   - performs no workflow / financial logic — it only re-labels persisted
 *     events (one timeline entry per persisted occurrence, never synthesised)
 *   - newest-first, matching the page-structure §6.7 example
 *   - identical timestamps fall back to a deterministic source ordering
 *     (status change, assignment, delivery attempt, financial event)
 *
 * This is NOT a full system audit log — it covers the order's operational and
 * financial history only.
 */

interface RawEvent {
  id: string;
  at: number;
  /** Deterministic tiebreak for identical timestamps. */
  seq: number;
  item: TimelineItem;
}

const fullName = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`.trim();

const driverLabel = (d: {
  driverNumber: string;
  user: { firstName: string; lastName: string };
}) => `${d.driverNumber} · ${fullName(d.user)}`;

function toMillis(iso: string): number {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : t;
}

const ATTEMPT_PRESENTATION: Record<
  string,
  { label: string; tone: BadgeTone }
> = {
  DELIVERED: { label: 'Delivered', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  RETURNED: { label: 'Returned', tone: 'warning' },
};

/** Label for a financial event, keyed by `ledger:type` then `type`. */
function financialEventLabel(ev: OrderFinancialEvent): string {
  const key = `${ev.ledger}:${ev.type}`;
  switch (key) {
    case 'DRIVER_CASH:COLLECTION':
      return 'Amount collected';
    case 'DRIVER_CASH:REVERSAL':
      return 'Cash collection reversed';
    case 'DRIVER_CASH:ADJUSTMENT':
      return 'Driver cash adjusted';
    case 'WALLET:ORDER_CREDIT':
      return 'Customer wallet credited';
    case 'WALLET:REVERSAL':
      return 'Customer wallet credit reversed';
    case 'WALLET:ADJUSTMENT':
      return 'Customer wallet adjusted';
    case 'COMPANY_FINANCE:DELIVERY_FEE_REVENUE':
      return 'Delivery fee revenue recorded';
    case 'COMPANY_FINANCE:COMPANY_ORDER_PRODUCT_REVENUE':
      return 'Company order revenue recorded';
    case 'COMPANY_FINANCE:REVERSAL':
      return 'Company revenue reversed';
    case 'COMPANY_FINANCE:ADJUSTMENT':
      return 'Company adjustment';
    default:
      return `${ev.ledger.replace(/_/g, ' ').toLowerCase()} ${ev.type
        .replace(/_/g, ' ')
        .toLowerCase()}`;
  }
}

function financialEventTone(ev: OrderFinancialEvent): BadgeTone {
  if (ev.type === 'REVERSAL') return 'warning';
  if (ev.type === 'ADJUSTMENT') return 'info';
  if (ev.type === 'COLLECTION') return 'brand';
  return 'success';
}

export function buildOrderTimeline(order: OrderDetail): TimelineItem[] {
  const events: RawEvent[] = [];

  order.statusHistory.forEach((entry, i) => {
    const { label, tone } = getOrderStatusPresentation(entry.toStatus);
    const parts = [entry.reason, entry.notes].filter(Boolean);
    events.push({
      id: `status:${entry.id}`,
      at: toMillis(entry.createdAt),
      seq: 100000 + i,
      item: {
        id: `status:${entry.id}`,
        title: entry.fromStatus ? `Status → ${label}` : label,
        description: parts.length ? parts.join(' — ') : undefined,
        timestamp: formatDateTime(entry.createdAt),
        actor: `by ${fullName(entry.changedBy)}`,
        tone,
      },
    });
  });

  order.assignmentHistory.forEach((entry, i) => {
    events.push({
      id: `assign:${entry.id}`,
      at: toMillis(entry.assignedAt),
      seq: 200000 + i,
      item: {
        id: `assign:${entry.id}`,
        title: `Assigned to ${driverLabel(entry.driver)}`,
        timestamp: formatDateTime(entry.assignedAt),
        actor: `by ${fullName(entry.assignedBy)}`,
        tone: 'info',
      },
    });
    if (entry.endedAt && entry.endReason) {
      events.push({
        id: `assign-end:${entry.id}`,
        at: toMillis(entry.endedAt),
        seq: 250000 + i,
        item: {
          id: `assign-end:${entry.id}`,
          title: `Assignment to ${driverLabel(entry.driver)} ended`,
          description: entry.endReason,
          timestamp: formatDateTime(entry.endedAt),
          tone: 'warning',
        },
      });
    }
  });

  order.deliveryAttempts.forEach((entry, i) => {
    const when = entry.completedAt ?? entry.startedAt;
    const outcome = ATTEMPT_PRESENTATION[entry.outcome];
    const descParts: string[] = [];
    if (entry.failedReason) descParts.push(entry.failedReason.name);
    if (entry.outcome === 'DELIVERED' && entry.actualCollection != null) {
      descParts.push(`Collected ${formatMoney(entry.actualCollection)}`);
    }
    if (entry.notes) descParts.push(entry.notes);
    events.push({
      id: `attempt:${entry.id}`,
      at: toMillis(when),
      seq: 300000 + i,
      item: {
        id: `attempt:${entry.id}`,
        title: `Delivery attempt #${entry.attemptNumber} — ${
          outcome?.label ?? entry.outcome
        }`,
        description: descParts.length ? descParts.join(' — ') : undefined,
        timestamp: formatDateTime(when),
        actor: `by ${driverLabel(entry.driver)}`,
        tone: outcome?.tone ?? 'neutral',
      },
    });
  });

  order.financialEvents.forEach((ev, i) => {
    const sign = ev.direction === 'DEBIT' ? '−' : '';
    events.push({
      id: `finance:${ev.id}`,
      at: toMillis(ev.occurredAt),
      seq: 400000 + i,
      item: {
        id: `finance:${ev.id}`,
        title: financialEventLabel(ev),
        description: [
          `${sign}${formatMoney(ev.amount)}`,
          ev.notes ?? undefined,
        ]
          .filter(Boolean)
          .join(' — '),
        timestamp: formatDateTime(ev.occurredAt),
        actor: ev.actor
          ? `by ${fullName(ev.actor)}`
          : undefined,
        tone: financialEventTone(ev),
      },
    });
  });

  events.sort((a, b) => (b.at - a.at) || (b.seq - a.seq));
  return events.map((e) => e.item);
}
