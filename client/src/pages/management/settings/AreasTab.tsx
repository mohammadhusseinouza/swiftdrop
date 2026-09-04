import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetAreasQuery,
  useCreateAreaMutation,
  useUpdateAreaMutation,
} from '../../../services/settingsApi';
import {
  getApiErrorMessage,
  type UnknownApiError,
} from '../../../services/apiError';
import type { AreaSummary } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { DataTable } from '../../../components/data-display/DataTable';
import { Pagination } from '../../../components/data-display/Pagination';
import { SearchInput } from '../../../components/filters/SearchInput';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useDebouncedValue } from '../../../lib/useDebouncedValue';
import { ReferenceDialog } from './ReferenceDialog';
import { TextField } from '../../../components/forms/Field';

/** Areas list state lives in the shared URL (namespaced so tabs don't clash). */
interface AreaState {
  search: string;
  status: '' | 'active' | 'inactive';
  page: number;
}

function parseAreaState(sp: URLSearchParams): AreaState {
  const status = sp.get('areaStatus');
  const page = Number(sp.get('areaPage'));
  return {
    search: sp.get('areaSearch') ?? '',
    status: status === 'active' || status === 'inactive' ? status : '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

type Editing = { mode: 'create' } | { mode: 'edit'; row: AreaSummary } | null;

const PAGE_SIZE = 20;

export function AreasTab() {
  const canManage = useHasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const isDesktop = useMediaQuery(MD_QUERY);
  const [sp, setSp] = useSearchParams();

  const state = useMemo(() => parseAreaState(sp), [sp]);

  const commit = useCallback(
    (next: AreaState) => {
      setSp((prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', 'areas');
        next.search ? p.set('areaSearch', next.search) : p.delete('areaSearch');
        next.status ? p.set('areaStatus', next.status) : p.delete('areaStatus');
        next.page > 1
          ? p.set('areaPage', String(next.page))
          : p.delete('areaPage');
        return p;
      });
    },
    [setSp],
  );

  const [searchInput, setSearchInput] = useState(state.search);
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => setSearchInput(state.search), [state.search]);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (debouncedSearch === stateRef.current.search) return;
    commit({ ...stateRef.current, search: debouncedSearch, page: 1 });
  }, [debouncedSearch, commit]);

  const query = useGetAreasQuery({
    page: state.page,
    limit: PAGE_SIZE,
    search: state.search || undefined,
    isActive:
      state.status === 'active'
        ? true
        : state.status === 'inactive'
          ? false
          : undefined,
  });
  const rows = query.data?.items ?? [];
  const meta = query.data?.meta;

  const [editing, setEditing] = useState<Editing>(null);
  const [toggling, setToggling] = useState<AreaSummary | null>(null);
  const [update, updateState] = useUpdateAreaMutation();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const doToggle = (row: AreaSummary) =>
    void (async () => {
      setToggleError(null);
      try {
        await update({ id: row.id, body: { isActive: !row.isActive } }).unwrap();
        setToggling(null);
      } catch (e) {
        setToggleError(getApiErrorMessage(e as UnknownApiError));
        setToggling(null);
      }
    })();

  const filtersActive = state.search !== '' || state.status !== '';

  const columns = [
    { id: 'name', header: 'Area name', cell: (r: AreaSummary) => r.name },
    {
      id: 'status',
      header: 'Status',
      cell: (r: AreaSummary) => <ActiveBadge isActive={r.isActive} />,
    },
    {
      id: 'sortOrder',
      header: 'Sort order',
      align: 'right' as const,
      hideBelow: 'sm' as const,
      cell: (r: AreaSummary) => r.sortOrder,
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            align: 'right' as const,
            cell: (r: AreaSummary) => (
              <div className="flex justify-end gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing({ mode: 'edit', row: r })}
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  className={
                    r.isActive
                      ? 'text-danger-700 hover:bg-danger-50'
                      : undefined
                  }
                  onClick={() => setToggling(r)}
                >
                  {r.isActive ? 'Deactivate' : 'Reactivate'}
                </Button>
              </div>
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-ink-muted">
          Delivery areas offered on customer and order forms. Deactivating an
          area hides it from new selections; customers and orders that already
          reference it are unaffected.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setEditing({ mode: 'create' })}>
            Add area
          </Button>
        )}
      </div>

      <Card flush className="space-y-3 p-4">
        <SearchInput
          value={searchInput}
          onChange={setSearchInput}
          onClear={() => setSearchInput('')}
          placeholder="Search areas by name…"
          className="w-full"
        />
        <div role="search" className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs font-medium text-ink-muted sm:w-44">
            Status
            <select
              className="h-9 rounded-control border border-line bg-card px-2 text-sm text-ink"
              value={state.status}
              onChange={(e) =>
                commit({
                  ...state,
                  status: e.target.value as AreaState['status'],
                  page: 1,
                })
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
              onClick={() => {
                setSearchInput('');
                commit({ search: '', status: '', page: 1 });
              }}
              className="self-end pb-1.5 text-sm font-medium text-brand-600 hover:text-brand-700"
            >
              Clear filters
            </button>
          )}
        </div>
      </Card>

      {toggleError && (
        <div
          role="alert"
          className="rounded-card border border-danger-200 bg-danger-50 px-4 py-2.5 text-sm text-danger-700"
        >
          {toggleError}
        </div>
      )}

      {query.isLoading ? (
        <LoadingState className="py-16" />
      ) : query.isError ? (
        <ErrorState
          className="py-16"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          className="py-12"
          title={
            filtersActive
              ? 'No areas match these filters.'
              : 'No areas configured.'
          }
        />
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            caption="Areas"
          />
        </Card>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-ink">{r.name}</span>
                  <ActiveBadge isActive={r.isActive} />
                </div>
                <p className="text-xs text-ink-muted">Sort {r.sortOrder}</p>
                {canManage && (
                  <div className="flex gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditing({ mode: 'edit', row: r })}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className={
                        r.isActive
                          ? 'text-danger-700 hover:bg-danger-50'
                          : undefined
                      }
                      onClick={() => setToggling(r)}
                    >
                      {r.isActive ? 'Deactivate' : 'Reactivate'}
                    </Button>
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {meta && meta.totalPages > 1 && (
        <Pagination
          page={state.page}
          totalPages={meta.totalPages}
          total={meta.total}
          onPageChange={(page) => commit({ ...state, page })}
        />
      )}

      <AreaDialog editing={editing} onClose={() => setEditing(null)} />

      <ConfirmationModal
        open={!!toggling && toggling.isActive}
        title={`Deactivate "${toggling?.name}"?`}
        description={
          <p>
            This area will no longer appear in new customer or order area
            selections. Existing customers and orders keep their current area
            reference.
          </p>
        }
        confirmLabel="Deactivate"
        confirmVariant="danger"
        confirmLoading={updateState.isLoading}
        onConfirm={() => toggling && doToggle(toggling)}
        onCancel={() => setToggling(null)}
      />
      <ConfirmationModal
        open={!!toggling && !toggling.isActive}
        title={`Reactivate "${toggling?.name}"?`}
        description={<p>This area will be selectable again on new records.</p>}
        confirmLabel="Reactivate"
        confirmLoading={updateState.isLoading}
        onConfirm={() => toggling && doToggle(toggling)}
        onCancel={() => setToggling(null)}
      />
    </div>
  );
}

function AreaDialog({
  editing,
  onClose,
}: {
  editing: Editing;
  onClose: () => void;
}) {
  const [create, createState] = useCreateAreaMutation();
  const [update, updateState] = useUpdateAreaMutation();
  const isEdit = editing?.mode === 'edit';
  const row = editing?.mode === 'edit' ? editing.row : null;

  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('');
  const [error, setError] = useState<string | null>(null);

  const key = editing?.mode === 'edit' ? editing.row.id : editing?.mode;
  useEffect(() => {
    setError(null);
    setName(row?.name ?? '');
    setSortOrder(row ? String(row.sortOrder) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!editing) return null;

  const submit = () => {
    setError(null);
    const parsedSort = sortOrder.trim() === '' ? undefined : Number(sortOrder);
    if (parsedSort !== undefined && !Number.isInteger(parsedSort)) {
      setError('Sort order must be a whole number.');
      return;
    }
    void (async () => {
      try {
        if (isEdit && row) {
          await update({
            id: row.id,
            body: { name: name.trim(), sortOrder: parsedSort },
          }).unwrap();
        } else {
          await create({ name: name.trim(), sortOrder: parsedSort }).unwrap();
        }
        onClose();
      } catch (e) {
        setError(getApiErrorMessage(e as UnknownApiError));
      }
    })();
  };

  return (
    <ReferenceDialog
      open={!!editing}
      title={isEdit ? `Edit "${row?.name}"` : 'Add area'}
      submitLabel={isEdit ? 'Save changes' : 'Add area'}
      submitLoading={createState.isLoading || updateState.isLoading}
      submitDisabled={!name.trim()}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextField
        label="Area name"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Sort order"
        type="number"
        value={sortOrder}
        onChange={(e) => setSortOrder(e.target.value)}
        hint="Lower numbers appear first."
      />
    </ReferenceDialog>
  );
}
