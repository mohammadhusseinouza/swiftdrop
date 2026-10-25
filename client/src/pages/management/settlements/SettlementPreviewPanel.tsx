import { cn } from '../../../components/ui/cn';
import { Badge } from '../../../components/ui/Badge';
import { formatMoney } from '../../../lib/format';

import type { PreviewRow, SettlementPreview } from './settlementAllocation';
import { ALLOCATION_ROW_STATUS } from './settlementPresentation';

/**
 * FR.9 — the PROVISIONAL settlement preview shown before submission. Expected
 * releases sum only the backend-approved planned amounts of collections this
 * settlement makes fully settled with review not pending; nothing here is
 * final until the server confirms the settlement.
 */
export function SettlementPreviewPanel({
  preview,
  driverLabel,
  methodName,
  notes,
  dataAsOf,
}: {
  preview: SettlementPreview;
  driverLabel: string;
  methodName: string;
  notes: string;
  dataAsOf: string | null;
}) {
  const releasing = preview.willRelease.length > 0;
  return (
    <div className="space-y-4">
      <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle">
        <Row label="Driver" value={driverLabel} />
        <Row label="Total amount received" value={formatMoney(preview.amountReceived)} emphasis />
        <Row label="Allocated to orders" value={formatMoney(preview.allocated)} />
        <Row label="Unattributed" value={formatMoney(preview.unattributed)} />
        <Row label="Payment method" value={methodName || '—'} />
        {notes && <Row label="Notes" value={notes} />}
        {preview.cashAfter !== null && (
          <Row label="Driver cash after settlement" value={formatMoney(preview.cashAfter)} />
        )}
      </dl>

      <PreviewGroup
        title="Will become fully settled and release"
        rows={preview.willRelease}
        empty="No collection is released by this settlement."
      />
      <PreviewGroup
        title="Fully settled, release waits for the difference review"
        rows={preview.awaitingReview}
        hint="These collections are settled now; their customer/company split is decided when the collection difference is resolved."
      />
      <PreviewGroup
        title="Remains partially settled"
        rows={preview.partial}
        showOutstandingAfter
      />
      {preview.missingPlannedSplit.length > 0 && (
        <PreviewGroup
          title="Will settle — release amounts not available"
          rows={preview.missingPlannedSplit}
          hint="The server did not provide an approved split for these collections, so they are left out of the expected amounts below."
        />
      )}

      <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">
          Expected releases (approved planned amounts)
        </p>
        <dl className="mt-1.5 grid grid-cols-1 gap-2 text-sm sm:grid-cols-3">
          <Figure label="Customer wallet credits" value={preview.expectedWalletCredit} />
          <Figure label="Company product revenue" value={preview.expectedProductRevenue} />
          <Figure label="Delivery-fee revenue" value={preview.expectedDeliveryFee} />
        </dl>
        {!releasing && (
          <p className="mt-1.5 text-xs text-ink-muted">
            Nothing is released: this settlement only reduces driver cash.
          </p>
        )}
      </div>

      <p className="text-xs text-ink-muted">
        <strong>Provisional preview.</strong> The server re-validates every
        allocation, the driver&rsquo;s cash and the unattributed limit when the
        settlement is processed; the result it returns is final.
        {dataAsOf ? ` Collections as loaded at ${dataAsOf}.` : ''} A settlement
        never debits a customer wallet — it only releases money already earned
        on fully settled collections.
      </p>
    </div>
  );
}

function PreviewGroup({
  title,
  rows,
  empty,
  hint,
  showOutstandingAfter,
}: {
  title: string;
  rows: PreviewRow[];
  empty?: string;
  hint?: string;
  showOutstandingAfter?: boolean;
}) {
  if (rows.length === 0 && !empty) return null;
  return (
    <section aria-label={title} className="space-y-1.5">
      <h3 className="text-sm font-semibold text-ink">
        {title} <span className="font-normal text-ink-muted">({rows.length})</span>
      </h3>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
      {rows.length === 0 ? (
        <p className="text-xs text-ink-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line-subtle rounded-control border border-line-subtle text-sm">
          {rows.map((r) => {
            const status = ALLOCATION_ROW_STATUS[r.status];
            return (
              <li key={r.releaseId} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-0">
                  <span className="font-medium text-ink">{r.orderNumber}</span>
                  <span className="text-ink-muted"> · {r.customerName}</span>
                </span>
                <span className="flex items-center gap-2">
                  <span className="tabular-nums text-ink">{formatMoney(r.amount)}</span>
                  {showOutstandingAfter && (
                    <span className="text-xs tabular-nums text-ink-muted">
                      {formatMoney(r.outstandingAfter)} left
                    </span>
                  )}
                  <Badge tone={status.tone}>{status.label}</Badge>
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Row({ label, value, emphasis }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <div className="flex justify-between gap-4 px-3 py-2 text-sm">
      <dt className="text-ink-muted">{label}</dt>
      <dd className={cn('text-right', emphasis ? 'font-semibold tabular-nums text-ink' : 'font-medium text-ink-secondary')}>
        {value}
      </dd>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className="font-semibold tabular-nums text-ink">{formatMoney(value)}</dd>
    </div>
  );
}
