import type { ReactNode } from 'react';

import { formatDateTime, formatMoney, humanizeToken } from '../../../../lib/format';
import { Card } from '../../../../components/ui/Card';
import { cn } from '../../../../components/ui/cn';
import type { LedgerRowSummary, ReconciliationDetail } from '../../../../services/historicalReconciliation.types';
import { driverLabel, failureMessage } from './historicalReconciliationModel';

/**
 * FR.12A.6 — the evidence of one historical reconciliation, exactly as the
 * server derived and validated it. Used by the detail page AND the Finance
 * approval review, so the reviewer inspects the same presentation. Every
 * figure is a server value: nothing is computed here. Ids are shown in full
 * (monospace) so they can be checked against the investigation queries; no
 * customer or receiver data exists in this record.
 */

function Row({ label, value, mono, wide }: { label: string; value: ReactNode; mono?: boolean; wide?: boolean }) {
  return (
    <div className={cn('min-w-0', wide && 'sm:col-span-2')}>
      <dt className="text-xs text-ink-muted">{label}</dt>
      <dd className={cn('mt-0.5 break-all text-sm text-ink', mono && 'font-mono text-xs')}>{value}</dd>
    </div>
  );
}

function LedgerRow({ title, row, fallback }: { title: string; row: LedgerRowSummary | null; fallback: string }) {
  return (
    <div className="rounded-control border border-line-subtle p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</p>
      {row ? (
        <dl className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Row label="Ledger row" value={row.id} mono wide />
          <Row label="Type · amount" value={`${humanizeToken(row.type)} · ${formatMoney(row.amount)}`} />
          <Row label="Recorded" value={formatDateTime(row.recordedAt)} />
          <Row label="Balance before" value={formatMoney(row.balanceBefore)} />
          <Row label="Balance after" value={formatMoney(row.balanceAfter)} />
        </dl>
      ) : (
        <p className="mt-2 text-sm text-ink-secondary">{fallback}</p>
      )}
    </div>
  );
}

export function ReconciliationEvidencePanel({ detail }: { detail: ReconciliationDetail }) {
  const e = detail.evidence;
  const c = detail.evidenceContext;
  return (
    <div className="space-y-4">
      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Missing collection (from the surviving audit)</h2>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Row label="Missing collection amount" value={<span className="text-base font-semibold tabular-nums">{formatMoney(e.amount)}</span>} />
          <Row label="Expected collection" value={formatMoney(e.expectedAmount)} />
          <Row label="Actual collection" value={formatMoney(e.actualAmount)} />
          <Row label="Collection difference" value={formatMoney(e.collectionDifference)} />
          <Row label="Order type" value={humanizeToken(e.orderType)} />
          <Row label="Located ledger gap" value={formatMoney(e.observedJump)} />
          <Row label="Deleted order (reference)" value={e.deletedOrderReference} mono wide />
          <Row label="Missing cash row (reference)" value={e.missingTransactionId} mono wide />
        </dl>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Original audit reference</h2>
        {c.sourceAudit ? (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Row label="Audit record" value={c.sourceAudit.id} mono wide />
            <Row label="Action" value={c.sourceAudit.action} />
            <Row label="Recorded" value={formatDateTime(c.sourceAudit.recordedAt)} />
          </dl>
        ) : (
          <p className="text-sm text-danger-700">The cited audit record no longer exists — the evidence is invalid.</p>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Driver cash account and surviving ledger rows</h2>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Row label="Driver" value={driverLabel(detail.driver)} />
          <Row label="Driver cash account" value={e.accountId} mono />
        </dl>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <LedgerRow
            title="Last row before the gap"
            row={c.predecessorTransaction}
            fallback={e.predecessorTransactionId ? 'The cited row no longer exists — the evidence is invalid.' : 'None — the gap is at the start of the ledger.'}
          />
          <LedgerRow title="First row after the gap (anchor)" row={c.anchorTransaction} fallback="The cited row no longer exists — the evidence is invalid." />
        </div>
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Related settlement</h2>
        {c.relatedSettlement ? (
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Row label="Settlement" value={c.relatedSettlement.settlementNumber} />
            <Row label="Amount received" value={formatMoney(c.relatedSettlement.amountReceived)} />
            <Row label="Driver cash before → after" value={`${formatMoney(c.relatedSettlement.balanceBefore)} → ${formatMoney(c.relatedSettlement.balanceAfter)}`} />
            <Row label="Recorded" value={formatDateTime(c.relatedSettlement.recordedAt)} />
          </dl>
        ) : (
          <p className="text-sm text-ink-secondary">No settlement is cited.</p>
        )}
      </Card>

      <Card className="space-y-3">
        <h2 className="text-sm font-semibold text-ink">Evidence validation (V1–V7, evaluated now)</h2>
        {detail.failures.length === 0 ? (
          <p className="rounded-control border border-success-200 bg-success-50 px-3 py-2 text-sm text-success-700">Every evidence check currently passes.</p>
        ) : (
          <ul className="space-y-1 rounded-control border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-700">
            {detail.failures.map((f) => (
              <li key={f}>
                <span className="font-mono text-xs">{f}</span> — {failureMessage(f)}
              </li>
            ))}
          </ul>
        )}
        <Row label="Evidence fingerprint (SHA-256)" value={e.evidenceDigest} mono />
      </Card>
    </div>
  );
}
