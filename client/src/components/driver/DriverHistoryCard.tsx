import type { ReactNode } from 'react';
import { MapPin, PackageCheck, PackageX, Truck } from 'lucide-react';

import { Badge } from '../ui/Badge';
import { cn } from '../ui/cn';
import { formatDateTime, formatMoney, isZeroMoney } from '../../lib/format';
import { getParcelCollectionStatusPresentation } from '../orders/parcelCollection';
import { getOrderStatusPresentation } from '../orders/orderStatus';
import type { DriverWorkHistoryItem } from '../../services/domain.types';

/**
 * Phase 12.5 — one presentational card for every Driver Work History row.
 * READ-ONLY: no workflow actions, and deliberately NO link to the current
 * Job Detail route (that route is current-job-only and 404s for history —
 * task §33). The card carries enough safe summary to stand alone.
 *
 * The discriminated union makes it structurally impossible for a Collection
 * card to render an amount-collected line (Parcel Collection is financially
 * neutral — task §22/§27) or for a Delivery card to render collection
 * contact data.
 *
 * `result` is communicated in TEXT (a labelled badge), never by colour alone
 * (task §72).
 */
export interface DriverHistoryCardProps {
  item: DriverWorkHistoryItem;
  className?: string;
}

export function DriverHistoryCard({ item, className }: DriverHistoryCardProps) {
  const isCompleted = item.result === 'COMPLETED';
  return (
    <div
      className={cn(
        'rounded-card border border-line bg-card p-3.5 shadow-card sm:p-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.jobType === 'COLLECTION' ? 'warning' : 'brand'}>
              {item.jobType === 'COLLECTION' ? 'Collection' : 'Delivery'}
            </Badge>
            <span className="text-xs font-medium text-ink-subtle">
              {item.jobType === 'COLLECTION'
                ? 'Sender → Company'
                : 'Company → Receiver'}
            </span>
          </div>
          <p className="mt-1.5 font-semibold text-ink">{item.orderNumber}</p>
        </div>

        <Badge tone={isCompleted ? 'success' : 'danger'}>
          {isCompleted ? (
            <PackageCheck className="size-3.5" aria-hidden="true" />
          ) : (
            <PackageX className="size-3.5" aria-hidden="true" />
          )}
          {isCompleted ? 'Completed' : 'Failed'}
        </Badge>
      </div>

      {item.jobType === 'COLLECTION' && item.result === 'COMPLETED' && (
        <CollectionCompletedBody item={item} />
      )}
      {item.jobType === 'COLLECTION' && item.result === 'FAILED' && (
        <CollectionFailedBody item={item} />
      )}
      {item.jobType === 'DELIVERY' && item.result === 'COMPLETED' && (
        <DeliveryCompletedBody item={item} />
      )}
      {item.jobType === 'DELIVERY' && item.result === 'FAILED' && (
        <DeliveryFailedBody item={item} />
      )}
    </div>
  );
}

/* ------------------------------- shared bits ------------------------------ */

function Line({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex flex-wrap gap-x-1.5 text-sm">
      <span className="text-ink-subtle">{label}</span>
      <span className="min-w-0 break-words text-ink">{children}</span>
    </p>
  );
}

function LocationLine({ area, address }: { area: string | null; address?: string | null }) {
  if (!area && !address) return null;
  return (
    <p className="flex items-start gap-1.5 text-sm text-ink-muted">
      <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0 break-words">
        {area && <span className="font-medium text-ink">{area}</span>}
        {area && address ? ' — ' : ''}
        {address}
      </span>
    </p>
  );
}

function FailureLines({
  reasonName,
  notes,
}: {
  reasonName: string | null;
  notes: string | null;
}) {
  return (
    <>
      <Line label="Reason">{reasonName ?? 'Not recorded'}</Line>
      {notes && <Line label="Your notes">{notes}</Line>}
    </>
  );
}

/** Secondary "where the Order sits now" line — the row's result stays as-is (task §63). */
function ResultingStatusLine({
  label,
  presentation,
}: {
  label: string;
  presentation: { label: string };
}) {
  return (
    <p className="mt-2 border-t border-line-subtle pt-2 text-xs text-ink-subtle">
      {label}: <span className="font-medium text-ink-muted">{presentation.label}</span>
    </p>
  );
}

/* ------------------------------- Collection ------------------------------ */

function CollectionCompletedBody({
  item,
}: {
  item: Extract<DriverWorkHistoryItem, { jobType: 'COLLECTION'; result: 'COMPLETED' }>;
}) {
  return (
    <div className="mt-2.5 space-y-1.5">
      <Line label="Collection contact">{item.contact.name ?? 'Unnamed sender'}</Line>
      <LocationLine area={item.contact.area} address={item.contact.address} />
      <p className="flex items-center gap-1.5 text-sm text-success-700">
        <PackageCheck className="size-3.5 shrink-0" aria-hidden="true" />
        Received at Company · {formatDateTime(item.completedAt)}
      </p>
    </div>
  );
}

function CollectionFailedBody({
  item,
}: {
  item: Extract<DriverWorkHistoryItem, { jobType: 'COLLECTION'; result: 'FAILED' }>;
}) {
  const resulting = getParcelCollectionStatusPresentation(
    item.resultingParcelCollectionStatus,
  );
  const showResulting = item.resultingParcelCollectionStatus !== 'FAILED';
  return (
    <div className="mt-2.5 space-y-1.5">
      <Line label="Collection contact">{item.contact.name ?? 'Unnamed sender'}</Line>
      <LocationLine area={item.contact.area} address={item.contact.address} />
      <FailureLines reasonName={item.failure.reasonName} notes={item.failure.notes} />
      <p className="text-xs text-ink-subtle">
        Attempt #{item.attemptNumber} · Failed {formatDateTime(item.failedAt)}
      </p>
      {showResulting && (
        <ResultingStatusLine label="Collection now" presentation={resulting} />
      )}
    </div>
  );
}

/* -------------------------------- Delivery ------------------------------- */

function DeliveryCompletedBody({
  item,
}: {
  item: Extract<DriverWorkHistoryItem, { jobType: 'DELIVERY'; result: 'COMPLETED' }>;
}) {
  const zero =
    item.actualAmountCollected == null || isZeroMoney(item.actualAmountCollected);
  return (
    <div className="mt-2.5 space-y-1.5">
      <Line label="Receiver">{item.receiver.name}</Line>
      <LocationLine area={item.receiver.area} />
      <p className="flex items-center gap-1.5 text-sm text-success-700">
        <Truck className="size-3.5 shrink-0" aria-hidden="true" />
        Delivered · {formatDateTime(item.completedAt)}
      </p>
      <div className="mt-1 flex items-center justify-between border-t border-line-subtle pt-2">
        <span className="text-xs font-medium text-ink-subtle">Amount collected</span>
        {zero ? (
          <span className="text-sm font-medium text-ink-muted">None</span>
        ) : (
          <span className="text-sm font-semibold tabular-nums text-ink">
            {formatMoney(item.actualAmountCollected)}
          </span>
        )}
      </div>
    </div>
  );
}

function DeliveryFailedBody({
  item,
}: {
  item: Extract<DriverWorkHistoryItem, { jobType: 'DELIVERY'; result: 'FAILED' }>;
}) {
  const resulting = getOrderStatusPresentation(item.resultingOrderStatus);
  const showResulting = item.resultingOrderStatus !== 'FAILED_DELIVERY';
  return (
    <div className="mt-2.5 space-y-1.5">
      <Line label="Receiver">{item.receiver.name}</Line>
      <LocationLine area={item.receiver.area} />
      <FailureLines reasonName={item.failure.reasonName} notes={item.failure.notes} />
      <p className="text-xs text-ink-subtle">
        Attempt #{item.attemptNumber} · Failed {formatDateTime(item.failedAt)}
      </p>
      {showResulting && (
        <ResultingStatusLine label="Order now" presentation={resulting} />
      )}
    </div>
  );
}
