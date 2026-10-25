import { Link, useParams } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';

import { usePermissions } from '../../../features/auth/usePermissions';
import { paths } from '../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../lib/format';
import { MD_QUERY, useMediaQuery } from '../../../lib/useMediaQuery';
import { useGetSettlementQuery, type SettlementAllocationDetail } from '../../../services/settlementsApi';
import {
  getApiErrorCode,
  getApiErrorMessage,
  getApiErrorStatus,
  type UnknownApiError,
} from '../../../services/apiError';

import { PageHeader } from '../../../components/data-display/PageHeader';
import { StatisticCard } from '../../../components/data-display/StatisticCard';
import { Card } from '../../../components/ui/Card';
import { Badge } from '../../../components/ui/Badge';
import { OrderTypeBadge } from '../../../components/orders/OrderTypeBadge';
import { LoadingState } from '../../../components/feedback/LoadingState';
import { ErrorState } from '../../../components/feedback/ErrorState';
import { StaleDataNotice } from '../../../components/feedback/StaleDataNotice';
import { EmptyState } from '../../../components/feedback/EmptyState';
import { SettlementReversalAction } from './SettlementReversalAction';

import {
  collectionStateLabel,
  correctionResultLabel,
  correctionTypeLabel,
  describeSettlementDetail,
  releaseStatusLabel,
  reviewStatusLabel,
  settlementCapabilities,
} from './settlementPresentation';

/**
 * FR.9 — Settlement detail (`GET /driver-settlements/:id`, settlements.read).
 * Read-only: allocations per order with the amount this settlement allocated
 * and the CURRENT state of each collection, releases this settlement
 * triggered, the unattributed amount and reason, and recorded corrections.
 * Correction actions (reverse / shortfall) are a separate workflow and are
 * not offered here.
 */
export default function SettlementDetailPage() {
  const { id = '' } = useParams<{ id: string }>();
  const isDesktop = useMediaQuery(MD_QUERY);
  const caps = settlementCapabilities(usePermissions());
  const query = useGetSettlementQuery(id, { skip: !id });
  const s = query.data;

  if (!id || (query.isError && !s)) {
    const status = getApiErrorStatus(query.error);
    const notFound = !id || status === 404 || getApiErrorCode(query.error) === 'NOT_FOUND' || status === 400;
    return (
      <div className="mx-auto max-w-2xl">
        <BackLink />
        <ErrorState
          className="py-16"
          title={notFound ? 'Settlement not found' : 'Could not load this settlement'}
          message={
            notFound
              ? 'This settlement does not exist or the reference is not valid.'
              : getApiErrorMessage(query.error as UnknownApiError)
          }
          onRetry={notFound ? undefined : () => void query.refetch()}
        />
      </div>
    );
  }

  if (query.isLoading || !s) {
    return (
      <div className="space-y-5">
        <BackLink />
        <PageHeader title="Settlement" size="lg" />
        <LoadingState className="py-16" label="Loading settlement…" />
      </div>
    );
  }

  const summary = describeSettlementDetail(s);
  const driverName = `${s.driver.user.firstName} ${s.driver.user.lastName}`;

  return (
    <div className="space-y-5 pb-6">
      <BackLink />
      {query.isError && <StaleDataNotice onRetry={() => void query.refetch()} />}

      <PageHeader
        size="lg"
        title={s.settlementNumber}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{formatDateTime(s.createdAt)}</span>
            <span aria-hidden="true" className="text-ink-subtle">·</span>
            {caps.canViewDriver ? (
              <Link to={paths.management.driverDetail(s.driver.id)} className="text-brand-600 hover:underline">
                {driverName} · {s.driver.driverNumber}
              </Link>
            ) : (
              <span>{driverName} · {s.driver.driverNumber}</span>
            )}
            <Badge tone={summary.isLegacy ? 'neutral' : 'brand'}>
              {summary.isLegacy ? 'Legacy settlement' : 'Allocation settlement'}
            </Badge>
            {s.reversed && <Badge tone="danger">Reversed</Badge>}
          </span>
        }
        actions={<SettlementReversalAction detail={s} />}
      />

      {summary.notices.length > 0 && (
        <div className="space-y-2">
          {summary.notices.map((n) => (
            <p key={n} className="rounded-card border border-line bg-sunken px-4 py-2.5 text-sm text-ink-secondary">
              {n}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <StatisticCard label="Amount received" value={formatMoney(s.amountReceived)} supportingText={s.paymentMethod.name} />
        <StatisticCard
          label="Allocated to orders"
          value={summary.isLegacy ? '—' : formatMoney(s.allocatedTotal)}
          supportingText={
            summary.isLegacy
              ? 'Not applicable to legacy settlements'
              : `${s.collectionsFullySettled} fully · ${s.collectionsPartiallySettled} partially settled now`
          }
        />
        <StatisticCard
          label="Unattributed"
          value={summary.isLegacy ? '—' : formatMoney(s.unattributedAmount)}
          supportingText={summary.isLegacy ? 'Not applicable to legacy settlements' : 'Not reserved for any order'}
        />
        <StatisticCard
          label="Driver cash"
          value={formatMoney(s.balanceAfter)}
          supportingText={`Before: ${formatMoney(s.balanceBefore)}`}
        />
      </div>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Details</h2>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Detail label="Payment method" value={s.paymentMethod.name} />
          <Detail label="Received by" value={`${s.receivedBy.firstName} ${s.receivedBy.lastName}`} />
          <Detail label="Recorded" value={formatDateTime(s.createdAt)} />
          {!/^0+(\.0+)?$/.test(s.shortfallTotal) && (
            <Detail label="Recorded shortfall" value={formatMoney(s.shortfallTotal)} />
          )}
          {s.notes && <Detail label="Notes" value={s.notes} wide />}
          {summary.hasUnattributed && s.unattributedReason && (
            <Detail label="Unattributed reason" value={s.unattributedReason} wide />
          )}
        </dl>
      </Card>

      {!summary.isLegacy && (
        <section aria-labelledby="allocations-heading" className="space-y-2">
          <h2 id="allocations-heading" className="text-base font-semibold text-ink">
            Allocations{' '}
            <span className="font-normal text-ink-muted">
              ({summary.activeAllocationCount} active
              {summary.reversedAllocationCount > 0 ? `, ${summary.reversedAllocationCount} reversed` : ''})
            </span>
          </h2>
          <p className="text-xs text-ink-muted">
            Collection figures show each collection&rsquo;s current state — a
            later settlement or correction may have changed it since.
          </p>
          {s.allocations.length === 0 ? (
            <Card flush>
              <EmptyState className="py-10" title="No collections were allocated." description="This settlement recorded unattributed cash only." />
            </Card>
          ) : isDesktop ? (
            <Card flush className="overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Settlement allocations</caption>
                <thead className="bg-sunken text-left text-xs text-ink-muted">
                  <tr>
                    <th scope="col" className="px-4 py-2">Order</th>
                    <th scope="col" className="px-4 py-2">Customer</th>
                    <th scope="col" className="px-4 py-2 text-right">Allocated here</th>
                    <th scope="col" className="px-4 py-2 text-right">Collection settled</th>
                    <th scope="col" className="px-4 py-2">State</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-subtle">
                  {s.allocations.map((a) => (
                    <tr key={a.id}>
                      <td className="px-4 py-2.5 align-top">
                        <OrderRef allocation={a} canViewOrders={caps.canViewOrders} />
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <span className="block">{a.customer.name}</span>
                        <OrderTypeBadge orderType={a.orderType} className="mt-0.5" />
                      </td>
                      <td className="px-4 py-2.5 text-right align-top font-medium tabular-nums">{formatMoney(a.amount)}</td>
                      <td className="px-4 py-2.5 text-right align-top tabular-nums text-ink-muted">
                        {formatMoney(a.collection.allocatedAmount)} of {formatMoney(a.collection.collectionAmount)}
                      </td>
                      <td className="px-4 py-2.5 align-top">
                        <AllocationBadges allocation={a} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          ) : (
            <ul className="space-y-2">
              {s.allocations.map((a) => (
                <li key={a.id} className="rounded-card border border-line bg-card p-3 shadow-card">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <OrderRef allocation={a} canViewOrders={caps.canViewOrders} />
                      <p className="truncate text-xs text-ink-muted">{a.customer.name}</p>
                    </div>
                    <p className="text-right font-semibold tabular-nums text-ink">{formatMoney(a.amount)}</p>
                  </div>
                  <p className="mt-1 text-xs text-ink-muted">
                    Collection settled {formatMoney(a.collection.allocatedAmount)} of {formatMoney(a.collection.collectionAmount)}
                  </p>
                  <div className="mt-2">
                    <AllocationBadges allocation={a} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {!summary.isLegacy && (
        <section aria-labelledby="released-heading" className="space-y-2">
          <h2 id="released-heading" className="text-base font-semibold text-ink">
            Releases triggered <span className="font-normal text-ink-muted">({summary.releasedCount})</span>
          </h2>
          {s.releasedOrders.length === 0 ? (
            <p className="text-sm text-ink-muted">This settlement did not release any order.</p>
          ) : (
            <ul className="divide-y divide-line-subtle rounded-card border border-line bg-card text-sm">
              {s.releasedOrders.map((r) => (
                <li key={r.releaseId} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5">
                  {caps.canViewOrders ? (
                    <Link to={paths.management.orderDetail(r.order.id)} className="font-medium text-brand-600 hover:underline">
                      {r.order.orderNumber}
                    </Link>
                  ) : (
                    <span className="font-medium">{r.order.orderNumber}</span>
                  )}
                  <span className="text-xs text-ink-muted">Released {formatDateTime(r.releasedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {summary.hasCorrections && (
        <section aria-labelledby="corrections-heading" className="space-y-2">
          <h2 id="corrections-heading" className="text-base font-semibold text-ink">Correction history</h2>
          <ul className="space-y-2">
            {s.corrections.map((c) => (
              <li key={c.id} className="rounded-card border border-line bg-card px-4 py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium text-ink">{correctionTypeLabel(c.correctionType)}</span>
                  <span className="tabular-nums text-ink">{formatMoney(c.amount)}</span>
                </div>
                <p className="mt-1 text-ink-secondary">{c.reason}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {c.createdBy.firstName} {c.createdBy.lastName} · {formatDateTime(c.createdAt)} · settlement {s.settlementNumber}
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">Resulting state: {correctionResultLabel(c.correctionType)}</p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function OrderRef({ allocation, canViewOrders }: { allocation: SettlementAllocationDetail; canViewOrders: boolean }) {
  return canViewOrders ? (
    <Link to={paths.management.orderDetail(allocation.order.id)} className="font-medium text-brand-600 hover:underline">
      {allocation.order.orderNumber}
    </Link>
  ) : (
    <span className="font-medium text-ink">{allocation.order.orderNumber}</span>
  );
}

function AllocationBadges({ allocation }: { allocation: SettlementAllocationDetail }) {
  const state = collectionStateLabel(allocation.collection.settlementState);
  const release = releaseStatusLabel(allocation.collection.releaseStatus);
  const review = reviewStatusLabel(allocation.collection.reviewStatus);
  return (
    <span className="flex flex-wrap gap-1">
      {allocation.status === 'REVERSED' && <Badge tone="danger">Allocation reversed</Badge>}
      {allocation.releasedByThisSettlement && <Badge tone="success">Released by this settlement</Badge>}
      <Badge tone={state.tone}>{state.label}</Badge>
      <Badge tone={release.tone}>{release.label}</Badge>
      {review && <Badge tone={review.tone}>{review.label}</Badge>}
    </span>
  );
}

function Detail({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="whitespace-pre-line text-ink">{value}</dd>
    </div>
  );
}

function BackLink() {
  return (
    <Link
      to={paths.management.driverSettlements}
      className="inline-flex items-center gap-1 text-sm text-ink-muted hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      Back to Driver Settlements
    </Link>
  );
}
