import { useEffect, useMemo, useState } from 'react';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetFailedDeliveryReasonsQuery,
  useCreateFailedDeliveryReasonMutation,
  useUpdateFailedDeliveryReasonMutation,
} from '../../../services/settingsApi';
import {
  getApiErrorMessage,
  type UnknownApiError,
} from '../../../services/apiError';
import type { FailedDeliveryReasonSummary } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { DataTable } from '../../../components/data-display/DataTable';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { ReferenceDialog } from './ReferenceDialog';
import { TextField, SelectField } from '../../../components/forms/Field';

type Editing =
  | { mode: 'create' }
  | { mode: 'edit'; row: FailedDeliveryReasonSummary }
  | null;

function YesNo({ value }: { value: boolean }) {
  return (
    <Badge tone={value ? 'info' : 'neutral'}>{value ? 'Yes' : 'No'}</Badge>
  );
}

export function FailedReasonsTab() {
  const canManage = useHasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const isDesktop = useMediaQuery(MD_QUERY);
  const query = useGetFailedDeliveryReasonsQuery();
  const [editing, setEditing] = useState<Editing>(null);
  const [toggling, setToggling] = useState<FailedDeliveryReasonSummary | null>(
    null,
  );
  const [update, updateState] = useUpdateFailedDeliveryReasonMutation();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const rows = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [query.data],
  );

  const doToggle = (row: FailedDeliveryReasonSummary) =>
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

  if (query.isLoading) return <LoadingState className="py-16" />;
  if (query.isError) {
    return (
      <ErrorState
        className="py-16"
        message={getApiErrorMessage(query.error as UnknownApiError)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  const columns = [
    {
      id: 'name',
      header: 'Reason',
      cell: (r: FailedDeliveryReasonSummary) => r.name,
    },
    {
      id: 'requiresNotes',
      header: 'Requires notes',
      cell: (r: FailedDeliveryReasonSummary) => (
        <YesNo value={r.requiresNotes} />
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r: FailedDeliveryReasonSummary) => (
        <ActiveBadge isActive={r.isActive} />
      ),
    },
    {
      id: 'sortOrder',
      header: 'Sort order',
      align: 'right' as const,
      hideBelow: 'sm' as const,
      cell: (r: FailedDeliveryReasonSummary) => r.sortOrder,
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            align: 'right' as const,
            cell: (r: FailedDeliveryReasonSummary) => (
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
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">
          Reasons a driver can pick when a delivery attempt fails. Whether a
          reason forces the driver to add notes is set per reason.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setEditing({ mode: 'create' })}>
            Add reason
          </Button>
        )}
      </div>

      {toggleError && (
        <div
          role="alert"
          className="rounded-card border border-danger-200 bg-danger-50 px-4 py-2.5 text-sm text-danger-700"
        >
          {toggleError}
        </div>
      )}

      {rows.length === 0 ? (
        <EmptyState className="py-12" title="No failed delivery reasons configured." />
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            caption="Failed delivery reasons"
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
                <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
                  <span>Requires notes:</span>
                  <YesNo value={r.requiresNotes} />
                  <span>· Sort {r.sortOrder}</span>
                </div>
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

      <ReasonDialog editing={editing} onClose={() => setEditing(null)} />

      <ConfirmationModal
        open={!!toggling && toggling.isActive}
        title={`Deactivate "${toggling?.name}"?`}
        description={
          <p>
            This reason will no longer be offered for new failed-delivery
            attempts. Delivery attempts that already reference it stay
            unchanged.
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
        description={<p>This reason will be offered again on failed deliveries.</p>}
        confirmLabel="Reactivate"
        confirmLoading={updateState.isLoading}
        onConfirm={() => toggling && doToggle(toggling)}
        onCancel={() => setToggling(null)}
      />
    </div>
  );
}

function ReasonDialog({
  editing,
  onClose,
}: {
  editing: Editing;
  onClose: () => void;
}) {
  const [create, createState] = useCreateFailedDeliveryReasonMutation();
  const [update, updateState] = useUpdateFailedDeliveryReasonMutation();
  const isEdit = editing?.mode === 'edit';
  const row = editing?.mode === 'edit' ? editing.row : null;

  const [name, setName] = useState('');
  const [requiresNotes, setRequiresNotes] = useState('false');
  const [sortOrder, setSortOrder] = useState('');
  const [error, setError] = useState<string | null>(null);

  const key = editing?.mode === 'edit' ? editing.row.id : editing?.mode;
  useEffect(() => {
    setError(null);
    setName(row?.name ?? '');
    setRequiresNotes(row?.requiresNotes ? 'true' : 'false');
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
    const body = {
      name: name.trim(),
      requiresNotes: requiresNotes === 'true',
      sortOrder: parsedSort,
    };
    void (async () => {
      try {
        if (isEdit && row) await update({ id: row.id, body }).unwrap();
        else await create(body).unwrap();
        onClose();
      } catch (e) {
        setError(getApiErrorMessage(e as UnknownApiError));
      }
    })();
  };

  return (
    <ReferenceDialog
      open={!!editing}
      title={isEdit ? `Edit "${row?.name}"` : 'Add failed delivery reason'}
      submitLabel={isEdit ? 'Save changes' : 'Add reason'}
      submitLoading={createState.isLoading || updateState.isLoading}
      submitDisabled={!name.trim()}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      <TextField
        label="Reason"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <SelectField
        label="Requires notes"
        value={requiresNotes}
        onChange={(e) => setRequiresNotes(e.target.value)}
        hint="When Yes, the driver must add notes to submit this reason."
        options={[
          { value: 'false', label: 'No' },
          { value: 'true', label: 'Yes' },
        ]}
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
