import type { ReverseActionState } from './ledgerCorrection';

/**
 * FR.10 closure / FR.10.1 — the reversal control of one ledger row, shared by every
 * ledger table and mobile card so desktop and mobile always agree. A row the
 * backend marks as dedicated-workflow-only, already reversed or otherwise
 * ineligible shows a non-actionable explanation
 * instead of Reverse; the row itself is never hidden.
 */
export function ReverseRowAction({ state, onReverse }: { state: ReverseActionState; onReverse: () => void }) {
  if (state.kind === 'NONE') return null;
  if (state.kind === 'DEDICATED') {
    return <span className="text-xs text-warning-700">{state.label}</span>;
  }
  if (state.kind === 'INFO') {
    return <span className="text-xs text-ink-muted">{state.label}</span>;
  }
  return (
    <button
      type="button"
      onClick={onReverse}
      className="rounded-control px-2 py-1 text-xs font-medium text-danger-700 hover:bg-danger-50"
    >
      Reverse
    </button>
  );
}
