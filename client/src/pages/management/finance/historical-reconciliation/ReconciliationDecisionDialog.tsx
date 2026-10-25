import { useEffect, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';

import { Button } from '../../../../components/ui/Button';
import { TextAreaField } from '../../../../components/forms/Field';
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
  ACTION_CONSEQUENCES,
  ACTION_LABELS,
  RECONCILIATION_REASON_MIN_LENGTH,
  classifyWorkflowError,
  driverLabel,
  reasonError,
  requiresReReview,
  workflowErrorMessage,
} from './historicalReconciliationModel';
import { DialogMessage, ReconciliationDialogShell } from './ReconciliationDialogShell';

export type ReasonedAction = 'reject' | 'withdraw' | 'revoke';

/**
 * FR.12A.6 — Reject (FINANCE), Withdraw (ADMIN) or Revoke (ADMIN, independent)
 * a historical reconciliation: reason → explicit consequences → server
 * confirmation. Never optimistic. One Idempotency-Key per intended decision,
 * bound to its reason; after an ambiguous failure only the unchanged request
 * may be retried (the server replays, never applies it twice).
 */
export function ReconciliationDecisionDialog({
  open,
  action,
  detail,
  onSubmit,
  onRefresh,
  onClose,
}: {
  open: boolean;
  action: ReasonedAction;
  detail: ReconciliationDetail;
  onSubmit: (reason: string, idempotencyKey: string) => Promise<unknown>;
  onRefresh: () => void;
  onClose: () => void;
}) {
  const [step, setStep] = useState<'form' | 'confirm' | 'done' | 'stopped'>('form');
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const idemRef = useRef<IdempotencyState>(INITIAL_IDEMPOTENCY_STATE);
  const submittingRef = useRef(false);

  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setStep('form');
      setReason('');
      setTouched(false);
      setMessage(null);
      setAmbiguous(false);
      idemRef.current = INITIAL_IDEMPOTENCY_STATE;
    }
    wasOpen.current = open;
  }, [open]);

  const label = ACTION_LABELS[action];
  const error = touched ? reasonError(reason) : null;

  const run = async () => {
    if (submittingRef.current) return;
    const trimmed = reason.trim();
    const resolution = resolveIdempotencyKey(idemRef.current, JSON.stringify({ action, reason: trimmed }), generateIdempotencyKey);
    if (!resolution.ok) {
      setMessage('An earlier attempt may already have been recorded. Retry it unchanged, or close and check the record.');
      return;
    }
    idemRef.current = resolution.state;
    submittingRef.current = true;
    setSubmitting(true);
    setMessage(null);
    try {
      await onSubmit(trimmed, resolution.key);
      idemRef.current = afterSuccess();
      setAmbiguous(false);
      setStep('done');
    } catch (e) {
      const kind = classifyWorkflowError(e as UnknownApiError);
      idemRef.current = afterFailure(idemRef.current, kind.kind === 'AMBIGUOUS');
      setAmbiguous(idemRef.current.ambiguous);
      setMessage(workflowErrorMessage(kind));
      if (requiresReReview(kind)) onRefresh();
      if (kind.kind === 'VALIDATION') setStep('form');
      else if (kind.kind !== 'AMBIGUOUS') setStep('stopped');
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  };

  const summary = (
    <dl className="divide-y divide-line-subtle rounded-control border border-line-subtle text-sm">
      {[
        ['Incident', detail.incident.incidentNumber],
        ['Driver', driverLabel(detail.driver)],
        ['Reconciliation amount', formatMoney(detail.evidence.amount)],
        ['Raw ledger discrepancy (account)', formatMoney(detail.account.rawDiscrepancy)],
        ['Unexplained residual now', formatMoney(detail.account.unexplainedResidual)],
      ].map(([k, v]) => (
        <div key={k} className="flex justify-between gap-4 px-3 py-2">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="text-right font-medium tabular-nums text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <ReconciliationDialogShell
      open={open}
      busy={submitting}
      onClose={onClose}
      title={step === 'done' ? `${label}: recorded` : step === 'confirm' ? `Confirm: ${label}` : `${label} historical reconciliation`}
    >
      {message && <DialogMessage tone={ambiguous ? 'warning' : 'danger'}>{message}</DialogMessage>}

      {step === 'form' && (
        <form
          noValidate
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (!reasonError(reason)) setStep('confirm');
          }}
        >
          {summary}
          <TextAreaField
            label="Reason"
            required
            rows={3}
            hint={`Required — at least ${RECONCILIATION_REASON_MIN_LENGTH} characters. Recorded in the decision history and the audit log.`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            error={error ?? undefined}
          />
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Review {label.toLowerCase()}</Button>
          </div>
        </form>
      )}

      {step === 'confirm' && (
        <div className="space-y-4">
          {summary}
          <div className="rounded-control border border-line-subtle bg-sunken px-3 py-2 text-sm">
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-subtle">Reason</p>
            <p className="mt-1 whitespace-pre-line text-ink">{reason.trim()}</p>
          </div>
          <div>
            <p className="text-sm font-semibold text-ink">This will:</p>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-ink-secondary">
              {ACTION_CONSEQUENCES[action].map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            {ambiguous ? (
              <Button type="button" variant="secondary" onClick={onClose} disabled={submitting}>
                Close and check the record
              </Button>
            ) : (
              <Button type="button" variant="secondary" icon={<ArrowLeft />} onClick={() => setStep('form')} disabled={submitting}>
                Back
              </Button>
            )}
            <Button type="button" variant="danger" loading={submitting} disabled={submitting} onClick={() => void run()}>
              {ambiguous ? `Retry ${label.toLowerCase()}` : label}
            </Button>
          </div>
        </div>
      )}

      {step === 'stopped' && (
        <div className="flex justify-end">
          <Button type="button" onClick={onClose}>
            Close
          </Button>
        </div>
      )}

      {step === 'done' && (
        <div className="space-y-4">
          <DialogMessage tone="success">The decision was recorded. Nothing was posted and no balance changed.</DialogMessage>
          <div className="flex justify-end">
            <Button type="button" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      )}
    </ReconciliationDialogShell>
  );
}
