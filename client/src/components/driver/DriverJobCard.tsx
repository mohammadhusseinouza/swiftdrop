import { Link } from 'react-router-dom';
import { ChevronRight, Phone, MapPin } from 'lucide-react';
import { cn } from '../ui/cn';
import { Badge } from '../ui/Badge';
import { StatusBadge } from '../orders/StatusBadge';
import { formatDateTime, formatMoney, isZeroMoney } from '../../lib/format';
import { getCollectionJobStatusPresentation, COLLECTION_CUSTODY_NOTE } from './driverJobStatus';
import { toDriverJobRouteSegment } from './driverJobRoute';
import { paths } from '../../routes/paths';
import type { DriverJobSummary } from '../../services/domain.types';

export interface DriverJobCardProps {
  job: DriverJobSummary;
  className?: string;
}

/**
 * Presentational "My Jobs" card (Phase 12.1). Read-only — no workflow
 * actions here (task §32: Collect/Fail/Pickup/Start Delivery/Deliver are
 * later Phase 12 sub-phases). Money is pre-formatted server data only; this
 * component never calculates a collection amount.
 *
 * COLLECTION and DELIVERY render deliberately different content — the
 * discriminated union means a Collection card can never accidentally show
 * an amount-to-collect callout (Parcel Collection is financially neutral in
 * V1, CLAUDE.md §72).
 */
export function DriverJobCard({ job, className }: DriverJobCardProps) {
  return (
    <div
      className={cn(
        'rounded-card border border-line bg-card p-3.5 shadow-card sm:p-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <Badge tone={job.jobType === 'COLLECTION' ? 'warning' : 'brand'}>
              {job.jobType === 'COLLECTION' ? 'Collection' : 'Delivery'}
            </Badge>
            <span className="text-xs font-medium text-ink-subtle">
              {job.jobType === 'COLLECTION' ? 'Sender → Company' : 'Company → Receiver'}
            </span>
          </div>
          <p className="mt-1.5 font-semibold text-ink">{job.orderNumber}</p>
        </div>

        {job.jobType === 'COLLECTION' ? (
          (() => {
            const { label, tone } = getCollectionJobStatusPresentation(job.status);
            return (
              <Badge tone={tone} dot>
                {label}
              </Badge>
            );
          })()
        ) : (
          <StatusBadge status={job.status} />
        )}
      </div>

      {job.jobType === 'COLLECTION' ? (
        <CollectionJobBody job={job} />
      ) : (
        <DeliveryJobBody job={job} />
      )}

      <Link
        to={paths.driver.jobDetail(toDriverJobRouteSegment(job.jobType), job.orderId)}
        className="mt-3 flex items-center justify-end gap-1 border-t border-line-subtle pt-3 text-sm font-medium text-brand-600 hover:text-brand-700"
      >
        View Job
        <ChevronRight className="size-4" aria-hidden="true" />
      </Link>
    </div>
  );
}

function CollectionJobBody({ job }: { job: Extract<DriverJobSummary, { jobType: 'COLLECTION' }> }) {
  return (
    <>
      <p className="mt-2.5 text-sm font-medium text-ink">
        {job.contact.name ?? 'Unnamed sender'}
      </p>
      <div className="mt-1 space-y-0.5 text-sm text-ink-muted">
        {job.contact.phone && (
          <p className="flex items-center gap-1.5">
            <Phone className="size-3.5 shrink-0" aria-hidden="true" />
            <a href={`tel:${job.contact.phone}`} className="hover:underline" aria-label={`Call ${job.contact.phone}`}>
              {job.contact.phone}
            </a>
          </p>
        )}
        {(job.contact.area || job.contact.address) && (
          <p className="flex items-start gap-1.5">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            <span>
              {job.contact.area && <span className="font-medium text-ink">{job.contact.area}</span>}
              {job.contact.area && job.contact.address && ' — '}
              {job.contact.address}
            </span>
          </p>
        )}
      </div>

      {job.status === 'COLLECTED_FROM_SENDER' && (
        <p className="mt-2 text-xs font-medium text-brand-700">{COLLECTION_CUSTODY_NOTE}</p>
      )}

      <p className="mt-2.5 text-xs text-ink-subtle">
        Assigned {formatDateTime(job.assignedAt)}
      </p>
    </>
  );
}

function DeliveryJobBody({ job }: { job: Extract<DriverJobSummary, { jobType: 'DELIVERY' }> }) {
  const zero = isZeroMoney(job.collection.amountToCollect);
  return (
    <>
      <p className="mt-2.5 text-sm font-medium text-ink">{job.receiver.name}</p>
      <div className="mt-1 space-y-0.5 text-sm text-ink-muted">
        <p className="flex items-center gap-1.5">
          <Phone className="size-3.5 shrink-0" aria-hidden="true" />
          <a href={`tel:${job.receiver.phone}`} className="hover:underline" aria-label={`Call ${job.receiver.phone}`}>
            {job.receiver.phone}
          </a>
        </p>
        <p className="flex items-start gap-1.5">
          <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>
            <span className="font-medium text-ink">{job.receiver.area}</span>
            {' — '}
            {job.receiver.address}
          </span>
        </p>
      </div>

      <div className="mt-2.5 flex items-center justify-between border-t border-line-subtle pt-2.5">
        <span className="text-xs font-medium text-ink-subtle">Amount to collect</span>
        {zero ? (
          <span className="text-sm font-medium text-ink-muted">No collection required</span>
        ) : (
          <span className="text-sm font-semibold tabular-nums text-ink">
            {formatMoney(job.collection.amountToCollect)}
          </span>
        )}
      </div>

      <p className="mt-2 text-xs text-ink-subtle">
        Assigned {formatDateTime(job.timestamps.assignedAt)}
      </p>
    </>
  );
}
