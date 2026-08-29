import type { ListWalletsParams } from '../../../services/walletsApi';

/**
 * URL search params are the source of truth for the Customer Wallets list.
 * The live backend `ListWalletsQuerySchema` accepts ONLY: `page`, `limit`,
 * `search` (customer_number / name / primary_phone). There is NO sort
 * parameter — `GET /wallets` is always ordered `created_at DESC, id DESC`.
 * No client sorting or extra filters are invented.
 */
export interface WalletsListState {
  search: string;
  page: number;
}

export const EMPTY_WALLETS_STATE: WalletsListState = { search: '', page: 1 };

export function parseWalletsListParams(sp: URLSearchParams): WalletsListState {
  const pageRaw = Number(sp.get('page'));
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function serializeWalletsListParams(
  state: WalletsListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.page > 1) sp.set('page', String(state.page));
  return sp;
}

export function toListWalletsParams(state: WalletsListState): ListWalletsParams {
  return {
    page: state.page,
    search: state.search || undefined,
  };
}

export function hasActiveWalletFilters(state: WalletsListState): boolean {
  return state.search !== '';
}
