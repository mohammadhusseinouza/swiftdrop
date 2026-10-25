import { Card } from '../ui/Card';
import { cn } from '../ui/cn';
import { formatMoney } from '../../lib/format';
import type { PendingBreakdown } from './financialRelease';

/**
 * FR.10 — the customer's pending (NOT withdrawable) money: Pending Delivery +
 * Pending Settlement = the backend total. Under-review collections are a
 * count only for customers; Management additionally sees the collected cash,
 * explicitly labelled as not customer funds (no split is approved yet).
 */
export function PendingBreakdownCard({
  breakdown,
  audience,
  underReviewCollectionAmount,
  className,
}: {
  breakdown: PendingBreakdown;
  audience: 'management' | 'customer';
  /** Management only — cash collected on differences awaiting review. */
  underReviewCollectionAmount?: string | null;
  className?: string;
}) {
  const customer = audience === 'customer';
  const reviewCount = breakdown.underReviewOrderCount;
  return (
    <Card className={cn('flex flex-col gap-3 bg-sunken/40', className)}>
      <div>
        <p className="text-xs font-medium uppercase tracking-wide text-ink-muted">
          {customer ? 'Pending' : 'Pending amount'}
        </p>
        <p className="mt-1.5 text-2xl font-semibold tracking-tight text-ink-secondary tabular-nums">
          {formatMoney(breakdown.totalPending)}
        </p>
        <p className="text-xs text-ink-muted">
          {customer ? 'Not available to withdraw yet.' : 'Not withdrawable — never part of the available balance.'}
        </p>
      </div>

      {breakdown.hasBreakdown && (
        <dl className="space-y-2 border-t border-line pt-2 text-sm">
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-secondary">Pending delivery</dt>
              <dd className="tabular-nums text-ink">{formatMoney(breakdown.pendingDelivery)}</dd>
            </div>
            <p className="text-xs text-ink-muted">
              {customer
                ? 'Your share of orders that are still on the way.'
                : 'Order value of active delivery-only orders (delivery fee excluded).'}
            </p>
          </div>
          <div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-secondary">Pending settlement</dt>
              <dd className="tabular-nums text-ink">{formatMoney(breakdown.pendingSettlement)}</dd>
            </div>
            <p className="text-xs text-ink-muted">
              {customer
                ? 'Your share of delivered orders. It becomes available once the courier hands the collected cash to the company.'
                : 'Approved customer amount of delivered orders whose cash the driver has not fully settled yet.'}
            </p>
          </div>
        </dl>
      )}

      {reviewCount > 0 && (
        <p className="rounded-control border border-warning-200 bg-warning-50 px-3 py-2 text-xs text-warning-700">
          {customer ? (
            <>
              {reviewCount} delivered {reviewCount === 1 ? 'order is' : 'orders are'} being reviewed because the amount
              collected differed from the expected amount. {reviewCount === 1 ? 'Its' : 'Their'} value is not included above
              until the review is complete.
            </>
          ) : (
            <>
              {reviewCount} delivered {reviewCount === 1 ? 'order' : 'orders'} under collection review
              {underReviewCollectionAmount ? <> ({formatMoney(underReviewCollectionAmount)} collected)</> : null}. Not
              included in pending and not customer funds until a split is approved.
            </>
          )}
        </p>
      )}
    </Card>
  );
}
