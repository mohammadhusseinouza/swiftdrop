import { useState } from 'react';

import { Button } from '../../../../components/ui/Button';
import { FinancialCorrectionDialog } from '../../../../components/finance/FinancialCorrectionDialog';
import {
  releaseReversalSummary,
  reverseReleaseAvailability,
  voidCollectionAvailability,
  voidCollectionSummary,
  type CorrectionAvailability,
} from '../../../../components/finance/correctionActions';
import { usePermissions } from '../../../../features/auth/usePermissions';
import { useReverseFinancialReleaseMutation, useVoidReleaseCollectionMutation } from '../../../../services/financeApi';
import type { OrderDetail, OrderFinancialReleaseView } from '../../../../services/domain.types';

/**
 * FR.10.2 — the dedicated release corrections on Order Detail (finance.adjust).
 * Shown only when the release is eligible; a blocked case explains why. The
 * backend re-validates every condition inside its transaction.
 *
 * The open dialog works from a SNAPSHOT of the release taken when it opened:
 * a successful correction refreshes the release (making the action
 * ineligible), and the dialog must stay mounted — showing exactly what was
 * confirmed — until the user closes it.
 */
export function ReleaseCorrectionActions({ order, view }: { order: OrderDetail; view: OrderFinancialReleaseView }) {
  const permissions = usePermissions();
  const voidState = voidCollectionAvailability(view, permissions);
  const reverseState = reverseReleaseAvailability(view, permissions);
  const [open, setOpen] = useState<{ kind: 'void' | 'reverse'; view: OrderFinancialReleaseView } | null>(null);
  const [voidCollection] = useVoidReleaseCollectionMutation();
  const [reverseRelease] = useReverseFinancialReleaseMutation();

  const showActions = !!view.release && (voidState.kind !== 'HIDDEN' || reverseState.kind !== 'HIDDEN');
  if (!showActions && !open) return null;

  const snap = open?.view.release ?? null;
  const driverLabel = order.currentDriver?.driverNumber ?? '—';

  return (
    <div className="mt-4 space-y-2 border-t border-line pt-3">
      {showActions && (
        <>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Financial corrections</h3>
          <Action
            state={voidState}
            label="Void collection"
            description="For a collection recorded in error that no settlement has touched."
            onClick={() => setOpen({ kind: 'void', view })}
          />
          <Action
            state={reverseState}
            label="Reverse release"
            description="For released funds that were attributed in error."
            onClick={() => setOpen({ kind: 'reverse', view })}
          />
        </>
      )}

      {open?.kind === 'void' && snap && (
        <FinancialCorrectionDialog
          open
          title="Void collection"
          intro="Void the driver cash collection recorded for this order. Use this only when the collection was recorded in error and is not settled."
          {...dialogContent(voidCollectionSummary(open.view, { orderNumber: order.orderNumber, driverLabel }))}
          moneyLabels={['Collection amount', 'Currently settled (allocated)']}
          confirmLabel="Void collection"
          successMessage="The collection was voided. The release is now VOIDED; the delivery stays DELIVERED."
          onClose={() => setOpen(null)}
          onSubmit={(reason, idempotencyKey) =>
            voidCollection({
              releaseId: snap.id,
              reason,
              idempotencyKey,
              ctx: { orderId: order.id, driverId: order.currentDriver?.id ?? null, customerId: order.customer.id },
            }).unwrap()
          }
        />
      )}
      {open?.kind === 'reverse' && snap && (
        <FinancialCorrectionDialog
          open
          title="Reverse financial release"
          intro="Reverse the customer credit and company revenue this release posted."
          {...dialogContent(releaseReversalSummary(open.view, { orderNumber: order.orderNumber, customerName: order.customer.name }))}
          moneyLabels={['Released customer wallet credit', 'Released company product revenue', 'Released delivery-fee revenue']}
          confirmLabel="Reverse release"
          successMessage="The release was reversed. The release and the order now show Release reversed."
          onClose={() => setOpen(null)}
          onSubmit={(reason, idempotencyKey) =>
            reverseRelease({
              releaseId: snap.id,
              reason,
              idempotencyKey,
              ctx: { orderId: order.id, customerId: order.customer.id, settlementIds: snap.allocations.map((a) => a.settlement.id) },
            }).unwrap()
          }
        />
      )}
    </div>
  );
}

function dialogContent(s: { rows: { label: string; value: string }[]; consequences: string[]; warnings?: string[] }) {
  return { rows: s.rows, consequences: s.consequences, warnings: s.warnings ?? [] };
}

function Action({
  state,
  label,
  description,
  onClick,
}: {
  state: CorrectionAvailability;
  label: string;
  description: string;
  onClick: () => void;
}) {
  if (state.kind === 'HIDDEN') return null;
  return (
    <div className="flex flex-wrap items-start justify-between gap-2">
      <p className="min-w-0 flex-1 text-xs text-ink-muted">
        {state.kind === 'BLOCKED' ? <span className="text-warning-700">{state.reason}</span> : description}
      </p>
      <Button size="sm" variant="secondary" className="text-danger-700" disabled={state.kind === 'BLOCKED'} onClick={onClick}>
        {label}
      </Button>
    </div>
  );
}
