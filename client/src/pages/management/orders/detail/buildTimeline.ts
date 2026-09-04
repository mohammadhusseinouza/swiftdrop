import type { TimelineItem } from '../../../../components/orders/OrderTimeline';
import type { BadgeTone } from '../../../../components/ui/Badge';
import { getOrderStatusPresentation } from '../../../../components/orders/orderStatus';
import {
  getParcelAttemptOutcomePresentation,
  getParcelEndReasonLabel,
} from '../../../../components/orders/parcelCollection';
import { formatDateTime, formatMoney } from '../../../../lib/format';
import type {
  OrderTimelineDriverRef,
  OrderTimelineEvent,
} from '../../../../services/domain.types';

/**
 * Build the Management Order Timeline from the server-authoritative
 * GET /orders/:id/timeline response (Phase 11.17.6) — Collection + Delivery
 * events, already deduplicated and deterministically ordered server-side.
 *
 * DISPLAY ONLY: performs no workflow/financial logic, just labels one
 * persisted event per entry. The server returns oldest-first (chronological,
 * matching every other raw list in this codebase); this module reverses to
 * newest-first for display — the same presentation choice the pre-11.17.6
 * client-built timeline used, unchanged.
 */

const fullName = (p: { firstName: string; lastName: string }) =>
  `${p.firstName} ${p.lastName}`.trim();

const driverLabel = (d: OrderTimelineDriverRef) =>
  `${d.driverNumber} · ${d.firstName} ${d.lastName}`;

const ATTEMPT_PRESENTATION: Record<
  string,
  { label: string; tone: BadgeTone }
> = {
  DELIVERED: { label: 'Delivered', tone: 'success' },
  FAILED: { label: 'Failed', tone: 'danger' },
  RETURNED: { label: 'Returned', tone: 'warning' },
};

/** Label for a financial event, keyed by `ledger:type` then `type`. */
function financialEventLabel(ev: OrderTimelineEvent): string {
  const key = `${ev.ledger}:${ev.financialType}`;
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
      return `${(ev.ledger ?? '').replace(/_/g, ' ').toLowerCase()} ${(ev.financialType ?? '')
        .replace(/_/g, ' ')
        .toLowerCase()}`.trim();
  }
}

function financialEventTone(ev: OrderTimelineEvent): BadgeTone {
  if (ev.financialType === 'REVERSAL') return 'warning';
  if (ev.financialType === 'ADJUSTMENT') return 'info';
  if (ev.financialType === 'COLLECTION') return 'brand';
  return 'success';
}

function toTimelineItem(ev: OrderTimelineEvent): TimelineItem {
  const timestamp = formatDateTime(ev.occurredAt);

  switch (ev.type) {
    case 'STATUS_CHANGED': {
      const { label, tone } = getOrderStatusPresentation(ev.toStatus ?? '');
      const parts = [ev.reason, ev.notes].filter(Boolean);
      return {
        id: ev.id,
        title: ev.fromStatus ? `Status → ${label}` : label,
        description: parts.length ? parts.join(' — ') : undefined,
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone,
      };
    }

    case 'DELIVERY_DRIVER_ASSIGNED':
      return {
        id: ev.id,
        title: `Assigned to ${ev.driver ? driverLabel(ev.driver) : 'driver'}`,
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone: 'info',
      };

    case 'DELIVERY_ASSIGNMENT_ENDED':
      return {
        id: ev.id,
        title: `Assignment to ${ev.driver ? driverLabel(ev.driver) : 'driver'} ended`,
        description: ev.endReason ?? undefined,
        timestamp,
        tone: 'warning',
      };

    case 'DELIVERY_ATTEMPT': {
      const outcome = ATTEMPT_PRESENTATION[ev.outcome ?? ''];
      const descParts: string[] = [];
      if (ev.reason) descParts.push(ev.reason);
      if (ev.outcome === 'DELIVERED' && ev.amount != null) {
        descParts.push(`Collected ${formatMoney(ev.amount)}`);
      }
      if (ev.notes) descParts.push(ev.notes);
      return {
        id: ev.id,
        title: `Delivery attempt #${ev.attemptNumber ?? ''} — ${outcome?.label ?? ev.outcome ?? 'Unknown'}`,
        description: descParts.length ? descParts.join(' — ') : undefined,
        timestamp,
        actor: ev.driver ? `by ${driverLabel(ev.driver)}` : undefined,
        tone: outcome?.tone ?? 'neutral',
      };
    }

    case 'FINANCIAL_EVENT': {
      const descParts = [
        ev.amount != null ? formatMoney(ev.amount) : undefined,
        ev.notes ?? undefined,
      ].filter(Boolean);
      return {
        id: ev.id,
        title: financialEventLabel(ev),
        description: descParts.length ? descParts.join(' — ') : undefined,
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone: financialEventTone(ev),
      };
    }

    case 'PARCEL_COLLECTION_DRIVER_ASSIGNED':
      return {
        id: ev.id,
        title: `Collection driver assigned: ${ev.driver ? driverLabel(ev.driver) : ''}`,
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone: 'info',
      };

    case 'PARCEL_COLLECTION_DRIVER_REASSIGNED':
      return {
        id: ev.id,
        title: `Collection driver reassigned from ${ev.driver ? driverLabel(ev.driver) : ''} to ${ev.toDriver ? driverLabel(ev.toDriver) : ''}`,
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone: 'info',
      };

    case 'PARCEL_COLLECTION_FAILED': {
      const parts = [ev.reason, ev.notes].filter(Boolean);
      return {
        id: ev.id,
        title: `Collection failed (attempt #${ev.attemptNumber ?? ''})`,
        description: parts.length ? parts.join(' — ') : undefined,
        timestamp,
        actor: ev.driver ? `by ${driverLabel(ev.driver)}` : undefined,
        tone: 'danger',
      };
    }

    case 'PARCEL_COLLECTION_RESCHEDULED':
      return {
        id: ev.id,
        title: 'Collection rescheduled',
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone: 'warning',
      };

    case 'PARCEL_COLLECTED_FROM_SENDER': {
      const outcome = getParcelAttemptOutcomePresentation('COLLECTED');
      return {
        id: ev.id,
        title: `Collected from sender (attempt #${ev.attemptNumber ?? ''})`,
        timestamp,
        actor: ev.driver ? `by ${driverLabel(ev.driver)}` : undefined,
        tone: outcome.tone,
      };
    }

    case 'PARCEL_RECEIVED_AT_COMPANY':
      return {
        id: ev.id,
        title: 'Parcel received at company',
        timestamp,
        actor: ev.actor ? `by ${fullName(ev.actor)}` : undefined,
        tone: 'success',
      };

    case 'PARCEL_COLLECTION_ENDED_ORDER_CANCELLED':
      return {
        id: ev.id,
        title: `Collection ended — order cancelled${ev.driver ? ` (was ${driverLabel(ev.driver)})` : ''}`,
        description: getParcelEndReasonLabel(ev.endReason),
        timestamp,
        tone: 'warning',
      };

    default:
      return { id: ev.id, title: ev.type, timestamp, tone: 'neutral' };
  }
}

export function buildOrderTimeline(events: OrderTimelineEvent[]): TimelineItem[] {
  // Server returns oldest-first; display newest-first (unchanged convention).
  return [...events].reverse().map(toTimelineItem);
}
