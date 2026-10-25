import { Link } from 'react-router-dom';

import { Badge } from '../../../../components/ui/Badge';
import { LoadingState } from '../../../../components/feedback/LoadingState';
import { ErrorState } from '../../../../components/feedback/ErrorState';
import { StaleDataNotice } from '../../../../components/feedback/StaleDataNotice';
import { paths } from '../../../../routes/paths';
import { formatDateTime, formatMoney } from '../../../../lib/format';
import { useGetOrderFinancialReleaseQuery } from '../../../../services/ordersApi';
import { getApiErrorMessage, type UnknownApiError } from '../../../../services/apiError';
import type { OrderDetail, OrderFinancialReleaseView } from '../../../../services/domain.types';
import {
  collectionStateLabel,
  getFinancialStatusPresentation,
  getReleaseModePresentation,
  releaseCorrectionLabel,
  releaseStatusLabel,
  reviewStatusLabel,
  summarizeOrderRelease,
} from '../../../../components/finance/financialRelease';

import { DetailList, Section, type DetailRow } from './sections';
import { ReleaseCorrectionActions } from './ReleaseCorrectionActions';

/**
 * FR.10 — Order Detail "Financial release" panel (finance.read only; the
 * parent never renders it otherwise). The release itself is the dedicated
 * GET /orders/:id/financial-release sub-resource — fetched ONLY for
 * ON_SETTLEMENT orders; a legacy (NULL) or IMMEDIATE order has no release
 * and is described from OrderDetail alone. Operational status (DELIVERED) is
 * independent of everything shown here. FR.10.2: finance.adjust users get the
 * dedicated corrections (collection void, release reversal) when eligible.
 */
export function FinancialReleaseSection({
  order,
  canViewSettlements,
}: {
  order: OrderDetail;
  canViewSettlements: boolean;
}) {
  const settlementMode = order.financialReleaseMode === 'ON_SETTLEMENT';
  const query = useGetOrderFinancialReleaseQuery(order.id, { skip: !settlementMode });

  if (!order.deliveredAt && order.financialReleaseMode == null) return null;

  if (!settlementMode) {
    const view: OrderFinancialReleaseView = {
      orderId: order.id,
      financialReleaseMode: order.financialReleaseMode,
      financialStatus: order.financialStatus,
      release: null,
    };
    return (
      <Section title="Financial release">
        <ReleaseView view={view} canViewSettlements={canViewSettlements} />
      </Section>
    );
  }

  return (
    <Section title="Financial release">
      {query.isLoading ? (
        <LoadingState className="py-6" label="Loading financial release…" />
      ) : !query.data ? (
        <ErrorState
          className="py-6"
          title="Could not load the financial release"
          message={getApiErrorMessage(query.error as UnknownApiError)}
          onRetry={() => void query.refetch()}
        />
      ) : (
        <>
          {query.isError && <StaleDataNotice className="mb-3" onRetry={() => void query.refetch()} />}
          <ReleaseView view={query.data} canViewSettlements={canViewSettlements} />
          <ReleaseCorrectionActions order={order} view={query.data} />
        </>
      )}
    </Section>
  );
}

function ReleaseView({ view, canViewSettlements }: { view: OrderFinancialReleaseView; canViewSettlements: boolean }) {
  const summary = summarizeOrderRelease(view);
  const mode = getReleaseModePresentation(view.financialReleaseMode);
  const status = getFinancialStatusPresentation(view.financialStatus);
  const r = view.release;

  const head = (
    <div className="mb-3 flex flex-wrap items-center gap-1.5">
      <Badge tone={mode.tone}>{mode.label}</Badge>
      <Badge tone={status.tone}>{status.label}</Badge>
    </div>
  );

  if (!r) {
    return (
      <>
        {head}
        <p className="text-sm text-ink-secondary">{summary.headline}</p>
        <p className="mt-1 text-xs text-ink-muted">{mode.description}</p>
      </>
    );
  }

  const release = releaseStatusLabel(r.releaseStatus);
  const review = reviewStatusLabel(r.reviewStatus);
  const state = collectionStateLabel(r.settlementState);
  const settlementRef = (s: { id: string; settlementNumber: string }) =>
    canViewSettlements ? (
      <Link to={paths.management.driverSettlementDetail(s.id)} className="text-brand-600 hover:underline">
        {s.settlementNumber}
      </Link>
    ) : (
      s.settlementNumber
    );

  const rows: DetailRow[] = [
    {
      label: 'Release status',
      value: (
        <span className="flex flex-wrap gap-1">
          <Badge tone={release.tone}>{release.label}</Badge>
          {review && <Badge tone={review.tone}>{review.label}</Badge>}
        </span>
      ),
    },
    { label: 'Collection', value: <Badge tone={state.tone}>{state.label}</Badge> },
    { label: 'Collected by the driver', value: <span className="tabular-nums">{formatMoney(r.collectionAmount)}</span> },
    { label: 'Settled by the driver', value: <span className="tabular-nums">{formatMoney(r.allocatedAmount)}</span> },
    { label: 'Outstanding', value: <span className="font-semibold tabular-nums">{formatMoney(r.outstandingAmount)}</span> },
    { label: 'Delivered', value: formatDateTime(r.deliveredAt) },
  ];

  if (summary.plannedSplitKnown) {
    rows.push(
      { label: 'Customer wallet (planned)', value: <span className="tabular-nums">{formatMoney(r.plannedCustomerWalletAmount)}</span> },
      { label: 'Company product (planned)', value: <span className="tabular-nums">{formatMoney(r.plannedCompanyProductAmount)}</span> },
      { label: 'Delivery fee (planned)', value: <span className="tabular-nums">{formatMoney(r.plannedCompanyFeeAmount)}</span> },
    );
  } else {
    rows.push({
      label: 'Planned split',
      value: <span className="text-ink-muted">Not decided — the collection difference must be resolved first.</span>,
      wide: true,
    });
  }

  if (r.releasedAt) {
    rows.push({
      label: 'Released',
      value: (
        <span>
          {formatDateTime(r.releasedAt)}
          {r.releaseTrigger === 'RESOLUTION' && ' · by difference resolution'}
          {r.releasedBySettlement && <> · by {settlementRef(r.releasedBySettlement)}</>}
          {r.releasedBy && ` · ${r.releasedBy.firstName} ${r.releasedBy.lastName}`}
        </span>
      ),
      wide: true,
    });
  }

  return (
    <>
      {head}
      <p className="mb-3 text-sm text-ink-secondary">{summary.headline}</p>
      {/* A void reverses the collection by design (shown as the correction
          below); the flag only signals a pre-FR.6 generic reversal otherwise. */}
      {r.collectionReversed && r.releaseStatus !== 'VOIDED' && (
        <p className="mb-3 rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-xs text-danger-700">
          The driver cash collection for this order was reversed by an earlier generic correction.
        </p>
      )}
      <DetailList rows={rows} />

      <h3 className="mt-4 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Settlements</h3>
      {r.allocations.length === 0 ? (
        <p className="mt-1 text-sm text-ink-muted">Not yet allocated by any settlement.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line-subtle rounded-control border border-line-subtle text-sm">
          {r.allocations.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
              <span>
                {settlementRef(a.settlement)}
                <span className="text-xs text-ink-muted"> · {formatDateTime(a.settlement.createdAt)}</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="tabular-nums">{formatMoney(a.amount)}</span>
                {a.status === 'REVERSED' && <Badge tone="danger">Reversed</Badge>}
              </span>
            </li>
          ))}
        </ul>
      )}

      {r.correction && (
        <div className="mt-4 rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm">
          <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Correction history</p>
          <p className="mt-1 font-medium text-ink">{releaseCorrectionLabel(r.correction.correctionType)}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            Resulting state: {release.label} · order {status.label.toLowerCase()}
          </p>
          <p className="mt-0.5 text-ink-secondary">{r.correction.reason}</p>
          <p className="mt-0.5 text-xs text-ink-muted">
            {r.correction.createdBy.firstName} {r.correction.createdBy.lastName} · {formatDateTime(r.correction.createdAt)}
          </p>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-muted">
        Read-only. Amounts come from the server; corrections are recorded through the dedicated Finance workflow.
      </p>
    </>
  );
}
