import type { BadgeTone } from '../ui/Badge';
import { PERMISSIONS } from '../../features/auth/permissions';
import { formatCents, parseMoneyToCents } from '../../lib/money';
import type {
  CollectionSettlementState,
  OrderFinancialReleaseView,
  ReportingBasis,
} from '../../services/domain.types';

/**
 * Settlement-based financial release (FR.10) — the shared display vocabulary
 * for financial status, release mode, release / review / collection state,
 * the customer pending breakdown and the reporting basis. Pure (no React), so
 * every label and rule is unit-tested. Display only: every figure comes from
 * the backend; nothing here derives an unapproved financial split.
 */

export interface LabelTone {
  label: string;
  tone: BadgeTone;
}

function humanize(token: string): string {
  return token.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

/* ----------------------------- financial status --------------------------- */

/**
 * Every OrderFinancialStatus value, in filter order. GET /orders accepts all
 * seven as the `financialStatus` filter (the server schema is derived from the
 * Prisma enum since the FR.10 closure).
 */
export const FINANCIAL_STATUSES = [
  'PENDING',
  'REVIEW_REQUIRED',
  'AWAITING_SETTLEMENT',
  'FINALIZED',
  'COLLECTION_VOIDED',
  'RELEASE_REVERSED',
  'NOT_APPLICABLE',
] as const;

const FINANCIAL_STATUS: Record<string, LabelTone & { description: string }> = {
  PENDING: { label: 'Pending', tone: 'neutral', description: 'Not delivered yet — nothing has been posted.' },
  REVIEW_REQUIRED: {
    label: 'Review required',
    tone: 'danger',
    description: 'The collected amount differs from the expected amount and needs an approved split.',
  },
  AWAITING_SETTLEMENT: {
    label: 'Awaiting settlement',
    tone: 'warning',
    description: 'Delivered; released once the driver fully settles this collection.',
  },
  FINALIZED: { label: 'Finalized', tone: 'success', description: 'Customer and company amounts are posted.' },
  COLLECTION_VOIDED: {
    label: 'Collection voided',
    tone: 'danger',
    description: 'The recorded collection was voided before any release.',
  },
  RELEASE_REVERSED: {
    label: 'Release reversed',
    tone: 'danger',
    description: 'The released customer credit and company revenue were reversed.',
  },
  NOT_APPLICABLE: { label: 'Not applicable', tone: 'neutral', description: 'No financial posting applies.' },
};

export function getFinancialStatusPresentation(status: string): LabelTone & { description: string } {
  return FINANCIAL_STATUS[status] ?? { label: humanize(status), tone: 'neutral', description: '' };
}

/* ------------------------------- release mode ----------------------------- */

/** The mode persisted at delivery; null is a legacy (pre-FR) order. */
export function getReleaseModePresentation(mode: string | null | undefined): LabelTone & { description: string } {
  if (mode === 'ON_SETTLEMENT') {
    return { label: 'On settlement', tone: 'brand', description: 'Released when the driver fully settles the collection.' };
  }
  if (mode === 'IMMEDIATE') {
    return { label: 'Immediate', tone: 'neutral', description: 'Posted at delivery (direct payment or no cash collected).' };
  }
  return { label: 'Legacy (immediate)', tone: 'neutral', description: 'Posted at delivery under the original rules.' };
}

/* --------------------------- release / review state ----------------------- */

const COLLECTION_STATE: Record<CollectionSettlementState, LabelTone> = {
  UNSETTLED: { label: 'Unsettled', tone: 'neutral' },
  PARTIALLY_SETTLED: { label: 'Partially settled', tone: 'info' },
  FULLY_SETTLED: { label: 'Fully settled', tone: 'success' },
};

const RELEASE_STATUS: Record<string, LabelTone> = {
  PENDING: { label: 'Awaiting settlement', tone: 'warning' },
  RELEASED: { label: 'Released', tone: 'success' },
  VOIDED: { label: 'Collection voided', tone: 'danger' },
  RELEASE_REVERSED: { label: 'Release reversed', tone: 'danger' },
};

const REVIEW_STATUS: Record<string, LabelTone | null> = {
  NOT_REQUIRED: null,
  AWAITING_REVIEW: { label: 'Under review', tone: 'warning' },
  RESOLVED: { label: 'Review resolved', tone: 'neutral' },
};

export function collectionStateLabel(state: CollectionSettlementState): LabelTone {
  return COLLECTION_STATE[state] ?? { label: humanize(state), tone: 'neutral' };
}

export function releaseStatusLabel(status: string): LabelTone {
  return RELEASE_STATUS[status] ?? { label: humanize(status), tone: 'neutral' };
}

/** null when no review applies (nothing to show). */
export function reviewStatusLabel(status: string): LabelTone | null {
  return status in REVIEW_STATUS ? REVIEW_STATUS[status] : { label: humanize(status), tone: 'neutral' };
}

const RELEASE_CORRECTION: Record<string, string> = {
  COLLECTION_VOID: 'Collection voided',
  RELEASE_REVERSAL: 'Release reversed',
};

export function releaseCorrectionLabel(type: string): string {
  return RELEASE_CORRECTION[type] ?? humanize(type);
}

/* --------------------------- order release summary ------------------------ */

export type OrderReleaseState =
  | 'LEGACY'
  | 'IMMEDIATE'
  | 'AWAITING_REVIEW'
  | 'UNSETTLED'
  | 'PARTIALLY_SETTLED'
  | 'SETTLED_AWAITING_REVIEW'
  | 'FULLY_SETTLED_PENDING'
  | 'RELEASED'
  | 'VOIDED'
  | 'REVERSED';

export interface OrderReleaseSummary {
  state: OrderReleaseState;
  headline: string;
  tone: BadgeTone;
  /** The approved split is known (all three planned amounts present). */
  plannedSplitKnown: boolean;
}

/** One headline for the Order Detail panel, from the backend release view only. */
export function summarizeOrderRelease(view: OrderFinancialReleaseView): OrderReleaseSummary {
  const r = view.release;
  if (!r) {
    return view.financialReleaseMode === 'IMMEDIATE'
      ? { state: 'IMMEDIATE', headline: 'Posted at delivery (immediate release).', tone: 'neutral', plannedSplitKnown: false }
      : { state: 'LEGACY', headline: 'Legacy order — posted at delivery under the original rules.', tone: 'neutral', plannedSplitKnown: false };
  }
  const plannedSplitKnown =
    r.plannedCustomerWalletAmount !== null && r.plannedCompanyProductAmount !== null && r.plannedCompanyFeeAmount !== null;
  if (r.releaseStatus === 'RELEASED') return { state: 'RELEASED', headline: 'Released — customer and company amounts are posted.', tone: 'success', plannedSplitKnown };
  if (r.releaseStatus === 'VOIDED') return { state: 'VOIDED', headline: 'Collection voided — nothing was released.', tone: 'danger', plannedSplitKnown };
  if (r.releaseStatus === 'RELEASE_REVERSED') return { state: 'REVERSED', headline: 'Release reversed — the posted amounts were reversed.', tone: 'danger', plannedSplitKnown };
  const awaitingReview = r.reviewStatus === 'AWAITING_REVIEW';
  if (r.settlementState === 'FULLY_SETTLED') {
    return awaitingReview
      ? { state: 'SETTLED_AWAITING_REVIEW', headline: 'Fully settled — release waits for the collection difference review.', tone: 'warning', plannedSplitKnown }
      : { state: 'FULLY_SETTLED_PENDING', headline: 'Fully settled — release pending.', tone: 'warning', plannedSplitKnown };
  }
  if (awaitingReview) return { state: 'AWAITING_REVIEW', headline: 'Collection difference under review — no split approved yet.', tone: 'warning', plannedSplitKnown };
  if (r.settlementState === 'PARTIALLY_SETTLED') return { state: 'PARTIALLY_SETTLED', headline: 'Partially settled by the driver — released when fully settled.', tone: 'info', plannedSplitKnown };
  return { state: 'UNSETTLED', headline: 'Awaiting driver settlement — released when fully settled.', tone: 'warning', plannedSplitKnown };
}

/* ----------------------------- pending breakdown -------------------------- */

export interface PendingBreakdownInput {
  pendingAmount: string;
  pendingDeliveryAmount?: string | null;
  pendingSettlementAmount?: string | null;
  underReviewOrderCount?: number | null;
}

export interface PendingBreakdown {
  totalPending: string;
  pendingDelivery: string | null;
  pendingSettlement: string | null;
  underReviewOrderCount: number;
  /** Both parts present (FR.7 API); otherwise only the total is shown. */
  hasBreakdown: boolean;
  /** delivery + settlement equals the backend total exactly (cents). */
  consistent: boolean;
}

/**
 * The customer pending breakdown exactly as the backend reports it. The total
 * is ALWAYS the backend `pendingAmount` (never recomputed for display); the
 * parts are shown only when the API provides both. Neither part is ever
 * withdrawable, and an under-review collection is a count, never money.
 */
export function pendingBreakdown(src: PendingBreakdownInput): PendingBreakdown {
  const delivery = src.pendingDeliveryAmount ?? null;
  const settlement = src.pendingSettlementAmount ?? null;
  const hasBreakdown = delivery !== null && settlement !== null;
  let consistent = true;
  if (hasBreakdown) {
    const t = parseMoneyToCents(src.pendingAmount);
    const d = parseMoneyToCents(delivery);
    const s = parseMoneyToCents(settlement);
    consistent = t !== null && d !== null && s !== null && t === d + s;
  }
  return {
    totalPending: src.pendingAmount,
    pendingDelivery: hasBreakdown ? delivery : null,
    pendingSettlement: hasBreakdown ? settlement : null,
    underReviewOrderCount: src.underReviewOrderCount ?? 0,
    hasBreakdown,
    consistent,
  };
}

/** "$70.00 delivery · $50.00 settlement" — the compact sub-line for tables / cards. */
export function pendingSubline(b: PendingBreakdown, format: (v: string) => string): string | null {
  if (!b.hasBreakdown) return null;
  return `${format(b.pendingDelivery as string)} delivery · ${format(b.pendingSettlement as string)} settlement`;
}

/** Customer-facing explanation under the pending total (plain language). */
export function customerPendingSupportingText(b: PendingBreakdown, format: (v: string) => string): string {
  if (!b.hasBreakdown) return 'Money from your orders that is not yet available.';
  return `${format(b.pendingDelivery as string)} on the way · ${format(b.pendingSettlement as string)} delivered, awaiting courier settlement. Not yet available.`;
}

/* ---------------------------- reporting basis ----------------------------- */

export const REPORTING_BASES: readonly ReportingBasis[] = ['released', 'delivered'];

export function parseReportingBasis(raw: string | null | undefined): ReportingBasis {
  return raw === 'delivered' ? 'delivered' : 'released';
}

export const REPORTING_BASIS_LABEL: Record<ReportingBasis, { label: string; description: string }> = {
  released: {
    label: 'Released (posting date)',
    description: 'Amounts count when posted to the ledger — for settlement-mode orders, when released.',
  },
  delivered: {
    label: 'Delivery date',
    description: 'Amounts by the date the order was delivered, split into posted and still pending release.',
  },
};

/* ------------------------------ permissions ------------------------------- */

/** The release sub-resource and every release figure are finance.read reads. */
export function canViewFinancialRelease(permissions: readonly string[]): boolean {
  return permissions.includes(PERMISSIONS.FINANCE_READ);
}

/** Σ of server money strings (exact cents) — for display totals of backend parts only. */
export function sumMoney(values: readonly string[]): string {
  return formatCents(values.reduce((s, v) => s + (parseMoneyToCents(v.replace(/^-/, '')) ?? 0n) * (v.startsWith('-') ? -1n : 1n), 0n));
}
