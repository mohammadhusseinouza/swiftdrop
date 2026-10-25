import { formatCents, parseMoneyToCents } from '../../../lib/money';
import type {
  CreateSettlementRequest,
  DriverOutstandingCollections,
  OutstandingCollection,
} from '../../../services/settlementsApi';

/**
 * Settlement-Based Financial Release FR.9 — the pure allocation model behind
 * the Process Settlement dialog (contract §5.2, page_structure §16.1).
 *
 * Every figure is exact integer cents (`bigint`) — never `Number()`. Finance
 * selects collections explicitly; "oldest first" only fills the form. The
 * server re-validates everything inside the settlement transaction (lock
 * order, `allocated_amount` compare-and-set, U ≤ unattributed cash), so this
 * module is UX validation and a provisional preview only.
 */

/** Mirrors server `MAX_ALLOCATIONS_PER_SETTLEMENT` (FR.4 starting value). */
export const MAX_ALLOCATIONS_PER_SETTLEMENT = 20;
/** Mirrors server `UNATTRIBUTED_REASON_MIN_LENGTH` (decision A11). */
export const UNATTRIBUTED_REASON_MIN_LENGTH = 10;

/** One selected collection: the server row it was chosen from + the typed amount. */
export interface AllocationSelection {
  item: OutstandingCollection;
  amount: string;
}

export interface AllocationDraft {
  /** The driver these selections belong to — selections never cross drivers. */
  driverId: string;
  /** Keyed by releaseId; insertion order is the display/submission order. */
  selections: Record<string, AllocationSelection>;
  unattributedAmount: string;
  unattributedReason: string;
}

export function emptyAllocationDraft(driverId: string): AllocationDraft {
  return { driverId, selections: {}, unattributedAmount: '', unattributedReason: '' };
}

/** Driver switch: a draft is never carried from one driver to another. */
export function draftForDriver(draft: AllocationDraft, driverId: string): AllocationDraft {
  return draft.driverId === driverId ? draft : emptyAllocationDraft(driverId);
}

function cents(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  return parseMoneyToCents(value);
}

/** Server money string → canonical 2-decimal string ("105" → "105.00"). */
export function canonicalMoney(value: string): string {
  const c = parseMoneyToCents(value);
  return c === null ? value : formatCents(c);
}

/* ------------------------------ eligibility ------------------------------ */

/**
 * A collection can be selected only while its release is PENDING and it still
 * has an unsettled amount. Voided, reversed, released and fully allocated
 * collections are never selectable (the server would reject them anyway).
 */
export function isSelectable(item: OutstandingCollection): boolean {
  const outstanding = cents(item.outstandingAmount);
  return item.releaseStatus === 'PENDING' && outstanding !== null && outstanding > 0n;
}

export function isAwaitingReview(item: OutstandingCollection): boolean {
  return item.reviewStatus === 'AWAITING_REVIEW';
}

/* ------------------------------ selection ops ---------------------------- */

export type SelectResult =
  | { ok: true; draft: AllocationDraft }
  | { ok: false; reason: 'NOT_SELECTABLE' | 'LIMIT_REACHED' };

/** Select one collection, defaulting the amount to its full outstanding amount. */
export function selectCollection(draft: AllocationDraft, item: OutstandingCollection): SelectResult {
  if (draft.selections[item.releaseId]) return { ok: true, draft };
  if (!isSelectable(item)) return { ok: false, reason: 'NOT_SELECTABLE' };
  if (Object.keys(draft.selections).length >= MAX_ALLOCATIONS_PER_SETTLEMENT) {
    return { ok: false, reason: 'LIMIT_REACHED' };
  }
  return {
    ok: true,
    draft: {
      ...draft,
      selections: {
        ...draft.selections,
        [item.releaseId]: { item, amount: canonicalMoney(item.outstandingAmount) },
      },
    },
  };
}

export function deselectCollection(draft: AllocationDraft, releaseId: string): AllocationDraft {
  if (!draft.selections[releaseId]) return draft;
  const selections = { ...draft.selections };
  delete selections[releaseId];
  return { ...draft, selections };
}

export function setAllocationAmount(draft: AllocationDraft, releaseId: string, amount: string): AllocationDraft {
  const current = draft.selections[releaseId];
  if (!current) return draft;
  return { ...draft, selections: { ...draft.selections, [releaseId]: { ...current, amount } } };
}

/** "Full" — set the selected row back to its whole outstanding amount. */
export function setFullOutstanding(draft: AllocationDraft, releaseId: string): AllocationDraft {
  const current = draft.selections[releaseId];
  if (!current) return draft;
  return setAllocationAmount(draft, releaseId, canonicalMoney(current.item.outstandingAmount));
}

export function clearSelections(draft: AllocationDraft): AllocationDraft {
  return { ...draft, selections: {} };
}

/**
 * Oldest-first PRESELECTION (a UI convenience only — nothing is allocated
 * until Finance submits). Walks the server's oldest-first order and fills
 * full outstanding amounts until `upTo` is reached; the last row may be
 * partial. A blank `upTo` selects every eligible row. Replaces the current
 * selection and never exceeds the allocation limit. Returns null for an
 * invalid `upTo`.
 */
export function preselectOldestFirst(
  draft: AllocationDraft,
  items: readonly OutstandingCollection[],
  upTo: string,
): AllocationDraft | null {
  const limit = upTo.trim() === '' ? null : cents(upTo);
  if (upTo.trim() !== '' && (limit === null || limit <= 0n)) return null;

  const ordered = [...items].sort((a, b) =>
    a.deliveredAt === b.deliveredAt
      ? a.releaseId < b.releaseId ? -1 : a.releaseId > b.releaseId ? 1 : 0
      : a.deliveredAt < b.deliveredAt ? -1 : 1,
  );

  const selections: Record<string, AllocationSelection> = {};
  let remaining = limit;
  let count = 0;
  for (const item of ordered) {
    if (count >= MAX_ALLOCATIONS_PER_SETTLEMENT) break;
    if (remaining !== null && remaining <= 0n) break;
    if (!isSelectable(item)) continue;
    const outstanding = cents(item.outstandingAmount) as bigint;
    const take = remaining === null || remaining >= outstanding ? outstanding : remaining;
    selections[item.releaseId] = { item, amount: formatCents(take) };
    if (remaining !== null) remaining -= take;
    count += 1;
  }
  return { ...draft, selections };
}

/* ------------------------------ row status ------------------------------- */

export type AllocationRowStatus =
  /** Full outstanding, review not pending — the settlement releases it. */
  | 'WILL_RELEASE'
  /** Full outstanding, but the collection difference still awaits review. */
  | 'SETTLES_AWAITS_REVIEW'
  /** Less than the outstanding amount — stays partially settled. */
  | 'PARTIAL'
  | 'INVALID';

export function allocationRowStatus(selection: AllocationSelection): AllocationRowStatus {
  const amount = cents(selection.amount);
  const outstanding = cents(selection.item.outstandingAmount);
  if (amount === null || outstanding === null || amount <= 0n || amount > outstanding) return 'INVALID';
  if (amount < outstanding) return 'PARTIAL';
  return isAwaitingReview(selection.item) ? 'SETTLES_AWAITS_REVIEW' : 'WILL_RELEASE';
}

/* ------------------------------ validation ------------------------------- */

export interface AllocationValidation {
  valid: boolean;
  rowErrors: Record<string, string>;
  unattributedAmountError?: string;
  unattributedReasonError?: string;
  /** Errors that belong to the whole settlement (shown above the form). */
  formErrors: string[];
  allocatedCents: bigint;
  unattributedCents: bigint;
  /** amountReceived = Σ allocations + unattributedAmount, exactly. */
  amountReceivedCents: bigint;
}

export interface CashPosition {
  cashBalance: string;
  attributedOutstanding: string;
  unattributedBalance: string;
}

export function validateAllocationDraft(
  draft: AllocationDraft,
  position: CashPosition | null,
): AllocationValidation {
  const rowErrors: Record<string, string> = {};
  const formErrors: string[] = [];
  let allocated = 0n;

  const selections = Object.values(draft.selections);
  if (selections.length > MAX_ALLOCATIONS_PER_SETTLEMENT) {
    formErrors.push(`At most ${MAX_ALLOCATIONS_PER_SETTLEMENT} collections can be allocated per settlement.`);
  }
  for (const { item, amount } of selections) {
    const c = cents(amount);
    const outstanding = cents(item.outstandingAmount);
    if (amount.trim() === '') rowErrors[item.releaseId] = 'Enter an amount';
    else if (c === null) rowErrors[item.releaseId] = 'Enter an amount with at most 2 decimals';
    else if (c <= 0n) rowErrors[item.releaseId] = 'Amount must be greater than zero';
    else if (outstanding !== null && c > outstanding) {
      rowErrors[item.releaseId] = `Exceeds the outstanding $${formatCents(outstanding)}`;
    } else allocated += c;
  }

  let unattributed = 0n;
  let unattributedAmountError: string | undefined;
  let unattributedReasonError: string | undefined;
  const rawUnattributed = draft.unattributedAmount.trim();
  if (rawUnattributed !== '') {
    const c = cents(rawUnattributed);
    if (c === null) unattributedAmountError = 'Enter an amount with at most 2 decimals';
    else unattributed = c;
  }
  const maxUnattributed = position ? cents(position.unattributedBalance) : null;
  if (!unattributedAmountError && maxUnattributed !== null && unattributed > maxUnattributed) {
    unattributedAmountError = `Exceeds the driver's unattributed cash ($${formatCents(maxUnattributed)})`;
  }
  if (unattributed > 0n && draft.unattributedReason.trim().length < UNATTRIBUTED_REASON_MIN_LENGTH) {
    unattributedReasonError = `Explain the unattributed amount (at least ${UNATTRIBUTED_REASON_MIN_LENGTH} characters)`;
  }

  const amountReceived = allocated + unattributed;
  const hasErrors =
    Object.keys(rowErrors).length > 0 || !!unattributedAmountError || !!unattributedReasonError;
  if (!hasErrors && amountReceived <= 0n) {
    formErrors.push('Select at least one collection or enter an unattributed amount.');
  }
  const cash = position ? cents(position.cashBalance) : null;
  if (!hasErrors && cash !== null && amountReceived > cash) {
    formErrors.push(`The total exceeds the cash held by the driver ($${formatCents(cash)}).`);
  }

  return {
    valid: !hasErrors && formErrors.length === 0,
    rowErrors,
    unattributedAmountError,
    unattributedReasonError,
    formErrors,
    allocatedCents: allocated,
    unattributedCents: unattributed,
    amountReceivedCents: amountReceived,
  };
}

/* ------------------------------ request body ----------------------------- */

/**
 * The exact allocation-format `POST /driver-settlements` body. `allocations`
 * is ALWAYS present (possibly empty) so the server never treats it as a
 * legacy request. `amountReceived` is computed here — never typed — so
 * `amountReceived = Σ allocations + unattributedAmount` holds by construction.
 */
export function buildAllocationRequest(
  draft: AllocationDraft,
  base: { paymentMethodId: string; notes: string },
): CreateSettlementRequest {
  const allocations = Object.values(draft.selections).map((s) => ({
    releaseId: s.item.releaseId,
    amount: canonicalMoney(s.amount.trim()),
  }));
  const allocated = allocations.reduce((sum, a) => sum + (cents(a.amount) ?? 0n), 0n);
  const unattributed = cents(draft.unattributedAmount.trim() || '0') ?? 0n;
  const notes = base.notes.trim();
  return {
    driverId: draft.driverId,
    amountReceived: formatCents(allocated + unattributed),
    paymentMethodId: base.paymentMethodId,
    ...(notes === '' ? {} : { notes }),
    allocations,
    ...(unattributed > 0n
      ? { unattributedAmount: formatCents(unattributed), unattributedReason: draft.unattributedReason.trim() }
      : {}),
  };
}

/* -------------------------------- preview -------------------------------- */

export interface PreviewRow {
  releaseId: string;
  orderNumber: string;
  customerName: string;
  orderType: string;
  amount: string;
  outstandingAfter: string;
  status: AllocationRowStatus;
}

export interface SettlementPreview {
  amountReceived: string;
  allocated: string;
  unattributed: string;
  cashAfter: string | null;
  willRelease: PreviewRow[];
  partial: PreviewRow[];
  awaitingReview: PreviewRow[];
  /** Σ backend planned amounts over the collections this settlement releases. */
  expectedWalletCredit: string;
  expectedProductRevenue: string;
  expectedDeliveryFee: string;
  /**
   * Rows that would fully settle with review cleared but carry no planned
   * split — never guessed; excluded from the expected totals and flagged.
   */
  missingPlannedSplit: PreviewRow[];
}

/**
 * The provisional preview shown before submission. Expected releases use only
 * the backend-approved planned amounts of collections this settlement makes
 * fully settled with review not pending; a difference awaiting review never
 * contributes (its split is not decided yet).
 */
export function buildSettlementPreview(
  draft: AllocationDraft,
  position: CashPosition | null,
): SettlementPreview {
  const willRelease: PreviewRow[] = [];
  const partial: PreviewRow[] = [];
  const awaitingReview: PreviewRow[] = [];
  const missingPlannedSplit: PreviewRow[] = [];
  let allocated = 0n;
  let wallet = 0n;
  let product = 0n;
  let fee = 0n;

  for (const selection of Object.values(draft.selections)) {
    const { item } = selection;
    const amount = cents(selection.amount) ?? 0n;
    const outstanding = cents(item.outstandingAmount) ?? 0n;
    allocated += amount;
    const row: PreviewRow = {
      releaseId: item.releaseId,
      orderNumber: item.order.orderNumber,
      customerName: item.customer.name,
      orderType: item.orderType,
      amount: formatCents(amount),
      outstandingAfter: formatCents(outstanding - amount),
      status: allocationRowStatus(selection),
    };
    if (row.status === 'PARTIAL') partial.push(row);
    else if (row.status === 'SETTLES_AWAITS_REVIEW') awaitingReview.push(row);
    else if (row.status === 'WILL_RELEASE') {
      const w = cents(item.plannedCustomerWalletAmount);
      const p = cents(item.plannedCompanyProductAmount);
      const f = cents(item.plannedCompanyFeeAmount);
      if (w === null || p === null || f === null) {
        missingPlannedSplit.push(row);
      } else {
        willRelease.push(row);
        wallet += w;
        product += p;
        fee += f;
      }
    }
  }

  const unattributed = cents(draft.unattributedAmount.trim() || '0') ?? 0n;
  const received = allocated + unattributed;
  const cash = position ? cents(position.cashBalance) : null;
  return {
    amountReceived: formatCents(received),
    allocated: formatCents(allocated),
    unattributed: formatCents(unattributed),
    cashAfter: cash === null ? null : formatCents(cash - received),
    willRelease,
    partial,
    awaitingReview,
    expectedWalletCredit: formatCents(wallet),
    expectedProductRevenue: formatCents(product),
    expectedDeliveryFee: formatCents(fee),
    missingPlannedSplit,
  };
}

/* ---------------------------- stale collections -------------------------- */

export interface ReconcileResult {
  draft: AllocationDraft;
  /** Selections dropped: the collection is no longer outstanding. */
  removed: string[];
  /** Selections whose amount now exceeds the refreshed outstanding amount. */
  overAllocated: string[];
  /** Selections whose collection data changed (amounts / review state). */
  changed: string[];
}

/**
 * Re-applies the selection to freshly fetched outstanding collections. Only
 * rows visible in `fresh` can be re-checked (the endpoint is paginated); the
 * server stays the final judge for the rest. Never re-adds or grows amounts.
 */
export function reconcileDraft(
  draft: AllocationDraft,
  fresh: Pick<DriverOutstandingCollections, 'driverId' | 'items'>,
  opts: { completeList: boolean },
): ReconcileResult {
  if (fresh.driverId !== draft.driverId) {
    return { draft: emptyAllocationDraft(fresh.driverId), removed: Object.keys(draft.selections), overAllocated: [], changed: [] };
  }
  const byId = new Map(fresh.items.map((i) => [i.releaseId, i]));
  const selections: Record<string, AllocationSelection> = {};
  const removed: string[] = [];
  const overAllocated: string[] = [];
  const changed: string[] = [];

  for (const [releaseId, selection] of Object.entries(draft.selections)) {
    const item = byId.get(releaseId);
    if (!item) {
      if (opts.completeList) removed.push(releaseId);
      else selections[releaseId] = selection;
      continue;
    }
    if (!isSelectable(item)) {
      removed.push(releaseId);
      continue;
    }
    const prev = selection.item;
    if (
      prev.outstandingAmount !== item.outstandingAmount ||
      prev.allocatedAmount !== item.allocatedAmount ||
      prev.reviewStatus !== item.reviewStatus ||
      prev.plannedCustomerWalletAmount !== item.plannedCustomerWalletAmount ||
      prev.plannedCompanyProductAmount !== item.plannedCompanyProductAmount ||
      prev.plannedCompanyFeeAmount !== item.plannedCompanyFeeAmount
    ) {
      changed.push(releaseId);
    }
    const amount = cents(selection.amount);
    const outstanding = cents(item.outstandingAmount);
    if (amount !== null && outstanding !== null && amount > outstanding) overAllocated.push(releaseId);
    selections[releaseId] = { item, amount: selection.amount };
  }
  return { draft: { ...draft, selections }, removed, overAllocated, changed };
}

/**
 * Applies the server's `ALLOCATION_INVALID` verdict for one release. The
 * server names the release, which matters on a paginated list: a collection
 * settled elsewhere simply disappears from the outstanding list and cannot be
 * told apart from one on another page. A collection that is no longer
 * eligible (released / voided / reversed / not found) is removed from the
 * selection; an amount problem keeps the selection and flags the row.
 */
export function applyAllocationRejection(
  draft: AllocationDraft,
  releaseId: string,
  problem: string,
): { draft: AllocationDraft; removed: boolean; orderLabel: string; message: string } {
  const selection = draft.selections[releaseId];
  const orderLabel = selection ? `Order ${selection.item.order.orderNumber}` : 'A selected collection';
  if (/not eligible|not found|reversed/i.test(problem)) {
    return {
      draft: deselectCollection(draft, releaseId),
      removed: true,
      orderLabel,
      message: `${orderLabel} can no longer be settled (${problem}) and was removed from the selection. Review the remaining selection.`,
    };
  }
  return {
    draft,
    removed: false,
    orderLabel,
    message: `${orderLabel}: ${problem}. The collections were refreshed — correct the amount and review again.`,
  };
}

/* ---------------------------- format decision --------------------------- */

export type SettlementFormat = 'ALLOCATION' | 'LEGACY';

/**
 * Which request format the dialog uses. Allocation format whenever the driver
 * holds settlement-mode money (any attributed outstanding or outstanding
 * collection) or the server has already required it
 * (`ALLOCATION_CONTRACT_REQUIRED`). Otherwise the existing legacy workflow
 * (amount ≤ cash held, no reason) is kept — the server accepts it only while
 * activation is off and the driver has no PENDING release.
 */
export function chooseSettlementFormat(
  position: Pick<DriverOutstandingCollections, 'attributedOutstanding' | 'outstandingCollectionCount'> | null,
  contractRequired: boolean,
): SettlementFormat {
  if (contractRequired) return 'ALLOCATION';
  if (!position) return 'LEGACY';
  const attributed = cents(position.attributedOutstanding) ?? 0n;
  return attributed > 0n || position.outstandingCollectionCount > 0 ? 'ALLOCATION' : 'LEGACY';
}
