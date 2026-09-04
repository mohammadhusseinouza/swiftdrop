import { useEffect, useId, useRef } from 'react';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';

import { cn } from '../../../components/ui/cn';
import { Button } from '../../../components/ui/Button';
import { Badge } from '../../../components/ui/Badge';
import { formatDateTime } from '../../../lib/format';
import type { AuditLogEntry } from '../../../services/domain.types';

import {
  actionLabel,
  actionTone,
  entityRoute,
  entityTypeLabel,
} from './auditPresentation';
import { AuditChangeView, AuditValueBlock } from './AuditValueViewer';

export interface AuditDetailDialogProps {
  entry: AuditLogEntry | null;
  perms: {
    orders: boolean;
    customers: boolean;
    drivers: boolean;
    employees: boolean;
  };
  onClose: () => void;
}

/** Read-only detail for one audit record. No route — a dialog. */
export function AuditDetailDialog({ entry, perms, onClose }: AuditDetailDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (entry && !d.open) d.showModal();
    else if (!entry && d.open) d.close();
  }, [entry]);

  const route = entry
    ? entityRoute(entry.entityType, entry.entityId, perms)
    : null;
  const hasBoth =
    !!entry &&
    isObj(entry.previousValues) &&
    isObj(entry.newValues);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        'm-auto w-[calc(100vw-2rem)] max-w-xl rounded-card border border-line',
        'bg-card p-0 text-ink shadow-overlay backdrop:bg-ink/40',
        'max-h-[calc(100vh-3rem)]',
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 id={titleId} className="text-base font-semibold text-ink">
          Audit event
        </h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="rounded-control p-1 text-ink-muted hover:bg-neutral-50 hover:text-ink"
        >
          <X className="size-5" aria-hidden="true" />
        </button>
      </div>

      {entry && (
        <div className="max-h-[calc(100vh-9rem)] space-y-4 overflow-y-auto p-5">
          <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
            <Row label="Time" value={formatDateTime(entry.createdAt)} />
            <Row
              label="Actor"
              value={
                entry.actor ? (
                  <span>
                    {entry.actor.firstName} {entry.actor.lastName}
                    <span className="block text-xs text-ink-muted">
                      {entry.actor.email}
                    </span>
                  </span>
                ) : (
                  <span className="text-ink-muted">System</span>
                )
              }
            />
            <Row
              label="Action"
              value={
                <span className="flex flex-wrap items-center gap-2">
                  <Badge tone={actionTone(entry.action)}>
                    {actionLabel(entry.action)}
                  </Badge>
                  <code className="text-xs text-ink-muted">{entry.action}</code>
                </span>
              }
            />
            <Row label="Entity type" value={entityTypeLabel(entry.entityType)} />
            <Row
              label="Entity ID"
              value={
                <span className="flex flex-wrap items-center gap-2">
                  <code className="break-all text-xs text-ink-secondary">
                    {entry.entityId}
                  </code>
                  {route && (
                    <Link
                      to={route}
                      className="text-xs font-medium text-brand-600 hover:underline"
                    >
                      Open →
                    </Link>
                  )}
                </span>
              }
            />
          </dl>

          {hasBoth ? (
            <AuditChangeView
              previousValues={entry.previousValues}
              newValues={entry.newValues}
            />
          ) : (
            <div className="space-y-3">
              <AuditValueBlock title="Previous values" value={entry.previousValues} />
              <AuditValueBlock title="New values" value={entry.newValues} />
            </div>
          )}

          {isObj(entry.metadata) && (
            <AuditValueBlock title="Context" value={entry.metadata} />
          )}

          <p className="text-xs text-ink-muted">
            Audit records are immutable history — they are never edited,
            corrected or deleted.
          </p>

          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>
      )}
    </dialog>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-x-4 gap-y-1 px-3 py-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className="min-w-0 text-right font-medium text-ink-secondary">
        {value}
      </dd>
    </div>
  );
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
