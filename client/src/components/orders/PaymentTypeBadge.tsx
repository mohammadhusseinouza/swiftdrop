import { Badge } from '../ui/Badge';
import { getPaymentTypePresentation } from './orderStatus';

export interface PaymentTypeBadgeProps {
  paymentType: string;
  className?: string;
}

/**
 * Display-only. Payment TYPE (CASH_ON_DELIVERY / ALREADY_PAID / PARTIALLY_PAID)
 * — distinct from payment METHOD (cash / card / bank transfer / …), which is
 * configurable reference data.
 */
export function PaymentTypeBadge({ paymentType, className }: PaymentTypeBadgeProps) {
  const { label, tone } = getPaymentTypePresentation(paymentType);
  return (
    <Badge tone={tone} className={className}>
      {label}
    </Badge>
  );
}
