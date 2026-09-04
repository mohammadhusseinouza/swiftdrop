import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetEmployeesQuery,
  useGetEmployeeRolesQuery,
} from '../../../services/employeesApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Pagination } from '../../../components/data-display/Pagination';
import { DataTable } from '../../../components/data-display/DataTable';
import { SearchInput } from '../../../components/filters/SearchInput';
import { Button } from '../../../components/ui/Button';
import { Card } from '../../../components/ui/Card';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';

import { employeeColumns } from './employeeColumns';
import { MobileEmployeeCard } from './MobileEmployeeCard';
import { EmployeeFormDialog } from './EmployeeFormDialog';
import {
  EMPTY_EMPLOYEES_STATE,
  hasActiveEmployeeFilters,
  parseEmployeesListParams,
  serializeEmployeesListParams,
  toListEmployeesParams,
  type EmployeesListState,
} from './employeesListParams';

/**
 * Phase 11.14 — Management Employees. Admin-only in practice (route guard
 * `employees.read`; only ADMIN holds it). All querying is server-side via
 * `useGetEmployeesQuery` (search / roleId / isActive / page); nothing is
 * filtered or sorted client-side.
 */
export default function EmployeesListPage() {
  const [sp, setSp] = useSearchParams();
  const navigate = useNavigate();
  const isDesktop = useMediaQuery(MD_QUERY);

  const canManage = useHasPermission(PERMISSIONS.EMPLOYEES_MANAGE);

  const state = useMemo(() => parseEmployeesListParams(sp), [sp]);
  const filtersActive = hasActiveEmployeeFilters(state);

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);

  const commit = useCallback(
    (next: EmployeesListState) => setSp(serializeEmployeesListParams(next)),
    [setSp],
  );
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const patch = useCallback(
    (p: Partial<EmployeesListState>) => commit({ ...state, ...p, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => {
    setSearchInput('');
    commit({ ...EMPTY_EMPLOYEES_STATE });
  }, [commit]);

  const roles = useGetEmployeeRolesQuery();
  const query = useGetEmployeesQuery(toListEmployeesParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Employees"
        description="Manage internal employee accounts, roles, and access."
        actions={
          canManage ? (
            <Button onClick={() => setCreateOpen(true)}>Add employee</Button>
          ) : undefined
        }
      />

      <Card flush className="space-y-4 p-4 sm:p-6">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          size="lg"
          placeholder="Search by name, employee number, email or phone…"
          className="w-full"
        />
        <div role="search" className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
            Role
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.roleId}
              disabled={roles.isLoading}
              onChange={(e) => patch({ roleId: e.target.value })}
            >
              <option value="">Any role</option>
              {(roles.data ?? []).map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
            Status
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.status}
              onChange={(e) =>
                patch({ status: e.target.value as EmployeesListState['status'] })
              }
            >
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
            </select>
          </label>
          {filtersActive && (
            <button
              type="button"
              onClick={clearAll}
              className="self-end pb-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {query.isLoading ? (
        <Card flush>
          <LoadingState className="py-16" />
        </Card>
      ) : query.isError ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card flush>
          {filtersActive ? (
            <EmptyState
              className="py-16"
              title="No employees match these filters."
              description="Try adjusting or clearing the filters."
              action={
                <Button variant="secondary" size="sm" onClick={clearAll}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              className="py-16"
              title="No employees found."
              description={
                canManage
                  ? 'Add the first employee account.'
                  : 'Employee accounts will appear here.'
              }
              action={
                canManage ? (
                  <Button size="sm" onClick={() => setCreateOpen(true)}>
                    Add employee
                  </Button>
                ) : undefined
              }
            />
          )}
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={employeeColumns}
            rows={rows}
            getRowId={(e) => e.id}
            caption="Employees"
            onRowClick={(e) => navigate(`/management/employees/${e.id}`)}
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((e) => (
            <li key={e.id}>
              <MobileEmployeeCard employee={e} />
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <Pagination
          page={state.page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={setPage}
        />
      )}
      {meta && rows.length > 0 && (
        <p className="sr-only" aria-live="polite">
          Showing {rows.length} of {meta.total} employees.
        </p>
      )}

      <EmployeeFormDialog
        open={createOpen}
        mode="create"
        onClose={() => setCreateOpen(false)}
        onCreated={(employee) => {
          setCreateOpen(false);
          navigate(`/management/employees/${employee.id}`);
        }}
        onSaved={() => setCreateOpen(false)}
      />
    </div>
  );
}
