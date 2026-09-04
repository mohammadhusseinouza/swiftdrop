import { useMemo, useState } from 'react';

import { useHasPermission } from '../../../features/auth/usePermissions';
import { PERMISSIONS } from '../../../features/auth/permissions';
import {
  useGetSystemSettingsQuery,
  useUpdateSystemSettingMutation,
} from '../../../services/settingsApi';
import {
  getApiErrorMessage,
  type UnknownApiError,
} from '../../../services/apiError';
import type { SystemSettingSummary } from '../../../services/domain.types';

import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { humanizeToken, formatDateTime } from '../../../lib/format';
import { SystemSettingDialog } from './SystemSettingDialog';

/**
 * General tab — surfaces whatever rows exist in `system_settings`. The V1
 * backend has NO approved General key catalog and NO create endpoint, so
 * when the table is empty this shows an honest informational state rather
 * than fake inputs or a Save button that writes nowhere.
 */
export function GeneralTab() {
  const canManage = useHasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const query = useGetSystemSettingsQuery();
  const [, updateState] = useUpdateSystemSettingMutation();
  const [editing, setEditing] = useState<SystemSettingSummary | null>(null);

  // Delivery-looking keys belong to the Delivery tab; everything else here.
  const rows = useMemo(
    () =>
      (query.data ?? []).filter(
        (s) => !/deliver|fee|redeliver|attempt/i.test(s.key),
      ),
    [query.data],
  );

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

  if (rows.length === 0) {
    return (
      <Card className="space-y-2">
        <h2 className="text-sm font-semibold text-ink">General Settings</h2>
        <p className="text-sm text-ink-muted">
          No configurable General settings are defined in the current V1
          backend. Company identity, currency and general operational values
          are not yet an approved system-setting catalog, so there is nothing
          to edit here.
        </p>
        <p className="text-xs text-ink-subtle">
          Order and financial behaviour is defined server-side and is not
          controlled from this page.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-muted">
        These rows exist in the backend&rsquo;s <code>system_settings</code>{' '}
        table. Sensitive values are protected and cannot be edited here.
      </p>
      {rows.map((s) => (
        <SettingRow
          key={s.key}
          setting={s}
          canManage={canManage}
          onEdit={() => setEditing(s)}
        />
      ))}
      <SystemSettingDialog
        setting={editing}
        onClose={() => setEditing(null)}
        saving={updateState.isLoading}
      />
    </div>
  );
}

function SettingRow({
  setting,
  canManage,
  onEdit,
}: {
  setting: SystemSettingSummary;
  canManage: boolean;
  onEdit: () => void;
}) {
  const editable = canManage && !setting.isSensitive;
  return (
    <Card className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <code className="text-sm font-medium text-ink">{setting.key}</code>
          {setting.isSensitive && <Badge tone="warning">Protected value</Badge>}
        </div>
        {setting.description && (
          <p className="text-xs text-ink-muted">{setting.description}</p>
        )}
        <p className="text-sm text-ink-secondary">
          {setting.isSensitive ? (
            <span className="text-ink-subtle">Protected — not shown</span>
          ) : (
            <ValuePreview value={setting.value} />
          )}
        </p>
        <p className="text-xs text-ink-subtle">
          {setting.updatedBy
            ? `Updated by ${setting.updatedBy.firstName} ${setting.updatedBy.lastName} · `
            : ''}
          {formatDateTime(setting.updatedAt)}
        </p>
      </div>
      {editable && (
        <Button variant="secondary" size="sm" onClick={onEdit}>
          Edit
        </Button>
      )}
    </Card>
  );
}

function ValuePreview({ value }: { value: unknown }) {
  if (value === null || value === undefined)
    return <span className="text-ink-subtle">Not set</span>;
  if (typeof value === 'boolean')
    return <span>{value ? 'On' : 'Off'}</span>;
  if (typeof value === 'string' || typeof value === 'number')
    return <span>{String(value)}</span>;
  return (
    <span className="text-ink-subtle">
      {humanizeToken(Array.isArray(value) ? 'list value' : 'structured value')} —
      not editable here
    </span>
  );
}
