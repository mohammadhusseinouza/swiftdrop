import { useEffect, useMemo, useState } from 'react';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetPaymentMethodsQuery,
  useCreatePaymentMethodMutation,
  useUpdatePaymentMethodMutation,
} from '../../../services/settingsApi';
import {
  getApiErrorMessage,
  type UnknownApiError,
} from '../../../services/apiError';
import type { PaymentMethodSummary } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Button } from '../../../components/ui/Button';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { DataTable } from '../../../components/data-display/DataTable';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { ReferenceDialog } from './ReferenceDialog';
import { TextField } from '../../../components/forms/Field';

type Editing =
  | { mode: 'create' }
  | { mode: 'edit'; row: PaymentMethodSummary }
  | null;

export function PaymentMethodsTab() {
  const canManage = useHasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const isDesktop = useMediaQuery(MD_QUERY);
  const query = useGetPaymentMethodsQuery();
  const [editing, setEditing] = useState<Editing>(null);
  const [toggling, setToggling] = useState<PaymentMethodSummary | null>(null);

  const [updateMethod, updateState] = useUpdatePaymentMethodMutation();
  const [toggleError, setToggleError] = useState<string | null>(null);

  const rows = useMemo(
    () => [...(query.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder),
    [query.data],
  );

  const doToggle = (row: PaymentMethodSummary) =>
    void (async () => {
      setToggleError(null);
      try {
        await updateMethod({
          id: row.id,
          body: { isActive: !row.isActive },
        }).unwrap();
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
    { id: 'name', header: 'Name', cell: (r: PaymentMethodSummary) => r.name },
    {
      id: 'code',
      header: 'Code',
      cell: (r: PaymentMethodSummary) => (
        <code className="text-xs text-ink-muted">{r.code}</code>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (r: PaymentMethodSummary) => <ActiveBadge isActive={r.isActive} />,
    },
    {
      id: 'sortOrder',
      header: 'Sort order',
      align: 'right' as const,
      cell: (r: PaymentMethodSummary) => r.sortOrder,
      hideBelow: 'sm' as const,
    },
    ...(canManage
      ? [
          {
            id: 'actions',
            header: '',
            align: 'right' as const,
            cell: (r: PaymentMethodSummary) => (
              <RowActions
                onEdit={() => setEditing({ mode: 'edit', row: r })}
                onToggle={() => setToggling(r)}
                isActive={r.isActive}
              />
            ),
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink-muted">
          Payment methods offered on new transactions. Deactivating one keeps
          every historical order, payout and settlement reference intact.
        </p>
        {canManage && (
          <Button size="sm" onClick={() => setEditing({ mode: 'create' })}>
            Add payment method
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
        <EmptyState className="py-12" title="No payment methods configured." />
      ) : isDesktop ? (
        <Card flush>
          <DataTable
            columns={columns}
            rows={rows}
            getRowId={(r) => r.id}
            caption="Payment methods"
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
                <div className="flex flex-wrap items-center gap-x-3 text-xs text-ink-muted">
                  <code>{r.code}</code>
                  <span>Sort {r.sortOrder}</span>
                </div>
                {canManage && (
                  <RowActions
                    onEdit={() => setEditing({ mode: 'edit', row: r })}
                    onToggle={() => setToggling(r)}
                    isActive={r.isActive}
                  />
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      <PaymentMethodDialog editing={editing} onClose={() => setEditing(null)} />

      <ConfirmationModal
        open={!!toggling && toggling.isActive}
        title={`Deactivate ${toggling?.name}?`}
        description={
          <p>
            This payment method will no longer be available for new eligible
            transactions. Existing orders and financial history keep their
            original payment-method reference.
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
        title={`Reactivate ${toggling?.name}?`}
        description={
          <p>
            This payment method will be available again for new eligible
            transactions.
          </p>
        }
        confirmLabel="Reactivate"
        confirmLoading={updateState.isLoading}
        onConfirm={() => toggling && doToggle(toggling)}
        onCancel={() => setToggling(null)}
      />
    </div>
  );
}

function RowActions({
  onEdit,
  onToggle,
  isActive,
}: {
  onEdit: () => void;
  onToggle: () => void;
  isActive: boolean;
}) {
  return (
    <div className="flex items-center justify-end gap-1">
      <Button variant="ghost" size="sm" onClick={onEdit}>
        Edit
      </Button>
      <Button
        variant="ghost"
        size="sm"
        className={isActive ? 'text-danger-700 hover:bg-danger-50' : undefined}
        onClick={onToggle}
      >
        {isActive ? 'Deactivate' : 'Reactivate'}
      </Button>
    </div>
  );
}

function PaymentMethodDialog({
  editing,
  onClose,
}: {
  editing: Editing;
  onClose: () => void;
}) {
  const [create, createState] = useCreatePaymentMethodMutation();
  const [update, updateState] = useUpdatePaymentMethodMutation();
  const isEdit = editing?.mode === 'edit';
  const row = editing?.mode === 'edit' ? editing.row : null;

  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [sortOrder, setSortOrder] = useState('');
  const [error, setError] = useState<string | null>(null);

  const key = editing?.mode === 'edit' ? editing.row.id : editing?.mode;
  useEffect(() => {
    setError(null);
    setCode(row?.code ?? '');
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
          await create({
            code: code.trim(),
            name: name.trim(),
            sortOrder: parsedSort,
          }).unwrap();
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
      title={isEdit ? `Edit ${row?.name}` : 'Add payment method'}
      submitLabel={isEdit ? 'Save changes' : 'Add payment method'}
      submitLoading={createState.isLoading || updateState.isLoading}
      submitDisabled={!name.trim() || (!isEdit && !code.trim())}
      error={error}
      onSubmit={submit}
      onClose={onClose}
    >
      {isEdit ? (
        <div className="rounded-control border border-line bg-sunken px-3 py-2 text-xs text-ink-muted">
          Code <code className="text-ink">{row?.code}</code> — the identity is
          fixed and cannot change (financial records reference it).
        </div>
      ) : (
        <TextField
          label="Code"
          required
          value={code}
          onChange={(e) => setCode(e.target.value)}
          hint="A short unique identifier, e.g. VOUCHER. Cannot be changed later."
          autoComplete="off"
        />
      )}
      <TextField
        label="Name"
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
