import type { ListCustomersParams } from '../../../services/customersApi';

/**
 * URL search params are the source of truth for the Customers list
 * (search / status / area / page). The backend `ListCustomersQuerySchema`
 * accepts: `page`, `limit`, `search`, `isActive` (`"true"`/`"false"`),
 * `areaId`, `hasPortalAccount`.
 *
 * There is NO server sort parameter — `GET /customers` is always ordered by
 * `created_at DESC`. No client sorting is added.
 */

export interface CustomersListState {
  search: string;
  page: number;
  /** '' = any, 'active' -> isActive=true, 'inactive' -> isActive=false. */
  status: '' | 'active' | 'inactive';
  areaId: string;
}

export const EMPTY_CUSTOMERS_STATE: CustomersListState = {
  search: '',
  page: 1,
  status: '',
  areaId: '',
};

export function parseCustomersListParams(
  sp: URLSearchParams,
): CustomersListState {
  const pageRaw = Number(sp.get('page'));
  const statusRaw = sp.get('status');
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
    status:
      statusRaw === 'active' || statusRaw === 'inactive' ? statusRaw : '',
    // Opaque id — the backend validates the UUID and stays authoritative.
    areaId: sp.get('areaId') ?? '',
  };
}

export function serializeCustomersListParams(
  state: CustomersListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.page > 1) sp.set('page', String(state.page));
  if (state.status) sp.set('status', state.status);
  if (state.areaId) sp.set('areaId', state.areaId);
  return sp;
}

export function toListCustomersParams(
  state: CustomersListState,
): ListCustomersParams {
  return {
    page: state.page,
    search: state.search || undefined,
    isActive:
      state.status === 'active'
        ? true
        : state.status === 'inactive'
          ? false
          : undefined,
    areaId: state.areaId || undefined,
  };
}

export function hasActiveCustomerFilters(state: CustomersListState): boolean {
  return state.search !== '' || state.status !== '' || state.areaId !== '';
}
