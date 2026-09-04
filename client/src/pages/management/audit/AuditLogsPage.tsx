import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import { useGetAuditLogsQuery } from '../../../services/auditApi';
import { useGetEmployeesQuery } from '../../../services/employeesApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../services/apiError';
import type { AuditLogEntry } from '../../../services/domain.types';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { DataTable } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { DateRangeFilter } from '../../../components/filters/DateRangeFilter';
import { ServerSearchSelect } from '../../../components/forms/ServerSearchSelect';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';

import { buildAuditColumns } from './auditColumns';
import { MobileAuditCard } from './MobileAuditCard';
import { AuditDetailDialog } from './AuditDetailDialog';
import {
  actionLabel,
  entityTypeLabel,
  KNOWN_AUDIT_ACTIONS,
  KNOWN_AUDIT_ENTITY_TYPES,
} from './auditPresentation';
import {
  EMPTY_AUDIT_STATE,
  hasActiveAuditFilters,
  parseAuditLogsParams,
  serializeAuditLogsParams,
  toListAuditLogsParams,
  type AuditLogsListState,
} from './auditLogsParams';

/**
 * Phase 11.15 — Management Audit Logs. Read-only. Admin-only in practice
 * (route guard `audit.read`; only ADMIN holds it). ONE data source:
 * `GET /audit-logs` (server pagination + `actorId` / `action` / `entityType`
 * / `entityId` / `from` / `to`, all AND-combined). No mutations, no export,
 * no local filtering/sorting.
 */
export default function AuditLogsPage() {
  const [sp, setSp] = useSearchParams();
  const isDesktop = useMediaQuery(MD_QUERY);

  const perms = {
    orders: useHasPermission(PERMISSIONS.ORDERS_READ),
    customers: useHasPermission(PERMISSIONS.CUSTOMERS_READ),
    drivers: useHasPermission(PERMISSIONS.DRIVERS_READ),
    employees: useHasPermission(PERMISSIONS.EMPLOYEES_READ),
  };

  const state = useMemo(() => parseAuditLogsParams(sp), [sp]);
  const filtersActive = hasActiveAuditFilters(state);

  const commit = useCallback(
    (next: AuditLogsListState) => setSp(serializeAuditLogsParams(next)),
    [setSp],
  );
  const patch = useCallback(
    (p: Partial<AuditLogsListState>) => commit({ ...state, ...p, page: 1 }),
    [commit, state],
  );
  const setPage = useCallback(
    (page: number) => commit({ ...state, page }),
    [commit, state],
  );
  const clearAll = useCallback(() => commit({ ...EMPTY_AUDIT_STATE }), [commit]);

  /* ---- actor picker (Employees; value = employee.userId = audit actor_user_id) ---- */
  const [actorTerm, setActorTerm] = useState('');
  const debouncedActorTerm = useDebouncedValue(actorTerm, 300);
  const employees = useGetEmployeesQuery({
    search: debouncedActorTerm.trim() || undefined,
    limit: 20,
  });
  const [entityIdInput, setEntityIdInput] = useState(state.entityId);
  const debouncedEntityId = useDebouncedValue(entityIdInput, 400);
  useEffect(() => setEntityIdInput(state.entityId), [state.entityId]);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const trimmed = debouncedEntityId.trim();
    if (trimmed === stateRef.current.entityId) return;
    commit({ ...stateRef.current, entityId: trimmed, page: 1 });
  }, [debouncedEntityId, commit]);

  const query = useGetAuditLogsQuery(toListAuditLogsParams(state));
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  // resolve the selected actor's label: prefer a matched employee, else the
  // actor carried on a returned row, else a short id.
  const selectedActorLabel = useMemo(() => {
    if (!state.actorId) return undefined;
    const emp = (employees.data?.items ?? []).find(
      (e) => e.userId === state.actorId,
    );
    if (emp) return `${emp.firstName} ${emp.lastName} · ${emp.employeeNumber}`;
    const fromRow = rows.find((r) => r.actor?.id === state.actorId)?.actor;
    if (fromRow) return `${fromRow.firstName} ${fromRow.lastName}`;
    return `${state.actorId.slice(0, 8)}…`;
  }, [state.actorId, employees.data, rows]);

  const [detail, setDetail] = useState<AuditLogEntry | null>(null);
  const columns = useMemo(
    () => buildAuditColumns({ perms, onView: setDetail }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [perms.orders, perms.customers, perms.drivers, perms.employees],
  );

  // action / entityType selects: known values + any novel value from a deep link
  const actionOptions = state.action && !KNOWN_AUDIT_ACTIONS.includes(state.action as never)
    ? [state.action, ...KNOWN_AUDIT_ACTIONS]
    : KNOWN_AUDIT_ACTIONS;
  const entityTypeOptions =
    state.entityType && !KNOWN_AUDIT_ENTITY_TYPES.includes(state.entityType as never)
      ? [state.entityType, ...KNOWN_AUDIT_ENTITY_TYPES]
      : KNOWN_AUDIT_ENTITY_TYPES;

  return (
    <div className="space-y-4 sm:space-y-5">
      <PageHeader
        size="lg"
        title="Audit Logs"
        description="Review sensitive system activity and historical changes."
        actions={
          <Button
            variant="secondary"
            icon={<RefreshCw className={query.isFetching ? 'animate-spin' : ''} />}
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            Refresh
          </Button>
        }
      />

      <Card flush className="space-y-4 p-4 sm:p-6">
        <div role="search" className="flex flex-wrap items-end gap-2">
          <ServerSearchSelect
            label="Actor"
            anyLabel="Any actor"
            searchPlaceholder="Search employees…"
            value={state.actorId}
            onChange={(userId) => patch({ actorId: userId || undefined })}
            searchTerm={actorTerm}
            onSearchTermChange={setActorTerm}
            loading={employees.isFetching}
            total={employees.data?.meta.total}
            options={(employees.data?.items ?? []).map((e) => ({
              id: e.userId,
              label: `${e.firstName} ${e.lastName} · ${e.employeeNumber}`,
            }))}
            selectedLabel={selectedActorLabel}
          />

          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-56">
            Action
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.action}
              onChange={(e) => patch({ action: e.target.value || undefined })}
            >
              <option value="">Any action</option>
              {actionOptions.map((a) => (
                <option key={a} value={a}>
                  {actionLabel(a)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-52">
            Entity type
            <select
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.entityType}
              onChange={(e) =>
                patch({ entityType: e.target.value || undefined })
              }
            >
              <option value="">Any entity type</option>
              {entityTypeOptions.map((t) => (
                <option key={t} value={t}>
                  {entityTypeLabel(t)}
                </option>
              ))}
            </select>
          </label>

          <label className="flex min-w-0 flex-col gap-1 text-xs font-medium text-ink-muted sm:w-64">
            Entity ID
            <input
              type="text"
              value={entityIdInput}
              placeholder="Exact entity ID…"
              onChange={(e) => setEntityIdInput(e.target.value)}
              className="h-9 w-full rounded-control border border-line bg-card px-2 text-sm text-ink placeholder:text-ink-subtle"
            />
          </label>
        </div>

        <DateRangeFilter
          value={{ from: state.from, to: state.to }}
          onChange={(range) =>
            patch({ from: range.from || undefined, to: range.to || undefined })
          }
          fromLabel="From"
          toLabel="To (inclusive)"
        />

        <div className="flex flex-wrap items-center gap-3">
          {filtersActive && (
            <button
              type="button"
              onClick={() => {
                setActorTerm('');
                setEntityIdInput('');
                clearAll();
              }}
              className="text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Clear filters
            </button>
          )}
          <p className="text-xs text-ink-muted">
            Newest first. Dates are whole UTC calendar days. System-generated
            events show &ldquo;System&rdquo; as the actor.
          </p>
        </div>
      </Card>

      {query.isLoading && !query.data ? (
        <Card flush>
          <LoadingState className="py-16" />
        </Card>
      ) : query.isError && !query.data ? (
        <Card flush>
          <ErrorState
            className="py-16"
            message={getApiErrorMessage(query.error as UnknownApiError)}
            onRetry={() => void query.refetch()}
          />
        </Card>
      ) : rows.length === 0 ? (
        <Card flush>
          <EmptyState
            className="py-16"
            title={
              filtersActive
                ? 'No audit events match these filters.'
                : 'No audit activity has been recorded yet.'
            }
            description={
              filtersActive
                ? 'Try a different actor, action, entity or date range.'
                : undefined
            }
            action={
              filtersActive ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setActorTerm('');
                    setEntityIdInput('');
                    clearAll();
                  }}
                >
                  Clear filters
                </Button>
              ) : undefined
            }
          />
        </Card>
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            caption="Audit events"
            onRowClick={(r) => setDetail(r)}
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <MobileAuditCard entry={r} onView={() => setDetail(r)} />
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
          Showing {rows.length} of {meta.total} audit events.
        </p>
      )}

      <AuditDetailDialog
        entry={detail}
        perms={perms}
        onClose={() => setDetail(null)}
      />
    </div>
  );
}
