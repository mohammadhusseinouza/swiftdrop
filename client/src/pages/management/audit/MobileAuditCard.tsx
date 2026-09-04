import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { formatDateTime } from '../../../lib/format';
import type { AuditLogEntry } from '../../../services/domain.types';

import {
  actionLabel,
  actionTone,
  changeSummary,
  entityTypeLabel,
  shortId,
} from './auditPresentation';

export function MobileAuditCard({
  entry,
  onView,
}: {
  entry: AuditLogEntry;
  onView: () => void;
}) {
  return (
    <div className="rounded-card border border-line bg-card p-3 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <Badge tone={actionTone(entry.action)}>{actionLabel(entry.action)}</Badge>
        <span className="shrink-0 text-xs text-ink-muted">
          {formatDateTime(entry.createdAt)}
        </span>
      </div>
      <dl className="mt-2 space-y-1 text-xs text-ink-muted">
        <div className="flex items-center justify-between gap-2">
          <dt>Actor</dt>
          <dd className="truncate">
            {entry.actor
              ? `${entry.actor.firstName} ${entry.actor.lastName}`
              : 'System'}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Entity</dt>
          <dd>
            {entityTypeLabel(entry.entityType)} · {shortId(entry.entityId)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>Changes</dt>
          <dd>{changeSummary(entry)}</dd>
        </div>
      </dl>
      <div className="mt-2 flex justify-end border-t border-line pt-2">
        <Button size="sm" variant="ghost" onClick={onView}>
          View details
        </Button>
      </div>
    </div>
  );
}
