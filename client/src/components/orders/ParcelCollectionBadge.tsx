import { Badge } from '../ui/Badge';
import {
  getParcelCollectionStatusPresentation,
  getParcelIntakePresentation,
} from './parcelCollection';

/**
 * Display-only Parcel Collection status pill. Never decides workflow
 * transitions. Unknown values render a safe "Unknown" badge.
 */
export function ParcelCollectionStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const { label, tone } = getParcelCollectionStatusPresentation(status);
  return (
    <Badge tone={tone} dot className={className}>
      {label}
    </Badge>
  );
}

/**
 * Combined Parcel Intake pill for the Orders list — reads "Already at Company"
 * for ALREADY_AT_COMPANY orders, or the collection status for DRIVER_COLLECTION.
 */
export function ParcelIntakeBadge({
  method,
  status,
  className,
}: {
  method: string;
  status: string;
  className?: string;
}) {
  const { label, tone } = getParcelIntakePresentation(method, status);
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}
