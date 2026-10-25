import { useState } from 'react';

import { Button } from '../../../components/ui/Button';
import { FinancialCorrectionDialog } from '../../../components/finance/FinancialCorrectionDialog';
import {
  settlementReversalConsequences,
  settlementReversalPlan,
} from '../../../components/finance/correctionActions';
import { formatMoney } from '../../../lib/format';
import { usePermissions } from '../../../features/auth/usePermissions';
import { useReverseSettlementMutation, type SettlementDetail } from '../../../services/settlementsApi';

/**
 * FR.10.2 — "Reverse settlement" on Settlement Detail (finance.adjust).
 * Not offered when the backend's own data shows released funds, a shortfall
 * or a prior reversal; the reason is shown instead. The server re-validates
 * everything. The settlement SHORTFALL action is intentionally not offered
 * (withheld in FR.10.2 — business authorization review still open).
 */
export function SettlementReversalAction({ detail }: { detail: SettlementDetail }) {
  const permissions = usePermissions();
  const plan = settlementReversalPlan(detail, permissions);
  // Snapshot taken when the dialog opens: a successful reversal refreshes the
  // detail (allocations become REVERSED), and the dialog must keep showing
  // exactly what was confirmed until it is closed.
  const [snapshot, setSnapshot] = useState<{ detail: SettlementDetail; plan: ReturnType<typeof settlementReversalPlan> } | null>(null);
  const [reverse] = useReverseSettlementMutation();

  if (plan.availability.kind === 'HIDDEN' && !snapshot) return null;
  const snap = snapshot?.detail ?? detail;
  const snapPlan = snapshot?.plan ?? plan;
  const driver = `${snap.driver.user.firstName} ${snap.driver.user.lastName} · ${snap.driver.driverNumber}`;

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        variant="secondary"
        className="text-danger-700"
        disabled={plan.availability.kind === 'BLOCKED'}
        onClick={() => setSnapshot({ detail, plan })}
      >
        Reverse settlement
      </Button>
      {plan.availability.kind === 'BLOCKED' && (
        <span className="max-w-xs text-right text-xs text-warning-700">{plan.availability.reason}</span>
      )}

      {snapshot && (
        <FinancialCorrectionDialog
          open
          title="Reverse settlement"
          intro="Use this only when the settlement did not happen or was recorded in error."
          rows={[
            { label: 'Settlement', value: snap.settlementNumber },
            { label: 'Driver', value: driver },
            { label: 'Amount received', value: snap.amountReceived },
            { label: 'Allocations affected', value: String(snapPlan.affected.length) },
            { label: 'Releases already triggered', value: snap.releasedOrders.length === 0 ? 'None' : String(snap.releasedOrders.length) },
          ]}
          moneyLabels={['Amount received']}
          details={
            snapPlan.affected.length > 0 ? (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Collections whose settled amount decreases</p>
                <ul className="mt-1 divide-y divide-line-subtle rounded-control border border-line-subtle text-sm">
                  {snapPlan.affected.map((a) => (
                    <li key={a.releaseId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                      <span className="font-medium text-ink">{a.orderNumber}</span>
                      <span className="tabular-nums text-ink-secondary">
                        −{formatMoney(a.amount)} · settled {formatMoney(a.settledNow)} → {formatMoney(a.settledAfter)} of {formatMoney(a.collection)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null
          }
          consequences={settlementReversalConsequences(snap)}
          confirmLabel="Reverse settlement"
          successMessage="The settlement was reversed. Driver cash was credited back and its allocations are now reversed."
          onClose={() => setSnapshot(null)}
          onSubmit={(reason, idempotencyKey) =>
            reverse({
              settlementId: snap.id,
              reason,
              idempotencyKey,
              ctx: { driverId: snap.driver.id, orderIds: snap.allocations.map((a) => a.order.id) },
            }).unwrap()
          }
        />
      )}
    </div>
  );
}
