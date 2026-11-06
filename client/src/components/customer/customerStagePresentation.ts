import type { BadgeTone } from '../ui/Badge';
import { getCustomerStatusPresentation } from '../orders/orderStatus';

/**
 * Customer Portal Redesign — stage + pill presentation for StageProgress /
 * StatusPill (handoff §2, §3.2).
 *
 * DISPLAY ONLY, and deliberately NOT a second status mapping: the wording and
 * the status → stage grouping both come from the canonical customer-safe
 * mapping `getCustomerStatusPresentation` (components/orders/orderStatus.ts,
 * page_structure §40). Each of the four progress stages is identified by the
 * label the canonical mapping gives one representative status, so e.g.
 * ASSIGNED / PICKED_UP land on the "Ready for Delivery" stage because the
 * canonical mapping labels them that way — not because this file says so.
 */

export type CustomerStageNumber = 1 | 2 | 3 | 4;

/** Representative internal status for each of the four customer stages. */
const STAGE_REPRESENTATIVES = [
  'RECEIVED',
  'READY_FOR_PICKUP',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
] as const;

/** The four stage labels, in order, exactly as the canonical mapping words them. */
export function getCustomerStageLabels(): string[] {
  return STAGE_REPRESENTATIVES.map((s) => getCustomerStatusPresentation(s).label);
}

/**
 * The 1–4 progress stage of a status, or `null` for an exception status
 * (failed / rescheduled / returned / cancelled / unknown), which is not one of
 * the four drawn stages (handoff §3.2).
 */
export function getCustomerStageNumber(status: string): CustomerStageNumber | null {
  const label = getCustomerStatusPresentation(status).label;
  const index = getCustomerStageLabels().indexOf(label);
  return index === -1 ? null : ((index + 1) as CustomerStageNumber);
}

/** Visual tone of the redesigned customer StatusPill. */
export type CustomerPillTone = 'neutral' | 'neutral-strong' | 'brand' | 'success' | 'warning';

/**
 * Translates the canonical mapping's tone into the redesign's pill palette
 * (handoff §3.2): `info` (Ready for Delivery) becomes the stronger neutral,
 * `danger` (unsuccessful attempt) becomes the warning pill — the redesign has
 * no red pill on the customer canvas. Wording is untouched.
 */
const PILL_TONE: Record<BadgeTone, CustomerPillTone> = {
  neutral: 'neutral',
  info: 'neutral-strong',
  brand: 'brand',
  success: 'success',
  warning: 'warning',
  danger: 'warning',
};

export function getCustomerPillPresentation(status: string): {
  label: string;
  tone: CustomerPillTone;
} {
  const { label, tone } = getCustomerStatusPresentation(status);
  return { label, tone: PILL_TONE[tone] };
}
