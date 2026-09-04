import type { ListEmployeesParams } from '../../../services/employeesApi';

/**
 * URL search params own the Employees list state. The live backend
 * `ListEmployeesQuerySchema` accepts: page, limit, search, roleId, isActive
 * (`"true"`/`"false"`). No sort parameter — `GET /employees` is always
 * `created_at DESC`.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface EmployeesListState {
  search: string;
  roleId: string;
  status: '' | 'active' | 'inactive';
  page: number;
}

export const EMPTY_EMPLOYEES_STATE: EmployeesListState = {
  search: '',
  roleId: '',
  status: '',
  page: 1,
};

export function parseEmployeesListParams(
  sp: URLSearchParams,
): EmployeesListState {
  const pageRaw = Number(sp.get('page'));
  const statusRaw = sp.get('status');
  const roleId = sp.get('roleId') ?? '';
  return {
    search: sp.get('search')?.slice(0, 200) ?? '',
    roleId: UUID_RE.test(roleId) ? roleId : '',
    status:
      statusRaw === 'active' || statusRaw === 'inactive' ? statusRaw : '',
    page: Number.isInteger(pageRaw) && pageRaw >= 1 ? pageRaw : 1,
  };
}

export function serializeEmployeesListParams(
  state: EmployeesListState,
): URLSearchParams {
  const sp = new URLSearchParams();
  if (state.search) sp.set('search', state.search);
  if (state.roleId) sp.set('roleId', state.roleId);
  if (state.status) sp.set('status', state.status);
  if (state.page > 1) sp.set('page', String(state.page));
  return sp;
}

export function toListEmployeesParams(
  state: EmployeesListState,
): ListEmployeesParams {
  return {
    page: state.page,
    search: state.search || undefined,
    roleId: state.roleId || undefined,
    isActive:
      state.status === 'active'
        ? true
        : state.status === 'inactive'
          ? false
          : undefined,
  };
}

export function hasActiveEmployeeFilters(state: EmployeesListState): boolean {
  return state.search !== '' || state.roleId !== '' || state.status !== '';
}
