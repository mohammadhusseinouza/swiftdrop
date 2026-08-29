import { Badge } from '../ui/Badge';
import {
  getCustomerStatusPresentation,
  getOrderStatusPresentation,
} from './orderStatus';

export interface StatusBadgeProps {
  status: string;
  /** 'internal' (Management, default) or 'customer' (simplified public wording). */
  audience?: 'internal' | 'customer';
  className?: string;
}

/**
 * Display-only Order status pill. Never decides workflow transitions.
 * Unknown status values render a safe "Unknown" / "Processing" badge rather
 * than throwing.
 */
export function StatusBadge({
  status,
  audience = 'internal',
  className,
}: StatusBadgeProps) {
  const { label, tone } =
    audience === 'customer'
      ? getCustomerStatusPresentation(status)
      : getOrderStatusPresentation(status);

  return (
    <Badge tone={tone} dot className={className}>
      {label}
    </Badge>
  );
}
