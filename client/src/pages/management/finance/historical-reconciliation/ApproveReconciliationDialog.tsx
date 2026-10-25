import { useEffect, useRef, useState } from 'react';

import { Button } from '../../../../components/ui/Button';
import { formatMoney } from '../../../../lib/format';
import type { UnknownApiError } from '../../../../services/apiError';
import type { ReconciliationDetail } from '../../../../services/historicalReconciliation.types';
import {
  INITIAL_IDEMPOTENCY_STATE,
  afterFailure,
  afterSuccess,
  generateIdempotencyKey,
  resolveIdempotencyKey,
  type IdempotencyState,
} from '../../settlements/settlementSubmission';
import {
  EVIDENCE_ONLY_NOTICE,
  OWNERSHIP_NOTICE,
  acknowledge,
  afterApprovalFailure,
  afterApprovalSuccess,
  approvalBody,
  canSubmitApproval,
  classifyWorkflowError,
  reviewIsStale,
  startReview,
  workflowErrorMessage,
  type ApprovalReview,
} from './historicalReconciliationModel';
import { ReconciliationEvidencePanel } from './ReconciliationEvidencePanel';
import { DialogMessage, ReconciliationDialogShell } from './ReconciliationDialogShell';

/**
 * FR.12A.6 — independent Finance approval.
 *
 * The reviewer inspects a SNAPSHOT of the evidence captured when the review
 * starts and must acknowledge that approval is evidence-only. The request
 * carries that snapshot's fingerprint — never one fetched just before
 * submitting. If the server answers STALE_EVIDENCE_DIGEST, invalid evidence
 * or a changed state, nothing is approved: the evidence is refreshed and the
 * reviewer must explicitly start a new review (new snapshot, new
 * acknowledgment, new request key). There is no automatic retry.
 */
export function ApproveReconciliationDialog({
  open,
  latest,
  onSubmit,
  onRefresh,
  onClose,
}: {
  open: boolean;
  /** The page's current server data (kept fresh by RTK Query). */
  latest: ReconciliationDetail;
  onSubmit: (evidenceDigest: string, idempotencyKey: string) => Promise<unknown>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ReconciliationDetail>(latest);
  const [review, setReview] = useState<ApprovalReview>(() => startReview(latest));
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const idemRef = useRef<IdempotencyState>(INITIAL_IDEMPOTENCY_STATE);
  const submittingRef = useRef(false);

  const begin = (d: ReconciliationDetail) => {
    setSnapshot(d);
    setReview(startReview(d));
    idemRef.current = INITIAL_IDEMPOTENCY_STATE;
  };

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      begin(latest);
      setMessage(null);
    }
    wasOpen.current = open;
    // Only on opening: later server data never silently replaces the snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const stale = review.phase === 'reviewing' && reviewIsStale(review, latest);

  const submit = async () => {
    if (submittingRef.current || !canSubmitApproval(review, latest)) return;
    const body = approvalBody(review);
    const resolution = resolveIdempotencyKey(idemRef.current, JSON.stringify(body), generateIdempotencyKey);
    if (!resolution.ok) return;
    idemRef.current = resolution.state;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      await onSubmit(body.evidenceDigest, resolution.key);
      idemRef.current = afterSuccess();
      setReview((r) => afterApprovalSuccess(r));
    } catch (e) {
      const kind = classifyWorkflowError(e as UnknownApiError);
      idemRef.current = afterFailure(idemRef.current, kind.kind === 'AMBIGUOUS');
      setReview((r) => afterApprovalFailure(r, kind));
      setMessage(workflowErrorMessage(kind));
      if (kind.kind !== 'AMBIGUOUS') onRefresh();
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  return (
    <ReconciliationDialogShell open={open} busy={submitting} wide onClose={onClose} title={review.phase === 'approved' ? 'Approval recorded' : 'Independent review: approve historical reconciliation'}>
      {message && <DialogMessage tone={review.ambiguous ? 'warning' : 'danger'}>{message}</DialogMessage>}

      {review.phase === 'approved' ? (
        <div className="space-y-4">
          <DialogMessage tone="success">
            Approved as evidence. The ledger gap is now explained for G3 / R1 while the evidence stays valid. Nothing was posted, no balance changed, and ownership is still unresolved.
          </DialogMessage>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      ) : review.phase === 'needs-re-review' ? (
        <div className="space-y-4">
          <p className="text-sm text-ink-secondary">
            The evidence you reviewed is no longer what the server holds. Inspect the refreshed evidence from the beginning before deciding.
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button type="button" onClick={() => { setMessage(null); begin(latest); }}>
              Review the refreshed evidence
            </Button>
          </div>
        </div>
      ) : review.phase === 'stopped' ? (
        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <DialogMessage tone="info">{EVIDENCE_ONLY_NOTICE}</DialogMessage>
          {stale && (
            <DialogMessage tone="warning">
              This record changed since you opened the review. Approval is disabled until you review the current evidence.{' '}
              <button type="button" className="font-semibold underline" onClick={() => begin(latest)}>
                Review the current evidence
              </button>
            </DialogMessage>
          )}

          <dl className="grid grid-cols-1 gap-3 rounded-control border border-line-subtle p-3 text-sm sm:grid-cols-3">
            <div>
              <dt className="text-xs text-ink-muted">Raw ledger discrepancy (account)</dt>
              <dd className="font-semibold tabular-nums">{formatMoney(snapshot.account.rawDiscrepancy)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Approved explanation now</dt>
              <dd className="font-semibold tabular-nums">{formatMoney(snapshot.account.approvedHistoricalAmount)}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-muted">Unexplained residual now</dt>
              <dd className="font-semibold tabular-nums">{formatMoney(snapshot.account.unexplainedResidual)}</dd>
            </div>
          </dl>

          <ReconciliationEvidencePanel detail={snapshot} />

          <DialogMessage tone="warning">{OWNERSHIP_NOTICE}</DialogMessage>

          <label className="flex items-start gap-3 rounded-control border border-line p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4"
              checked={review.acknowledged}
              disabled={review.ambiguous || submitting || !snapshot.evidenceValid}
              onChange={(e) => setReview((r) => acknowledge(r, e.target.checked))}
            />
            <span>
              I reviewed the audit evidence, the ledger rows, the missing collection amount, the settlement, the discrepancy, the validation result and fingerprint{' '}
              <span className="font-mono text-xs">{snapshot.evidence.evidenceDigest.slice(0, 16)}…</span>. I understand that approving is
              evidence only: it posts no money, changes no balance and does not resolve ownership.
            </span>
          </label>

          {!snapshot.evidenceValid && (
            <DialogMessage tone="danger">The evidence does not currently validate, so it cannot be approved. You can reject it instead.</DialogMessage>
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
              {review.ambiguous ? 'Close and check the record' : 'Cancel'}
            </Button>
            <Button type="button" loading={submitting} disabled={submitting || !canSubmitApproval(review, latest)} onClick={() => void submit()}>
              {review.ambiguous ? 'Retry the same approval' : 'Approve as evidence'}
            </Button>
          </div>
        </div>
      )}
    </ReconciliationDialogShell>
  );
}
