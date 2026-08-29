import { Badge } from '../ui/Badge';
import { getOrderTypeLabel } from './orderStatus';

export interface OrderTypeBadgeProps {
  orderType: string;
  className?: string;
}

/** Display-only. Does not calculate financial ownership. */
export function OrderTypeBadge({ orderType, className }: OrderTypeBadgeProps) {
  return (
    <Badge
      tone={orderType === 'COMPANY_ORDER' ? 'brand' : 'neutral'}
      className={className}
    >
      {getOrderTypeLabel(orderType)}
    </Badge>
  );
}
