import type { ListSettlementsParams } from '../../../services/settlementsApi';

/**
 * URL search params are the source of truth for the Driver Settlements list
 * (search / driver / payment method / page).
 *
 * The live backend `ListSettlementsQuerySchema` accepts exactly:
 *   page, limit, search, driverId, paymentMethodId
 * There is NO date filter, NO status field (settlements have no lifecycle) and
 * NO server sort parameter — `GET /driver-settlements` is always ordered
 * `created_at DESC, id DESC`. Nothing is filtered, sorted or sliced
 * client-side.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SettlementsListState {
  search: string;
  driverId: string;
  paymentMethodId: string;
  page: number;
}

export const EMPTY_SETTLEMENTS_STATE: SettlementsListState = {
  search: '',
  driverId: '',
  paymentMethodId: '',
  page: 1,
};

export function parseSettlementsListParams(
  sp: URLSearchParams,
): SettlementsListState {
  const pageRaw = Number(sp.get('page'));
  const driverId = sp.get('driverId') ?? '';
  const paymentMethodId = sp.get('paymentMethodId') ?? '';
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    driverId: UUID_RE.test(driverId) ? driverId : '',
    paymentMethodId: UUID_RE.test(paymentMethodId) ? paymentMethodId : '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function serializeSettlementsListParams(
  state: SettlementsListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.driverId) sp.set('driverId', state.driverId);
  if (state.paymentMethodId) sp.set('paymentMethodId', state.paymentMethodId);
  if (state.page > 1) sp.set('page', String(state.page));
  return sp;
}

export function toListSettlementsParams(
  state: SettlementsListState,
): ListSettlementsParams {
  return {
    page: state.page,
    search: state.search || undefined,
    driverId: state.driverId || undefined,
    paymentMethodId: state.paymentMethodId || undefined,
  };
}

export function hasActiveSettlementFilters(
  state: SettlementsListState,
): boolean {
  return (
    state.search !== '' ||
    state.driverId !== '' ||
    state.paymentMethodId !== ''
  );
}
