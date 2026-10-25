import { MetricTile } from '../../pages/management/dashboard/MetricTile';
import { formatMoney } from '../../lib/format';
import type { ReleaseActivity, SettlementReleaseSnapshot } from '../../services/domain.types';

/**
 * FR.10 — the settlement-based release position, shown on Finance, the
 * Financial report and the Dashboard. Three groups that must never be read as
 * one another:
 *   - Driver cash custody   — cash physically held by drivers (NOT revenue);
 *   - Awaiting release      — earned on delivery, posted only at settlement
 *                             (NOT yet in wallets or revenue);
 *   - Under review          — collected, split not approved (NOT customer funds).
 * Released activity (when given) is what DID post within the range. Every
 * figure is a backend value; nothing is derived here.
 */
export function SettlementReleasePanel({
  snapshot,
  activity,
  activityLabel,
  releasesCompletedToday,
  headingId,
}: {
  snapshot: SettlementReleaseSnapshot;
  activity?: ReleaseActivity | null;
  /** e.g. "in the selected range". */
  activityLabel?: string;
  /** Dashboard only — releases completed today (count). */
  releasesCompletedToday?: number;
  headingId?: string;
}) {
  const s = snapshot;
  const review = s.underReview;
  return (
    <div className="space-y-4" aria-labelledby={headingId}>
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Driver cash custody (current)</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <MetricTile label="Driver cash held" value={formatMoney(s.driverCashHeld)} hint="Physically held by drivers — not revenue" />
          <MetricTile
            label="Attributed to collections"
            value={formatMoney(s.attributedDriverCash)}
            hint="Reserved for outstanding settlement-mode collections"
          />
          <MetricTile
            label="Unattributed cash"
            value={formatMoney(s.unattributedDriverCash)}
            hint="Legacy collections, adjustments, corrections"
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Awaiting release (current)</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <MetricTile
            label="Customer funds pending settlement"
            value={formatMoney(s.customerFundsAwaitingSettlement)}
            hint={`${s.awaitingSettlementOrderCount} ${s.awaitingSettlementOrderCount === 1 ? 'order' : 'orders'} · not yet in customer wallets`}
          />
          <MetricTile
            label="Delivery fees awaiting release"
            value={formatMoney(s.companyDeliveryFeesAwaitingSettlement)}
            hint="Not yet company revenue"
          />
          <MetricTile
            label="Product revenue awaiting release"
            value={formatMoney(s.companyProductRevenueAwaitingSettlement)}
            hint="Company orders · not yet company revenue"
          />
        </div>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Collection differences under review (current)</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <MetricTile
            label="Orders under review"
            value={review.orderCount}
            hint={`${review.settlementModeOrderCount} on settlement-based release`}
          />
          <MetricTile
            label="Collected on reviewed orders"
            value={formatMoney(review.collectionAmount)}
            hint={`Split not approved — not customer funds or revenue (${formatMoney(review.settlementModeCollectionAmount)} on settlement-based release)`}
          />
        </div>
      </div>

      {(activity || releasesCompletedToday !== undefined) && (
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
            Released {activity ? activityLabel ?? '' : 'today'}
          </h3>
          {activity ? (
            <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile
                label="Releases completed"
                value={activity.releasesCompleted}
                hint={`${formatMoney(activity.releasedCollectionAmount)} of collections`}
              />
              <MetricTile label="Customer credits released" value={formatMoney(activity.releasedCustomerWalletCredits)} hint="Now in customer wallets" />
              <MetricTile label="Delivery-fee revenue released" value={formatMoney(activity.releasedDeliveryFeeRevenue)} hint="Now company revenue" />
              <MetricTile
                label="Product revenue released"
                value={formatMoney(activity.releasedCompanyProductRevenue)}
                hint={`${activity.releaseReversals} release reversal(s) · ${activity.collectionVoids} collection void(s)`}
              />
            </div>
          ) : (
            <div className="mt-2 grid gap-3 sm:grid-cols-3">
              <MetricTile label="Releases completed today" value={releasesCompletedToday ?? 0} hint="Settlement-mode orders posted today" />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
