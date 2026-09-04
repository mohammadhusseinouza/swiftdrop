import { Link } from 'react-router-dom';

import type { DataTableColumn } from '../../../components/data-display/DataTable';
import { Badge } from '../../../components/ui/Badge';
import { Button } from '../../../components/ui/Button';
import { formatDateTime } from '../../../lib/format';
import type { AuditLogEntry } from '../../../services/domain.types';

import {
  actionLabel,
  actionTone,
  changeSummary,
  entityRoute,
  entityTypeLabel,
  shortId,
} from './auditPresentation';

interface Opts {
  perms: {
    orders: boolean;
    customers: boolean;
    drivers: boolean;
    employees: boolean;
  };
  onView: (entry: AuditLogEntry) => void;
}

export function buildAuditColumns({
  perms,
  onView,
}: Opts): DataTableColumn<AuditLogEntry>[] {
  return [
    {
      id: 'time',
      header: 'Time',
      cell: (r) => formatDateTime(r.createdAt),
    },
    {
      id: 'actor',
      header: 'Actor',
      cell: (r) =>
        r.actor ? (
          <span className="flex flex-col gap-0.5">
            <span>
              {r.actor.firstName} {r.actor.lastName}
            </span>
            <span className="text-xs text-ink-muted">{r.actor.email}</span>
          </span>
        ) : (
          <span className="text-ink-muted">System</span>
        ),
    },
    {
      id: 'action',
      header: 'Action',
      cell: (r) => (
        <span className="flex flex-col gap-0.5">
          <Badge tone={actionTone(r.action)}>{actionLabel(r.action)}</Badge>
          <code className="text-[0.6875rem] text-ink-subtle">{r.action}</code>
        </span>
      ),
    },
    {
      id: 'entity',
      header: 'Entity',
      hideBelow: 'lg',
      cell: (r) => {
        const route = entityRoute(r.entityType, r.entityId, perms);
        return (
          <span className="flex flex-col gap-0.5">
            <span>{entityTypeLabel(r.entityType)}</span>
            {route ? (
              <Link
                to={route}
                className="text-xs text-brand-600 hover:underline"
              >
                {shortId(r.entityId)}
              </Link>
            ) : (
              <code className="text-[0.6875rem] text-ink-subtle">
                {shortId(r.entityId)}
              </code>
            )}
          </span>
        );
      },
    },
    {
      id: 'changes',
      header: 'Changes',
      hideBelow: 'md',
      cell: (r) => (
        <span className="text-ink-muted">{changeSummary(r)}</span>
      ),
    },
    {
      id: 'details',
      header: '',
      align: 'right',
      cell: (r) => (
        <Button size="sm" variant="ghost" onClick={() => onView(r)}>
          Details
        </Button>
      ),
    },
  ];
}
