import type { ReactNode } from 'react';

import { Badge } from '../../../components/ui/Badge';
import { formatDateTime, formatMoney } from '../../../lib/format';
import {
  LEDGER_LABEL,
  ledgerTypeLabel,
} from '../../../components/finance/ledgerCorrection';
import type { FinanceTransactionEntry } from '../../../services/domain.types';

const LEDGER_TONE: Record<string, 'brand' | 'info' | 'neutral'> = {
  WALLET: 'brand',
  DRIVER_CASH: 'info',
  COMPANY_FINANCE: 'neutral',
};

export function MobileFinanceTransactionCard({
  tx,
  actions,
}: {
  tx: FinanceTransactionEntry;
  actions?: ReactNode;
}) {
  const reference =
    tx.order?.orderNumber ??
    tx.payout?.payoutNumber ??
    tx.settlement?.settlementNumber ??
    null;
  const party = tx.customer?.name ?? tx.driver?.name ?? null;

  return (
    <div className="rounded-card border border-line bg-card p-3 shadow-card">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={LEDGER_TONE[tx.ledger] ?? 'neutral'}>
              {LEDGER_LABEL[tx.ledger]}
            </Badge>
            <span className="text-sm font-medium text-ink">
              {ledgerTypeLabel(tx.type)}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-ink-muted">
            {[party, reference].filter(Boolean).join(' · ') || '—'}
          </p>
        </div>
        <span
          className={
            tx.direction === 'CREDIT'
              ? 'shrink-0 font-semibold tabular-nums text-success-700'
              : 'shrink-0 font-semibold tabular-nums text-danger-700'
          }
        >
          {tx.direction === 'CREDIT' ? '+' : '−'}
          {formatMoney(tx.amount)}
        </span>
      </div>
      <div className="mt-2 flex items-center justify-between gap-3 border-t border-line pt-2 text-xs text-ink-muted">
        <span>{formatDateTime(tx.createdAt)}</span>
        {actions}
      </div>
    </div>
  );
}
