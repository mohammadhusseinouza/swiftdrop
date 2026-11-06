import type {
  CustomerOrderPackage,
  CustomerOrderReceiver,
  TrackingStageState,
} from '../../services/domain.types';
import { getCustomerStatusPresentation } from '../orders/orderStatus';
import { getCustomerStageNumber } from './customerStagePresentation';

/**
 * Customer Portal Redesign Step 4 — Order Detail presentation helpers.
 * DISPLAY ONLY; pure (no React), so each rule is unit-tested.
 */

/* ------------------------------- Journey ------------------------------- */

/** Text for a server tracking-stage state — state is never colour alone. */
const STATE_WORD: Record<TrackingStageState, string> = {
  done: 'Done',
  current: 'In progress',
  upcoming: 'Upcoming',
};

export function getTrackingStateWord(state: string): string {
  return (STATE_WORD as Record<string, string>)[state] ?? 'Upcoming';
}

const STAGE_LEAD: Record<1 | 2 | 3 | 4, string> = {
  1: 'Your order has been received.',
  2: 'Your order is ready for delivery.',
  3: 'Your parcel is on its way.',
  4: 'Your parcel has been delivered.',
};

/**
 * One-line lead under the Journey title. Derived ONLY from the canonical
 * customer-safe status: the four normal stages get a sentence, anything else
 * states the customer-safe wording. Never names a driver, never gives an ETA.
 */
export function getJourneyLead(status: string): string {
  const stage = getCustomerStageNumber(status);
  if (stage !== null) return STAGE_LEAD[stage];
  return `Current status: ${getCustomerStatusPresentation(status).label}.`;
}

/* ---------------------------- Copy to clipboard ---------------------------- */

export type CopyResult = 'copied' | 'unavailable' | 'failed';

/** Minimal clipboard surface, injectable for tests. */
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}

/**
 * Copy text without ever throwing: `unavailable` when there is no Clipboard
 * API (insecure context / old browser), `failed` when the write is rejected
 * (permission denied). The caller shows a short non-blocking message.
 */
export async function copyText(text: string, clipboard: ClipboardLike | undefined | null): Promise<CopyResult> {
  if (!clipboard || typeof clipboard.writeText !== 'function') return 'unavailable';
  try {
    await clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function getCopyMessage(result: CopyResult): string {
  if (result === 'copied') return 'Copied';
  return 'Couldn’t copy. Select the code to copy it.';
}

/* ------------------------------ Delivering to ------------------------------ */

/** Only http(s) map links are rendered as links (never javascript:, data:, …). */
export function isSafeHttpUrl(value: string | null | undefined): value is string {
  if (!value || value.trim() === '') return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** "Area · Address · Building / floor" — blank parts are skipped. */
export function getReceiverAddressParts(receiver: CustomerOrderReceiver): string[] {
  return [receiver.area, receiver.address, receiver.buildingFloor]
    .map((p) => (p ?? '').trim())
    .filter((p) => p !== '');
}

/* --------------------------------- Package --------------------------------- */

export interface DetailRow {
  label: string;
  value: string;
}

/** Contents + Pieces always; Quantity / Weight only when the server sends them. */
export function getPackageRows(pkg: CustomerOrderPackage): DetailRow[] {
  const rows: DetailRow[] = [
    { label: 'Contents', value: pkg.description?.trim() || '—' },
    { label: 'Pieces', value: String(pkg.packageCount) },
  ];
  if (pkg.quantity != null) rows.push({ label: 'Quantity', value: String(pkg.quantity) });
  if (pkg.weightKg != null && pkg.weightKg.trim() !== '') {
    rows.push({ label: 'Weight', value: `${pkg.weightKg} kg` });
  }
  return rows;
}
