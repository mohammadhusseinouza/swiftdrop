import { PERMISSIONS } from '../../features/auth/permissions';
import { formatCents, parseMoneyToCents } from '../../lib/money';
import {
  getApiErrorCode,
  getApiErrorDetails,
  getApiErrorMessage,
  getApiErrorStatus,
  isTransportError,
  type UnknownApiError,
} from '../../services/apiError';
import type { OrderFinancialReleaseView } from '../../services/domain.types';
import type { SettlementDetail } from '../../services/settlementsApi';

/**
 * FR.10.2 — the dedicated financial corrections (FR.6 endpoints), pure:
 * who may see each action, when it is eligible, what it will change, and how
 * a refusal is explained. Eligibility mirrors the service guards but the
 * backend re-validates everything inside its transaction — these rules only
 * decide what the UI offers. The settlement SHORTFALL is deliberately absent
 * (withheld in FR.10.2: its business authorization review is still open).
 */

/** Mirrors server RELEASE_CORRECTION_REASON_MIN_LENGTH / CORRECTION_REASON_MIN_LENGTH. */
export const CORRECTION_REASON_MIN_LENGTH = 10;

export function canCorrectFinance(permissions: readonly string[]): boolean {
  return permissions.includes(PERMISSIONS.FINANCE_ADJUST);
}

export type CorrectionAvailability =
  | { kind: 'HIDDEN' }
  | { kind: 'AVAILABLE' }
  | { kind: 'BLOCKED'; reason: string };

const isZero = (v: string) => (parseMoneyToCents(v) ?? 1n) === 0n;

/* ------------------------------ release actions --------------------------- */

/** POST /finance/order-releases/:releaseId/void-collection — PENDING + unallocated only. */
export function voidCollectionAvailability(view: OrderFinancialReleaseView, permissions: readonly string[]): CorrectionAvailability {
  const r = view.release;
  if (!r || !canCorrectFinance(permissions) || r.correction || r.releaseStatus !== 'PENDING') return { kind: 'HIDDEN' };
  if (r.collectionReversed) return { kind: 'BLOCKED', reason: 'The collection was already reversed by an earlier correction.' };
  if (!isZero(r.allocatedAmount)) {
    return {
      kind: 'BLOCKED',
      reason: 'Part of this collection is already settled — reverse the allocating settlement(s) before voiding the collection.',
    };
  }
  return { kind: 'AVAILABLE' };
}

/** POST /finance/order-releases/:releaseId/reverse-release — RELEASED only. */
export function reverseReleaseAvailability(view: OrderFinancialReleaseView, permissions: readonly string[]): CorrectionAvailability {
  const r = view.release;
  if (!r || !canCorrectFinance(permissions) || r.correction || r.releaseStatus !== 'RELEASED') return { kind: 'HIDDEN' };
  return { kind: 'AVAILABLE' };
}

export interface ConsequenceRow {
  label: string;
  value: string;
}

export function voidCollectionSummary(view: OrderFinancialReleaseView, ctx: { orderNumber: string; driverLabel: string }): {
  rows: ConsequenceRow[];
  consequences: string[];
} {
  const r = view.release!;
  return {
    rows: [
      { label: 'Order', value: ctx.orderNumber },
      { label: 'Driver', value: ctx.driverLabel },
      { label: 'Collection amount', value: formatCents(parseMoneyToCents(r.collectionAmount) ?? 0n) },
      { label: 'Currently settled (allocated)', value: formatCents(parseMoneyToCents(r.allocatedAmount) ?? 0n) },
    ],
    consequences: [
      `The driver cash collection of ${formatCents(parseMoneyToCents(r.collectionAmount) ?? 0n)} is reversed (removed from the driver's cash held).`,
      'The financial release becomes VOIDED and the order financial status becomes Collection voided. Nothing is posted to the customer wallet or company revenue.',
      'The operational delivery status stays DELIVERED — this does not undo the delivery.',
    ],
  };
}

export function releaseReversalSummary(view: OrderFinancialReleaseView, ctx: { orderNumber: string; customerName: string }): {
  rows: ConsequenceRow[];
  consequences: string[];
  warnings: string[];
} {
  const r = view.release!;
  const money = (v: string | null) => formatCents(parseMoneyToCents(v ?? '0') ?? 0n);
  const companyOrder = r.orderType === 'COMPANY_ORDER';
  const rows: ConsequenceRow[] = [
    { label: 'Order', value: ctx.orderNumber },
    { label: 'Customer', value: ctx.customerName },
    { label: 'Released customer wallet credit', value: money(r.plannedCustomerWalletAmount) },
  ];
  if (companyOrder || !isZero(r.plannedCompanyProductAmount ?? '0')) {
    rows.push({ label: 'Released company product revenue', value: money(r.plannedCompanyProductAmount) });
  }
  rows.push({ label: 'Released delivery-fee revenue', value: money(r.plannedCompanyFeeAmount) });
  const consequences = [
    ...(!isZero(r.plannedCustomerWalletAmount ?? '0')
      ? [`A wallet REVERSAL debits ${money(r.plannedCustomerWalletAmount)} from the customer's available balance.`]
      : []),
    ...(!isZero(r.plannedCompanyProductAmount ?? '0') || !isZero(r.plannedCompanyFeeAmount ?? '0')
      ? ['Company REVERSAL rows offset the released revenue.']
      : []),
    'The release becomes RELEASE_REVERSED and the order financial status becomes Release reversed. The original postings stay in history.',
    'Driver cash and the operational delivery status are unchanged.',
  ];
  return {
    rows,
    consequences,
    warnings: [
      "The reversal is rejected if the customer's wallet no longer holds enough available funds (for example after a payout) — nothing is changed in that case.",
      'Recovery of funds already paid out and any customer debt are NOT handled by the system.',
    ],
  };
}

/* ---------------------------- settlement reversal ------------------------- */

export interface SettlementReversalPlan {
  availability: CorrectionAvailability;
  /** Active allocations whose collections lose their settled amount. */
  affected: { releaseId: string; orderNumber: string; amount: string; settledNow: string; settledAfter: string; collection: string }[];
}

/** POST /driver-settlements/:id/reverse — blocked by released funds, a shortfall or a prior reversal. */
export function settlementReversalPlan(detail: SettlementDetail, permissions: readonly string[]): SettlementReversalPlan {
  const active = detail.allocations.filter((a) => a.status === 'ACTIVE');
  const affected = active.map((a) => {
    const now = parseMoneyToCents(a.collection.allocatedAmount) ?? 0n;
    const amount = parseMoneyToCents(a.amount) ?? 0n;
    return {
      releaseId: a.releaseId,
      orderNumber: a.order.orderNumber,
      amount: formatCents(amount),
      settledNow: formatCents(now),
      settledAfter: formatCents(now - amount),
      collection: formatCents(parseMoneyToCents(a.collection.collectionAmount) ?? 0n),
    };
  });
  if (!canCorrectFinance(permissions)) return { availability: { kind: 'HIDDEN' }, affected };
  if (detail.reversed) return { availability: { kind: 'BLOCKED', reason: 'This settlement has already been reversed.' }, affected };
  const hasShortfall = !isZero(detail.shortfallTotal) || detail.corrections.some((c) => c.correctionType === 'SETTLEMENT_SHORTFALL');
  if (hasShortfall) {
    return { availability: { kind: 'BLOCKED', reason: 'A shortfall was recorded for this settlement — it cannot be reversed.' }, affected };
  }
  const released = active.filter((a) => a.collection.releaseStatus === 'RELEASED' || a.collection.releaseStatus === 'RELEASE_REVERSED');
  if (released.length > 0) {
    return {
      availability: {
        kind: 'BLOCKED',
        reason: `Released funds exist for ${released.map((a) => a.order.orderNumber).join(', ')} — correct them through the financial release reversal, not by reversing this settlement.`,
      },
      affected,
    };
  }
  return { availability: { kind: 'AVAILABLE' }, affected };
}

export function settlementReversalConsequences(detail: SettlementDetail): string[] {
  const amount = formatCents(parseMoneyToCents(detail.amountReceived) ?? 0n);
  return [
    `Driver cash is credited back with ${amount} (the driver holds this cash again).`,
    detail.format === 'ALLOCATION'
      ? "Each active allocation becomes REVERSED and its amount returns to the collection's unsettled balance."
      : 'This legacy settlement has no allocations; only driver cash changes.',
    'No customer wallet or company revenue is changed. The original settlement record stays in history.',
  ];
}

/* ------------------------------ error messages ---------------------------- */

const REASON_MESSAGES: Record<string, string> = {
  COLLECTION_HAS_ALLOCATIONS: 'This collection has settlement allocations or released funds — reverse the allocating settlement(s) first.',
  RELEASE_ALREADY_CORRECTED: 'This financial release has already been corrected (with a different reason). Nothing was changed.',
  RELEASE_NOT_RELEASED: 'Only a released financial release can be reversed. The data was refreshed.',
  RELEASED_FUNDS_PAID_OUT:
    "The customer's wallet no longer holds enough available funds to reverse this release (funds were likely paid out). Nothing was changed. Recovery of paid-out funds is handled outside the system.",
  POSTING_ALREADY_REVERSED: 'A posting of this release was already reversed separately — it must be resolved manually. Nothing was changed.',
  SETTLEMENT_ALREADY_REVERSED: 'This settlement has already been reversed. Nothing was changed.',
  SETTLEMENT_HAS_SHORTFALL: 'A shortfall was recorded for this settlement — it cannot be reversed. Nothing was changed.',
  SETTLEMENT_HAS_RELEASED_FUNDS: 'An allocation of this settlement led to released funds — correct them through the financial release reversal. Nothing was changed.',
  ORDER_STATE_CHANGED: 'The order was changed by another request. The data was refreshed — review it and try again.',
  RELEASE_STATE_CHANGED: 'The financial release was changed by another request. The data was refreshed — review it and try again.',
  ALLOCATIONS_CHANGED: "The settlement's allocations were changed by another request. The data was refreshed — review it and try again.",
};

export type CorrectionErrorKind =
  | { kind: 'TRANSPORT'; message: string }
  | { kind: 'CONFLICT'; reason: string | null; message: string }
  | { kind: 'VALIDATION'; message: string }
  | { kind: 'PERMISSION'; message: string }
  | { kind: 'NOT_FOUND'; message: string }
  | { kind: 'SERVER'; message: string };

export function classifyCorrectionError(error: UnknownApiError): CorrectionErrorKind {
  if (isTransportError(error)) {
    return {
      kind: 'TRANSPORT',
      message: 'We could not confirm whether the correction was recorded. Retry with the same reason — the server will not apply it twice.',
    };
  }
  const status = getApiErrorStatus(error);
  const message = getApiErrorMessage(error);
  const details = getApiErrorDetails(error);
  const reason =
    details && typeof details === 'object' && typeof (details as { reason?: unknown }).reason === 'string'
      ? (details as { reason: string }).reason
      : null;
  if (status === 403 || getApiErrorCode(error) === 'FORBIDDEN') return { kind: 'PERMISSION', message: 'You do not have permission to record financial corrections.' };
  if (status === 404) return { kind: 'NOT_FOUND', message: 'The record could not be found. The data was refreshed.' };
  if (status === 409) return { kind: 'CONFLICT', reason, message: (reason && REASON_MESSAGES[reason]) || message };
  if (status === 400) return { kind: 'VALIDATION', message };
  return { kind: 'SERVER', message: 'Something went wrong on the server. Nothing was confirmed — refresh and check before retrying.' };
}

export function reasonError(reason: string): string | null {
  return reason.trim().length < CORRECTION_REASON_MIN_LENGTH
    ? `Explain the correction (at least ${CORRECTION_REASON_MIN_LENGTH} characters).`
    : null;
}
