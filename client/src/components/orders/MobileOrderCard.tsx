import type { ReactNode } from 'react';
import { Phone, MapPin } from 'lucide-react';
import { cn } from '../ui/cn';
import { StatusBadge } from './StatusBadge';
import { OrderTypeBadge } from './OrderTypeBadge';

export interface MobileOrderCardData {
  orderNumber: string;
  status: string;
  orderType: string;
  receiverName: string;
  receiverPhone?: string;
  area?: string;
  /** Pre-formatted, display-safe money string (e.g. "$120.00"). */
  amountToCollect?: string;
  driverName?: string;
  createdAt?: string;
}

export interface MobileOrderCardProps {
  order: MobileOrderCardData;
  /** Card tap (e.g. navigate to detail). */
  onClick?: () => void;
  /** Action slot rendered at the bottom (workflow buttons live in the parent). */
  actions?: ReactNode;
  /** Controlled selection checkbox (bulk operations). Shown only when both set. */
  selected?: boolean;
  onSelectedChange?: (next: boolean) => void;
  /** Accessible label for the selection checkbox, e.g. "Select order ORD-1". */
  selectLabel?: string;
  className?: string;
}

/**
 * Presentational compact order card for mobile Orders views. No API calls, no
 * workflow logic, no monetary calculation — money arrives pre-formatted.
 */
export function MobileOrderCard({
  order,
  onClick,
  actions,
  selected,
  onSelectedChange,
  selectLabel,
  className,
}: MobileOrderCardProps) {
  const Wrapper = onClick ? 'button' : 'div';
  const selectable = selected !== undefined && onSelectedChange !== undefined;

  return (
    <div
      className={cn(
        'rounded-card border bg-card p-3 shadow-card',
        selected ? 'border-brand-600' : 'border-line',
        className,
      )}
    >
      <div className="flex items-start gap-2">
        {selectable && (
          <input
            type="checkbox"
            className="mt-0.5 size-4 shrink-0 rounded border-line"
            checked={selected}
            aria-label={selectLabel ?? `Select order ${order.orderNumber}`}
            onChange={(e) => onSelectedChange(e.target.checked)}
          />
        )}

        <div className="min-w-0 flex-1">
          <Wrapper
            type={onClick ? 'button' : undefined}
            onClick={onClick}
            className={cn('block w-full text-left', onClick && 'cursor-pointer')}
          >
            <div className="flex items-start justify-between gap-2">
              <span className="font-semibold text-ink">{order.orderNumber}</span>
              <StatusBadge status={order.status} />
            </div>

            <p className="mt-1 text-sm font-medium text-ink">
              {order.receiverName}
            </p>

            <div className="mt-1 space-y-0.5 text-xs text-ink-muted">
              {order.receiverPhone && (
                <p className="flex items-center gap-1.5">
                  <Phone className="size-3.5" aria-hidden="true" />
                  {order.receiverPhone}
                </p>
              )}
              {order.area && (
                <p className="flex items-center gap-1.5">
                  <MapPin className="size-3.5" aria-hidden="true" />
                  {order.area}
                </p>
              )}
            </div>

            <div className="mt-2 flex items-center justify-between gap-2">
              <OrderTypeBadge orderType={order.orderType} />
              {order.amountToCollect && (
                <span className="text-sm font-semibold tabular-nums text-ink">
                  {order.amountToCollect}
                </span>
              )}
            </div>

            <p className="mt-1.5 text-xs text-ink-subtle">
              {order.driverName ? `Driver: ${order.driverName}` : 'Unassigned'}
              {order.createdAt ? ` · ${order.createdAt}` : ''}
            </p>
          </Wrapper>

          {actions && (
            <div className="mt-3 flex flex-wrap gap-2 border-t border-line-subtle pt-3">
              {actions}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
