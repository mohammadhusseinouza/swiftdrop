import type { ListPayoutsParams } from '../../../services/payoutsApi';

/**
 * URL search params are the source of truth for the Customer Payouts list
 * (search / customer / payment method / status / page).
 *
 * The live backend `ListPayoutsQuerySchema` accepts exactly:
 *   page, limit, search, customerId, status, paymentMethodId
 * There is NO date filter and NO server sort parameter — `GET /payouts` is
 * always ordered `created_at DESC, id DESC`. Nothing is filtered, sorted or
 * sliced client-side.
 */

export const PAYOUT_STATUSES = ['COMPLETED', 'REVERSED', 'CANCELLED'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface PayoutsListState {
  search: string;
  customerId: string;
  paymentMethodId: string;
  status: '' | PayoutStatus;
  page: number;
}

export const EMPTY_PAYOUTS_STATE: PayoutsListState = {
  search: '',
  customerId: '',
  paymentMethodId: '',
  status: '',
  page: 1,
};

export function parsePayoutsListParams(sp: URLSearchParams): PayoutsListState {
  const pageRaw = Number(sp.get('page'));
  const statusRaw = sp.get('status');
  const customerId = sp.get('customerId') ?? '';
  const paymentMethodId = sp.get('paymentMethodId') ?? '';
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    customerId: UUID_RE.test(customerId) ? customerId : '',
    paymentMethodId: UUID_RE.test(paymentMethodId) ? paymentMethodId : '',
    status: (PAYOUT_STATUSES as readonly string[]).includes(statusRaw ?? '')
      ? (statusRaw as PayoutStatus)
      : '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function serializePayoutsListParams(
  state: PayoutsListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.customerId) sp.set('customerId', state.customerId);
  if (state.paymentMethodId) sp.set('paymentMethodId', state.paymentMethodId);
  if (state.status) sp.set('status', state.status);
  if (state.page > 1) sp.set('page', String(state.page));
  return sp;
}

export function toListPayoutsParams(
  state: PayoutsListState,
): ListPayoutsParams {
  return {
    page: state.page,
    search: state.search || undefined,
    customerId: state.customerId || undefined,
    paymentMethodId: state.paymentMethodId || undefined,
    status: state.status || undefined,
  };
}

export function hasActivePayoutFilters(state: PayoutsListState): boolean {
  return (
    state.search !== '' ||
    state.customerId !== '' ||
    state.paymentMethodId !== '' ||
    state.status !== ''
  );
}
