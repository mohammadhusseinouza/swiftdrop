import type { LedgerName } from '../../../services/domain.types';
import type { FinanceTransactionsParams } from '../../../services/financeApi';

/**
 * URL search params own the Finance page state: date range (`from`/`to`),
 * transaction `ledger` + `type` filters, and `page`.
 *
 * The live backend accepts EXACTLY:
 *   GET /finance/summary        — from?, to?  (YYYY-MM-DD, from <= to)
 *   GET /finance/transactions   — page, limit, from?, to?, ledger?, type?
 * There is NO search param and NO sort param (fixed created_at DESC, id DESC).
 * `type` must be valid for the chosen `ledger` (backend rejects a mismatch).
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const LEDGERS: readonly LedgerName[] = [
  'WALLET',
  'DRIVER_CASH',
  'COMPANY_FINANCE',
];

export const LEDGER_TYPES: Record<LedgerName, readonly string[]> = {
  WALLET: ['ORDER_CREDIT', 'PAYOUT', 'ADJUSTMENT', 'REVERSAL'],
  DRIVER_CASH: ['COLLECTION', 'SETTLEMENT', 'ADJUSTMENT', 'REVERSAL'],
  COMPANY_FINANCE: [
    'DELIVERY_FEE_REVENUE',
    'COMPANY_ORDER_PRODUCT_REVENUE',
    'ADJUSTMENT',
    'REVERSAL',
  ],
};

const ALL_TYPES = Array.from(
  new Set(Object.values(LEDGER_TYPES).flatMap((t) => [...t])),
);

export interface FinanceListState {
  from: string;
  to: string;
  ledger: '' | LedgerName;
  type: string;
  page: number;
}

export const EMPTY_FINANCE_STATE: FinanceListState = {
  from: '',
  to: '',
  ledger: '',
  type: '',
  page: 1,
};

export function parseFinanceListParams(sp: URLSearchParams): FinanceListState {
  const pageRaw = Number(sp.get('page'));
  const ledgerRaw = sp.get('ledger');
  const ledger = (LEDGERS as string[]).includes(ledgerRaw ?? '')
    ? (ledgerRaw as LedgerName)
    : '';
  const typeRaw = sp.get('type') ?? '';
  // Only keep a type that is real AND (if a ledger is set) valid for it.
  const type =
    ALL_TYPES.includes(typeRaw) &&
    (!ledger || (LEDGER_TYPES[ledger] as string[]).includes(typeRaw))
      ? typeRaw
      : '';
  return {
    from: DATE_RE.test(sp.get('from') ?? '') ? (sp.get('from') as string) : '',
    to: DATE_RE.test(sp.get('to') ?? '') ? (sp.get('to') as string) : '',
    ledger,
    type,
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function serializeFinanceListParams(
  state: FinanceListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.from) sp.set('from', state.from);
  if (state.to) sp.set('to', state.to);
  if (state.ledger) sp.set('ledger', state.ledger);
  if (state.type) sp.set('type', state.type);
  if (state.page > 1) sp.set('page', String(state.page));
  return sp;
}

export function toSummaryParams(state: FinanceListState): {
  from?: string;
  to?: string;
} {
  return { from: state.from || undefined, to: state.to || undefined };
}

export function toTransactionParams(
  state: FinanceListState,
): FinanceTransactionsParams {
  return {
    page: state.page,
    from: state.from || undefined,
    to: state.to || undefined,
    ledger: state.ledger || undefined,
    type: state.type || undefined,
  };
}

export function hasActiveFinanceFilters(state: FinanceListState): boolean {
  return (
    state.from !== '' ||
    state.to !== '' ||
    state.ledger !== '' ||
    state.type !== ''
  );
}
