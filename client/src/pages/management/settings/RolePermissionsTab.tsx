import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetRoleConfigQuery,
  useUpdateRolePermissionsMutation,
} from '../../../services/settingsApi';
import {
  getApiErrorMessage,
  type UnknownApiError,
} from '../../../services/apiError';
import type { RoleConfigSummary } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { ConfirmationModal } from '../../../components/feedback/ConfirmationModal';
import {
  buildPermissionMatrix,
  ELEVATED_PERMISSION_CODES,
} from './permissionMatrix';

const ROLE_ORDER = ['ADMIN', 'DISPATCHER', 'FINANCE'];

export function RolePermissionsTab() {
  const canManage = useHasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const [sp, setSp] = useSearchParams();
  const query = useGetRoleConfigQuery();

  const roles = useMemo(
    () =>
      [...(query.data?.roles ?? [])].sort(
        (a, b) => ROLE_ORDER.indexOf(a.code) - ROLE_ORDER.indexOf(b.code),
      ),
    [query.data],
  );

  const urlRole = sp.get('role');
  const selectedCode =
    urlRole && roles.some((r) => r.code === urlRole)
      ? urlRole
      : (roles[1]?.code ?? roles[0]?.code ?? '');
  const selected = roles.find((r) => r.code === selectedCode) ?? null;

  const selectRole = useCallback(
    (code: string) => {
      setSp((prev) => {
        const p = new URLSearchParams(prev);
        p.set('tab', 'permissions');
        p.set('role', code);
        return p;
      });
    },
    [setSp],
  );

  if (query.isLoading) return <LoadingState className="py-16" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        className="py-16"
        message={getApiErrorMessage(query.error as UnknownApiError)}
        onRetry={() => void query.refetch()}
      />
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-muted">
        Configure which permissions each management role grants. This does{' '}
        <strong>not</strong> assign roles to people (that is Employee
        Management) and there are no per-person permission overrides — every
        change applies to <strong>all</strong> users with the role.
      </p>

      <div
        role="group"
        aria-label="Select a role to view or configure"
        className="flex flex-wrap gap-2"
      >
        {roles.map((r) => (
          <button
            key={r.code}
            type="button"
            aria-pressed={r.code === selectedCode}
            onClick={() => selectRole(r.code)}
            className={
              'rounded-control border px-3 py-1.5 text-sm font-medium ' +
              (r.code === selectedCode
                ? 'border-brand-600 bg-brand-50 text-brand-700'
                : 'border-line bg-card text-ink-secondary hover:bg-sunken')
            }
          >
            {r.name}
            <span className="ml-1.5 text-xs text-ink-muted">
              {r.permissionCount}
            </span>
          </button>
        ))}
      </div>

      {selected && (
        <RoleEditor
          key={selected.code}
          role={selected}
          catalogCodes={query.data.permissionCatalog}
          assignableCodes={query.data.assignablePermissionCodes}
          canManage={canManage}
        />
      )}
    </div>
  );
}

function RoleEditor({
  role,
  catalogCodes,
  assignableCodes,
  canManage,
}: {
  role: RoleConfigSummary;
  catalogCodes: { code: string; name: string; description: string | null }[];
  assignableCodes: string[];
  canManage: boolean;
}) {
  const [update, updateState] = useUpdateRolePermissionsMutation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Set<string>>(new Set(role.permissionCodes));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setDraft(new Set(role.permissionCodes));
    setEditing(false);
    setError(null);
  }, [role]);

  const matrix = useMemo(
    () =>
      editing
        ? buildPermissionMatrix(catalogCodes, assignableCodes)
        : buildPermissionMatrix(
            catalogCodes.filter((p) => role.permissionCodes.includes(p.code)),
          ),
    [editing, catalogCodes, assignableCodes, role.permissionCodes],
  );

  const current = new Set(role.permissionCodes);
  const added = [...draft].filter((c) => !current.has(c)).sort();
  const removed = [...current].filter((c) => !draft.has(c)).sort();
  const dirty = added.length > 0 || removed.length > 0;
  const elevatedAdded = added.filter((c) => ELEVATED_PERMISSION_CODES.has(c));

  const save = () =>
    void (async () => {
      setError(null);
      try {
        await update({
          roleId: role.id,
          permissionCodes: [...draft],
        }).unwrap();
        setConfirmOpen(false);
        setEditing(false);
        setNotice(`${role.name} permissions updated.`);
      } catch (e) {
        setConfirmOpen(false);
        setError(getApiErrorMessage(e as UnknownApiError));
      }
    })();

  if (role.locked) {
    return (
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-ink">{role.name}</h2>
          <Badge tone="brand">Full access — protected role</Badge>
          <span className="text-xs text-ink-muted">
            {role.userCount} user{role.userCount === 1 ? '' : 's'}
          </span>
        </div>
        <p className="text-xs text-ink-muted">
          The Administrator role always holds every permission. Its matrix
          cannot be edited here (the backend rejects any change) so the system
          can never be locked out of administration.
        </p>
        <MatrixView
          matrix={matrix}
          checked={draft}
          disabled
          onToggle={() => {}}
        />
      </Card>
    );
  }

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{role.name}</h2>
          <p className="text-xs text-ink-muted">
            {role.permissionCount} permission
            {role.permissionCount === 1 ? '' : 's'} · affects {role.userCount}{' '}
            user{role.userCount === 1 ? '' : 's'}
          </p>
        </div>
        {canManage &&
          (editing ? (
            <div className="flex gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => {
                  setDraft(new Set(role.permissionCodes));
                  setEditing(false);
                }}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={!dirty}
                onClick={() => setConfirmOpen(true)}
              >
                Review &amp; save
              </Button>
            </div>
          ) : (
            <Button size="sm" onClick={() => setEditing(true)}>
              Edit permissions
            </Button>
          ))}
      </div>

      {notice && (
        <div
          role="status"
          className="rounded-card border border-line bg-card px-3 py-2 text-xs text-ink-secondary"
        >
          {notice}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-card border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700"
        >
          {error}
        </div>
      )}

      {editing && (
        <p className="text-xs text-ink-muted">
          Changes affect every user assigned to <strong>{role.name}</strong> and
          take effect on their next request. Driver and Customer portal
          permissions are not assignable to a management role.
        </p>
      )}

      {!editing && matrix.length === 0 ? (
        <p className="text-sm text-ink-muted">
          This role currently grants no permissions.
        </p>
      ) : (
        <MatrixView
          matrix={matrix}
          checked={draft}
          disabled={!editing}
          onToggle={(code) =>
            setDraft((prev) => {
              const next = new Set(prev);
              next.has(code) ? next.delete(code) : next.add(code);
              return next;
            })
          }
        />
      )}

      <ConfirmationModal
        open={confirmOpen}
        title={`Update ${role.name} role permissions?`}
        description={
          <div className="space-y-2">
            <p>
              This changes authorization for every {role.name} user (
              {role.userCount}). Existing sessions use the new permissions on
              their next authenticated request.
            </p>
            <p className="text-xs">
              {role.permissionCount} → <strong>{draft.size}</strong> permissions
            </p>
            {added.length > 0 && (
              <div className="text-xs">
                <span className="font-medium text-success-700">Added:</span>{' '}
                {added.join(', ')}
              </div>
            )}
            {removed.length > 0 && (
              <div className="text-xs">
                <span className="font-medium text-danger-700">Removed:</span>{' '}
                {removed.join(', ')}
              </div>
            )}
            {elevatedAdded.length > 0 && (
              <p className="rounded-control border border-warning-200 bg-warning-50 px-2 py-1.5 text-xs text-ink-secondary">
                <strong>Note:</strong> {elevatedAdded.join(', ')} grant broad
                administrative control. {role.name} users will be able to use
                these after their permissions refresh.
              </p>
            )}
          </div>
        }
        confirmLabel="Update permissions"
        confirmLoading={updateState.isLoading}
        onConfirm={save}
        onCancel={() => setConfirmOpen(false)}
      />
    </Card>
  );
}

function MatrixView({
  matrix,
  checked,
  disabled,
  onToggle,
}: {
  matrix: {
    id: string;
    label: string;
    permissions: { code: string; name: string; description: string | null }[];
  }[];
  checked: Set<string>;
  disabled: boolean;
  onToggle: (code: string) => void;
}) {
  return (
    <div className="space-y-4">
      {matrix.map((g) => (
        <fieldset key={g.id} className="space-y-1.5">
          <legend className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            {g.label}
          </legend>
          <ul className="space-y-1">
            {g.permissions.map((p) => {
              const on = checked.has(p.code);
              return (
                <li key={p.code}>
                  <label
                    className={
                      'flex items-start gap-2 text-sm ' +
                      (disabled ? '' : 'cursor-pointer')
                    }
                  >
                    <input
                      type="checkbox"
                      className="mt-0.5 size-4 rounded border-line"
                      checked={on}
                      disabled={disabled}
                      onChange={() => onToggle(p.code)}
                    />
                    <span className="min-w-0">
                      <span className="text-ink">{p.name}</span>{' '}
                      <code className="break-all text-xs text-ink-muted">
                        {p.code}
                      </code>
                      {p.description && (
                        <span className="block text-xs text-ink-subtle">
                          {p.description}
                        </span>
                      )}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
      ))}
    </div>
  );
}
