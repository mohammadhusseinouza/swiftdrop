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
import { formatDateTime } from '../../../lib/format';
import { SystemSettingDialog } from './SystemSettingDialog';

/**
 * Delivery Settings tab. Automatic delivery-fee / failed-attempt-fee /
 * redelivery-fee rules are DEFERRED beyond V1 and no backend service
 * consumes such keys, so this tab does NOT invent them. If a delivery-shaped
 * `system_settings` key genuinely exists it is shown; otherwise an honest
 * informational state.
 */
export function DeliveryTab() {
  const canManage = useHasPermission(PERMISSIONS.SETTINGS_MANAGE);
  const query = useGetSystemSettingsQuery();
  const [, updateState] = useUpdateSystemSettingMutation();
  const [editing, setEditing] = useState<SystemSettingSummary | null>(null);

  const rows = useMemo(
    () =>
      (query.data ?? []).filter((s) =>
        /deliver|fee|redeliver|attempt/i.test(s.key),
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
        <h2 className="text-sm font-semibold text-ink">Delivery Settings</h2>
        <p className="text-sm text-ink-muted">
          No configurable delivery-fee or redelivery rules are defined in the
          current V1 backend. Default delivery fee, failed-attempt fee and
          redelivery fee are not active system settings — no server business
          logic consumes them.
        </p>
        <p className="text-xs text-ink-subtle">
          Each order&rsquo;s amounts are entered per order and validated
          server-side. Automatic fee-by-area pricing is deferred beyond V1.
        </p>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {rows.map((s) => (
        <Card
          key={s.key}
          className="flex flex-wrap items-start justify-between gap-3"
        >
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-sm font-medium text-ink">{s.key}</code>
              {s.isSensitive && <Badge tone="warning">Protected value</Badge>}
            </div>
            {s.description && (
              <p className="text-xs text-ink-muted">{s.description}</p>
            )}
            <p className="text-sm text-ink-secondary">
              {s.isSensitive ? (
                <span className="text-ink-subtle">Protected — not shown</span>
              ) : (
                <span>{JSON.stringify(s.value)}</span>
              )}
            </p>
            <p className="text-xs text-ink-subtle">
              {formatDateTime(s.updatedAt)}
            </p>
          </div>
          {canManage && !s.isSensitive && (
            <Button variant="secondary" size="sm" onClick={() => setEditing(s)}>
              Edit
            </Button>
          )}
        </Card>
      ))}
      <SystemSettingDialog
        setting={editing}
        onClose={() => setEditing(null)}
        saving={updateState.isLoading}
      />
    </div>
  );
}
