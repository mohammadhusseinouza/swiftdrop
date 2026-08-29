import type { ListDriversParams } from '../../../services/driversApi';

/**
 * URL search params are the source of truth for the Drivers list
 * (search / status / page). The backend `ListDriversQuerySchema` accepts:
 * `page`, `limit`, `search`, `isActive` (`"true"`/`"false"`).
 *
 * There is NO server sort parameter — `GET /drivers` is always ordered by
 * `created_at DESC`. No client sorting is added.
 */

export interface DriversListState {
  search: string;
  page: number;
  /** '' = any, 'active' -> isActive=true, 'inactive' -> isActive=false. */
  status: '' | 'active' | 'inactive';
}

export const EMPTY_DRIVERS_STATE: DriversListState = {
  search: '',
  page: 1,
  status: '',
};

export function parseDriversListParams(sp: URLSearchParams): DriversListState {
  const pageRaw = Number(sp.get('page'));
  const statusRaw = sp.get('status');
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    status: statusRaw === 'active' || statusRaw === 'inactive' ? statusRaw : '',
  };
}

export function serializeDriversListParams(
  state: DriversListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.page > 1) sp.set('page', String(state.page));
  if (state.status) sp.set('status', state.status);
  return sp;
}

export function toListDriversParams(state: DriversListState): ListDriversParams {
  return {
    page: state.page,
    search: state.search || undefined,
    isActive:
      state.status === 'active'
        ? true
        : state.status === 'inactive'
          ? false
          : undefined,
  };
}

export function hasActiveDriverFilters(state: DriversListState): boolean {
  return state.search !== '' || state.status !== '';
}
