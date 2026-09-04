import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { paths } from '../../../routes/paths';
import { useAppSelector } from '../../../app/hooks';
import { selectCurrentUser } from '../../../features/auth/authSlice';
import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetEmployeeQuery,
  useUpdateEmployeeMutation,
} from '../../../services/employeesApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { ActiveBadge } from '../../../components/ui/ActiveBadge';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import { formatDateTime } from '../../../lib/format';

import { EmployeeFormDialog } from './EmployeeFormDialog';
import { groupPermissions } from './permissionGroups';

const ROLE_TONE: Record<string, 'brand' | 'info' | 'neutral'> = {
  ADMIN: 'brand',
  FINANCE: 'info',
  DISPATCHER: 'neutral',
};

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const currentUser = useAppSelector(selectCurrentUser);
  const canManage = useHasPermission(PERMISSIONS.EMPLOYEES_MANAGE);
  const canViewAudit = useHasPermission(PERMISSIONS.AUDIT_READ);

  const query = useGetEmployeeQuery(id ?? '', { skip: !id });
  const employee = query.data;

  const [editOpen, setEditOpen] = useState(false);
  const [confirm, setConfirm] = useState<'deactivate' | 'reactivate' | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [updateEmployee, { isLoading: updating }] = useUpdateEmployeeMutation();

  const isSelf = !!employee && !!currentUser && employee.userId === currentUser.id;

  const permissionGroups = useMemo(
    () => (employee ? groupPermissions(employee.role.permissions) : []),
    [employee],
  );

  const setActive = (isActive: boolean, msg: string) =>
    void (async () => {
      if (!employee) return;
      setActionError(null);
      try {
        await updateEmployee({
          id: employee.id,
          body: { isActive },
          selfUserId: employee.userId,
        }).unwrap();
        setConfirm(null);
        setNotice(msg);
      } catch (e) {
        const err = e as UnknownApiError;
        setConfirm(null);
        const status = getApiErrorStatus(err);
        const code = getApiErrorCode(err);
        setActionError(
          status === 409 || code === 'CONFLICT'
            ? getApiErrorMessage(err)
            : getApiErrorMessage(err),
        );
      }
    })();

  if (!id || query.isError || (query.isSuccess && !employee)) {
    const status = getApiErrorStatus(query.error);
    const code = getApiErrorCode(query.error);
    const notFound = !id || status === 404 || code === 'NOT_FOUND';
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Employee not found' : 'Could not load this employee'}
          message={
            notFound
              ? 'This employee does not exist or the reference is not valid.'
              : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
          action={
            <Link
              to={paths.management.employees}
              className="inline-flex h-8 items-center rounded-control border border-line bg-card px-3 text-xs font-medium text-ink-secondary hover:bg-sunken"
            >
              Back to employees
            </Link>
          }
        />
      </div>
    );
  }

  if (query.isLoading || !employee) {
    return (
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Employee" size="lg" />
        <LoadingState className="py-16" label="Loading employee…" />
      </div>
    );
  }

  const headerActions = canManage ? (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="secondary" onClick={() => setEditOpen(true)}>
        Edit
      </Button>
      {employee.isActive ? (
        <div className="flex flex-col items-end">
          <Button
            variant="ghost"
            className="text-danger-700 hover:bg-danger-50"
            disabled={isSelf}
            onClick={() => setConfirm('deactivate')}
          >
            Deactivate
          </Button>
          {isSelf && (
            <span className="text-xs text-ink-muted">
              You cannot deactivate your own account.
            </span>
          )}
        </div>
      ) : (
        <Button variant="ghost" onClick={() => setConfirm('reactivate')}>
          Reactivate
        </Button>
      )}
    </div>
  ) : undefined;

  return (
    <div className="space-y-5 pb-6">
      <BackLink />

      <PageHeader
        size="lg"
        title={`${employee.firstName} ${employee.lastName}`}
        description={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ActiveBadge isActive={employee.isActive} />
            <Badge tone={ROLE_TONE[employee.role.code] ?? 'neutral'}>
              {employee.role.name}
            </Badge>
            <span className="text-ink-muted">{employee.employeeNumber}</span>
          </span>
        }
        actions={headerActions}
      />

      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-3 rounded-card border border-line bg-card px-4 py-2.5 text-sm text-ink-secondary"
        >
          <span>{notice}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="text-xs font-medium text-ink-muted hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}
      {actionError && (
        <div
          role="alert"
          className="flex items-start justify-between gap-3 rounded-card border border-danger-200 bg-danger-50 px-4 py-2.5 text-sm text-danger-700"
        >
          <span>{actionError}</span>
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="text-xs font-medium hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {!employee.isActive && (
        <div className="rounded-card border border-warning-200 bg-warning-50 px-4 py-2.5 text-sm text-ink-secondary">
          This account is inactive — the employee cannot sign in. Their history
          and past actions are preserved.
        </div>
      )}

      {/* account info */}
      <section
        aria-labelledby="account-heading"
        className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5"
      >
        <h2 id="account-heading" className="text-sm font-semibold text-ink">
          Account information
        </h2>
        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Info label="Name" value={`${employee.firstName} ${employee.lastName}`} />
          <Info
            label="Email"
            value={
              <a
                href={`mailto:${employee.email}`}
                className="break-all text-brand-600 hover:underline"
              >
                {employee.email}
              </a>
            }
          />
          <Info label="Phone" value={employee.phone ?? '—'} />
          <Info label="Employee number" value={employee.employeeNumber} />
          <Info
            label="Account status"
            value={<ActiveBadge isActive={employee.isActive} />}
          />
          <Info
            label="Last login"
            value={
              employee.lastLoginAt ? (
                formatDateTime(employee.lastLoginAt)
              ) : (
                <span className="text-ink-subtle">Never</span>
              )
            }
          />
          <Info label="Created" value={formatDateTime(employee.createdAt)} />
          <Info label="Last updated" value={formatDateTime(employee.updatedAt)} />
        </dl>
      </section>

      {/* role & access */}
      <section
        aria-labelledby="access-heading"
        className="rounded-card border border-line bg-card p-4 shadow-card sm:p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="access-heading" className="text-sm font-semibold text-ink">
            Role &amp; access
          </h2>
          {canManage && (
            <button
              type="button"
              onClick={() => setEditOpen(true)}
              className="text-xs font-medium text-brand-600 hover:underline"
            >
              Change role
            </button>
          )}
        </div>

        <dl className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <Info label="Role" value={employee.role.name} />
          <Info label="Role code" value={employee.role.code} />
          {employee.role.description && (
            <Info
              label="Description"
              value={employee.role.description}
              wide
            />
          )}
          <Info
            label="Inherited permissions"
            value={`${employee.role.permissionCount}`}
          />
        </dl>

        <p className="mt-4 text-xs text-ink-muted">
          Permissions are inherited from the <strong>{employee.role.name}</strong>{' '}
          role. They are the same for every employee with this role and are not
          editable per person.
        </p>

        <div className="mt-3 space-y-3">
          {permissionGroups.map((g) => (
            <div key={g.id}>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
                {g.label}
              </h3>
              <ul className="mt-1 space-y-1">
                {g.permissions.map((p) => (
                  <li key={p.code} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                    <span aria-hidden="true" className="text-success-700">
                      ✓
                    </span>
                    <span className="text-ink">{p.name}</span>
                    <code className="break-all text-xs text-ink-muted">
                      {p.code}
                    </code>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {canViewAudit && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <Link
            to={`${paths.management.auditLogs}?actorId=${employee.userId}`}
            className="font-medium text-brand-600 hover:underline"
          >
            View actions performed by this employee →
          </Link>
          <Link
            to={`${paths.management.auditLogs}?entityType=EMPLOYEE&entityId=${employee.id}`}
            className="font-medium text-brand-600 hover:underline"
          >
            View changes to this employee record →
          </Link>
        </div>
      )}

      {/* dialogs */}
      <EmployeeFormDialog
        open={editOpen}
        mode="edit"
        employee={employee}
        onClose={() => setEditOpen(false)}
        onCreated={() => setEditOpen(false)}
        onSaved={() => {
          setEditOpen(false);
          setNotice('Employee updated.');
        }}
      />
      <ConfirmationModal
        open={confirm === 'deactivate'}
        title="Deactivate this employee?"
        description={
          <p>
            <span className="font-medium">
              {employee.firstName} {employee.lastName}
            </span>{' '}
            will not be able to sign in. Their history and past actions stay
            intact, and the account can be reactivated later. This does not
            change any financial data.
          </p>
        }
        confirmLabel="Deactivate"
        confirmVariant="danger"
        confirmLoading={updating}
        onConfirm={() => setActive(false, 'Employee deactivated.')}
        onCancel={() => setConfirm(null)}
      />
      <ConfirmationModal
        open={confirm === 'reactivate'}
        title="Reactivate this employee?"
        description={
          <p>
            <span className="font-medium">
              {employee.firstName} {employee.lastName}
            </span>{' '}
            will be able to sign in again with their existing credentials.
          </p>
        }
        confirmLabel="Reactivate"
        confirmLoading={updating}
        onConfirm={() => setActive(true, 'Employee reactivated.')}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}

function Info({
  label,
  value,
  wide,
}: {
  label: string;
  value: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <div className={wide ? 'min-w-0 sm:col-span-2' : 'min-w-0'}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="mt-0.5 break-words text-sm text-ink">{value}</dd>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.management.employees}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to employees
    </Link>
  );
}
